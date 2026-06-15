import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import pino from "pino";
import mysql from "mysql2/promise";
import { JobRepository } from "./repositories/job.js";
import { Dispatcher } from "./dispatcher.js";
import { bearerAuth } from "./middlewares/auth.js";
import type { BackoffParams } from "./utils/backoff.js";
import { migrateDatabase } from "./migrations.js";

// server
const PORT = Number(process.env.ENDUROQ_PORT ?? 7225);

// configuration
const LEASE = Number(process.env.ENDUROQ_LEASE_IN_SEC ?? 60);
const ACK_GRACE = Number(process.env.ENDUROQ_ACK_GRACE_IN_SEC ?? 30);
const NACK_BACKOFF = Number(process.env.ENDUROQ_NACK_BACKOFF_IN_SEC ?? 5);
const TIMEOUT = Number(process.env.ENDUROQ_TIMEOUT_IN_MS ?? 1000 * 10);
const SERVER_URL = process.env.ENDUROQ_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

// authentication
const AUTH_TOKEN = process.env.ENDUROQ_AUTH_TOKEN || undefined;

// database
const DB_HOST = process.env.ENDUROQ_DB_HOST ?? "127.0.0.1";
const DB_PORT = Number(process.env.ENDUROQ_DB_PORT ?? 3306);
const DB_USER = process.env.ENDUROQ_DB_USER ?? "root";
const DB_PASS = process.env.ENDUROQ_DB_PASSWORD ?? "";
const DB_NAME = process.env.ENDUROQ_DB_NAME ?? "enduroq";
const DB_CONNECTION_LIMIT = Number(process.env.ENDUROQ_DB_CONNECTION ?? 16);
const DB_AUTO_MIGRATE =
  (process.env.ENDUROQ_DB_AUTO_MIGRATE ?? "true") !== "false";
const DB_MIGRATE_ONLY =
  (process.env.ENDUROQ_DB_MIGRATE_ONLY ?? "false") === "true";
const DB_MIGRATION_LOCK_TIMEOUT = Number(
  process.env.ENDUROQ_DB_MIGRATION_LOCK_TIMEOUT_IN_SEC ?? 60,
);

// queues
const QUEUES = (process.env.ENDUROQ_QUEUES ?? "default").split(",");
const WORKER_PER_QUEUE = Number(process.env.ENDUROQ_WORKER_PER_QUEUE ?? 4);

