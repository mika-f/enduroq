// Server-side client for the Enduroq queue server.
//
// The admin console never talks to the queue server directly from the browser:
// the bearer token must stay on the server, and proxying also sidesteps CORS.
// These helpers run inside the Next.js API routes (see src/app/api/**).

import "server-only";

import type { Job, JobListResponse, JobStatus } from "./types";

const SERVER_URL = (process.env.ENDUROQ_SERVER_URL ?? "http://127.0.0.1:7225").replace(/\/+$/, "");

const AUTH_TOKEN = process.env.ENDUROQ_AUTH_TOKEN || undefined;

const authHeaders = (): Record<string, string> =>
  AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

export interface UpstreamResult<T> {
  status: number;
  body: T | { error: string };
}

export interface ListJobsParams {
  queue?: string | undefined;
  status?: JobStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const request = async <T>(path: string, init?: RequestInit): Promise<UpstreamResult<T>> => {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...init?.headers },
      cache: "no-store",
    });
  } catch (e) {
    return {
      status: 502,
      body: {
        error: `failed to reach enduroq server at ${SERVER_URL}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
    };
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
};

export const listJobs = (params: ListJobsParams): Promise<UpstreamResult<JobListResponse>> => {
  const search = new URLSearchParams();
  if (params.queue) search.set("queue", params.queue);
  if (params.status) search.set("status", params.status);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));

  const qs = search.toString();
  return request<JobListResponse>(`/jobs${qs ? `?${qs}` : ""}`);
};

export const getJob = (id: number): Promise<UpstreamResult<Job>> => request<Job>(`/jobs/${id}`);

export const cancelJob = (id: number): Promise<UpstreamResult<{ ok: true }>> =>
  request<{ ok: true }>(`/jobs/${id}`, { method: "DELETE" });
