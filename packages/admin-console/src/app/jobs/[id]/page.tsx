"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";

import { RefreshControl } from "@/components/RefreshControl";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, relativeTime } from "@/lib/format";
import { isActive, type Job } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-neutral-400">—</span>;
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [intervalMs, setIntervalMs] = useState(5000);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const fetcher = useCallback(async (): Promise<Job> => {
    const res = await fetch(`/api/jobs/${id}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body?.error ?? `request failed (${res.status})`);
    }
    return body as Job;
  }, [id]);

  const { data: job, error, loading, refresh } = usePolling(fetcher, intervalMs);

  const onCancel = async () => {
    if (!confirm(`Cancel job #${id}?`)) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error ?? `request failed (${res.status})`);
      }
      refresh();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            ← Jobs
          </Link>
          <h1 className="text-xl font-semibold">Job #{id}</h1>
          {job ? <StatusBadge status={job.status} /> : null}
        </div>
        <RefreshControl
          intervalMs={intervalMs}
          onChange={setIntervalMs}
          loading={loading}
          onRefresh={refresh}
        />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {job ? (
        <>
          <div className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
              <Field label="Queue">{job.name}</Field>
              <Field label="Attempt">
                <span className="tabular-nums">
                  {job.attempt} / {job.max_retries}
                </span>
              </Field>
              <Field label="Run after">
                <span title={formatDate(job.run_after)}>
                  {relativeTime(job.run_after)} · {formatDate(job.run_after)}
                </span>
              </Field>
              <Field label="Created">{formatDate(job.created_at)}</Field>
              <Field label="Updated">{formatDate(job.updated_at)}</Field>
              <Field label="Worker URL">
                <span className="break-all">{job.url}</span>
              </Field>
            </dl>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="mb-2 text-sm font-semibold">Result</h2>
            <JsonBlock value={job.result} />
          </div>

          {job.last_error ? (
            <div className="rounded-lg border border-red-200 bg-white p-5 dark:border-red-900/50 dark:bg-neutral-900">
              <h2 className="mb-2 text-sm font-semibold text-red-700 dark:text-red-300">
                Last error
              </h2>
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">
                {job.last_error}
              </pre>
            </div>
          ) : null}

          {isActive(job.status) ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onCancel}
                disabled={cancelling}
                className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                {cancelling ? "Cancelling…" : "Cancel job"}
              </button>
              {cancelError ? (
                <span className="text-sm text-red-600 dark:text-red-400">{cancelError}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : !error && loading ? (
        <div className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</div>
      ) : null}
    </div>
  );
}
