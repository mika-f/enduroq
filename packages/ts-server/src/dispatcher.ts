import pino from "pino";
import type { GrabbedJob, JobRepository } from "./repositories/job.js";
import { delay } from "./utils/delay.js";
import type { BackoffParams } from "./utils/backoff.js";

type DispatchOutcome =
  | { kind: "accepted" }
  | {
      kind: "result";
      success: boolean;
      retryable: boolean;
      output?: unknown;
      error?: string;
    }
  | { kind: "busy" }
  | { kind: "reject" }
  | { kind: "unknown" };

export interface DispatcherOptions {
  ackGraceInSec: number;
  leaseInSec: number;
  nackBackOffInSec: number;
  pollIntervalInMs: number;
  timeoutInMs: number;
  workersPerQueue: number;
  serverUrl: string;
  backoff: BackoffParams;
  fetchImpl?: typeof fetch;
}

export class Dispatcher {
  private stopped: boolean = false;
  private loops: Promise<void>[] = [];
  private readonly log: pino.Logger;
  private readonly fetchImpl: typeof fetch;

  public constructor(
    private readonly jobRepository: JobRepository,
    private readonly jobQueues: string[],
    logger: pino.Logger,
    private readonly opts: DispatcherOptions,
  ) {
    this.log = logger.child({ module: "dispatcher" });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public start(): void {
    this.log.info(
      { queues: this.jobQueues, workersPerQueue: this.opts.workersPerQueue },
      "dispatcher starting",
    );
    for (const queue of this.jobQueues) {
      for (let i = 0; i < this.opts.workersPerQueue; i++) {
        this.loops.push(this.loop(queue, i));
      }
    }
  }

  public async stop(): Promise<void> {
    this.log.info("dispatcher stopping, waiting for in-flight ticks");
    this.stopped = true;
    await Promise.allSettled(this.loops);
    this.log.info("dispatcher stopped");
  }

  private async loop(queue: string, workerIndex: number): Promise<void> {
    const log = this.log.child({ queue, worker: workerIndex });
    log.debug("worker loop started");
    while (!this.stopped) {
      let progressed = false;
      try {
        progressed = await this.tick(queue, log);
      } catch (e) {
        log.error(e, "tick loop error");
      }

      if (!progressed) {
        await delay(this.opts.pollIntervalInMs);
      }
    }
    log.debug("worker loop stopped");
  }

  private async tick(queue: string, log: pino.Logger): Promise<boolean> {
    const job = await this.jobRepository.grab(queue, this.opts.ackGraceInSec);
    if (!job) {
      log.trace("no job available");
      return false;
    }

    log.debug(
      {
        jobId: job.id,
        url: job.url,
        attempt: job.attempt,
        maxRetries: job.maxRetries,
      },
      "job grabbed, dispatching",
    );

    const outcome = await this.dispatch(job, log);
    switch (outcome.kind) {
      case "accepted":
        await this.jobRepository.ack(
          job.id,
          job.leaseToken,
          this.opts.leaseInSec,
        );
        log.info({ jobId: job.id, url: job.url }, "job accepted by worker");
        break;

      case "result":
        if (outcome.success) {
          await this.jobRepository.succeed(
            job.id,
            job.leaseToken,
            outcome.output,
          );
        } else {
          await this.jobRepository.fail(
            job.id,
            job.leaseToken,
            outcome.retryable,
            outcome.error!,
            this.opts.backoff,
          );
        }
        break;

      case "busy":
        await this.jobRepository.nack(
          job.id,
          job.leaseToken,
          this.opts.nackBackOffInSec,
        );
        log.warn(
          {
            jobId: job.id,
            url: job.url,
            backoffSec: this.opts.nackBackOffInSec,
          },
          "worker busy (503): job nacked, will retry after backoff",
        );
        break;

      case "reject":
        await this.jobRepository.reject(
          job.id,
          job.leaseToken,
          "worker rejected (4xx)",
        );
        log.warn(
          { jobId: job.id, url: job.url },
          "worker rejected job (4xx): job permanently failed",
        );
        break;

      case "unknown":
        log.error(
          { jobId: job.id, url: job.url },
          "dispatch outcome unknown (network error or 5xx): lease will expire and reaper will requeue",
        );
        break;
    }

    return true;
  }

  private async dispatch(
    job: GrabbedJob,
    log: pino.Logger,
  ): Promise<DispatchOutcome> {
    log.debug(
      { jobId: job.id, url: job.url },
      "sending dispatch request to worker",
    );
    const signal = AbortSignal.timeout(this.opts.timeoutInMs);
    try {
      const res = await this.fetchImpl(job.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Enduroq-Job-Id": `${job.id}`,
        },
        body: JSON.stringify({
          callback: this.opts.serverUrl,
          lease_token: job.leaseToken,
          data: job.payload,
        }),
        signal,
      });

      log.debug(
        { jobId: job.id, url: job.url, httpStatus: res.status },
        "dispatch response received",
      );

      if (res.ok) {
        if (res.status === 202) {
          return { kind: "accepted" };
        }

        const body = (await res.json().catch(() => null)) as {
          status?: string;
          retryable?: boolean;
          output?: unknown;
          error?: string;
        } | null;
        if (body && typeof body.status === "string") {
          return body.status === "success"
            ? {
                kind: "result",
                success: true,
                retryable: false,
                output: body.output,
              }
            : {
                kind: "result",
                success: false,
                retryable: body.retryable ?? true,
                error: body.error ?? "failure",
              };
        }

        // for backward compatibility
        return { kind: "accepted" };
      }

      if (res.status === 503) {
        return { kind: "busy" };
      }

      if (400 <= res.status && res.status < 500) {
        return { kind: "reject" };
      }

      return { kind: "unknown" };
    } catch (e) {
      log.error(
        { jobId: job.id, url: job.url, err: e },
        "dispatch request failed (network error)",
      );
      return { kind: "unknown" };
    }
  }
}
