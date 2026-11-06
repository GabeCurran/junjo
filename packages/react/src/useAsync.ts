import type { Junjo } from "@junjo.io/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

// Shared fetch + refetch core for hooks over user-scoped reads. These
// have no per-group SSE channel (their events flow through webhooks
// only), so consumers refetch on mutation completion or on an
// operator-triggered refresh.

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useAsync<T>(junjo: Junjo, loader: () => Promise<T>, depKey: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Latest loader is captured by ref so refetch sees it without
  // listing it in deps (which would create a new identity each render
  // on caller-supplied lambdas).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // One generation counter guards BOTH mount loads and manual
  // refetches: only the newest in-flight load may commit state, so two
  // overlapping refetches cannot resolve out of order and clobber the
  // fresher result, and a load resolving after unmount (or after a
  // dep change) commits nothing because the cleanup bumped the
  // generation past it.
  const generationRef = useRef(0);

  const runLoad = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (generation !== generationRef.current) return;
      setData(result);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  // The client is a dep so a JunjoProvider client swap refetches
  // against the new client instead of serving the old client's data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loader reads via ref; junjo + depKey are the canonical signals that a reload is needed
  useEffect(() => {
    void runLoad();
    return () => {
      // Invalidates whatever is in flight (mount load or refetch) on
      // unmount and on dep change.
      generationRef.current++;
    };
  }, [junjo, depKey, runLoad]);

  return { data, loading, error, refetch: runLoad };
}
