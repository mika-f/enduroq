"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Trigger an immediate out-of-band refresh. */
  refresh: () => void;
}

/**
 * Polls `fetcher` every `intervalMs` milliseconds.
 *
 * - Passing `intervalMs <= 0` disables polling (a single fetch still runs).
 * - Overlapping requests are prevented; if a tick fires while a request is
 *   still in flight it is skipped.
 * - Polling pauses while the browser tab is hidden to avoid wasted requests.
 */
export const usePolling = <T>(fetcher: () => Promise<T>, intervalMs: number): PollingState<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the latest fetcher in a ref so changing it (e.g. when filters change)
  // does not tear down the interval.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void run();

    if (intervalMs <= 0) return;

    const tick = () => {
      if (document.visibilityState === "visible") void run();
    };
    const handle = setInterval(tick, intervalMs);
    return () => clearInterval(handle);
  }, [run, intervalMs]);

  return { data, error, loading, refresh: run };
};
