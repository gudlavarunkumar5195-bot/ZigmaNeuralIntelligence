// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return { ...actual, apiGetScan: vi.fn(), apiCancelScan: vi.fn() };
});

import * as api from "../services/api";
import { ScanProgress } from "../pages/websites/ScanProgress";

const scan = (status: string, extra: Record<string, unknown> = {}) => ({
  data: { id: "s1", status, started_at: null, completed_at: null, error: null, modules: ["seo", "ssl"], scores: [], ...extra },
  error: null,
});
const renderPage = () => render(
  <MemoryRouter initialEntries={["/websites/scan/s1"]}><Routes><Route path="/websites/scan/:id" element={<ScanProgress />} /></Routes></MemoryRouter>,
);
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("ScanProgress", () => {
  it("stops polling after a 404 and offers Retry", async () => {
    vi.mocked(api.apiGetScan).mockResolvedValue({ data: null, error: { code: "NOT_FOUND", message: "Scan not found" } });
    renderPage();
    await flush();
    expect(screen.getByText("Scan not found")).toBeTruthy();
    await flush(20_000);
    expect(api.apiGetScan).toHaveBeenCalledTimes(1);
    vi.mocked(api.apiGetScan).mockResolvedValue(scan("completed") as never);
    await act(async () => { screen.getByRole("button", { name: /Retry/ }).click(); });
    await flush();
    expect(screen.getByText("Scan completed")).toBeTruthy();
  });

  it("backs off on transient 5xx errors instead of polling every 2s", async () => {
    vi.mocked(api.apiGetScan).mockResolvedValue({ data: null, error: { code: "503", message: "down" } });
    renderPage();
    await flush();
    await flush(2_000); // not yet: first backoff is 4s
    expect(api.apiGetScan).toHaveBeenCalledTimes(1);
    await flush(2_100);
    expect(api.apiGetScan).toHaveBeenCalledTimes(2);
  });

  it("polls while running, shows Cancel and surfaces cancel errors", async () => {
    vi.mocked(api.apiGetScan).mockResolvedValue(scan("running") as never);
    vi.mocked(api.apiCancelScan).mockResolvedValue({ data: null, error: { code: "CONFLICT", message: "Scan is completed and cannot be cancelled" } });
    renderPage();
    await flush();
    await flush(2_000);
    expect(vi.mocked(api.apiGetScan).mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => { screen.getByRole("button", { name: "Cancel scan" }).click(); });
    await flush();
    expect(api.apiCancelScan).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("alert").textContent).toContain("cannot be cancelled");
  });

  it("completed scans link to findings pages and reports, with no Cancel", async () => {
    vi.mocked(api.apiGetScan).mockResolvedValue(scan("completed") as never);
    renderPage();
    await flush();
    expect(screen.queryByRole("button", { name: "Cancel scan" })).toBeNull();
    expect(screen.getByRole("link", { name: "SEO findings" }).getAttribute("href")).toBe("/intelligence/seo");
    expect(screen.getByRole("link", { name: "SSL findings" }).getAttribute("href")).toBe("/infrastructure/ssl");
    expect(screen.queryByRole("link", { name: "Security findings" })).toBeNull();
    expect(screen.getByRole("link", { name: "View report" }).getAttribute("href")).toBe("/reports");
    await flush(10_000);
    expect(api.apiGetScan).toHaveBeenCalledTimes(1);
  });

  it("failed scans show the error", async () => {
    vi.mocked(api.apiGetScan).mockResolvedValue(scan("failed", { error: "Target unreachable" }) as never);
    renderPage();
    await flush();
    expect(screen.getByText("Target unreachable")).toBeTruthy();
  });
});
