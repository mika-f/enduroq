# @enduroq/admin-console

A lightweight web admin console for [Enduroq](../../README.md). It lists jobs
and lets you inspect a single job's status, result, and errors, with live
polling so the view stays up to date while jobs move through the queue.

Built with Next.js (App Router) + React + Tailwind CSS, matching the stack used
by `@enduroq/ts-worker-example`.

![](https://images.natsuneko.com/83d2a4d067b8b1e522a443179036bb3c84d3cd3f6c3addeec19411f15ec41d52.png)

## Features

- **Job list** — filter by queue and status, paginated (newest first).
- **Job detail** — full metadata, JSON result, and last error.
- **Live polling** — auto-refresh every 2/5/10s (or off), pausing while the
  tab is hidden. Manual "Refresh now" is always available.
- **Cancel** — cancel a job that is still `queued`, `dispatching`, or
  `running`.

## How it talks to Enduroq

The browser never calls the queue server directly. Next.js API routes under
`/api/jobs` proxy to the Enduroq HTTP API, which keeps the bearer token on the
server and avoids CORS issues.

```
Browser ──/api/jobs──► Next.js route ──Bearer──► Enduroq server (GET/DELETE /jobs)
```

## Configuration

| Variable             | Default                 | Description                                                    |
| -------------------- | ----------------------- | -------------------------------------------------------------- |
| `ENDUROQ_SERVER_URL` | `http://127.0.0.1:7225` | Base URL of the Enduroq queue server.                          |
| `ENDUROQ_AUTH_TOKEN` | _(unset)_               | Bearer token; required only if the queue server enforces auth. |

Copy `.env.example` to `.env.local` and adjust as needed.

## Development

```sh
pnpm install
pnpm --filter @enduroq/admin-console serve   # dev server on http://localhost:9000
```

## Production

```sh
pnpm --filter @enduroq/admin-console build
pnpm --filter @enduroq/admin-console start    # serves on http://localhost:9000
```

## Docker

A multi-stage `Dockerfile` builds a minimal image from Next.js' standalone
output. Build from the **repository root** (the build context is the monorepo):

```sh
docker build -f packages/admin-console/Dockerfile -t enduroq-admin-console .
docker run --rm -p 9000:9000 \
  -e ENDUROQ_SERVER_URL=http://host.docker.internal:7225 \
  enduroq-admin-console
```

Or bring up the whole stack (MySQL + queue + worker + admin console) with
Compose; the console is published on <http://localhost:9000>:

```sh
docker compose up --build
```
