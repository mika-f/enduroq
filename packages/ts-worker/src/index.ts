export interface DispatchPayload<T = unknown> {
  callback: string;
  lease_token: string;
  lease_expires_at: string;
  data: T;
}

export interface AcquireJobOptions {
  heartbeatIntervalMs?: number;
  leaseExtendSeconds?: number;
  resultRetries?: number;
}

export type HeartbeatOutcome =
  | { kind: "ok"; leaseExpiresAt?: string }
  | { kind: "gone" }
  | { kind: "transient" };

export type ResultOutcome = "delivered" | "stale" | "failed";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const JOB_ID_HEADER = "X-Enduroq-Job-Id";

export class CallbackClient {
  public constructor(private readonly fetchImpl: typeof fetch) {}

  public async heartbeat(
    baseUrl: string,
    id: number,
    token: string,
    extendSeconds?: number,
  ): Promise<HeartbeatOutcome> {
    const url = `${baseUrl}/jobs/${id}/heartbeat`;
    const body = JSON.stringify({
      lease_token: token,
      ...(extendSeconds != null ? { extend_seconds: extendSeconds } : {}),
    });

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (res.status === 409) {
        return { kind: "gone" };
      }
      if (!res.ok) {
        return { kind: "transient" };
      }

      const json = (await res.json().catch(() => ({}))) as {
        lease_expires_at?: string;
      };

      return { kind: "ok", leaseExpiresAt: json.lease_expires_at };
    } catch {
      return { kind: "transient" };
    }
  }

  public async result(
    baseUrl: string,
    id: number,
    payload: {
      lease_token: string;
      status: "success" | "failure";
      retryable?: boolean;
      output?: unknown;
      error?: string;
    },
    retries: number = 1,
  ): Promise<ResultOutcome> {
    const url = `${baseUrl}/jobs/${id}/result`;
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (res.status === 409) {
          return "stale";
        }

        if (res.ok) {
          return "delivered";
        }
      } catch {
        // ignored
      }

      if (attempt < retries) {
        const backoff =
          Math.min(5000, 200 * 2 ** attempt) * Math.random() * 200;
        await delay(backoff);
      }
    }

    return "failed";
  }
}

export class Worker {
  public constructor(private readonly client: CallbackClient) {}

  public async acquire(
    id: number,
    job: DispatchPayload<unknown>,
    ac: AbortController,
    opts?: AcquireJobOptions,
  ): Promise<{ stop: () => void }> {
    let leaseExpiresAt = Date.parse(job.lease_expires_at);
    const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 20 * 1000;
    const window = Number.isFinite(leaseExpiresAt)
      ? leaseExpiresAt - Date.now()
      : heartbeatIntervalMs * 3;
    const interval = Math.max(
      1000,
      Math.min(heartbeatIntervalMs),
      Math.floor(window / 3),
    );

    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) {
        return;
      }

      const outcome = await this.client.heartbeat(
        job.callback,
        id,
        job.lease_token,
        opts?.leaseExtendSeconds,
      );
      if (stopped) {
        return;
      }

      if (outcome.kind === "gone") {
        stop();
        ac.abort();
        return;
      }

      if (outcome.kind === "ok" && outcome.leaseExpiresAt) {
        const next = Date.parse(outcome.leaseExpiresAt);
        if (Number.isFinite(next)) {
          leaseExpiresAt = next;
        }
        return;
      }

      if (Date.now() > leaseExpiresAt) {
        stop();
        ac.abort();
      }
    }, interval);

    function stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
    }

    return { stop };
  }
}
