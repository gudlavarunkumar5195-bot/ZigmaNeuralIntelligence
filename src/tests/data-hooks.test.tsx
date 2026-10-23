// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useApiQuery } from "../lib/useApiQuery";
import { useBusy } from "../lib/useBusy";
import * as apiModule from "../services/api";
import { ApiCallError } from "../services/api";
import type { ApiResponse } from "../types";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useApiQuery", () => {
  function Probe({ id, fetcher }: { id: string; fetcher: (id: string) => Promise<ApiResponse<string>> }) {
    const q = useApiQuery(() => fetcher(id), [id]);
    return <div data-testid="out">{q.loading ? "loading" : q.error ? `error:${q.error.message}` : `data:${q.data}`}</div>;
  }

  it("drops a slow response for previous inputs (no stale overwrite)", async () => {
    const calls: Record<string, ReturnType<typeof deferred<ApiResponse<string>>>> = { a: deferred(), b: deferred() };
    const fetcher = (id: string) => calls[id].promise;
    const { rerender } = render(<Probe id="a" fetcher={fetcher} />);
    rerender(<Probe id="b" fetcher={fetcher} />);
    await act(async () => calls.b.resolve({ data: "B", error: null }));
    await act(async () => calls.a.resolve({ data: "A", error: null }));
    expect(screen.getByTestId("out").textContent).toBe("data:B");
  });

  it("reports a failed request as an error, never as empty data", async () => {
    render(<Probe id="a" fetcher={async () => ({ data: null, error: { code: "INTERNAL_ERROR", message: "boom", status: 500 } })} />);
    expect((await screen.findByText(/error:boom/)).textContent).toBe("error:boom");
  });

  it("turns a thrown network failure into an error", async () => {
    render(<Probe id="a" fetcher={async () => { throw new ApiCallError(0, "NETWORK_ERROR", "offline"); }} />);
    expect(await screen.findByText("error:offline")).toBeTruthy();
  });

  it("clears data from the previous inputs while the new ones load", async () => {
    const b = deferred<ApiResponse<string>>();
    const fetcher = (id: string) => (id === "a" ? Promise.resolve({ data: "A", error: null }) : b.promise);
    const { rerender } = render(<Probe id="a" fetcher={fetcher} />);
    await screen.findByText("data:A");
    rerender(<Probe id="b" fetcher={fetcher} />);
    expect(screen.getByTestId("out").textContent).toBe("loading");
  });
});

describe("useBusy", () => {
  it("ignores a second call while the first is still running", async () => {
    const run = vi.fn();
    const gate = deferred<void>();
    function Btn() {
      const { busy, guard } = useBusy();
      const [n] = useState(0);
      const go = guard(async () => { run(n); await gate.promise; });
      return <button disabled={busy} onClick={() => { void go(); void go(); }}>go</button>;
    }
    render(<Btn />);
    await act(async () => screen.getByRole("button").click());
    expect(run).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => gate.resolve());
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("useApiQuery cancellation", () => {
  it("aborts the signal of superseded inputs (the client cancels the request with it)", async () => {
    const signals: AbortSignal[] = [];
    const spy = vi.spyOn(apiModule, "withSignal").mockImplementation((signal, start) => { signals.push(signal); return start(); });
    const never = () => new Promise<ApiResponse<string>>(() => {});
    function P({ id }: { id: string }) {
      const q = useApiQuery(never, [id]);
      return <span>{q.loading ? "loading" : "done"}</span>;
    }
    const { rerender, unmount } = render(<P id="a" />);
    rerender(<P id="b" />);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    unmount();
    expect(signals[1].aborted).toBe(true); // leaving the page cancels too
    spy.mockRestore();
  });
});
