"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { RefreshControl } from "@/components/RefreshControl";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, relativeTime } from "@/lib/format";
import { JOB_STATUSES, type JobListResponse, type JobStatus } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

const PAGE_SIZE = 25;

export default function JobsPage() {
  const [queue, setQueue] = useState("");
  const [status, setStatus] = useState<JobStatus | "">("");
  const [page, setPage] = useState(0);
  const [intervalMs, setIntervalMs] = useState(5000);

  const fetcher = useCallback(async (): Promise<JobListResponse> => {
    const search = new URLSearchParams();
    if (queue) search.set("queue", queue);
    if (status) search.set("status", status);
    search.set("limit", String(PAGE_SIZE));
    search.set("offset", String(page * PAGE_SIZE));

    const res = await fetch(`/api/jobs?${search.toString()}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body?.error ?? `request failed (${res.status})`);
    }
    return body as JobListResponse;
  }, [queue, status, page]);

  const { data, error, loading, refresh } = usePolling(fetcher, intervalMs);

  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1),
    [data],
  );

  // Filters reset pagination back to the first page.
  const onQueueChange = (v: string) => {
    setQueue(v);
    setPage(0);
  };
  const onStatusChange = (v: JobStatus | "") => {
    setStatus(v);
    setPage(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <RefreshControl
          intervalMs={intervalMs}
          onChange={setIntervalMs}
          loading={loading}
          onRefresh={refresh}
        />
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500 dark:text-neutral-400">Queue</span>
          <input
            type="text"
            value={queue}
            placeholder="all queues"
            onChange={(e) => onQueueChange(e.target.value.trim())}
            className="w-48 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500 dark:text-neutral-400">Status</span>
          <select
            value={status}
            onChange={(e) => onStatusChange(e.target.value as JobStatus | "")}
            className="w-48 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">all statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {data ? (
          <span className="ml-auto text-sm text-neutral-500 dark:text-neutral-400">
            {data.total} job{data.total === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">ID</th>
              <th className="px-4 py-2 font-medium">Queue</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Attempt</th>
              <th className="px-4 py-2 font-medium">Updated</th>
              <th className="px-4 py-2 font-medium">URL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-950">
            {data && data.jobs.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-neutral-500 dark:text-neutral-400"
                >
                  {loading ? "Loading…" : "No jobs found."}
                </td>
              </tr>
            ) : null}
            {data?.jobs.map((job) => (
              <tr key={job.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <td className="px-4 py-2">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    #{job.id}
                  </Link>
                </td>
                <td className="px-4 py-2">{job.name}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={job.status} />
                </td>
                <td className="px-4 py-2 tabular-nums text-neutral-600 dark:text-neutral-400">
                  {job.attempt}/{job.max_retries}
                </td>
                <td
                  className="px-4 py-2 text-neutral-600 dark:text-neutral-400"
                  title={formatDate(job.updated_at)}
                >
                  {relativeTime(job.updated_at)}
                </td>
                <td className="max-w-xs truncate px-4 py-2 text-neutral-500 dark:text-neutral-400">
                  {job.url}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-500 dark:text-neutral-400">
          Page {page + 1} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={page + 1 >= totalPages}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
