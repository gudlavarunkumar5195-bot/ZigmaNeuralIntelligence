// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiListWebsites: vi.fn(),
    apiResearchCapabilities: vi.fn(),
    apiRunResearch: vi.fn(),
    apiListResearchRuns: vi.fn(),
    apiGetResearchRun: vi.fn(),
    apiCompareResearchRuns: vi.fn(),
    apiResearchInsights: vi.fn(),
    apiExportResearchCsv: vi.fn(),
    apiListKeywordLists: vi.fn(),
    apiCreateKeywordList: vi.fn(),
    apiAddToKeywordList: vi.fn(),
  };
});

import * as api from "../services/api";
import { KeywordResearchPage } from "../pages/search/KeywordResearchPage";
import { CompetitorGapPage } from "../pages/search/CompetitorGapPage";

// Synthetic fixtures with the exact shapes the backend returns (see
// server/src/tests/keyword-research.integration.test.ts). Not real data.
const gsc = {
  id: "google_search_console", name: "Google Search Console", kind: "first_party", capabilities: ["keyword_overview", "keyword_ideas", "related_keywords", "organic_keywords", "keyword_gap"],
  unsupported: ["competitor_domains", "serp_results"], metrics: ["clicks", "impressions", "ctr", "position"], metricScope: "Your own site's Google Search performance.",
  targeting: { countries: [], languages: [], devices: [], note: "Search Console data is not filtered by country, language or device here." },
  caching: { allowed: true, maxAgeMinutes: 60 }, attribution: "Source: Google Search Console.", costNote: "No per-request cost.", configured: true, missingConfiguration: [],
};
const caps = { providers: [gsc], capabilities: gsc.capabilities, metrics: gsc.metrics, limits: { maxResults: 500, runsPerDay: 200, maxCompetitors: 5, maxOverviewKeywords: 100 } };
const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1", website_id: "w1", kind: "organic", provider: "google_search_console", capability: "organic_keywords", params: {}, status: "completed", result_count: 2,
  sample: true, observed_through: "2030-01-28", notes: [], summary: {}, error_code: null, error: null, created_at: "2030-01-29T10:00:00Z", finished_at: "2030-01-29T10:00:01Z", ...over,
});
const result = (keyword: string, over: Record<string, unknown> = {}) => ({
  seq: 1, keyword_key: keyword, keyword, metrics: { clicks: 12, impressions: 340, ctr: 0.035, position: 4.2 }, intent: "commercial", intent_rule: "best",
  gap_category: null, absence_from_sample: null, competitors_present: null, observations: null, ...over,
});

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.apiListWebsites).mockResolvedValue(ok([{ id: "w1", domain: "one.example" }, { id: "w2", domain: "two.example" }]));
  vi.mocked(api.apiResearchCapabilities).mockResolvedValue(ok(caps));
  vi.mocked(api.apiListResearchRuns).mockResolvedValue(ok([]));
  vi.mocked(api.apiListKeywordLists).mockResolvedValue(ok([]));
  vi.mocked(api.apiGetResearchRun).mockResolvedValue(ok({ run: run(), results: [result("best shoes"), result("shoe repair", { seq: 2, intent: null, intent_rule: null, metrics: { impressions: 20 } })], insight: null }, { nextCursor: null }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderKeywords = () => render(<MemoryRouter><KeywordResearchPage /></MemoryRouter>);
const renderGap = () => render(<MemoryRouter><CompetitorGapPage /></MemoryRouter>);

describe("Keywords page", () => {
  it("shows a loading state, then the data source and what it cannot supply", async () => {
    renderKeywords();
    expect(screen.getByText("Loading keyword research…")).toBeTruthy();
    const source = await screen.findByRole("region", { name: "Data source" });
    expect(source.textContent).toMatch(/Data source: Google Search Console/);
    expect(source.textContent).toMatch(/Not available from this source: Search volume, Difficulty, CPC, Competition/);
    expect(source.textContent).toMatch(/Not supported: Competitor discovery, SERP results/);
    // Targeting is shown but cannot be chosen.
    expect(screen.getByRole("group", { name: "Targeting" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an error with retry when capabilities fail", async () => {
    vi.mocked(api.apiResearchCapabilities).mockResolvedValueOnce(fail("INTERNAL", "Service unavailable"));
    renderKeywords();
    expect(await screen.findByText("Unable to load keyword research")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Data source" })).toBeTruthy();
  });

  it("shows an empty state without websites", async () => {
    vi.mocked(api.apiListWebsites).mockResolvedValue(ok([]));
    renderKeywords();
    expect(await screen.findByText("No websites yet")).toBeTruthy();
  });

  it("runs research and shows only the metrics the source returned, with provenance", async () => {
    vi.mocked(api.apiRunResearch).mockResolvedValue({ data: { run: run(), results: [] }, error: null, meta: { reused: "cache", nextCursor: null } } as never);
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    expect(api.apiRunResearch).toHaveBeenCalledWith("organic", { websiteId: "w1" });
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.join("|")).toMatch(/Clicks.*Impressions.*CTR.*Avg\. position/);
    expect(headers.join("|")).not.toMatch(/Search volume|Difficulty|CPC/);
    expect(within(table).getByText("3.5%")).toBeTruthy();
    // A metric the source did not return is a dash, never zero.
    const repair = within(table).getByText("shoe repair").closest("tr")!;
    expect(within(repair).getAllByText("—")).toHaveLength(3);
    expect(within(repair).getByText("unclassified")).toBeTruthy();
    expect(screen.getByText(/data through 2030-01-28/)).toBeTruthy();
    expect(screen.getByText(/reused: an identical request was answered recently/)).toBeTruthy();
    expect(screen.getByText(/sample of the source's data/)).toBeTruthy();
  });

  it("sorts on the server when a header is clicked", async () => {
    vi.mocked(api.apiRunResearch).mockResolvedValue(ok({ run: run(), results: [] }, { reused: null }));
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    await userEvent.click(await screen.findByRole("button", { name: "Impressions" }));
    await waitFor(() => expect(api.apiGetResearchRun).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ sort: "impressions", order: "desc" })));
    expect(screen.getByRole("columnheader", { name: /Impressions/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("says plainly when a request is unsupported or a source is missing", async () => {
    vi.mocked(api.apiRunResearch).mockResolvedValue(fail("DATA_SOURCE_UNAVAILABLE", "This website has no linked Search Console property."));
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no linked Search Console property/);
    expect(within(alert).getByRole("link", { name: "Open Integrations" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("disables a mode the source does not support", async () => {
    vi.mocked(api.apiResearchCapabilities).mockResolvedValue(ok({ ...caps, providers: [{ ...gsc, capabilities: ["organic_keywords"] }] }));
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Keyword ideas" }));
    expect(screen.getByText("Keyword ideas is not supported by the enabled data source.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports an export the role cannot perform and labels AI output, including when AI is unavailable", async () => {
    vi.mocked(api.apiRunResearch).mockResolvedValue(ok({ run: run(), results: [] }, { reused: null }));
    vi.mocked(api.apiExportResearchCsv).mockResolvedValue({ error: "Your role cannot export research results." });
    vi.mocked(api.apiResearchInsights).mockResolvedValue(fail("AI_UNAVAILABLE", "x"));
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Your role cannot export research results.")).toBeTruthy();
    expect(screen.getByText("AI-generated")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Analyse with AI" }));
    expect(await screen.findByText(/AI analysis is not configured on this server/)).toBeTruthy();
  });

  it("saves selected keywords to a new list", async () => {
    vi.mocked(api.apiRunResearch).mockResolvedValue(ok({ run: run(), results: [] }, { reused: null }));
    vi.mocked(api.apiCreateKeywordList).mockResolvedValue(ok({ id: "l1", name: "Shoes", created_at: "2030-01-29T10:00:00Z" }));
    vi.mocked(api.apiAddToKeywordList).mockResolvedValue(ok({ added: 1 }));
    renderKeywords();
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select best shoes" }));
    await userEvent.type(screen.getByLabelText("New list name"), "Shoes");
    await userEvent.click(screen.getByRole("button", { name: "Add to list" }));
    expect(await screen.findByText("Added 1 keyword(s) to the list.")).toBeTruthy();
    expect(api.apiAddToKeywordList).toHaveBeenCalledWith("l1", "run-1", ["best shoes"]);
  });
});

describe("Competitors (keyword gap) page", () => {
  it("explains the categories and that competitors must be the organization's own Search Console sites", async () => {
    renderGap();
    expect(await screen.findByRole("heading", { name: "Keyword gap" })).toBeTruthy();
    expect(screen.getByText(/another website of your organization with a linked Search Console property/)).toBeTruthy();
    expect(screen.getByText(/Automatic competitor discovery needs a licensed keyword data provider/)).toBeTruthy();
    expect(screen.getByText(/not observed in the sample/)).toBeTruthy();
  });

  it("runs a gap and shows counts, categories and sample-absence labels", async () => {
    const gapRun = run({ id: "gap-1", kind: "gap", status: "partial", notes: ["rival.example: no permitted data source for this domain."], summary: { counts: { shared: 1, missing: 1, unique: 0 } } });
    vi.mocked(api.apiRunResearch).mockResolvedValue(ok({ run: gapRun, results: [] }, { reused: null }));
    vi.mocked(api.apiGetResearchRun).mockResolvedValue(ok({
      run: gapRun,
      results: [
        result("best shoes", { gap_category: "shared", competitors_present: 1 }),
        result("trail shoes", { seq: 2, gap_category: "missing", absence_from_sample: true, competitors_present: 1, metrics: {} }),
      ],
      insight: null,
    }, { nextCursor: null }));
    renderGap();
    await userEvent.type(await screen.findByLabelText(/Competitor domains/), "two.example, rival.example");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(api.apiRunResearch).toHaveBeenCalledWith("gap", { websiteId: "w1", competitors: ["two.example", "rival.example"] });
    expect(await screen.findByRole("button", { name: "Missing (1)" })).toBeTruthy();
    expect(screen.getByText("Partial result")).toBeTruthy();
    expect(screen.getByText(/rival.example: no permitted data source/)).toBeTruthy();
    expect(screen.getByText("not observed in a sample")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Missing (1)" }));
    await waitFor(() => expect(api.apiGetResearchRun).toHaveBeenLastCalledWith("gap-1", expect.objectContaining({ gap: "missing" })));
  });

  it("validates the competitor count before calling the server and shows server errors", async () => {
    renderGap();
    await userEvent.type(await screen.findByLabelText(/Competitor domains/), "a.example b.example c.example d.example e.example f.example");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("At most 5 competitors at a time.")).toBeTruthy();
    expect(api.apiRunResearch).not.toHaveBeenCalled();
    vi.mocked(api.apiRunResearch).mockResolvedValue(fail("COMPETITOR_DATA_UNAVAILABLE", "No competitor has a permitted data source."));
    await userEvent.clear(screen.getByLabelText(/Competitor domains/));
    await userEvent.type(screen.getByLabelText(/Competitor domains/), "rival.example");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("No competitor has a permitted data source.")).toBeTruthy();
  });

  it("states that gap analysis is unsupported when no provider offers it", async () => {
    vi.mocked(api.apiResearchCapabilities).mockResolvedValue(ok({ ...caps, providers: [{ ...gsc, capabilities: ["organic_keywords"] }] }));
    renderGap();
    expect(await screen.findByText("Keyword gap analysis is not supported by the enabled data source.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Compare" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
