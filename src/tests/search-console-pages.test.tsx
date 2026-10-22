// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiListIntegrations: vi.fn(),
    apiListWebsites: vi.fn(),
    apiStartGoogleConnect: vi.fn(),
    apiListGscProperties: vi.fn(),
    apiLinkSearchConsole: vi.fn(),
    apiDisconnectIntegration: vi.fn(),
    apiGetDashboard: vi.fn(),
    apiGetSearchConsoleStatus: vi.fn(),
    apiGetSearchPerformance: vi.fn(),
    apiGetSearchTop: vi.fn(),
    apiStartSearchConsoleSync: vi.fn(),
    apiCancelSearchConsoleSync: vi.fn(),
  };
});

import * as api from "../services/api";
import { SettingsIntegrations } from "../pages/settings/SettingsIntegrations";
import { SearchPerformancePage } from "../pages/search/SearchPerformancePage";

// Shapes below are the backend's actual response bodies (asserted against
// PostgreSQL in server/src/tests/gsc.integration.test.ts).
const MISSING = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "INTEGRATION_ENCRYPTION_KEYS"];
const integration = (over: Record<string, unknown> = {}) => ({
  id: "int-1", provider: "google_search_console", account_email: "owner@gmail.example", scopes: ["openid", "email"], status: "active", status_reason: null,
  connected_at: "2030-01-01T00:00:00Z", connected_by_name: "Dana Owner", properties: [], ...over,
});
const websites = [
  { id: "w1", url: "https://one.example/", domain: "one.example", verified: true },
  { id: "w2", url: "https://two.example/", domain: "two.example", verified: false },
];
const renderAt = (ui: React.ReactNode, path = "/settings/integrations") => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

