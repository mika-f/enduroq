import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import pino from "pino";
import mysql from "mysql2/promise";
import { JobRepository } from "./repositories/job.js";
import { Dispatcher } from "./dispatcher.js";
import type { BackoffParams } from "./utils/backoff.js";

// server
const PORT = Number(process.env.ENDUROQ_PORT ?? 7225);

// configuration
const LEASE = Number(process.env.ENDUROQ_LEASE_IN_SEC ?? 60);
const ACK_GRACE = Number(process.env.ENDUROQ_ACK_GRACE_IN_SEC ?? 30);
const NACK_BACKOFF = Number(process.env.ENDUROQ_NACK_BACKOFF_IN_SEC ?? 5);
const SERVER_URL = process.env.ENDUROQ_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

// database
const DB_HOST = process.env.ENDUROQ_DB_HOST ?? "127.0.0.1";
const DB_PORT = Number(process.env.ENDUROQ_DB_PORT ?? 3306);
const DB_USER = process.env.ENDUROQ_DB_USER ?? "root";
const DB_PASS = process.env.ENDUROQ_DB_PASSWORD ?? "";
const DB_NAME = process.env.ENDUROQ_DB_NAME ?? "enduroq";
const DB_CONNECTION_LIMIT = Number(process.env.ENDUROQ_DB_CONNECTION ?? 16);

// queues
const QUEUES = (process.env.ENDUROQ_QUEUES ?? "default").split(",");
const WORKER_PER_QUEUE = Number(process.env.ENDUROQ_WORKER_PER_QUEUE ?? 4);

// logger
const LOG_LEVEL = process.env.ENDUROQ_LOG_LEVEL ?? "error";
const logger = pino({ level: LOG_LEVEL });

// backoff
const BACKOFF_BASE = Number(process.env.ENDUROQ_BACKOFF_BASE_IN_SEC ?? 2);
const BACKOFF_CAP = Number(process.env.ENDUROQ_BACKOFF_CAP_IN_SEC ?? 300);
const BACKOFF_JITTER = Number(process.env.ENDUROQ_BACKOFF_JITTER_IN_SEC ?? 5);
const BACKOFF: BackoffParams = {
  base: BACKOFF_BASE,
  cap: BACKOFF_CAP,
  jitter: BACKOFF_JITTER,
};

// dispatcher
const DISPATCHER_POLL = Number(process.env.ENDUROQ_DISPATCH_POLL_MS ?? 500);

// reaper
const REAPER_INTERVAL = Number(process.env.ENDUROQ_REAPER_INTERVAL_IN_SEC ?? 5);

const main = async () => {
  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: DB_CONNECTION_LIMIT,
    timezone: "Z",
  });
  const jobRepository = new JobRepository(pool, logger);
  const dispatcher = new Dispatcher(jobRepository, QUEUES, logger, {
    ackGraceInSec: ACK_GRACE,
    leaseInSec: LEASE,
    nackBackOffInSec: NACK_BACKOFF,
    pollIntervalInMs: DISPATCHER_POLL,
    workersPerQueue: WORKER_PER_QUEUE,
    serverUrl: SERVER_URL,
  });
  dispatcher.start();

  // reaper
  const reaper = setInterval(() => {
    jobRepository
      .reapExpired(200, BACKOFF)
      .then((r) => {
        if (r.requeued || r.failed) {
          logger.info(
            `[info] reaper requeued ${r.requeued} jobs and failed ${r.failed} jobs`,
          );
        }
      })
      .catch((e) => {
        logger.error(e, `reaper`);
      });
  }, 1000 * REAPER_INTERVAL);

  const app = new Hono();
  app.use(honoLogger());
  // POST /jobs/:queue
  app.post("/jobs/:queue", async (c) => {
    const queue = c.req.param("queue");
    if (!QUEUES.includes(queue)) {
      return c.json({ error: "queue not found" }, 404);
    }

    const body = await c.req.json();
    const id = await jobRepository.enqueue(
      {
        payload: JSON.stringify(body.data),
        maxRetries: Number(body?.max_retries ?? 0),
        runAfter: body?.run_after ? new Date(body.run_after as string) : null,
        url: body.url as string,
      },
      queue,
    );

    return c.json({ id }, 201);
  });

  // POST /jobs/:id/heartbeat
  app.post("/jobs/:id/heartbeat", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json();
    const token = body.lease_token as string | undefined;

    if (!token) {
      return c.json({ error: "lease_token is required" }, 400);
    }

    const extendSeconds = body.extend_seconds;
    const res = await jobRepository.heartbeat(
      id,
      token,
      extendSeconds ? Number(extendSeconds) : LEASE,
    );

    if (res.ok) {
      return c.json({ lease_expires_at: res.leaseExpiresAt }, 200);
    } else {
      return c.json({ error: "lease already expired" }, 409);
    }
  });

  // POST /jobs/:id/result
  app.post("/jobs/:id/result", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json();
    const token = body.lease_token as string | undefined;

    if (!token) {
      return c.json({ error: "lease_token is required" }, 400);
    }

    const status = body.status;

    if (status === "success") {
      const ok = await jobRepository.succeed(id, token, body.output);
      if (ok) {
        return c.json({ ok: true }, 200);
      } else {
        return c.json({ error: "lease already expired" }, 409);
      }
    }

    if (status === "failed") {
      const retryable = body.retryable ? Boolean(body.retryable) : true;
      const error = (body.error as string | undefined) ?? "failure";
      const ok = await jobRepository.fail(id, token, retryable, error, BACKOFF);
      if (ok) {
        return c.json({ ok: true }, 200);
      } else {
        return c.json({ error: "lease already expired" }, 409);
      }
    }

    return c.json({ error: "invalid status" }, 400);
  });

  // GET /jobs/:id
  app.get("/jobs/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const job = await jobRepository.get(id);
    if (job) {
      return c.json({ ...job }, 200);
    }

    return c.json({ error: "job not found" }, 404);
  });

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  });
  logger.info(`[info] start listening server at 127.0.0.1:${PORT}`);

  const shutdown = async () => {
    logger.info(`[info] shutting down server...`);
    clearInterval(reaper);
    await dispatcher.stop();
    await pool.end();
    server.close((err) => {
      if (err) {
        logger.error(err, "[error] server error");
        process.exit(1);
      }

      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
};

main()
  .then(() => {})
  .catch((err) => {
    logger.error(err, "[error] fatal error");
    process.exit(1);
  });
