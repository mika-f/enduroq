// Mirrors the job model exposed by the Enduroq queue server
// (see packages/ts-server/src/repositories/job.ts).

export const JOB_STATUSES = [
  "queued",
  "dispatching",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: number;
  name: string;
  url: string;
  status: JobStatus;
  attempt: number;
  max_retries: number;
  run_after: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  result: unknown;
}

export interface JobListResponse {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

// Statuses that may still transition (i.e. the job is cancellable and worth
// polling more aggressively).
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "dispatching", "running"];

export const isActive = (status: JobStatus): boolean => ACTIVE_STATUSES.includes(status);
