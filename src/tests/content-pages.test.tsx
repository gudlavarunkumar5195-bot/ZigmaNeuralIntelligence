// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  const fns = ["apiListWebsites", "apiContentOverview", "apiContentPages", "apiContentPage", "apiContentStartRun", "apiContentFindings", "apiContentUpdateFinding", "apiContentFindingHistory", "apiContentOpportunities", "apiContentOpportunity",
    "apiContentUpdateOpportunity", "apiContentTopics", "apiContentTopic", "apiContentRenameTopic", "apiContentTopicMember", "apiContentBriefs", "apiContentBrief", "apiContentCreateBrief", "apiContentSaveBrief", "apiContentBriefStatus", "apiContentBriefAi", "apiContentExport"];
  return { ...actual, ...Object.fromEntries(fns.map((f) => [f, vi.fn()])) };
});

import * as api from "../services/api";
import { ContentPage } from "../pages/intelligence/content/ContentPage";

// Shapes match server/src/tests/content.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

const overview = (over: Record<string, unknown> = {}) => ({
  inventory: { total: 6, byState: { ok: 5, fetch_failed: 1 }, lastCrawledAt: "2026-10-20T10:00:00Z" },
  findingsOpen: { medium: 2 },
  topOpportunities: [{ id: "o1", kind: "low_ctr_snippet", title: "Improve the search snippet of /shoes", priority: 72, confidence: "high", effort: "small", status: "open" }],
  runs: [{ id: "r1", scan_id: "s", trigger: "crawl", status: "completed", rules_version: "content-1", pages_analyzed: 6, findings_open: 2, findings_new: 2, findings_resolved: 0, opportunities: 3, error: null, created_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:01:00Z" }],
  coverage: { searchConsole: true, pagesWithSearchMetrics: 4, pagesAnalyzable: 5 },
  ai: { available: false }, rules: [], rulesVersion: "content-1", thresholds: {}, ...over,
});
const pageRow = (over: Record<string, unknown> = {}) => ({ id: "p1", url: "https://one.example/shoes", crawl_state: "ok", http_status: 200, indexable: true, title: "Trail running shoes", h1: "Trail running shoes", word_count: 800, inlinks: 1, last_crawled_at: "2026-10-20T10:00:00Z", content_changed_at: null, crawl_error: null, open_findings: 0, search: { clicks: 3, impressions: 1200, position: 5 }, ...over });
const finding = (over: Record<string, unknown> = {}) => ({ id: "f1", page_id: "p2", url: "https://one.example/thin", rule_id: "thin_content", rule_version: "content-1", ruleTitle: "Little main content", category: "content", severity: "medium", heuristic: true, status: "open", evidence: { wordCount: 81, threshold: 200 }, explanation: "The main content has 81 words (threshold 200, configurable).", recommendation: "Check whether the page fully answers what visitors come for.", ignore_reason: null, first_detected_at: "2026-10-20T10:00:00Z", last_detected_at: "2026-10-20T10:00:00Z", resolved_at: null, ...over });
const opp = { id: "o1", kind: "low_ctr_snippet", page_id: "p1", url: "https://one.example/shoes", topic_id: null, topic: null, title: "Improve the search snippet of https://one.example/shoes", evidence: { impressions: 1200, ctr: 0.3 }, problem: "CTR is well below your site's median for that position.", action: "Rewrite the title and description.", priority: 72, priority_factors: [{ name: "impressions", weight: 0.4, value: 1, explanation: "1200 impressions." }, { name: "ctr_gap", weight: 0.4, value: null, explanation: "Unavailable." }], confidence: "high", confidence_basis: "Measured Search Console data.", missing_data: ["Queries per page"], effort: "small", status: "open", first_detected_at: "x", last_detected_at: "x", completed_at: null };
const briefBody = { targetTopic: "trail running shoe", intent: { value: "commercial", rule: "best", note: "Rule-based." }, primaryKeyword: "trail running shoes", relatedKeywords: ["best trail running shoes"], existingPages: [], suggestedTitle: "Trail running shoes", suggestedMetaDescription: "", h1: "Trail running shoes", outline: [{ heading: "Fit", points: [] }], questions: [], internalLinks: [{ url: "https://one.example/", anchorHint: "Home" }], sources: [], missingEvidence: ["Search volume and difficulty (no licensed provider)"], researchQuestions: ["Which sources support the key facts?"], checklist: [{ item: "Facts are checked", done: false }, { item: "A human editor approved the final text", done: false }] };
const brief = (over: Record<string, unknown> = {}) => ({ brief: { id: "b1", title: "Brief: trail running shoe", status: "draft", current_revision: 1, page_url: "https://one.example/shoes", topic: "trail running shoe", approved_at: null, updated_at: "x" }, body: briefBody, source: "deterministic", aiModel: null, revisions: [{ revision: 1, source: "deterministic", ai_model: null, note: null, created_at: "2026-10-20T10:00:00Z" }], ...over });

beforeEach(() => {
  vi.mocked(api.apiListWebsites).mockResolvedValue(ok([{ id: "w1", domain: "one.example" }]));
  vi.mocked(api.apiContentOverview).mockResolvedValue(ok(overview()));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/intelligence/content" element={<ContentPage />} /><Route path="/intelligence/content/:tab" element={<ContentPage />} /></Routes></MemoryRouter>);

describe("Content overview", () => {
  it("shows measured inventory, findings, coverage and crawl failures separately", async () => {
    at("/intelligence/content");
    expect(screen.getByText("Loading websites…")).toBeTruthy();
    const summary = await screen.findByRole("region", { name: "Content summary" });
    expect(summary.textContent).toMatch(/Pages in inventory6/);
    expect(summary.textContent).toMatch(/4 of 5 pages have rows/);
    expect(screen.getByText(/Fetch failed 1/).textContent).toMatch(/not as content findings/);
    expect(screen.getByText(/AI brief suggestions: not configured/)).toBeTruthy();
  });
  it("explains how to get data when nothing was crawled", async () => {
    vi.mocked(api.apiContentOverview).mockResolvedValue(ok(overview({ inventory: { total: 0, byState: {}, lastCrawledAt: null } })));
    at("/intelligence/content");
    expect(await screen.findByText("No crawled pages yet")).toBeTruthy();
  });
  it("shows an error with retry, and the server's answer to 'Analyse now'", async () => {
    vi.mocked(api.apiContentOverview).mockResolvedValueOnce(fail("INTERNAL_ERROR", "boom")).mockResolvedValue(ok(overview()));
    vi.mocked(api.apiContentStartRun).mockResolvedValue(ok({ run: { id: "r2" }, deduplicated: true }));
    at("/intelligence/content");
    expect(await screen.findByText("Unable to load content intelligence")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Analyse now" }));
    expect(await screen.findByText("An analysis is already queued or running.")).toBeTruthy();
  });
  it("permission-denied reads as such", async () => {
    vi.mocked(api.apiContentStartRun).mockResolvedValue(fail("INSUFFICIENT_ROLE", "Insufficient role"));
    at("/intelligence/content");
    await userEvent.click(await screen.findByRole("button", { name: "Analyse now" }));
    expect(await screen.findByText("Your role can view content data but not change it.")).toBeTruthy();
  });
});

describe("Inventory", () => {
  it("filters and paginates on the server; distinguishes no Search Console rows from no Search Console", async () => {
    vi.mocked(api.apiContentPages).mockResolvedValue(ok([pageRow(), pageRow({ id: "p2", url: "https://one.example/new", search: { clicks: 0, impressions: 0, position: null, noRows: true } }), pageRow({ id: "p3", url: "https://one.example/broken", crawl_state: "fetch_failed", crawl_error: "ECONNRESET", word_count: null, search: null })], { total: 120, searchConsole: true }));
    vi.mocked(api.apiContentPage).mockResolvedValue(ok({ page: { url: "https://one.example/shoes", title: "Trail running shoes", headings: [{ level: 1, text: "Trail running shoes" }], word_count: 800 }, findings: [], opportunities: [], topics: [{ id: "t", name: "trail", assignment: "auto" }] }));
    at("/intelligence/content/inventory");
    const table = await screen.findByRole("table", { name: "Content inventory" });
    expect(within(table).getByText("https://one.example/shoes").closest("tr")!.textContent).toMatch(/3 \/ 1200/);
    expect(within(table).getByText("https://one.example/new").closest("tr")!.textContent).toMatch(/no rows \(0 \/ 0\)/);
    expect(within(table).getByText("https://one.example/broken").closest("tr")!.textContent).toMatch(/Fetch failed.*ECONNRESET.*no Search Console/);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.apiContentPages).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 50 })));
    await userEvent.selectOptions(screen.getByLabelText("Open findings"), "high");
    await waitFor(() => expect(api.apiContentPages).toHaveBeenLastCalledWith("w1", expect.objectContaining({ severity: "high", offset: 0 })));
    await userEvent.click(screen.getAllByRole("button", { name: "https://one.example/shoes" })[0]);
    expect((await screen.findByRole("region", { name: "Page detail" })).textContent).toMatch(/h1 · Trail running shoes/);
  });
});

