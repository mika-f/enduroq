# Enduroq

Enduroq `/ˈɛn.djʊ.rɒk/` is a durable, HTTP-based job queue system backed by MySQL, designed for long-running, language-agnostic workers.

Inspired by [Fireworq](https://github.com/fireworq/fireworq), Enduroq extends the architecture with a **lease / heartbeat mechanism** that lets workers hold jobs for minutes or hours without risking silent loss. Workers keep their lease alive by periodically calling a heartbeat endpoint; if the heartbeat stops the server automatically requeues the job.

## Features

- **Language-agnostic workers** — any HTTP service can be a worker
- **Durable jobs** — persisted in MySQL; survive server restarts
- **Lease-based ownership** — workers extend leases via heartbeat; expired leases are automatically reaped and requeued
- **Exponential backoff with jitter** — prevents retry storms
- **Configurable queues** — multiple named queues with independent worker pools
- **Scheduled jobs** — `run_after` defers execution to a future time
- **Graceful nack** — workers that return `503 Service Unavailable` are back-pressured without consuming a retry

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Start (Docker Compose)](#quick-start-docker-compose)
3. [Manual Setup](#manual-setup)
4. [Environment Variables](#environment-variables)
5. [API Reference](#api-reference)
6. [Job States](#job-states)
7. [Worker SDK (TypeScript)](#worker-sdk-typescript)
8. [Retry & Backoff](#retry--backoff)
9. [License](#license)

---

## Architecture

```
  Client
    │
    │  POST /jobs/:queue   (enqueue)
    ▼
┌─────────────┐
│ Queue Server│
│  (Enduroq)  │◄──────────────────────────────┐
└──────┬──────┘                               │
       │  INSERT job (status = queued)        │  POST /jobs/:id/heartbeat
       ▼                                      │  POST /jobs/:id/result
  ┌─────────┐   SELECT … FOR UPDATE SKIP LOCKED
  │  MySQL  │◄──────────────────────────────
  └─────────┘
       ▲
       │  grab job (status = dispatching)
       │
┌──────┴──────────────────────────────┐
│          Dispatcher                 │
│  (N workers × M queues)             │
│                                     │
│  loop()  ──tick()──► HTTP POST ──► Worker
│                                     │  ├── 202  → mark running (async)
│                                     │  ├── 200 {status:"success"}  → succeed immediately (sync)
│                                     │  ├── 200 {status:"failure"} → fail/retry immediately (sync)
│                                     │  ├── 503  → nack (requeue w/ backoff)
│                                     │  ├── 4xx  → reject (mark failed)
│                                     │  └── 5xx / network → unknown (leave)
└─────────────────────────────────────┘
                                Async worker (long-running)
                                  │
                                  ├── heartbeat loop ──► POST /jobs/:id/heartbeat
                                  │     └── 409  → lease gone, abort job
                                  │
                                  └── on done ──────► POST /jobs/:id/result
                                        ├── status: success
                                        └── status: failure  {retryable: true/false}
```

### Components

| Component        | Description                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| **Queue Server** | HTTP API (Hono) for enqueuing, status queries, heartbeat, and result reporting. Backed by MySQL.                |
| **Dispatcher**   | Background loops that poll queued jobs and POST them to worker URLs. One pool of N loops per named queue.       |
| **Reaper**       | Background timer that detects expired leases and requeues or fails jobs accordingly.                            |
| **Worker**       | Any HTTP service. Receives a job via POST, keeps the lease alive via heartbeat, and reports a result when done. |
| **Worker SDK**   | Optional TypeScript library (`@enduroq/enduroq-worker`) that automates the heartbeat loop and result reporting. |

### Job Lifecycle

1. **Enqueue** — Client POSTs to `/jobs/:queue`; job is inserted with `status = queued`.
2. **Grab** — Dispatcher selects the next eligible job using `SELECT … FOR UPDATE SKIP LOCKED`, generates a UUID lease token, and sets `status = dispatching`.
3. **Dispatch** — Dispatcher POSTs the job payload (including callback URL and lease token) to the worker URL. The request times out after `ENDUROQ_TIMEOUT_IN_MS` milliseconds.
4. The worker chooses one of two response modes:
   - **Sync** (`200 OK` + `{ status: "success"|"failure", ... }`) — the dispatcher finalizes the job immediately, no heartbeat needed.
   - **Async** (`202 Accepted`) — the server sets `status = running` and extends the lease; the worker continues processing in the background.
5. **Heartbeat** (async only) — Worker periodically POSTs to `/jobs/:id/heartbeat` to prevent lease expiry.
6. **Result** (async only) — Worker POSTs to `/jobs/:id/result`:
   - `status: success` → `status = succeeded`
   - `status: failure, retryable: true` (and retries remain) → requeue with backoff
   - `status: failure, retryable: false` or retries exhausted → `status = failed`
7. **Reaping** — If an async worker's lease expires before a result arrives, the Reaper requeues (or fails) the job automatically.

---

## Quick Start (Docker Compose)

```bash
git clone https://github.com/mika-f/enduroq.git
cd enduroq
docker compose up
```

This starts:

| Service  | Port | Description                           |
| -------- | ---- | ------------------------------------- |
| `mysql`  | 3306 | MySQL 8.0 with the schema pre-applied |
| `queue`  | 7225 | Enduroq queue server                  |
| `worker` | 8080 | Example Next.js worker                |

Enqueue a test job:

```bash
curl -X POST http://localhost:7225/jobs/default \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://worker:8080/workers/send_email",
    "data": { "label": "hello", "seconds": 5 },
    "max_retries": 3
  }'
# {"id": 1}
```

Check its status:

```bash
curl http://localhost:7225/jobs/1
```

---

## Manual Setup

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 10
- MySQL 8.0

### 1. Apply the database schema

```bash
mysql -u root -p < packages/sql-schema/schema.sql
```

### 2. Install dependencies

```bash
vp install   # or: pnpm install
```

### 3. Start the queue server

```bash
cd packages/ts-server
ENDUROQ_DB_HOST=127.0.0.1 \
ENDUROQ_DB_PASSWORD=yourpassword \
vp dev
```

---

## Environment Variables

All variables are optional; defaults are shown.

### Queue Server

#### Server

| Variable             | Default                   | Description                                             |
| -------------------- | ------------------------- | ------------------------------------------------------- |
| `ENDUROQ_PORT`       | `7225`                    | TCP port the HTTP server listens on                     |
| `ENDUROQ_SERVER_URL` | `http://127.0.0.1:<port>` | Public base URL sent to workers as the callback address |

#### Database

| Variable                | Default     | Description                |
| ----------------------- | ----------- | -------------------------- |
| `ENDUROQ_DB_HOST`       | `127.0.0.1` | MySQL hostname             |
| `ENDUROQ_DB_PORT`       | `3306`      | MySQL port                 |
| `ENDUROQ_DB_USER`       | `root`      | MySQL user                 |
| `ENDUROQ_DB_PASSWORD`   | _(empty)_   | MySQL password             |
| `ENDUROQ_DB_NAME`       | `enduroq`   | Database name              |
| `ENDUROQ_DB_CONNECTION` | `16`        | MySQL connection pool size |

#### Queue Management

| Variable                   | Default   | Description                                                      |
| -------------------------- | --------- | ---------------------------------------------------------------- |
| `ENDUROQ_QUEUES`           | `default` | Comma-separated list of queue names (e.g. `default,email,video`) |
| `ENDUROQ_WORKER_PER_QUEUE` | `4`       | Number of concurrent dispatcher loops per queue                  |

#### Lease & Acknowledgment

| Variable                      | Default | Description                                                                                                                   |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ENDUROQ_LEASE_IN_SEC`        | `60`    | Initial lease duration after a job is dispatched (async workers)                                                              |
| `ENDUROQ_ACK_GRACE_IN_SEC`    | `30`    | Extra grace period added to the lease when the server marks a job as `running` (i.e. after the worker's `202` acknowledgment). Must be greater than `ENDUROQ_TIMEOUT_IN_MS / 1000`. |
| `ENDUROQ_TIMEOUT_IN_MS`       | `10000` | HTTP request timeout when dispatching to a worker. Must be less than `ENDUROQ_ACK_GRACE_IN_SEC × 1000`.                      |
| `ENDUROQ_NACK_BACKOFF_IN_SEC` | `5`     | Delay before requeuing a job after a `503` (worker busy) response                                                             |

#### Retry Backoff

The retry delay uses truncated exponential backoff with jitter:
`delay = min(cap, base × 2^attempt) + random(0, jitter)`

| Variable                        | Default | Description                                          |
| ------------------------------- | ------- | ---------------------------------------------------- |
| `ENDUROQ_BACKOFF_BASE_IN_SEC`   | `2`     | Base delay in seconds                                |
| `ENDUROQ_BACKOFF_CAP_IN_SEC`    | `300`   | Maximum delay cap in seconds (5 minutes)             |
| `ENDUROQ_BACKOFF_JITTER_IN_SEC` | `5`     | Upper bound of the random jitter added to each delay |

#### Dispatcher & Reaper

| Variable                         | Default | Description                                            |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `ENDUROQ_DISPATCH_POLL_MS`       | `500`   | How often (ms) each dispatcher loop polls for new jobs |
| `ENDUROQ_REAPER_INTERVAL_IN_SEC` | `5`     | How often the reaper scans for expired leases          |

#### Logging

| Variable            | Default | Description                                                                                    |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `ENDUROQ_LOG_LEVEL` | `error` | [Pino](https://getpino.io) log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) |

### Worker (example)

These are used by the example worker.

| Variable           | Default | Description                                             |
| ------------------ | ------- | ------------------------------------------------------- |
| `HEARTBEAT_MS`     | `4000`  | Heartbeat interval in milliseconds                      |
| `LEASE_EXTEND_SEC` | `15`    | Number of seconds to extend the lease on each heartbeat |

---

## API Reference

### Enqueue a Job

```
POST /jobs/:queue
Content-Type: application/json
```

**Request body:**

| Field         | Type   | Required | Description                                         |
| ------------- | ------ | -------- | --------------------------------------------------- |
| `url`         | string | Yes      | Worker endpoint URL                                 |
| `data`        | any    | No       | Arbitrary JSON payload forwarded to the worker      |
| `max_retries` | number | No       | Maximum retry attempts (default: `3`)               |
| `run_after`   | string | No       | ISO 8601 timestamp; defer execution until this time |

**Response `201 Created`:**

```json
{ "id": 42 }
```

---

### Worker Dispatch Endpoint (Your Service)

When the dispatcher sends a job to a worker URL, the worker must respond within `ENDUROQ_TIMEOUT_IN_MS` milliseconds and choose one of two modes:

**Async mode** — respond `202 Accepted` to acknowledge receipt. The job enters `running` state and the worker is responsible for sending heartbeats and a final result.

```
HTTP/1.1 202 Accepted
```

**Sync mode** — respond `200 OK` with a JSON body containing `status`. The dispatcher finalizes the job immediately; no heartbeat or result call is needed.

```json
{ "status": "success", "output": { "any": "data" } }
```

```json
{ "status": "failure", "retryable": true, "error": "reason" }
```

Other response codes:

| Status | Meaning |
|---|---|
| `503 Service Unavailable` | Worker is busy; job is requeued after `ENDUROQ_NACK_BACKOFF_IN_SEC` seconds without consuming a retry |
| `4xx` (other) | Permanent client error; job is marked `failed` |
| `5xx` / network error | Outcome unknown; job remains in `dispatching` until the reaper handles it |

---

### Get Job Status

```
GET /jobs/:id
```

**Response `200 OK`:**

```json
{
  "id": 42,
  "name": "default",
  "url": "https://worker.example.com/process",
  "status": "running",
  "attempt": 1,
  "max_retries": 3,
  "run_after": "2026-06-14T10:00:00.000Z",
  "created_at": "2026-06-14T09:50:00.000Z",
  "updated_at": "2026-06-14T09:55:00.000Z",
  "last_error": null,
  "result": null
}
```

---

### Heartbeat (Extend Lease)

Workers call this periodically to prevent their lease from expiring.

```
POST /jobs/:id/heartbeat
Content-Type: application/json
```

**Request body:**

| Field            | Type   | Required | Description                                                   |
| ---------------- | ------ | -------- | ------------------------------------------------------------- |
| `lease_token`    | string | Yes      | UUID received in the dispatch payload                         |
| `extend_seconds` | number | No       | Seconds to extend the lease (default: `ENDUROQ_LEASE_IN_SEC`) |

**Response `200 OK`:**

```json
{ "lease_expires_at": "2026-06-14T10:05:00.000Z" }
```

**Response `409 Conflict`** — lease has already expired; the worker should abort:

```json
{ "error": "lease already expired" }
```

---

### Report Result

Workers call this when the job is complete or has permanently failed.

```
POST /jobs/:id/result
Content-Type: application/json
```

**Request body:**

| Field         | Type                       | Required | Description                                                |
| ------------- | -------------------------- | -------- | ---------------------------------------------------------- |
| `lease_token` | string                     | Yes      | UUID received in the dispatch payload                      |
| `status`      | `"success"` \| `"failure"` | Yes      | Outcome of the job                                         |
| `output`      | any                        | No       | Arbitrary JSON result (only for `success`)                 |
| `retryable`   | boolean                    | No       | Whether the failure should be retried (only for `failure`) |
| `error`       | string                     | No       | Human-readable error message (only for `failure`)          |

**Response `200 OK`:**

```json
{ "ok": true }
```

**Response `409 Conflict`** — lease expired before the result was submitted:

```json
{ "error": "lease already expired" }
```

---

## Job States

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                  │
  │         enqueue                 dispatch (2xx)                  │
  │  ──────► queued ──► dispatching ──────────────► running         │
  │            ▲             │                         │            │
  │            │             │ 503 / reaper            │ result     │
  │            │             ▼                         ▼            │
  │            └──── (requeue w/ backoff)        succeeded          │
  │                          │                         │            │
  │                          │ 4xx / retries exhausted │            │
  │                          └─────────────────────────► failed     │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

| Status        | Description                                                                       |
| ------------- | --------------------------------------------------------------------------------- |
| `queued`      | Waiting to be dispatched                                                          |
| `dispatching` | Dispatcher has grabbed the job; waiting for worker acknowledgment                 |
| `running`     | Worker acknowledged and is processing                                             |
| `succeeded`   | Worker reported success                                                           |
| `failed`      | Permanently failed (retries exhausted, non-retryable error, or `4xx` from worker) |

---

## Worker SDK (TypeScript)

Install:

```bash
pnpm add @enduroq/enduroq-worker
```

### `DispatchPayload<T>`

The JSON body sent to your worker endpoint by the dispatcher:

```typescript
interface DispatchPayload<T = unknown> {
  callback: string; // Base URL for heartbeat / result calls
  lease_token: string; // UUID identifying this lease
  lease_expires_at: string; // ISO 8601
  data: T; // Your custom payload
}
```

The dispatcher also sets the `X-Enduroq-Job-Id` request header (exported as `JOB_ID_HEADER`).

### `Worker` and `CallbackClient`

```typescript
import {
  CallbackClient,
  Worker,
  JOB_ID_HEADER,
  DispatchPayload,
} from "@enduroq/enduroq-worker";

const client = new CallbackClient(fetch);
const worker = new Worker(client);

// Inside your HTTP handler:
export async function POST(req: Request) {
  const jobId = Number(req.headers.get(JOB_ID_HEADER));
  const payload = (await req.json()) as DispatchPayload<{ message: string }>;

  // Acknowledge immediately, then process in the background.
  processInBackground(jobId, payload);

  return Response.json({ ok: true }, { status: 200 });
}

async function processInBackground(
  jobId: number,
  payload: DispatchPayload<{ message: string }>,
) {
  const ac = new AbortController();

  // acquire() starts a heartbeat loop.
  // If the lease is revoked server-side, ac.signal is aborted.
  const job = await worker.acquire(jobId, payload, ac, {
    heartbeatIntervalMs: 5_000, // call heartbeat every 5 s
    leaseExtendSeconds: 30, // extend by 30 s on each heartbeat
  });

  try {
    // Long-running work here. Check ac.signal.aborted if needed.
    await doWork(payload.data.message);

    await client.result(payload.callback, jobId, {
      lease_token: payload.lease_token,
      status: "success",
      output: { done: true },
    });
  } catch (err) {
    await client.result(payload.callback, jobId, {
      lease_token: payload.lease_token,
      status: "failure",
      retryable: true,
      error: String(err),
    });
  } finally {
    job.stop(); // stop the heartbeat loop
  }
}
```

### `AcquireJobOptions`

| Option                | Type   | Default        | Description                                                    |
| --------------------- | ------ | -------------- | -------------------------------------------------------------- |
| `heartbeatIntervalMs` | number | `20000`        | Heartbeat interval in milliseconds                             |
| `leaseExtendSeconds`  | number | server default | Seconds to extend the lease per heartbeat                      |
| `resultRetries`       | number | `1`            | Retry attempts for the result POST on transient network errors |

---

## Retry & Backoff

Enduroq uses **truncated exponential backoff with jitter** for both automatic retries and nack delays:

```
delay = min(BACKOFF_CAP, BACKOFF_BASE × 2^attempt) + random(0, BACKOFF_JITTER)
```

Example with defaults (`base=2`, `cap=300`, `jitter=5`):

| Attempt | Min delay | Max delay |
| ------- | --------- | --------- |
| 0       | 2 s       | 7 s       |
| 1       | 4 s       | 9 s       |
| 2       | 8 s       | 13 s      |
| 3       | 16 s      | 21 s      |
| 4       | 32 s      | 37 s      |
| 7+      | 300 s     | 305 s     |

The jitter prevents multiple failed jobs from hammering the worker simultaneously after a restart.

---

## License

MIT by [@6jz](https://twitter.com/6jz).
