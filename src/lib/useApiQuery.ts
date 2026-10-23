import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { ApiCallError, IntegrationRequired, isAbortedRequest, withSignal } from "../services/api";
import type { ApiError, ApiResponse } from "../types";

export interface ApiQuery<T> {
  /** The latest successful result; null while loading for new inputs or after a failure. */
  data: T | null;
  /** A failed request, kept separate from "no data" so pages never show an error as an empty list. */
  error: ApiError | null;
  loading: boolean;
  /** Re-run with the same inputs (keeps the current data visible while refreshing). */
  reload: () => void;
}

/** Normalizes a thrown failure (network, timeout, integration) into the ApiError shape. */
export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiCallError) return { code: cause.code, message: cause.message, status: cause.status || undefined };
  if (cause instanceof IntegrationRequired) return { code: "INTEGRATION_REQUIRED", message: cause.message };
  return { code: "UNKNOWN", message: cause instanceof Error ? cause.message : "Request failed" };
}

/**
 * Runs an API read whenever `deps` change. Requests for older inputs are
 * aborted on the network and their responses dropped (a slow request for the
 * previous project can never overwrite the current one), data from previous inputs is cleared rather than shown under
 * new filters, and failures surface as `error` instead of an empty result.
 */
export function useApiQuery<T>(run: () => Promise<ApiResponse<T>>, deps: DependencyList, options: { enabled?: boolean } = {}): ApiQuery<T> {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: enabled });
  const [tick, setTick] = useState(0);
  const lastTick = useRef(tick);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    const controller = new AbortController();
    const isReload = lastTick.current !== tick;
    lastTick.current = tick;
    setState((s) => ({ data: isReload ? s.data : null, error: null, loading: true }));
    withSignal(controller.signal, () => runRef.current()).then(
      (r) => {
        if (!live) return;
        setState(r.error ? { data: null, error: r.error, loading: false } : { data: r.data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (!live || isAbortedRequest(cause)) return;
        setState({ data: null, error: toApiError(cause), loading: false });
      },
    );
    return () => {
      live = false;
      controller.abort(); // the inputs changed or the page closed: cancel the request itself
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass the inputs that define the query
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