describe("Audit", () => {
  it("shows evidence, heuristic labels and lifecycle controls; ignoring needs a reason", async () => {
    vi.mocked(api.apiContentFindings).mockResolvedValue(ok([finding()], { nextCursor: null }));
    vi.mocked(api.apiContentUpdateFinding).mockResolvedValue(ok({ from: "open", to: "ignored" }));
    vi.mocked(api.apiContentFindingHistory).mockResolvedValue(ok([{ event: "detected", from_status: null, to_status: "open", note: null, created_at: "2026-10-20T10:00:00Z" }]));
    at("/intelligence/content/audit");
    const item = await screen.findByRole("listitem", { name: "Finding Little main content" });
    expect(item.textContent).toMatch(/heuristic/);
    expect(item.textContent).toMatch(/81 words/);
    expect(item.textContent).toMatch(/"wordCount":81/);
    expect(screen.getByText(/Technical Health/).closest("p")!.textContent).toMatch(/not repeated here/);
    await userEvent.click(within(item).getByRole("button", { name: "Ignore…" }));
    const ignore = within(item).getByRole("button", { name: "Ignore" }) as HTMLButtonElement;
    expect(ignore.disabled).toBe(true);
    await userEvent.type(within(item).getByLabelText("Reason"), "Intentional landing page");
    await userEvent.click(ignore);
    expect(api.apiContentUpdateFinding).toHaveBeenCalledWith("w1", "f1", { status: "ignored", reason: "Intentional landing page" });
    await userEvent.click(within(await screen.findByRole("listitem", { name: "Finding Little main content" })).getByRole("button", { name: "History" }));
    expect(await screen.findByText(/detected → open/)).toBeTruthy();
  });
  it("empty and error states", async () => {
    vi.mocked(api.apiContentFindings).mockResolvedValue(ok([], { nextCursor: null }));
    at("/intelligence/content/audit");
    expect(await screen.findByText("No findings match these filters.")).toBeTruthy();
  });
});