describe("Integrations settings", () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, assign });
    vi.mocked(api.apiListWebsites).mockResolvedValue({ data: websites, error: null } as never);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("says plainly when the server is not configured and disables connecting", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [], error: null, meta: { googleSearchConsole: { configured: false, missing: MISSING } } } as never);
    renderAt(<SettingsIntegrations />);
    expect(await screen.findByText("Not configured on this server.")).toBeTruthy();
    for (const name of MISSING) expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Google Search Console" })).toHaveProperty("disabled", true);
  });

  it("starts the Google sign-in in the same tab", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    vi.mocked(api.apiStartGoogleConnect).mockResolvedValue({ data: { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }, error: null } as never);
    renderAt(<SettingsIntegrations />);
    expect(await screen.findByText("No Google account is connected.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect Google Search Console" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=s"));
    expect(api.apiStartGoogleConnect).toHaveBeenCalledWith("/settings/integrations");
  });

  it("explains a role refusal instead of redirecting", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    vi.mocked(api.apiStartGoogleConnect).mockResolvedValue({ data: null, error: { code: "INSUFFICIENT_ROLE", message: "no" } } as never);
    renderAt(<SettingsIntegrations />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Search Console" }));
    expect(await screen.findByText("Only organization owners and admins can connect Google accounts.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["?gsc=connected", "Google Search Console connected", "status"],
    ["?gsc=cancelled&reason=access_denied", "You cancelled the Google sign-in", "alert"],
    ["?gsc=error&reason=scope_denied", "Search Console access was not granted", "alert"],
    ["?gsc=error&reason=invalid_state", "expired or was already used", "alert"],
  ])("shows the OAuth result %s", async (query, text, role) => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    renderAt(<SettingsIntegrations />, `/settings/integrations${query}`);
    const message = await screen.findByText(new RegExp(text));
    expect(message.closest(`[role=${role}]`)).toBeTruthy();
  });

  it("prompts to reconnect an account whose access was revoked", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [integration({ status: "reauth_required", status_reason: "Google access was revoked or expired; reconnect the account" })], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    renderAt(<SettingsIntegrations />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/revoked or expired.*Syncing is paused/);
    expect(within(alert).getByRole("button", { name: "Reconnect owner@gmail.example" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load Search Console properties" })).toBeNull();
  });

  it("links a verified website to a readable property, and explains a mismatch", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [integration()], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    vi.mocked(api.apiListGscProperties).mockResolvedValue({ data: [
      { siteUrl: "sc-domain:one.example", permissionLevel: "siteOwner", propertyType: "domain", canReadData: true, linkedWebsiteIds: [] },
      { siteUrl: "https://one.example/", permissionLevel: "siteUnverifiedUser", propertyType: "url_prefix", canReadData: false, linkedWebsiteIds: [] },
    ], error: null } as never);
    vi.mocked(api.apiLinkSearchConsole).mockResolvedValueOnce({ data: null, error: { code: "PROPERTY_MISMATCH", message: "x" } } as never).mockResolvedValueOnce({ data: { propertyType: "domain", permissionLevel: "siteOwner" }, error: null } as never);
    renderAt(<SettingsIntegrations />);
    const site = await screen.findByLabelText("Website");
    expect(within(site).getByRole("option", { name: /two.example \(not verified in ZigmaNeural\)/ })).toHaveProperty("disabled", true);
    await userEvent.selectOptions(site, "w1");
    await userEvent.click(screen.getByRole("button", { name: "Load Search Console properties" }));
    const group = await screen.findByRole("group", { name: "Search Console property" });
    expect(within(group).getByRole("radio", { name: /https:\/\/one.example\// })).toHaveProperty("disabled", true);
    await userEvent.click(within(group).getByRole("radio", { name: /sc-domain:one.example/ }));
    await userEvent.click(screen.getByRole("button", { name: "Link property" }));
    expect(await screen.findByText(/does not cover this website's URL/)).toBeTruthy();
    await userEvent.click(within(group).getByRole("radio", { name: /sc-domain:one.example/ }));
    await userEvent.click(screen.getByRole("button", { name: "Link property" }));
    expect(await screen.findByText(/Linked one.example to sc-domain:one.example/)).toBeTruthy();
    expect(api.apiLinkSearchConsole).toHaveBeenLastCalledWith("w1", "int-1", "sc-domain:one.example");
  });

  it("asks for confirmation before disconnecting, and says what was deleted", async () => {
    vi.mocked(api.apiListIntegrations).mockResolvedValue({ data: [integration()], error: null, meta: { googleSearchConsole: { configured: true, missing: [] } } } as never);
    vi.mocked(api.apiDisconnectIntegration).mockResolvedValue({ data: { revokedAtGoogle: true }, error: null } as never);
    renderAt(<SettingsIntegrations />);
    await userEvent.click(await screen.findByRole("button", { name: /Disconnect owner@gmail.example/ }));
    expect(api.apiDisconnectIntegration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect and delete" }));
    expect(await screen.findByText(/Stored Search Console data for its properties was deleted and access was revoked at Google/)).toBeTruthy();
    expect(api.apiDisconnectIntegration).toHaveBeenCalledWith("int-1");
  });
});

// ─── Search performance ──────────────────────────────────────────────────────

const status = (over: Record<string, unknown> = {}) => ({
  property: { id: "p1", site_url: "sc-domain:one.example", property_type: "domain", permission_level: "siteOwner", status: "active", status_reason: null, last_sync_success_at: "2030-01-30T10:00:00Z", last_synced_through: "2030-01-30", first_incomplete_date: "2030-01-29", next_sync_at: "2030-01-31T10:00:00Z", integration_id: "int-1" },
  integration: { id: "int-1", account_email: "owner@gmail.example", status: "active", status_reason: null },
  activeJob: null,
  recentJobs: [{ id: "j1", kind: "initial", status: "completed", date_from: "2030-01-01", date_to: "2030-01-30", units_total: 180, units_done: 180, units_failed: 0, error_code: null, error: null, created_at: "2030-01-30T09:00:00Z", started_at: null, finished_at: null }],
  freshness: { latestFinalDay: "2030-01-28", latestDay: "2030-01-30", firstIncompleteDate: "2030-01-29" },
  ...over,
});
const series = (days: number, state = "complete") => Array.from({ length: days }, (_, i) => ({ date: `2030-01-${String(i + 1).padStart(2, "0")}`, state, clicks: state === "missing" ? null : 10, impressions: state === "missing" ? null : 100, ctr: state === "missing" ? null : 0.1, position: state === "missing" ? null : 4 }));
const perf = (over: Record<string, unknown> = {}) => ({
  current: { dimensionSet: "total", totals: { clicks: 270, impressions: 2700, ctr: 0.1, position: 4.2 }, coverage: { days: 28, daysWithData: 27, daysMissing: 1, daysFresh: 2, daysNotReturned: 0 }, series: series(28) },
  previous: { dimensionSet: "total", totals: { clicks: 200, impressions: 2000, ctr: 0.1, position: 5 }, coverage: { days: 28, daysWithData: 28, daysMissing: 0, daysFresh: 0, daysNotReturned: 0 }, series: series(28) },
  comparison: { clicks: { change: 70, changePct: 0.35 }, impressions: { change: 700, changePct: 0.35 }, ctr: { change: 0, changePct: null }, position: { change: -0.8, changePct: null } },
  ...over,
});
const top = (keys: string[], cursor: string | null = null) => ({ data: keys.map((k, i) => ({ key: k, clicks: 10 - i, impressions: 100, ctr: (10 - i) / 100, position: 3 + i, daysWithRows: 28 })), error: null, meta: { limit: 25, nextCursor: cursor, coverage: { days: 28, daysFetched: 28, daysTruncated: 0 }, firstIncompleteDate: null } });

describe("Search performance", () => {
  beforeEach(() => {
    vi.mocked(api.apiGetDashboard).mockResolvedValue({ data: { selectedWebsite: { id: "w1", domain: "one.example" } }, error: null } as never);
    vi.mocked(api.apiGetSearchConsoleStatus).mockResolvedValue({ data: status(), error: null, meta: { websiteVerified: true } } as never);
    vi.mocked(api.apiGetSearchPerformance).mockResolvedValue({ data: perf(), error: null, meta: {} } as never);
    vi.mocked(api.apiGetSearchTop).mockResolvedValue(top(["shoes", "red shoes"]) as never);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  const renderPage = () => renderAt(<SearchPerformancePage />, "/search/performance");

  it("shows the disconnected state with a way to connect", async () => {
    vi.mocked(api.apiGetSearchConsoleStatus).mockResolvedValue({ data: null, error: null, meta: { websiteVerified: true } } as never);
    renderPage();
    expect(await screen.findByText("Search Console is not connected for this website")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Integrations" }).getAttribute("href")).toBe("/settings/integrations");
    expect(api.apiGetSearchPerformance).not.toHaveBeenCalled();
  });

  it("shows loading, then an error with retry", async () => {
    vi.mocked(api.apiGetSearchPerformance).mockResolvedValueOnce({ data: null, error: { code: "500", message: "boom" } } as never);
    renderPage();
    expect(await screen.findByText("Loading search performance…")).toBeTruthy();
    expect(await screen.findByText("boom")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("270")).toBeTruthy();
  });

  it("shows real totals, the comparison, freshness labels and missing-day warnings", async () => {
    renderPage();
    expect(await screen.findByText("270")).toBeTruthy();
    expect(screen.getByText("2,700")).toBeTruthy();
    expect(screen.getByText("10.0%")).toBeTruthy();
    expect(screen.getByText("4.2")).toBeTruthy();
    expect(screen.getByText(/vs previous: \+70 \(\+35\.0%\)/)).toBeTruthy();
    expect(screen.getByText(/-0\.8 \(lower is better\)/)).toBeTruthy();
    expect(screen.getByText(/Final data through/).textContent).toMatch(/2030-01-28.*2030-01-29 are preliminary/);
    expect(screen.getByText(/1 of 28 days are not synced yet and are excluded \(not counted as zero\)/)).toBeTruthy();
    expect(screen.getByText(/sc-domain:one.example/)).toBeTruthy();
    expect(api.apiGetSearchPerformance).toHaveBeenCalledWith("w1", { from: "2030-01-03", to: "2030-01-30", compareFrom: "2029-12-06", compareTo: "2030-01-02" });
  });

  it("says when a range has no synced data instead of showing zeros", async () => {
    vi.mocked(api.apiGetSearchPerformance).mockResolvedValue({ data: perf({ current: { dimensionSet: "total", totals: { clicks: null, impressions: null, ctr: null, position: null }, coverage: { days: 7, daysWithData: 0, daysMissing: 7, daysFresh: 0, daysNotReturned: 0 }, series: series(7, "missing") }, previous: null, comparison: null }), error: null } as never);
    renderPage();
    expect(await screen.findByText("No synced data for this range")).toBeTruthy();
    expect(screen.getByText(/have not been fetched from Google yet/)).toBeTruthy();
  });

  it("shows reauthorization and lost-access states", async () => {
    vi.mocked(api.apiGetSearchConsoleStatus).mockResolvedValue({ data: status({ integration: { id: "int-1", account_email: "x", status: "reauth_required", status_reason: null }, property: { ...status().property, status: "access_lost", status_reason: "The connected Google account can no longer read this property" } }), error: null } as never);
    renderPage();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toMatch(/revoked or expired.*can no longer read this property/s);
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);
  });

  it("starts a sync, shows progress of the active job and can cancel it", async () => {
    vi.mocked(api.apiStartSearchConsoleSync).mockResolvedValue({ data: { id: "j2", date_from: "2030-01-29", date_to: "2030-01-30" }, error: null, meta: { deduplicated: false } } as never);
    renderPage();
    await screen.findByText("270");
    const running = status({ activeJob: { id: "j2", kind: "manual", status: "running", date_from: "2030-01-29", date_to: "2030-01-30", units_total: 12, units_done: 5, units_failed: 0, error_code: null, error: null, created_at: "2030-01-30T11:00:00Z", started_at: null, finished_at: null } });
    vi.mocked(api.apiGetSearchConsoleStatus).mockResolvedValue({ data: running, error: null } as never);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Sync queued for 2030-01-29 to 2030-01-30.")).toBeTruthy();
    expect(screen.getByText(/5 of 12 fetches done/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Sync progress" })).toBeTruthy();
    vi.mocked(api.apiCancelSearchConsoleSync).mockResolvedValue({ data: { id: "j2", status: "running" }, error: null } as never);
    vi.mocked(api.apiGetSearchConsoleStatus).mockResolvedValue({ data: status(), error: null } as never);
    await userEvent.click(screen.getByRole("button", { name: "Cancel sync" }));
    expect(await screen.findByText("Sync cancelled. Days already fetched are kept.")).toBeTruthy();
    expect(api.apiCancelSearchConsoleSync).toHaveBeenCalledWith("w1", "j2");
  });

  it("breakdown tables switch dimension, sort by column, search and page with the cursor", async () => {
    vi.mocked(api.apiGetSearchTop).mockResolvedValueOnce(top(["shoes"], "C1") as never);
    renderPage();
    const table = await screen.findByRole("table", { name: /Queries sorted by Clicks descending/ });
    expect(within(table).getByText("shoes")).toBeTruthy();
    vi.mocked(api.apiGetSearchTop).mockResolvedValueOnce(top(["red shoes"]) as never);
    await userEvent.click(screen.getByRole("button", { name: "Load more queries" }));
    expect(await screen.findByText("red shoes")).toBeTruthy();
    expect(api.apiGetSearchTop).toHaveBeenLastCalledWith("w1", "query", expect.objectContaining({ cursor: "C1" }));

    await userEvent.click(screen.getByRole("button", { name: "Position" }));
    await waitFor(() => expect(api.apiGetSearchTop).toHaveBeenLastCalledWith("w1", "query", expect.objectContaining({ sort: "position", order: "asc", cursor: null })));
    expect(await screen.findByRole("columnheader", { name: /Position/ })).toHaveProperty("ariaSort", "ascending");

    await userEvent.click(screen.getByRole("tab", { name: "Countries" }));
    await waitFor(() => expect(api.apiGetSearchTop).toHaveBeenLastCalledWith("w1", "country", expect.anything()));
    await userEvent.type(screen.getByLabelText("Country contains"), "us");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.apiGetSearchTop).toHaveBeenLastCalledWith("w1", "country", expect.objectContaining({ search: "us" })));
  });
});
