// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    apiGetMe: vi.fn(),
    apiListWebsites: vi.fn(),
    apiListAlerts: vi.fn(),
    apiGetDashboard: vi.fn(),
    apiGetFindings: vi.fn(),
  };
});

import * as api from "../services/api";
import { Shell } from "../components/layout/Shell";
import { ScanModuleFindings } from "../components/ui/ScanModuleFindings";
import { AccessibilityPage } from "../pages/intelligence/AccessibilityPage";
import { SSLPage } from "../pages/infrastructure/SSLPage";
import { getSelectedWebsiteId } from "../lib/selectedWebsite";

const sites = [
  { id: "a", url: "https://a.example", domain: "a.example", verified: true },
  { id: "b", url: "https://b.example", domain: "b.example", verified: true },
];
const alert = (id: string, status: string) => ({ id, severity: "high", title: id, status, detected_at: "2030-01-01", monitoring_id: "m" });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("__APP_VERSION__", "test");
  vi.mocked(api.apiGetMe).mockResolvedValue({ data: { id: "u", email: "me@example.org", orgIds: [] }, error: null });
  vi.mocked(api.apiListWebsites).mockResolvedValue({ data: sites, error: null, meta: { page: 1, pageSize: 100 } });
  vi.mocked(api.apiListAlerts).mockResolvedValue({ data: [], error: null, meta: { page: 1, pageSize: 100 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const renderShell = (path = "/") => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/" element={<Shell />}><Route index element={<div>home</div>} /><Route path="monitoring/alerts" element={<div>alerts-page</div>} /></Route></Routes>
  </MemoryRouter>,
);

describe("Shell", () => {
  it("shows no fake marketing pill, the real user email and no alert dot when there are no open alerts", async () => {
    renderShell();
    expect(await screen.findByText("me@example.org")).toBeTruthy();
    expect(screen.queryByText(/live platform/i)).toBeNull();
    expect(screen.queryByText(/Authenticated workspace/)).toBeNull();
    await waitFor(() => expect(api.apiListAlerts).toHaveBeenCalledWith({ pageSize: 100 }));
    expect(screen.queryByTestId("open-alert-count")).toBeNull();
  });

  it("shows the real open-alert count and links the bell to /monitoring/alerts", async () => {
    vi.mocked(api.apiListAlerts).mockResolvedValue({ data: [alert("1", "OPEN"), alert("2", "OPEN"), alert("3", "RESOLVED")], error: null, meta: { page: 1, pageSize: 100 } });
    renderShell();
    expect((await screen.findByTestId("open-alert-count")).textContent).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "Alerts: 2 open" }));
    expect(await screen.findByText("alerts-page")).toBeTruthy();
  });

  it("shows no dot when alerts are unavailable", async () => {
    vi.mocked(api.apiListAlerts).mockResolvedValue({ data: null, error: { code: "500", message: "x" } });
    renderShell();
    await waitFor(() => expect(api.apiListAlerts).toHaveBeenCalled());
    expect(screen.queryByTestId("open-alert-count")).toBeNull();
  });

  it("requests a full page of websites and flags truncation", async () => {
    vi.mocked(api.apiListWebsites).mockResolvedValue({ data: Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, url: "", domain: `d${i}.example`, verified: true })), error: null, meta: { page: 1, pageSize: 100 } });
    renderShell();
    expect(await screen.findByTestId("website-truncation")).toBeTruthy();
    expect(api.apiListWebsites).toHaveBeenCalledWith({ pageSize: 100 });
  });

  it("initialises the selector from the stored selection and shares changes", async () => {
    sessionStorage.setItem("zn_selected_website", "b");
    renderShell();
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("b"));
    await userEvent.selectOptions(select, "a");
    expect(getSelectedWebsiteId()).toBe("a");
  });

  it("a ?websiteId= deep link becomes the shared selection", async () => {
    renderShell("/?websiteId=b");
    await waitFor(() => expect(getSelectedWebsiteId()).toBe("b"));
  });

  it("drops a stale stored selection in favour of the newest site", async () => {
    sessionStorage.setItem("zn_selected_website", "gone");
    renderShell();
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("a"));
  });
});

describe("selection is used by module pages", () => {
  const dash = (id: string) => ({ data: { websites: [], selectedWebsite: { id, domain: `${id}.example`, latest_scan_id: `scan-${id}` }, scores: [], findings: [], history: [], executions: [] }, error: null });

  it("ScanModuleFindings asks the dashboard for the selected website", async () => {
    sessionStorage.setItem("zn_selected_website", "b");
    vi.mocked(api.apiGetDashboard).mockResolvedValue(dash("b") as never);
    vi.mocked(api.apiGetFindings).mockResolvedValue({ data: [{ id: "f", title: "Cert expiring", severity: "high", module_name: "ssl" }, { id: "g", title: "other", severity: "low", module_name: "seo" }], error: null });
    render(<SSLPage />);
    expect(await screen.findByText("Cert expiring")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
    expect(api.apiGetDashboard).toHaveBeenCalledWith("b");
    expect(api.apiGetFindings).toHaveBeenCalledWith("scan-b");
  });

  it("ScanModuleFindings is exported and usable directly", () => {
    expect(typeof ScanModuleFindings).toBe("function");
  });

  it("Accessibility is an honest unavailable state, not 'no findings recorded'", () => {
    render(<MemoryRouter><AccessibilityPage /></MemoryRouter>);
    expect(screen.getByText("Not available yet")).toBeTruthy();
    expect(screen.queryByText(/No findings/)).toBeNull();
    expect(api.apiGetDashboard).not.toHaveBeenCalled();
  });
});
