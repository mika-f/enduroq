"use client";

export const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
] as const;

interface Props {
  intervalMs: number;
  onChange: (intervalMs: number) => void;
  loading: boolean;
  onRefresh: () => void;
}

export function RefreshControl({ intervalMs, onChange, loading, onRefresh }: Props) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        aria-hidden
        className={`size-2 rounded-full ${
          loading ? "animate-pulse bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
        }`}
      />
      <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
        Auto-refresh
        <select
          value={intervalMs}
          onChange={(e) => onChange(Number(e.target.value))}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        Refresh now
      </button>
    </div>
  );
}
