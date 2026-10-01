import { useCallback, useEffect, useRef, useState } from "react";

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refetch: () => Promise<void>;
}

/**
 * Tiny polling query. `key === null` disables it. Data is reset when the key
 * changes; background refreshes keep stale data visible and don't flash.
 */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { interval?: number } = {}): QueryState<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: unknown; loading: boolean }>({ key, loading: key !== null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(async () => {
    const k = keyRef.current;
    if (k === null) return;
    try {
      const data = await fnRef.current();
      if (keyRef.current === k) setState({ key: k, data, error: undefined, loading: false });
    } catch (error) {
      if (keyRef.current === k) setState((s) => ({ key: k, data: s.key === k ? s.data : undefined, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    setState({ key, loading: key !== null });
    if (key === null) return;
    void run();
    if (!opts.interval) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, opts.interval);
    return () => clearInterval(t);
  }, [key, opts.interval, run]);

  const same = state.key === key;
  return {
    data: same ? state.data : undefined,
    error: same ? state.error : undefined,
    loading: same ? state.loading : key !== null,
    refetch: run,
  };
}

/** Persist a small value in localStorage (best effort; falls back to memory). */
export function useStoredState<T>(storageKey: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(storageKey, JSON.stringify(nv));
      } catch {
        /* storage unavailable */
      }
    },
    [storageKey],
  );
  return [v, set];
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
