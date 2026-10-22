// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  const fns = ["apiListWebsites", "apiWsOverview", "apiWsIntegrations", "apiWsInsights", "apiWsInsight", "apiWsRefreshInsights", "apiWsUpdateInsight", "apiWsActions", "apiWsUpdateAction", "apiWsActionHistory", "apiWsReport", "apiWsAiSummary", "apiWsDownload"];
  return { ...actual, ...Object.fromEntries(fns.map((f) => [f, vi.fn()])) };
});

import * as api from "../services/api";
import { WorkspacePage } from "../pages/intelligence/workspace/WorkspacePage";

// Shapes match server/src/tests/seo-workspace.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

const fresh = { state: "fresh", lastUpdatedAt: "2026-10-21T10:00:00Z", ageHours: 5, staleAfterHours: 48 };
const section = (over: Record<string, unknown>) => ({ module: "x", status: "ok", freshness: fresh, range: { support: "full", note: "Range note." }, notes: [], link: "/x", data: null, ...over });
const overview = (over: Record<string, unknown> = {}) => ({
  website: { id: "w1", domain: "shop.example", verified: true },
  range: { preset: "28d", from: "2026-09-24", to: "2026-10-21", days: 28, previous: { from: "2026-08-27", to: "2026-09-23" }, timezone: "America/Los_Angeles", notes: [] },
  generatedAt: "2026-10-22T10:00:00Z",
  summary: ["Search Console: 305 clicks and 5050 impressions in 2026-09-24 – 2026-10-21 (+52.5% vs the previous period)."],
  sections: {
    search: section({ module: "search", status: "partial", notes: ["23 of 28 days in the range are not synced yet; totals cover synced days only."], data: {
      siteUrl: "sc-domain:shop.example", current: { clicks: 0, impressions: 5050, ctr: 0, position: null }, previous: { clicks: 200, impressions: 4000, ctr: 0.05, position: 3 },
      comparison: { clicks: { change: -200, changePct: -1 }, impressions: { change: 1050, changePct: 0.2625 }, ctr: { change: -0.05, changePct: null }, position: { change: null, changePct: null } },
      coverage: { current: { days: 28, daysWithData: 5, daysMissing: 23, daysFresh: 0 }, previous: { days: 28, daysWithData: 5, daysMissing: 23 } },
      series: [{ date: "2026-10-20", clicks: 0, impressions: 1010, state: "complete" }, { date: "2026-10-21", clicks: null, impressions: null, state: "missing" }],
      topPages: [{ key: "https://shop.example/", clicks: 0, impressions: 3000, ctr: 0, position: 2 }], topQueries: [], movers: [], latestFinalDay: "2026-10-20", firstIncompleteDate: null,
    } }),
    technical: section({ module: "technical", range: { support: "events_only", note: "Snapshot of the latest crawl." }, data: {
      latestCrawl: { scanId: "s1", crawledAt: "2026-10-20T10:00:00Z", pagesCrawled: 4, pagesDiscovered: 4, truncated: false, truncatedReason: null, statusCounts: { "2xx": 3, "4xx": 1 }, maxPages: 100 },
      indexability: { indexable: 2, not_indexable: 2, unknown: 0 }, openBySeverity: { high: 2, medium: 1 }, brokenInternalLinks: 1, canonicalIssues: 0, inRange: { detected: 3, fixed: 0 }, previousRange: { detected: 0, fixed: 0 },
      topIssues: [{ id: "i1", rule_id: "broken_internal_link", severity: "high", url: "https://shop.example/gone", title: "Broken internal link target (404)" }], history: [],
    } }),
    rankings: section({ module: "rankings", status: "not_configured", freshness: null, notes: ["No rank-tracking project for this website. Create one under Search data → Rankings."] }),
    backlinks: section({ module: "backlinks", status: "error", freshness: null, notes: ["This module could not be read right now; other sections are unaffected."] }),
    content: section({ module: "content", status: "no_data", freshness: null, notes: ["No content inventory yet."] }),
    aiVisibility: section({ module: "ai_visibility", status: "not_configured", freshness: null, notes: ["No monitored brand is linked to this website."] }),
    keywords: section({ module: "keywords", status: "no_data", freshness: null, notes: ["No keyword research run for this website yet."] }),
  },
  completeness: { search: { status: "partial", freshness: "fresh", lastUpdatedAt: null }, technical: { status: "ok", freshness: "fresh", lastUpdatedAt: null }, backlinks: { status: "error", freshness: null, lastUpdatedAt: null } },
  jobs: [{ module: "crawl_scan", id: "s1", status: "failed", created_at: "2026-10-20T10:00:00Z", finished_at: null, error: "Timeout" }],
  topInsights: [], insightsOpen: 0, insightsEvaluatedAt: null, topActions: [{ key: "site_issue:i1", title: "Broken internal link target (404)", priority: 80, category: "critical_technical" }], actionsTotal: 4,
  ...over,
});
const insight = { id: "n1", rule_id: "low_ctr_with_snippet_issue", entity_type: "page", entity_value: "https://shop.example/shoes", title: "Low CTR on /shoes while its title has an open finding", explanation: "400 impressions, CTR 0.25%.", action: "Fix the title.", evidence: [{ module: "search_console", kind: "page_metrics", url: "https://shop.example/shoes", label: "400 impressions", link: "/search/performance" }, { module: "technical", kind: "site_issue", id: "i2", label: "title_missing (high)", link: "/intelligence/technical-health" }], modules: ["search_console", "technical"], observed_from: "2026-09-24", observed_to: "2026-10-21", limitations: ["This is a correlation between observations from different modules, not proof that one caused the other."], priority: 61, priority_factors: [{ name: "impressions", weight: 0.5, value: 0.52, explanation: "400 impressions." }], confidence: "medium", status: "open", first_detected_at: "x", last_detected_at: "x" };
const action = { key: "site_issue:i1", source: "site_issue", sourceRef: "i1", sourceStatus: "OPEN", category: "critical_technical", title: "Broken internal link target (404)", detail: "https://shop.example/gone · broken_internal_link (high)", recommendedAction: "Open the issue in Technical health.", evidence: ["site_issue:i1"], priority: 80, priorityBasis: "Severity high.", effort: "small", link: "/intelligence/technical-health", detectedAt: "2026-10-20T10:00:00Z", state: { status: "open", ownerId: null, dueDate: null, note: null, updatedAt: null } };

