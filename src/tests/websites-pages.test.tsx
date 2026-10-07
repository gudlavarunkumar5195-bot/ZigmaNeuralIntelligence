// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    apiGetDashboard: vi.fn(),
    apiListWebsites: vi.fn(),
    apiCreateScan: vi.fn(),
    apiVerifyOwnership: vi.fn(),
    apiQaVerifyWebsite: vi.fn(),
  };
});

import * as api from "../services/api";
import { MyWebsites } from "../pages/websites/MyWebsites";
import { Overview } from "../pages/Overview";

const site = (over: Record<string, unknown> = {}) => ({
  id: "s1", url: "https://one.example", domain: "one.example", verified: true, created_at: "2030-01-01",
  latest_scan_id: "scan-old", latest_scan_status: "completed", started_at: null, completed_at: "2030-01-01T00:00:00Z",
  overall_score: 80, finding_count: 2, critical_count: 0, ...over,
});
const dashboard = (websites: ReturnType<typeof site>[]) => ({
  data: { websites, selectedWebsite: websites[0] ?? null, scores: [{ category: "accessibility", score: 55, status: "scored", finding_count: 1, critical_count: 0 }], findings: [], history: [], executions: [] },
  error: null,
});

function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }
const renderAt = (node: React.ReactNode) => render(
  <MemoryRouter initialEntries={["/start"]}>
    <Routes><Route path="/start" element={node} /><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.apiListWebsites).mockResolvedValue({ data: [], error: null });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("MyWebsites", () => {
  it("rescans a site that already has a scan and keeps a separate latest-scan link", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site()]) as never);
    vi.mocked(api.apiCreateScan).mockResolvedValue({ data: { id: "scan-new" }, error: null });
    renderAt(<MyWebsites />);
    await userEvent.click(await screen.findByRole("button", { name: /New scan/ }));
    await waitFor(() => expect(api.apiCreateScan).toHaveBeenCalledWith("s1", ["seo", "security", "performance", "ssl"]));
    expect((await screen.findByTestId("where")).textContent).toBe("/websites/scan/scan-new");
  });

  it("opens the latest scan without creating one", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site()]) as never);
    renderAt(<MyWebsites />);
    await userEvent.click(await screen.findByRole("button", { name: "Open latest scan" }));
    expect((await screen.findByTestId("where")).textContent).toBe("/websites/scan/scan-old");
    expect(api.apiCreateScan).not.toHaveBeenCalled();
  });

  it("disables scanning for unverified sites, shows the token and verifies ownership", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site({ verified: false, latest_scan_id: null, latest_scan_status: null })]) as never);
    vi.mocked(api.apiListWebsites).mockResolvedValue({
      data: [{ id: "s1", url: "https://one.example", domain: "one.example", verified: false, verification_method: "dns", verification_token: "tok123" }],
      error: null,
    });
    vi.mocked(api.apiVerifyOwnership).mockResolvedValue({ data: { verified: true }, error: null });
    renderAt(<MyWebsites />);
    expect(((await screen.findByRole("button", { name: /Start scan/ })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/disabled until ownership/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "QA verify" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Verify ownership/ }));
    expect(screen.getByText("tok123")).toBeTruthy();
    expect(screen.getByText(/_zignaneural-verify\.one\.example/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check ownership" }));
    await waitFor(() => expect(api.apiVerifyOwnership).toHaveBeenCalledWith("s1"));
  });

  it("is honest when the token is unavailable and shows verification errors", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site({ verified: false })]) as never);
    vi.mocked(api.apiVerifyOwnership).mockResolvedValue({ data: null, error: { code: "VERIFICATION_FAILED", message: "Ownership verification token was not found" } });
    renderAt(<MyWebsites />);
    await userEvent.click(await screen.findByRole("button", { name: /Verify ownership/ }));
    expect(screen.getByText(/token could not be retrieved/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check ownership" }));
    expect((await screen.findByRole("alert")).textContent).toContain("token was not found");
  });
});

describe("Overview", () => {
  it("New scan always creates a scan even when one exists", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site()]) as never);
    vi.mocked(api.apiCreateScan).mockResolvedValue({ data: { id: "scan-new" }, error: null });
    renderAt(<Overview />);
    await userEvent.click(await screen.findByRole("button", { name: /New scan/ }));
    await waitFor(() => expect(api.apiCreateScan).toHaveBeenCalledWith("s1", expect.any(Array)));
    expect((await screen.findByTestId("where")).textContent).toBe("/websites/scan/scan-new");
  });

  it("disables New scan for unverified sites and never fabricates an accessibility score", async () => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dashboard([site({ verified: false })]) as never);
    renderAt(<Overview />);
    const button = (await screen.findByRole("button", { name: /New scan/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Not measured")).toBeTruthy();
    expect(screen.queryByText("55")).toBeNull();
  });
});
