import {
  type RowDataPacket,
  type Pool,
  type ResultSetHeader,
} from "mysql2/promise";
import pino from "pino";
import { v4 } from "uuid";
import { toISO } from "../utils/date.js";
import { safeParseJSON } from "../utils/json.js";
import { compute, type BackoffParams } from "../utils/backoff.js";

export type JobStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed";

export interface EnqueueRequest {
  url: string;
  payload: string;
  maxRetries?: number;
  runAfter?: Date | null;
}

export interface GrabbedJob {
  id: number;
  name: string;
  url: string;
  attempt: number;
  maxRetries: number;
  leaseToken: string;
  leaseExpiresAt: string; // ISO8601
  payload: unknown;
}

export interface JobRow {
  id: number;
  name: string;
  status: JobStatus;
  attempt: number;
  max_retries: number;
  run_after: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  result: unknown;
}

export class JobRepository {
  private readonly log: pino.Logger;

  public constructor(
    private readonly pool: Pool,
    logger: pino.Logger,
  ) {
    this.log = logger.child({ module: "repository" });
  }

  public async enqueue(input: EnqueueRequest, name: string): Promise<number> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `
      INSERT INTO jobs (name, url, payload, status, attempt, max_retries, run_after)
      VALUES (?, ?, CAST(? as JSON), 'queued', 0, ?, COALESCE(?, NOW(3)))
      `,
      [
        name,
        input.url,
        JSON.stringify(input.payload ?? null),
        input.maxRetries ?? 3,
        input.runAfter ?? null,
      ],
    );

    return res.insertId;
  }

  public async grab(
    name: string,
    ackGraceInSec: number,
  ): Promise<GrabbedJob | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query<RowDataPacket[]>(
        `
          SELECT id, name, url, payload, attempt, max_retries
          FROM jobs
          WHERE
            status = 'queued'
            AND name = ?
            AND run_after <= NOW(3)
          ORDER BY run_after, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [name],
      );

      if (rows.length === 0) {
        await conn.commit();
        return null;
      }

      const row = rows[0]!;
      const leaseToken = v4();
      await conn.query(
        `
          UPDATE jobs
          SET status = 'dispatching', attempt = attempt + 1, lease_token = ?, lease_expires_at = NOW(3) + INTERVAL ? SECOND, updated_at = NOW(3)
          WHERE id = ?
      `,
        [leaseToken, ackGraceInSec, row.id],
      );

      const [leaseRows] = await conn.query<RowDataPacket[]>(
        `
          SELECT lease_expires_at FROM jobs WHERE id = ?
        `,
        [row.id],
      );

      await conn.commit();

      return {
        id: row.id,
        name: row.name,
        url: row.url,
        attempt: row.attempt + 1,
        maxRetries: row.max_retries,
        leaseToken,
        leaseExpiresAt: toISO(leaseRows[0]!.lease_expires_at),
        payload: safeParseJSON(row.payload),
      };
    } catch (e) {
      this.log.error({ queue: name, err: e }, "failed to grab job");
      throw e;
    } finally {
      conn.release();
    }
  }

  public async ack(
    id: number,
    leaseToken: string,
    leaseInSec: number,
  ): Promise<boolean> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE jobs
        SET status = 'running', lease_expires_at = NOW(3) + INTERVAL ? SECOND, updated_at = NOW(3)
        WHERE
          id = ?
          AND status = 'dispatching'
          AND lease_token = ?
      `,
      [leaseInSec, id, leaseToken],
    );

    return res.affectedRows === 1;
  }

  public async nack(
    id: number,
    leaseToken: string,
    backoffSec: number,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status      = IF(attempt <= max_retries, 'queued', 'failed'),
            run_after   = IF(attempt <= max_retries, NOW(3) + INTERVAL ? SECOND, run_after),
            lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
        WHERE
          id = ?
          AND status = 'dispatching'
          AND lease_token = ?
      `,
      [backoffSec, id, leaseToken],
    );
  }

  public async reject(
    id: number,
    leaseToken: string,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'failed', last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
        WHERE
          id = ?
          AND status = 'dispatching'
          AND lease_token = ?
      `,
      [reason, id, leaseToken],
    );
  }

  public async heartbeat(
    id: number,
    leaseToken: string,
    leaseInSec: number,
  ): Promise<{ ok: boolean; leaseExpiresAt?: string | undefined }> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE jobs
        SET status = 'running', lease_expires_at = NOW(3) + INTERVAL ? SECOND, updated_at = NOW(3)
        WHERE
          id = ?
          AND status IN ('dispatching', 'running')
          AND lease_token = ?
      `,
      [leaseInSec, id, leaseToken],
    );

    if (res.affectedRows !== 1) {
      return { ok: false };
    }

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `
        SELECT lease_expires_at FROM jobs WHERE id = ?
      `,
      [id],
    );

    return {
      ok: true,
      leaseExpiresAt: rows.length
        ? toISO(rows[0]!.lease_expires_at)
        : undefined,
    };
  }

  public async succeed(
    id: number,
    leaseToken: string,
    output: unknown,
  ): Promise<boolean> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE jobs
        SET status = 'succeeded', result = CAST(? AS JSON), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
        WHERE
          id = ?
          AND status IN ('dispatching', 'running')
          AND lease_token = ?
      `,
      [output === undefined ? null : JSON.stringify(output), id, leaseToken],
    );
    return res.affectedRows === 1;
  }

  public async fail(
    id: number,
    leaseToken: string,
    retryable: boolean,
    error: string,
    backoff: BackoffParams,
  ): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query<RowDataPacket[]>(
        `
          SELECT attempt, max_retries
          FROM jobs
          WHERE
            id = ?
            AND status IN ('dispatching', 'running')
            AND lease_token = ?
          FOR UPDATE
        `,
        [id, leaseToken],
      );
      if (rows.length === 0) {
        await conn.commit();
        return false;
      }

      const row = rows[0]!;
      const attempt = row.attempt as number;
      const maxRetries = row.max_retries as number;
      const retry = retryable && attempt <= maxRetries;

      if (retry) {
        const nextBackoff = compute({ attempt, params: backoff });
        await conn.query(
          `
            UPDATE jobs
            SET status = 'queued', run_after = NOW(3) + INTERVAL ? SECOND, last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
            WHERE id = ?
          `,
          [nextBackoff, error, id],
        );
        this.log.info(
          {
            jobId: id,
            attempt,
            maxRetries,
            nextRetryInSec: nextBackoff,
            error,
          },
          "job failed, scheduled for retry",
        );
      } else {
        await conn.query(
          `
            UPDATE jobs
            SET status = 'failed', last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
            WHERE id = ?
          `,
          [error, id],
        );
        this.log.warn(
          { jobId: id, attempt, maxRetries, error },
          "job permanently failed (retries exhausted)",
        );
      }

      await conn.commit();
      return true;
    } catch (e) {
      await conn.rollback();
      this.log.error({ jobId: id, err: e }, "failed to mark job as failed");
      throw e;
    } finally {
      conn.release();
    }
  }

  public async reapExpired(
    batch: number,
    backoff: BackoffParams,
  ): Promise<{ requeued: number; failed: number }> {
    const [r1] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE jobs
        SET status = 'queued',
            run_after = NOW(3) + INTERVAL LEAST(?, ? * POW(2, attempt)) SECOND + INTERVAL FLOOR(RAND() * ?) SECOND,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW(3)
        WHERE
          status IN ('dispatching', 'running')
          AND lease_expires_at < NOW(3)
          AND attempt <= max_retries
        LIMIT ?
      `,
      [backoff.cap, backoff.base, backoff.jitter, batch],
    );

    const [r2] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE jobs
        SET status = 'failed', last_error = 'lease expired (retries exhausted)', lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(3)
        WHERE
          status IN ('dispatching', 'running')
          AND lease_expires_at < NOW(3)
          AND attempt > max_retries
      `,
      [batch],
    );

    return { requeued: r1.affectedRows, failed: r2.affectedRows };
  }

  public async get(id: number): Promise<JobRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `
        SELECT id, name, url, status, attempt, max_retries, run_after, created_at, updated_at, last_error, result
        FROM jobs
        WHERE id = ?
      `,
      [id],
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0]!;
    return { ...row, result: safeParseJSON(row.result) } as JobRow;
  }
}