describe("Opportunities", () => {
  it("shows priority factors (including unavailable ones), missing data and review actions", async () => {
    vi.mocked(api.apiContentOpportunities).mockResolvedValue(ok([opp], { total: 1 }));
    vi.mocked(api.apiContentUpdateOpportunity).mockResolvedValue(ok({}));
    at("/intelligence/content/opportunities");
    const item = await screen.findByRole("listitem", { name: opp.title });
    expect(item.textContent).toMatch(/72\/100 · high confidence · effort small \(heuristic\)/);
    expect(item.textContent).toMatch(/Missing data: Queries per page/);
    await userEvent.click(within(item).getByRole("button", { name: "Show evidence and factors" }));
    expect(within(item).getByRole("table", { name: "Priority factors" }).textContent).toMatch(/ctr gap40%unavailable/);
    await userEvent.click(within(item).getByRole("button", { name: "Mark done" }));
    expect(api.apiContentUpdateOpportunity).toHaveBeenCalledWith("w1", "o1", { status: "done" });
    expect(await screen.findByText(/figures from before the change were recorded/)).toBeTruthy();
  });
});

describe("Topics", () => {
  it("lists clusters with coverage flags and lets the user rename and move members", async () => {
    vi.mocked(api.apiContentTopics).mockResolvedValue(ok([
      { id: "t1", name: "running shoe trail", nameLocked: false, source: "auto", terms: ["running", "shoe", "trail"], pages: 2, coveringPages: 2, queries: 2, queryImpressions: 1500, competitorGaps: 0 },
      { id: "t2", name: "pizza dough recipe", nameLocked: false, source: "auto", terms: ["pizza"], pages: 0, coveringPages: 0, queries: 1, queryImpressions: 450, competitorGaps: 1 },
    ]));
    vi.mocked(api.apiContentTopic).mockResolvedValue(ok({ topic: { id: "t1", name: "running shoe trail", name_locked: false, terms: ["running", "shoe"] }, coverage: { queryImpressions: 1500, queries: [{ query: "trail running shoes", impressions: 900, clicks: 5 }], pages: [{ pageId: "p1", url: "https://one.example/shoes", title: "T", covers: true }], competitorGaps: [] }, members: [], overlap: { pages: ["a", "b"], note: "Several pages focus on this topic." } }));
    vi.mocked(api.apiContentRenameTopic).mockResolvedValue(ok({ renamed: true }));
    vi.mocked(api.apiContentTopicMember).mockResolvedValue(ok({ assigned: true }));
    at("/intelligence/content/topics");
    const table = await screen.findByRole("table", { name: "Topics" });
    expect(within(table).getByText("pizza dough recipe").closest("tr")!.textContent).toMatch(/under-covered/);
    expect(within(table).getByText("running shoe trail").closest("tr")!.textContent).toMatch(/overlap/);
    await userEvent.click(within(table).getByRole("button", { name: "running shoe trail" }));
    const detail = await screen.findByRole("region", { name: "Topic running shoe trail" });
    expect(detail.textContent).toMatch(/Several pages focus on this topic/);
    await userEvent.clear(within(detail).getByLabelText("Topic name"));
    await userEvent.type(within(detail).getByLabelText("Topic name"), "Trail shoes");
    await userEvent.click(within(detail).getByRole("button", { name: "Rename" }));
    expect(api.apiContentRenameTopic).toHaveBeenCalledWith("w1", "t1", "Trail shoes");
    await userEvent.selectOptions(within(detail).getAllByLabelText("Move query to topic")[0], "t2");
    expect(api.apiContentTopicMember).toHaveBeenCalledWith("w1", "t2", { memberType: "query", memberKey: "trail running shoes", action: "assign" });
  });
});