beforeEach(() => {
  vi.mocked(api.apiListWebsites).mockResolvedValue(ok([{ id: "w1", url: "https://shop.example", domain: "shop.example", verified: true }, { id: "w2", url: "https://other.example", domain: "other.example", verified: false }]));
  vi.mocked(api.apiWsOverview).mockResolvedValue(ok(overview(), { ai: { available: false } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });

function Where() {
  const l = useLocation();
  return <output aria-label="location">{l.pathname}{l.search}</output>;
}
const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/intelligence/workspace" element={<><WorkspacePage /><Where /></>} /><Route path="/intelligence/workspace/:tab" element={<><WorkspacePage /><Where /></>} /></Routes></MemoryRouter>);

describe("Workspace overview", () => {
  it("shows real KPIs, distinguishes zero from no data, and marks partial and missing modules", async () => {
    at("/intelligence/workspace");
    const search = await screen.findByRole("region", { name: "Search performance" });
    expect(within(search).getByText("Partial data")).toBeTruthy();
    expect(within(search).getByText("Clicks", { selector: "p" }).parentElement!.textContent).toBe("Clicks0-100.0%");
    expect(within(search).getByText("Average position", { selector: "p" }).parentElement!.textContent).toMatch(/No data/);
    expect(within(search).getByText(/23 of 28 days in the range are not synced yet/)).toBeTruthy();
    expect(within(search).getByRole("img", { name: /gaps are days without synced data/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Keyword rankings" })).getByText("Not set up")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Backlinks" })).getByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Technical health" }).textContent).toMatch(/Broken internal link targets: 1/);
    expect(screen.getByRole("region", { name: "Recent jobs" }).textContent).toMatch(/crawl scan · failed — Timeout/);
    expect(screen.getByText(/AI explanations are not configured/)).toBeTruthy();
  });

  it("changes website and date range, keeps the range in the URL across tabs, and refetches", async () => {
    const user = userEvent.setup();
    at("/intelligence/workspace");
    await screen.findByRole("region", { name: "Search performance" });
    expect(api.apiWsOverview).toHaveBeenLastCalledWith("w1", { preset: "28d", from: undefined, to: undefined, compare: "previous" });
    await user.selectOptions(screen.getByLabelText("Range"), "7d");
    await waitFor(() => expect(api.apiWsOverview).toHaveBeenLastCalledWith("w1", expect.objectContaining({ preset: "7d" })));
    expect(screen.getByLabelText("location").textContent).toMatch(/preset=7d/);
    await user.click(screen.getByLabelText("Compare with previous period"));
    await waitFor(() => expect(api.apiWsOverview).toHaveBeenLastCalledWith("w1", expect.objectContaining({ compare: "none" })));
    await user.selectOptions(screen.getByLabelText("Range"), "custom");
    await user.type(screen.getByLabelText("From"), "2026-10-10");
    await user.type(screen.getByLabelText("To"), "2026-10-01");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toMatch(/after the end date/);
    await user.selectOptions(screen.getByLabelText("Website"), "w2");
    await waitFor(() => expect(api.apiWsOverview).toHaveBeenLastCalledWith("w2", expect.anything()));
    expect(screen.getByRole("link", { name: "Insights" }).getAttribute("href")).toMatch(/\/intelligence\/workspace\/insights\?.*preset=custom/);
  });

  it("shows the server's error for an invalid range with retry", async () => {
    vi.mocked(api.apiWsOverview).mockResolvedValueOnce(fail("INVALID_RANGE", "A range can cover at most 480 days.")).mockResolvedValue(ok(overview(), {}));
    const user = userEvent.setup();
    at("/intelligence/workspace");
    expect(await screen.findByText("A range can cover at most 480 days.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Search performance" })).toBeTruthy();
  });

  it("labels the AI explanation as interpretation and shows permission errors plainly", async () => {
    vi.mocked(api.apiWsOverview).mockResolvedValue(ok(overview(), { ai: { available: true } }));
    vi.mocked(api.apiWsAiSummary).mockResolvedValueOnce(ok({ model: "free/m", ai: { summary: "Clicks fell to zero.", points: [{ statement: "Search is partly synced", sources: ["section:search"] }], insufficientEvidence: ["No ranking data."] }, dropped: 0, sources: {} })).mockResolvedValueOnce(fail("INSUFFICIENT_ROLE", "x"));
    const user = userEvent.setup();
    at("/intelligence/workspace");
    await user.click(await screen.findByRole("button", { name: "Explain in plain language (AI)" }));
    expect(await screen.findByText(/AI interpretation \(free\/m\) of the facts above — not a measurement/)).toBeTruthy();
    expect(screen.getByText(/Insufficient evidence: No ranking data/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Explain in plain language (AI)" }));
    expect(await screen.findByText("Your role can view the SEO workspace but not change it.")).toBeTruthy();
  });
});

describe("Insights explorer", () => {
  it("filters, shows evidence with sources and limitations, and records status", async () => {
    vi.mocked(api.apiWsInsights).mockResolvedValue(ok([insight], { total: 1, lastRun: { evaluated_at: "2026-10-22T10:00:00Z", window_from: "2026-09-24", window_to: "2026-10-21", detected: 1, skipped_rules: [{ ruleId: "declining_keyword_with_page_issue", reason: "No tracked keyword has comparable observations." }] }, rules: { declining_keyword_with_page_issue: { title: "Tracked keyword declined", modules: [], description: "" } }, formula: "priority = round(…)" }));
    vi.mocked(api.apiWsInsight).mockResolvedValue(ok({ ...insight, formula: "f", events: [{ event: "detected", from_status: null, to_status: "open", note: null, created_at: "2026-10-22T10:00:00Z" }] }));
    vi.mocked(api.apiWsUpdateInsight).mockResolvedValue(ok({ updated: true }));
    vi.mocked(api.apiWsRefreshInsights).mockResolvedValue(ok({ detected: 1, skipped: [{ ruleId: "x", reason: "y" }] }));
    const user = userEvent.setup();
    at("/intelligence/workspace/insights");
    expect(await screen.findByText(insight.title)).toBeTruthy();
    expect(screen.getByText(/Skipped: Tracked keyword declined \(No tracked keyword has comparable observations\.\)/)).toBeTruthy();
    expect(screen.getByText(/correlations, not proof of cause/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Module"), "technical");
    await waitFor(() => expect(api.apiWsInsights).toHaveBeenLastCalledWith("w1", expect.objectContaining({ module: "technical" })));
    await user.click(await screen.findByRole("button", { name: "Evidence" }));
    expect(await screen.findByText(/Technical: title_missing \(high\)/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "source" }).map((l) => l.getAttribute("href"))).toEqual(["/search/performance", "/intelligence/technical-health"]);
    expect(screen.getByText(/not proof that one caused the other/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(api.apiWsUpdateInsight).toHaveBeenCalledWith("w1", "n1", { status: "in_progress" });
    await user.click(screen.getByRole("button", { name: "Re-evaluate for this range" }));
    expect(await screen.findByText(/1 insights supported by current evidence; 1 rules skipped/)).toBeTruthy();
  });
});

describe("Action center", () => {
  it("lists actions with source links and saves status, due date and note", async () => {
    vi.mocked(api.apiWsActions).mockResolvedValue(ok([action], { total: 1, openByCategory: { critical_technical: 1 }, effortNote: "Effort is a heuristic by kind of work." }));
    vi.mocked(api.apiWsActionHistory).mockResolvedValue(ok([]));
    vi.mocked(api.apiWsUpdateAction).mockResolvedValueOnce(ok({ key: "site_issue:i1" })).mockResolvedValueOnce(fail("INSUFFICIENT_ROLE", "no"));
    const user = userEvent.setup();
    at("/intelligence/workspace/actions");
    expect(await screen.findByText(action.title)).toBeTruthy();
    expect(screen.getByText(/effort small \(heuristic\)/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open source" }).getAttribute("href")).toBe("/intelligence/technical-health");
    expect(screen.getByRole("option", { name: "Critical technical problems (1)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Set status"), "in_progress");
    await user.type(screen.getByLabelText("Due date"), "2026-12-01");
    await user.type(screen.getByLabelText("Note"), "Fixing");
    await user.click(save);
    expect(api.apiWsUpdateAction).toHaveBeenCalledWith("w1", { source: "site_issue", sourceRef: "i1", status: "in_progress", dueDate: "2026-12-01", note: "Fixing" });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    await user.type(screen.getByLabelText("Note"), " again");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Your role can view the SEO workspace but not change it.")).toBeTruthy();
  });
});

describe("Integration health and reports", () => {
  it("shows each integration's real state and guidance", async () => {
    vi.mocked(api.apiWsIntegrations).mockResolvedValue(ok([
      { id: "search_console", name: "Google Search Console", state: "auth_expired", detail: "Reconnect the Google account.", lastSuccessAt: "2026-10-01T00:00:00Z", lastFailureAt: null, link: "/settings/integrations" },
      { id: "background_jobs", name: "Background jobs", state: "unknown", detail: "The worker does not run in this API process.", lastSuccessAt: null, lastFailureAt: null, link: "/admin" },
    ]));
    at("/intelligence/workspace/integrations");
    expect(await screen.findByText("Authentication expired")).toBeTruthy();
    expect(screen.getByText("Status unknown")).toBeTruthy();
    expect(screen.getByText(/stored credentials alone never count as healthy/)).toBeTruthy();
  });

  it("previews a report with provenance and reports export errors", async () => {
    vi.mocked(api.apiWsReport).mockResolvedValue(ok({ title: "SEO report for shop.example", range: overview().range, generatedAt: "2026-10-22T10:00:00Z", sections: ["summary", "search"], summary: ["Search Console: 305 clicks."], completeness: { search: { status: "partial", freshness: "fresh", lastUpdatedAt: null } }, actions: null, sources: null, definitions: ["CTR = clicks ÷ impressions."], limitations: ["Search Console covers Google Search only."] }));
    vi.mocked(api.apiWsDownload).mockResolvedValue({ error: "Your role cannot export from the SEO workspace." });
    const user = userEvent.setup();
    at("/intelligence/workspace/report");
    await user.click(await screen.findByLabelText("Backlinks"));
    await user.click(screen.getByRole("button", { name: "Preview report" }));
    expect(api.apiWsReport).toHaveBeenCalledWith("w1", expect.objectContaining({ preset: "28d" }), ["summary", "search", "technical", "rankings", "content", "ai_visibility", "actions", "sources"]);
    const preview = await screen.findByRole("article", { name: "Report preview" });
    expect(within(preview).getByText("SEO report for shop.example")).toBeTruthy();
    expect(within(preview).getByText(/search: Partial data/)).toBeTruthy();
    expect(within(preview).getByText("Search Console covers Google Search only.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search queries" }));
    expect(api.apiWsDownload).toHaveBeenCalledWith("w1", { dataset: "search_queries" }, expect.objectContaining({ preset: "28d" }));
    expect(await screen.findByText("Your role cannot export from the SEO workspace.")).toBeTruthy();
  });
});
