// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  const fns = ["apiListWebsites", "apiRankSources", "apiRankProjects", "apiRankCreateProject", "apiRankDashboard", "apiRankRankings", "apiRankKeywords", "apiRankAddKeywords", "apiRankRemoveKeyword", "apiRankUpdateKeyword",
    "apiRankHistory", "apiRankCompetitors", "apiRankCompetitorComparison", "apiRankSerpFeatures", "apiRankAlertRules", "apiRankAlerts", "apiRankCreateAlertRule", "apiRankPreviewObservations",
    "apiRankImportObservations", "apiRankImports", "apiRankJobs", "apiRankRefresh", "apiRankExport", "apiRankImportKeywords", "apiRankAddCompetitor", "apiRankAcknowledge"];
  return { ...actual, ...Object.fromEntries(fns.map((f) => [f, vi.fn()])) };
});

import * as api from "../services/api";
import { RankTrackingPage } from "../pages/search/rankings/RankTrackingPage";

// Shapes match server/src/tests/rank-tracking.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

const project = { id: "p1", website_id: "w1", website_domain: "one.example", name: "UK desktop", search_engine: "google", country: "gb", language: "en", device: "desktop", location: null, timezone: "Europe/London", frequency: "manual", status: "active", created_at: "x", keywords: 3, last_observed: "2026-09-08" };
const sources = (provider = false) => ({
  sources: [
    { id: "csv_import", name: "Ranking report import", status: "available", explanation: "Import…", setup: null, costNote: "No cost." },
    { id: "google_search_console", name: "Google Search Console", status: "not_supported", explanation: "Average position is not a SERP rank.", setup: null, costNote: "No cost." },
    { id: provider ? "fake_serp" : "licensed_serp_api", name: provider ? "Fake SERP" : "Licensed SERP data API", status: provider ? "available" : "not_configured", explanation: "…", setup: provider ? null : "Approve a provider.", costNote: "Paid" },
  ],
  usage: { day: "2026-09-08", limit: 1000, used: 0 }, features: [], limits: { keywordsPerProject: 500, competitorsPerProject: 10, requestsPerDay: 1000, importRows: 50000, importBytes: 10_000_000 },
});
const o = (over: Record<string, unknown>) => ({ id: "o", keyword_id: "k", subject_domain: "one.example", observed_date: "2026-09-08", status: "ranked", position: 5, result_depth: null, ranking_url: "https://one.example/a", source: "csv_import", source_label: "Tracker", serp_features: [], owned_features: [], result_type: null, error_code: null, ...over });
const dashboard = (over: Record<string, unknown> = {}) => ({
  keywords: { tracked: 3, active: 3, paused: 0, withObservations: 3 },
  changes: { improved: 1, declined: 1, unchanged: 0, entered: 0, dropped_out: 0, unavailable: 1 },
  distribution: { "1-3": 1, "4-10": 0, "11-20": 1, "21-50": 0, "51-100": 0, "101+": 0, not_in_results: 0, unavailable: 1 },
  topPages: [{ url: "https://one.example/a", keywords: 2, averagePosition: 8, bestPosition: 3 }],
  top10Trend: [{ day: "2026-09-01", source: "csv_import", share: 50, top10: 1, conclusive: 2, excluded: 0 }, { day: "2026-09-08", source: "csv_import", share: 33.3, top10: 1, conclusive: 3, excluded: 0 }],
  range: { from: "2026-06-10", to: "2026-09-08" },
  activity: { lastImport: { created_at: "2026-09-08T10:00:00Z", source_label: "Tracker", rows_accepted: 6 }, lastJob: null, usageToday: { limit: 1000, used: 0 } },
  ...over,
});
const rows = [
  { keywordId: "k1", keyword: "running shoes", group: "shoes", status: "active", landingPage: null, latest: o({ position: 14 }), previous: o({ position: 8, observed_date: "2026-09-01" }), change: { kind: "declined", delta: -6, reason: "Position 8 → 14." } },
  { keywordId: "k2", keyword: "trail shoes", group: null, status: "active", landingPage: null, latest: o({ status: "not_in_results", position: null, result_depth: 100, ranking_url: null }), previous: null, change: { kind: "unavailable", delta: null, reason: "No earlier comparable observation from the same source." } },
  { keywordId: "k3", keyword: "shoe sizes", group: null, status: "active", landingPage: null, latest: o({ status: "failed", position: null, ranking_url: null }), previous: o({ position: 15, observed_date: "2026-09-01" }), change: { kind: "unavailable", delta: null, reason: "The latest collection failed; this is not a ranking change." } },
];

