import pino from "pino";
import type { GrabbedJob, JobRepository } from "./repositories/job.js";
import { delay } from "./utils/delay.js";

type DispatchOutcome = "accepted" | "busy" | "reject" | "unknown";

export interface DispatcherOptions {
  ackGraceInSec: number;
  leaseInSec: number;
  nackBackOffInSec: number;
  pollIntervalInMs: number;
  workersPerQueue: number;
  serverUrl: string;
  fetchImpl?: typeof fetch;
}

export class Dispatcher {
  private stopped: boolean = false;
  private loops: Promise<void>[] = [];
  private readonly fetchImpl: typeof fetch;

  public constructor(
    private readonly jobRepository: JobRepository,
    private readonly jobQueues: string[],
    private readonly logger: pino.Logger,
    private readonly opts: DispatcherOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public start(): void {
    for (const queue of this.jobQueues) {
      for (let i = 0; i < this.opts.workersPerQueue; i++) {
        this.loops.push(this.loop(queue));
      }
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
  }

  private async loop(name: string): Promise<void> {
    while (!this.stopped) {
      let progressed = false;
      try {
        progressed = await this.tick(name);
      } catch (e) {
        this.logger.error(e, "[error] failed to run tick loop");
      }

      if (!progressed) {
        await delay(this.opts.pollIntervalInMs);
      }
    }
  }

  private async tick(name: string): Promise<boolean> {
    const job = await this.jobRepository.grab(name, this.opts.ackGraceInSec);
    if (!job) {
      return false;
    }

    const outcome = await this.dispatch(job);
    switch (outcome) {
      case "accepted":
        await this.jobRepository.ack(
          job.id,
          job.leaseToken,
          this.opts.leaseInSec,
        );
        break;

      case "busy":
        await this.jobRepository.nack(
          job.id,
          job.leaseToken,
          this.opts.nackBackOffInSec,
        );
        break;

      case "reject":
        await this.jobRepository.reject(
          job.id,
          job.leaseToken,
          "worker rejected (4xx)",
        );
        break;

      case "unknown":
        // no-op
        break;
    }

    return true;
  }

  private async dispatch(job: GrabbedJob): Promise<DispatchOutcome> {
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
      });

      if (res.ok) {
        return "accepted";
      }

      if (res.status === 503) {
        return "busy";
      }

      if (400 <= res.status && res.status < 500) {
        return "reject";
      }

      return "unknown";
    } catch {
      return "unknown";
    }
  }
}