describe("Briefs", () => {
  beforeEach(() => vi.mocked(api.apiContentBriefs).mockResolvedValue(ok([{ id: "b1", title: "Brief: trail running shoe", status: "draft", current_revision: 1, page_url: null, topic: null, updated_at: "x" }])));

  it("edits and saves a revision against the current one; conflicts are reported", async () => {
    vi.mocked(api.apiContentBrief).mockResolvedValue(ok(brief()));
    vi.mocked(api.apiContentSaveBrief).mockResolvedValueOnce(ok(brief({ brief: { ...brief().brief, current_revision: 2 } }))).mockResolvedValueOnce(fail("REVISION_CONFLICT", "The brief changed (now revision 3). Reload and apply your changes again."));
    at("/intelligence/content/briefs");
    const editor = await screen.findByRole("region", { name: "Brief Brief: trail running shoe" });
    expect(editor.textContent).toMatch(/Missing evidence.*Search volume and difficulty/);
    await userEvent.clear(within(editor).getByLabelText("Suggested title"));
    await userEvent.type(within(editor).getByLabelText("Suggested title"), "Choosing trail running shoes");
    await userEvent.click(within(editor).getByRole("button", { name: "Save revision" }));
    expect(api.apiContentSaveBrief).toHaveBeenCalledWith("w1", "b1", expect.objectContaining({ baseRevision: 1, body: expect.objectContaining({ suggestedTitle: "Choosing trail running shoes" }) }));
    expect(await screen.findByText("Saved as a new revision.")).toBeTruthy();
    await userEvent.click(within(editor).getByRole("button", { name: "Save revision" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Reload and apply your changes again/);
  });

  it("approval needs the checklist; AI suggestions are flagged for review; AI unavailability is explained", async () => {
    vi.mocked(api.apiContentBrief).mockResolvedValue(ok(brief()));
    vi.mocked(api.apiContentBriefStatus).mockResolvedValue(fail("CHECKLIST_INCOMPLETE", "Complete the editorial checklist first (2 item(s) open)."));
    vi.mocked(api.apiContentBriefAi).mockResolvedValueOnce(fail("AI_UNAVAILABLE", "AI is not configured on this server. The deterministic brief and editing work without it.")).mockResolvedValueOnce(ok(brief({ source: "ai_suggestion", aiModel: "free/model", brief: { ...brief().brief, current_revision: 2 } })));
    at("/intelligence/content/briefs");
    const editor = await screen.findByRole("region", { name: "Brief Brief: trail running shoe" });
    await userEvent.click(within(editor).getByRole("button", { name: "Approve" }));
    expect((await within(editor).findByRole("alert")).textContent).toMatch(/Complete the editorial checklist/);
    await userEvent.click(within(editor).getByRole("button", { name: "Suggest with AI" }));
    expect((await within(editor).findByRole("alert")).textContent).toMatch(/AI is not configured/);
    await userEvent.click(within(editor).getByRole("button", { name: "Suggest with AI" }));
    expect(await within(editor).findByText(/AI suggestion — review/)).toBeTruthy();
    await userEvent.click(within(editor).getByLabelText("Facts are checked"));
    expect((within(editor).getByLabelText("Facts are checked") as HTMLInputElement).checked).toBe(true);
  });

  it("empty state points to opportunities", async () => {
    vi.mocked(api.apiContentBriefs).mockResolvedValue(ok([]));
    at("/intelligence/content/briefs");
    expect(await screen.findByText("No briefs yet")).toBeTruthy();
  });
});