beforeEach(() => {
  vi.mocked(api.apiListWebsites).mockResolvedValue(ok([{ id: "w1", domain: "one.example" }]));
  vi.mocked(api.apiRankSources).mockResolvedValue(ok(sources()));
  vi.mocked(api.apiRankProjects).mockResolvedValue(ok([project]));
  vi.mocked(api.apiRankDashboard).mockResolvedValue(ok(dashboard()));
  vi.mocked(api.apiRankRankings).mockResolvedValue(ok(rows, { total: 3 }));
  vi.mocked(api.apiRankKeywords).mockResolvedValue(ok([], { nextCursor: null, groups: ["shoes"] }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/search/rankings" element={<RankTrackingPage />} /><Route path="/search/rankings/:tab" element={<RankTrackingPage />} /></Routes>
  </MemoryRouter>,
);

describe("Rank tracking overview", () => {
  it("loads, then shows changes, positions and 'not found' / failed states honestly", async () => {
    at("/search/rankings");
    expect(screen.getByText("Loading rank tracking…")).toBeTruthy();
    const changes = await screen.findByRole("region", { name: "Ranking changes" });
    expect(changes.textContent).toMatch(/Declined1/);
    expect(changes.textContent).toMatch(/No comparison1/);
    const table = screen.getByRole("table", { name: "Latest positions" });
    const r = (kw: string) => within(table).getByText(kw).closest("tr")!.textContent;
    expect(r("running shoes")).toMatch(/14.*8 \(2026-09-01\).*Declined -6/);
    expect(r("trail shoes")).toMatch(/Not in top 100/);
    expect(r("shoe sizes")).toMatch(/Collection failed.*No comparison/);
    expect(r("shoe sizes")).not.toMatch(/Declined/);
    expect(screen.getByText(/No SERP data provider is configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No traffic or volume is involved/)).toBeTruthy();
  });

  it("without observations explains how to get the first one", async () => {
    vi.mocked(api.apiRankDashboard).mockResolvedValue(ok(dashboard({ keywords: { tracked: 2, active: 2, paused: 0, withObservations: 0 } })));
    at("/search/rankings");
    expect(await screen.findByText("No ranking observations yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import rankings" }).getAttribute("href")).toBe("/search/rankings/import");
  });

  it("without projects shows the setup form; scheduled tracking needs a provider", async () => {
    vi.mocked(api.apiRankProjects).mockResolvedValue(ok([]));
    vi.mocked(api.apiRankCreateProject).mockResolvedValue(ok(project));
    at("/search/rankings");
    const form = await screen.findByRole("form", { name: "New rank-tracking project" });
    const tracking = within(form).getByLabelText("Tracking") as HTMLSelectElement;
    expect([...tracking.options].find((x) => x.value === "daily")!.disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText("Name"), "UK desktop");
    await userEvent.type(within(form).getByLabelText("Country (ISO code)"), "gb");
    await userEvent.selectOptions(within(form).getByLabelText("Device"), "desktop");
    await userEvent.click(within(form).getByRole("button", { name: "Create project" }));
    expect(api.apiRankCreateProject).toHaveBeenCalledWith(expect.objectContaining({ websiteId: "w1", name: "UK desktop", country: "gb", device: "desktop", frequency: "manual" }));
  });

  it("shows an error with retry", async () => {
    vi.mocked(api.apiRankProjects).mockResolvedValueOnce(fail("INTERNAL_ERROR", "An unexpected error occurred"));
    at("/search/rankings");
    expect(await screen.findByText("Unable to load rank tracking")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Ranking changes" })).toBeTruthy();
  });

  it("with a provider, refresh is available and reports the server's answer", async () => {
    vi.mocked(api.apiRankSources).mockResolvedValue(ok(sources(true)));
    vi.mocked(api.apiRankRefresh).mockResolvedValue(fail("QUOTA_EXCEEDED", "This refresh needs 3 requests; 1 of today's 1000 remain."));
    at("/search/rankings");
    await userEvent.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText(/This refresh needs 3 requests/)).toBeTruthy();
  });
});

describe("Keywords", () => {
  it("adds keywords, and removal needs confirmation and keeps history", async () => {
    vi.mocked(api.apiRankKeywords).mockResolvedValue(ok([{ id: "k1", keyword: "running shoes", group_name: "shoes", landing_page: null, status: "active", source: "manual", created_at: "x" }], { nextCursor: null, groups: ["shoes"] }));
    vi.mocked(api.apiRankAddKeywords).mockResolvedValue(ok({ added: 2, restored: 0, alreadyTracked: 1, invalid: [], warnings: [], limit: 500 }));
    vi.mocked(api.apiRankRemoveKeyword).mockResolvedValue(ok({ removed: true }));
    at("/search/rankings/keywords");
    await userEvent.type(await screen.findByLabelText("Keywords (one per line)"), "a{enter}b{enter}running shoes");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(api.apiRankAddKeywords).toHaveBeenCalledWith("p1", [{ keyword: "a", group: null }, { keyword: "b", group: null }, { keyword: "running shoes", group: null }]);
    expect(await screen.findByText(/Added 2, restored 0, already tracked 1/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(api.apiRankRemoveKeyword).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Confirm removal" });
    expect(dialog.textContent).toMatch(/Its history is kept/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.apiRankRemoveKeyword).toHaveBeenCalledWith("p1", "k1");
  });

  it("reports a keyword limit from the server", async () => {
    vi.mocked(api.apiRankAddKeywords).mockResolvedValue(fail("KEYWORD_LIMIT", "A project can track at most 500 keywords (499 tracked, 3 new)."));
    at("/search/rankings/keywords");
    await userEvent.type(await screen.findByLabelText("Keywords (one per line)"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 500 keywords/);
  });
});

describe("Competitors and SERP features", () => {
  it("shows comparable data, and 'not comparable' instead of guessing", async () => {
    vi.mocked(api.apiRankCompetitors).mockResolvedValue(ok([{ domain: "rival.example", created_at: "x" }]));
    vi.mocked(api.apiRankCompetitorComparison).mockResolvedValue(ok({
      note: "Compared only on the same day and from the same source.",
      competitors: [{ competitor: "rival.example", counts: { both_ranked: 1, own_only: 0, competitor_only: 0, neither: 0, not_comparable: 1, ownAhead: 0, competitorAhead: 1 }, keywords: [
        { keywordId: "k1", keyword: "running shoes", date: "2026-09-08", relation: "both_ranked", ahead: "competitor", reason: "You 14, competitor 3.", own: { position: 14, status: "ranked", url: null, ownedFeatures: [] }, competitor: { position: 3, status: "ranked", url: null, ownedFeatures: [] }, competitorMovement: { kind: "unchanged", delta: 0, reason: "" } },
        { keywordId: "k2", keyword: "trail shoes", date: null, relation: "not_comparable", ahead: null, reason: "No conclusive observations for both sites.", own: null, competitor: null, competitorMovement: { kind: "unavailable", delta: null, reason: "" } },
      ] }],
    }));
    at("/search/rankings/competitors");
    const section = await screen.findByRole("region", { name: "Comparison with rival.example" });
    expect(section.textContent).toMatch(/you ahead 0, they ahead 1/);
    expect(within(section).getByText("trail shoes").closest("tr")!.textContent).toMatch(/No conclusive observations for both sites/);
  });

  it("separates features seen on the page from features the site holds", async () => {
    vi.mocked(api.apiRankSerpFeatures).mockResolvedValue(ok({ keywordsObserved: 3, keywordsWithFeatureData: 2, features: [{ feature: "featured_snippet", present: 2, owned: 0, keywords: [{ keyword: "running shoes", owned: false }] }, { feature: "images", present: 1, owned: 1, keywords: [{ keyword: "shoe sizes", owned: true }] }] }));
    at("/search/rankings/features");
    const table = await screen.findByRole("table", { name: "SERP features" });
    expect(within(table).getByText("featured snippet").closest("tr")!.textContent).toMatch(/featured snippet20running shoes$/);
    expect(within(table).getByText("images").closest("tr")!.textContent).toMatch(/shoe sizes \(yours\)/);
    expect(screen.getByText(/not evidence that you hold it/)).toBeTruthy();
    expect(screen.getByText(/1 observed keyword\(s\) have no feature data/)).toBeTruthy();
  });
});

describe("Alerts, history and import", () => {
  it("creates rules and acknowledges alerts", async () => {
    vi.mocked(api.apiRankAlertRules).mockResolvedValue(ok([]));
    vi.mocked(api.apiRankAlerts).mockResolvedValue(ok([{ id: "e1", rule_id: "r1", rule_type: "position_change", keyword_id: "k1", keyword: "running shoes", message: "“running shoes” declined by 6 positions (8 → 14).", evidence: {}, created_at: "2026-09-08T10:00:00Z", acknowledged_at: null }], { nextCursor: null }));
    vi.mocked(api.apiRankCompetitors).mockResolvedValue(ok([]));
    vi.mocked(api.apiRankCreateAlertRule).mockResolvedValue(ok({ id: "r2" }));
    vi.mocked(api.apiRankAcknowledge).mockResolvedValue(ok({ acknowledged: true }));
    at("/search/rankings/alerts");
    expect(await screen.findByText(/declined by 6 positions/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Positions"));
    await userEvent.type(screen.getByLabelText("Positions"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(api.apiRankCreateAlertRule).toHaveBeenCalledWith("p1", { type: "position_change", params: { positions: 3 } });
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(api.apiRankAcknowledge).toHaveBeenCalledWith("p1", "e1");
  });

  it("history plots observed positions only and lists the rest", async () => {
    vi.mocked(api.apiRankHistory).mockResolvedValue(ok({ keyword: { id: "k1", keyword: "running shoes" }, observations: [o({ id: "a", observed_date: "2026-09-01", position: 8 }), o({ id: "b", observed_date: "2026-09-08", status: "failed", position: null, ranking_url: null })] }));
    at("/search/rankings/history");
    const table = await screen.findByRole("table", { name: "Observation history" });
    expect(table.textContent).toMatch(/2026-09-08one\.exampleCollection failed/);
    expect(screen.getByText(/never plotted as a position/)).toBeTruthy();
  });

  it("previews a report, then imports with a source label", async () => {
    vi.mocked(api.apiRankImports).mockResolvedValue(ok([]));
    vi.mocked(api.apiRankJobs).mockResolvedValue(ok([]));
    vi.mocked(api.apiRankPreviewObservations).mockResolvedValue(ok({ columns: { keyword: "Keyword", date: "Date", position: "Position" }, unmappedColumns: [], missingRequired: [], rowLimitExceeded: false, rows: { total: 5, accepted: 3, rejected: 1, duplicate: 1, skipped: 0 }, rejectedSamples: [{ row: 3, reason: "Device mobile differs from the project's desktop" }], warnings: [], newKeywords: 1, statuses: { ranked: 2, not_in_results: 1 } }));
    vi.mocked(api.apiRankImportObservations).mockResolvedValue(ok({ importId: "i1", duplicateImport: false, inserted: 3, alreadyObserved: 0, keywordsCreated: 1, rejected: 1, duplicates: 1, alertsCreated: 0, warnings: [] }));
    at("/search/rankings/import");
    await userEvent.upload(await screen.findByLabelText("File"), new File(["Keyword,Date,Position\nx,2026-09-01,3"], "r.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const region = await screen.findByRole("region", { name: "Import preview" });
    expect(region.textContent).toMatch(/3 observation\(s\) will be imported · 1 rejected · 1 duplicate · 0 blank \(of 5 rows\) · 1 new keyword/);
    expect(region.textContent).toMatch(/row 3: Device mobile differs/);
    const importBtn = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Source of the report"), "Tracker export");
    await userEvent.click(importBtn);
    await waitFor(() => expect(api.apiRankImportObservations).toHaveBeenCalledWith("p1", { csv: "Keyword,Date,Position\nx,2026-09-01,3", filename: "r.csv", sourceLabel: "Tracker export", createMissingKeywords: true }));
    expect(await screen.findByText(/Imported 3 observation\(s\); 0 already present, 1 rejected, 1 duplicate; 1 keyword\(s\) added; 0 alert\(s\)\./)).toBeTruthy();
  });
});

describe("Data sources", () => {
  it("states that no SERP provider is configured and that Search Console average position is not a rank", async () => {
    at("/search/rankings/sources");
    const licensed = await screen.findByRole("listitem", { name: "Licensed SERP data API" });
    expect(licensed.textContent).toMatch(/not configured/);
    expect(screen.getByRole("listitem", { name: "Google Search Console" }).textContent).toMatch(/not a SERP rank/);
  });
});