// logger
const LOG_LEVEL = process.env.ENDUROQ_LOG_LEVEL ?? "info";
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
  logger.debug(
    {
      port: PORT,
      serverUrl: SERVER_URL,
      queues: QUEUES,
      workersPerQueue: WORKER_PER_QUEUE,
      leaseInSec: LEASE,
      ackGraceInSec: ACK_GRACE,
      nackBackoffInSec: NACK_BACKOFF,
      dispatchPollMs: DISPATCHER_POLL,
      timeoutMs: TIMEOUT,
      reaperIntervalSec: REAPER_INTERVAL,
      backoff: BACKOFF,
      db: {
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        name: DB_NAME,
        connectionLimit: DB_CONNECTION_LIMIT,
        autoMigrate: DB_AUTO_MIGRATE,
        migrateOnly: DB_MIGRATE_ONLY,
        migrationLockTimeoutInSec: DB_MIGRATION_LOCK_TIMEOUT,
      },
    },
    "enduroq configuration",
  );

  if (TIMEOUT / 1000 >= ACK_GRACE) {
    logger.error(
      { timeout: TIMEOUT / 1000, ack_grace: ACK_GRACE },
      "(ENDUROQ_TIMEOUT_IN_MS / 1000) must be lesser than ENDUROQ_ACK_GRACE_IN_SEC",
    );
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: DB_CONNECTION_LIMIT,
    timezone: "Z",
  });

  if (DB_AUTO_MIGRATE || DB_MIGRATE_ONLY) {
    await migrateDatabase(pool, logger, {
      databaseName: DB_NAME,
      lockTimeoutInSec: DB_MIGRATION_LOCK_TIMEOUT,
    });
  } else {
    logger.warn("database auto-migration is disabled");
  }

  if (DB_MIGRATE_ONLY) {
    logger.info("database migrations completed; exiting");
    await pool.end();
    return;
  }

  const jobRepository = new JobRepository(pool, logger);
  const dispatcher = new Dispatcher(jobRepository, QUEUES, logger, {
    ackGraceInSec: ACK_GRACE,
    leaseInSec: LEASE,
    nackBackOffInSec: NACK_BACKOFF,
    pollIntervalInMs: DISPATCHER_POLL,
    timeoutInMs: TIMEOUT,
    workersPerQueue: WORKER_PER_QUEUE,
    serverUrl: SERVER_URL,
    backoff: BACKOFF,
  });
  dispatcher.start();

  // reaper
  const reaper = setInterval(() => {
    jobRepository
      .reapExpired(200, BACKOFF)
      .then((r) => {
        if (r.requeued || r.failed) {
          logger.info(
            { requeued: r.requeued, failed: r.failed },
            "reaper: reaped expired leases",
          );
        } else {
          logger.debug("reaper: no expired leases");
        }
      })
      .catch((e) => {
        logger.error(e, "reaper: unexpected error");
      });
  }, 1000 * REAPER_INTERVAL);

  const app = new Hono();
  app.use(
    honoLogger((str) => {
      logger.info({ type: "http" }, str);
    }),
  );

  const requireAuth = bearerAuth(AUTH_TOKEN, logger);
  if (AUTH_TOKEN) {
    logger.info("bearer authentication enabled for enqueue and status routes");
  } else {
    logger.warn(
      "ENDUROQ_AUTH_TOKEN is not set: enqueue and status routes are unauthenticated",
    );
  }

  // POST /jobs/:queue
  app.post("/jobs/:queue", requireAuth, async (c) => {
    const queue = c.req.param("queue");
    if (!QUEUES.includes(queue)) {
      logger.warn({ queue }, "enqueue rejected: unknown queue");
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

    logger.info(
      {
        jobId: id,
        queue,
        url: body.url as string,
        maxRetries: Number(body?.max_retries ?? 0),
      },
      "job enqueued",
    );
    return c.json({ id }, 201);
  });

  // POST /jobs/:id/heartbeat
  app.post("/jobs/:id/heartbeat", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json();
    const token = body.lease_token as string | undefined;

    if (!token) {
      logger.warn({ jobId: id }, "heartbeat rejected: missing lease_token");
      return c.json({ error: "lease_token is required" }, 400);
    }

    const extendSeconds = body.extend_seconds;
    const res = await jobRepository.heartbeat(
      id,
      token,
      extendSeconds ? Number(extendSeconds) : LEASE,
    );

    if (res.ok) {
      logger.debug(
        { jobId: id, leaseExpiresAt: res.leaseExpiresAt },
        "heartbeat: lease extended",
      );
      return c.json({ lease_expires_at: res.leaseExpiresAt }, 200);
    } else {
      logger.warn({ jobId: id }, "heartbeat: lease already expired");
      return c.json({ error: "lease already expired" }, 409);
    }
  });

  // POST /jobs/:id/result
  app.post("/jobs/:id/result", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json();
    const token = body.lease_token as string | undefined;

    if (!token) {
      logger.warn({ jobId: id }, "result rejected: missing lease_token");
      return c.json({ error: "lease_token is required" }, 400);
    }

    const status = body.status;

    if (status === "success") {
      const ok = await jobRepository.succeed(id, token, body.output);
      if (ok) {
        logger.info({ jobId: id }, "job succeeded");
        return c.json({ ok: true }, 200);
      } else {
        logger.warn(
          { jobId: id },
          "job result rejected: lease already expired",
        );
        return c.json({ error: "lease already expired" }, 409);
      }
    }

    if (status === "failure") {
      const retryable = body.retryable ? Boolean(body.retryable) : true;
      const error = (body.error as string | undefined) ?? "failure";
      const ok = await jobRepository.fail(id, token, retryable, error, BACKOFF);
      if (ok) {
        return c.json({ ok: true }, 200);
      } else {
        logger.warn(
          { jobId: id },
          "job result rejected: lease already expired",
        );
        return c.json({ error: "lease already expired" }, 409);
      }
    }

    logger.warn({ jobId: id, status }, "job result rejected: invalid status");
    return c.json({ error: "invalid status" }, 400);
  });

  // GET /jobs/:id
  app.get("/jobs/:id", requireAuth, async (c) => {
    const id = Number(c.req.param("id"));
    const job = await jobRepository.get(id);
    if (job) {
      logger.debug({ jobId: id, status: job.status }, "job status queried");
      return c.json({ ...job }, 200);
    }

    logger.debug({ jobId: id }, "job status query: not found");
    return c.json({ error: "job not found" }, 404);
  });

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  });
  logger.info({ port: PORT }, "server listening");

  const shutdown = async () => {
    logger.info("shutting down: stopping reaper and dispatcher");
    clearInterval(reaper);
    await dispatcher.stop();
    logger.debug("closing database pool");
    await pool.end();
    server.close((err) => {
      if (err) {
        logger.error(err, "server close error");
        process.exit(1);
      }

      logger.info("server shut down cleanly");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
};

main()
  .then(() => {})
  .catch((err) => {
    logger.fatal(err, "fatal startup error");
    process.exit(1);
  });
