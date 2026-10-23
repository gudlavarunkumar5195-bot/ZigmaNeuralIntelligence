import { useCallback, useRef, useState } from "react";

/**
 * One mutation at a time for a component: `guard(fn)` ignores calls while a
 * previous one is still running (a ref, so even a fast double click is caught
 * before the re-render), and `busy` disables the controls meanwhile.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const guard = useCallback(<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => async (...args: A) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn(...args);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, guard };
}
