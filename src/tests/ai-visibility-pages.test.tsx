// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  const fns = ["apiAivProviders", "apiAivBrands", "apiAivCreateBrand", "apiAivUpdateBrand", "apiAivOverview", "apiAivSetSchedule", "apiAivCompetitors", "apiAivAddCompetitor", "apiAivUpdateCompetitor",
    "apiAivQueries", "apiAivAddQueries", "apiAivUpdateQuery", "apiAivQueryVersions", "apiAivPreviewRun", "apiAivStartRun", "apiAivRuns", "apiAivRun", "apiAivCancelRun", "apiAivObservations", "apiAivObservation",
    "apiAivSetExcluded", "apiAivSources", "apiAivDomains", "apiAivVerifySource", "apiAivMetrics", "apiAivComparison", "apiAivOpportunities", "apiAivOpportunity", "apiAivUpdateOpportunity", "apiAivPreviewImport",
    "apiAivImport", "apiAivImports", "apiAivAiSummaries", "apiAivCreateAiSummary", "apiAivExport"];
  return { ...actual, ...Object.fromEntries(fns.map((f) => [f, vi.fn()])) };
});

import * as api from "../services/api";
import { AIVisibilityPage } from "../pages/intelligence/ai-visibility/AIVisibilityPage";

// Shapes match server/src/tests/ai-visibility.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

const surfaces = { model_api: "Model answer via API", chatgpt: "ChatGPT", perplexity: "Perplexity", google_ai_overviews: "Google AI Overviews" };
const provider = (id: string, status: string, collection = "provider_api") => ({ id, name: id === "openrouter_answer" ? "Model answer (OpenRouter)" : id, surface: collection === "provider_api" ? "model_api" : id, collection, capabilities: {}, explanation: `${id} explanation.`, limitations: [], costNote: "Cost note.", status, detail: status === "not_configured" ? "No OpenRouter API key is configured." : "ok", model: collection === "provider_api" ? "test/model" : null });
const providers = (apiStatus = "not_configured") => ({
  providers: [provider("openrouter_answer", apiStatus), provider("openrouter_web", "requires_approval"), provider("chatgpt", "manual_import_only", "manual_import")],
  usage: { day: "2026-10-20", limit: 30, used: 4, remaining: 26 }, surfaces, importSurfaces: ["chatgpt", "perplexity", "google_ai_overviews"], promptVersion: "aiv-prompt-1", metricDefinitions: {}, priorityFormula: "priority = …",
  ai: { available: false }, limits: { competitors: 10, queriesPerBrand: 200, requestsPerRun: 100, importRows: 5000, importBytes: 5_000_000, minSample: 10 },
});
const brand = { id: "b1", kind: "target", parent_id: null, website_id: null, website_domain: null, name: "Acme", domains: ["acme-test.com"], aliases: ["Acme Corp"], products: [], exclude_terms: [], disambiguation: null, topics: [], locations: [], language: null, country: null, status: "active", owner_id: null, schedule: "off", schedule_provider: null, schedule_repeats: null, schedule_max_requests: null, schedule_approved_at: null, config_version: 1, created_at: "x", updated_at: "x" };
const m = (numerator: number, denominator: number, smallSample = false) => ({ value: denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : null, numerator, denominator, smallSample });
const group = {
  key: { method: "manual_import", provider: "chatgpt", surface: "chatgpt", model: null },
  sample: { observations: 6, answered: 6, unanswered: 0, queries: 3, withCitations: 3, firstObservedAt: "2026-10-01T00:00:00Z", lastObservedAt: "2026-10-07T00:00:00Z", languages: [], countries: [] },
  brands: [
    { brandId: "b1", name: "Acme", kind: "target", mentionRate: m(2, 6, true), queryCoverage: m(2, 3, true), mentionShare: m(2, 9, true), citationRate: m(0, 0), citationShare: m(1, 2, true), firstMentionAt: null, lastMentionAt: "2026-10-03T00:00:00Z" },
    { brandId: "c1", name: "Globex", kind: "competitor", mentionRate: m(3, 6, true), queryCoverage: m(2, 3, true), mentionShare: m(3, 9, true), citationRate: m(0, 3, true), citationShare: m(0, 2, true), firstMentionAt: null, lastMentionAt: null },
  ],
  coMentions: [], sources: { citations: 4, distinctHosts: 2, topHosts: [{ host: "reviews-test.org", observations: 3 }], topSourceShare: m(3, 3) }, consistency: m(1, 3, true), trend: [],
};
const metrics = (groups: unknown[] = [group]) => ({ window: { from: "2026-07-22", to: null }, brands: [], groups, definitions: { mentionRate: { label: "Mention rate", numerator: "Answered observations naming the brand", denominator: "Answered observations", missing: "No data, not 0." } }, minSample: 10, surfaces, observations: 6, truncated: false, staleMentions: 0, note: "Metrics describe only the monitored queries." });
const overview = (over: Record<string, unknown> = {}) => ({
  brand, competitors: 1,
  counts: { active_queries: 3, queries_observed: 3, observations: 6, api_observations: 0, imported_observations: 6, excluded_observations: 0, last_observed_at: "2026-10-07T00:00:00Z" },
  providers: providers().providers, usage: providers().usage, runs: [], metrics: metrics(), changes: [], topOpportunities: [{ id: "o1", kind: "frequently_cited_source", title: "reviews-test.org is cited in 3 answers", priority: 61, confidence: "low", status: "open" }], ...over,
});
const query = (over: Record<string, unknown> = {}) => ({ id: "q1", text: "best crm for startups", topic: "crm", language: null, country: null, providers: [], status: "active", version: 1, source: "manual", last_run_at: null, last_observed_at: null, created_at: "x", observations: 0, answered: 0, mentioned: 0, ...over });
const obsRow = { id: "ob1", query_id: "q1", query_text: "best crm for startups", query_version: 1, provider: "chatgpt", surface: "chatgpt", model: "gpt-test", collection_method: "manual_import", observed_at: "2026-10-01T00:00:00Z", language: null, country: null, web_grounded: null, answer_status: "answered", response_retention: "full", excerpt: "Acme Corp and Globex are both good options.", excluded_at: null, mentions: [{ brandId: "b1", name: "Acme", kind: "target", count: 1 }, { brandId: "c1", name: "Globex", kind: "competitor", count: 1 }], citations: 2 };

beforeEach(() => {
  vi.mocked(api.apiAivProviders).mockResolvedValue(ok(providers()));
  vi.mocked(api.apiAivBrands).mockResolvedValue(ok([brand]));
  vi.mocked(api.apiAivOverview).mockResolvedValue(ok(overview()));
  vi.mocked(api.apiAivAiSummaries).mockResolvedValue(ok([], { available: false }));
  vi.mocked(api.apiAivCompetitors).mockResolvedValue(ok([{ ...brand, id: "c1", kind: "competitor", parent_id: "b1", name: "Globex", domains: ["globex-test.io"], aliases: [] }]));
  vi.mocked(api.apiAivQueries).mockResolvedValue(ok([query()], { total: 1, topics: ["crm"] }));
  vi.mocked(api.apiAivRuns).mockResolvedValue(ok([]));
  vi.mocked(api.apiAivImports).mockResolvedValue(ok([]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/intelligence/ai-visibility" element={<AIVisibilityPage />} /><Route path="/intelligence/ai-visibility/:tab" element={<AIVisibilityPage />} /></Routes></MemoryRouter>);

describe("AI visibility setup", () => {
  it("starts with brand setup when nothing is monitored, and sends the parsed configuration", async () => {
    vi.mocked(api.apiAivBrands).mockResolvedValueOnce(ok([])).mockResolvedValue(ok([brand]));
    vi.mocked(api.apiAivCreateBrand).mockResolvedValue(ok(brand));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility");
    expect(await screen.findByText("Start monitoring a brand")).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Official domains (comma-separated)"), "acme-test.com, www.acme-test.io");
    await user.type(screen.getByLabelText("Aliases and other names"), "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Create brand" }));
    await waitFor(() => expect(api.apiAivCreateBrand).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme", domains: ["acme-test.com", "www.acme-test.io"], aliases: ["Acme Corp"], products: [] })));
    expect(await screen.findByRole("region", { name: "Visibility summary" })).toBeTruthy();
  });

  it("states plainly that no provider is configured and points to imports", async () => {
    at("/intelligence/ai-visibility");
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/No answer provider is available/);
    expect(note.textContent).toMatch(/No OpenRouter API key/);
    expect(within(note).getByRole("link", { name: "import answers you observed" })).toBeTruthy();
  });
});

describe("AI visibility overview", () => {
  it("shows measured values with numerator/denominator, small samples and no-data, never zero for missing data", async () => {
    at("/intelligence/ai-visibility");
    const summary = await screen.findByRole("region", { name: "Visibility summary" });
    expect(summary.textContent).toMatch(/6 via API|0 via API · 6 imported/);
    const table = screen.getByRole("table", { name: /Metrics for Imported · ChatGPT/ });
    const acme = within(table).getByRole("row", { name: /^Acme/ });
    expect(acme.textContent).toContain("33.3%(2/6)small sample");
    expect(acme.textContent).toContain("No data(0/0)");
    expect(screen.getByText(/Metrics describe only the monitored queries/)).toBeTruthy();
    expect(screen.getByText(/AI analysis is not configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Summarise patterns" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/reviews-test.org is cited in 3 answers/)).toBeTruthy();
  });
  it("explains how to get data when nothing was collected", async () => {
    vi.mocked(api.apiAivOverview).mockResolvedValue(ok(overview({ counts: { active_queries: 0, queries_observed: 0, observations: 0, api_observations: 0, imported_observations: 0, excluded_observations: 0, last_observed_at: null }, metrics: metrics([]) })));
    at("/intelligence/ai-visibility");
    expect(await screen.findByText("No observations yet")).toBeTruthy();
  });
  it("shows an error with retry", async () => {
    vi.mocked(api.apiAivOverview).mockResolvedValueOnce(fail("INTERNAL_ERROR", "boom")).mockResolvedValue(ok(overview()));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility");
    expect(await screen.findByText("Unable to load the overview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Visibility summary" })).toBeTruthy();
  });
});

describe("Queries and runs", () => {
  it("adds queries and shows role errors as permission messages", async () => {
    vi.mocked(api.apiAivAddQueries).mockResolvedValueOnce(ok({ added: 1, alreadyExists: 1, invalid: [] })).mockResolvedValueOnce(fail("INSUFFICIENT_ROLE", "This action requires one of: owner, admin, member"));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/queries");
    await screen.findByRole("table", { name: "Monitored queries" });
    expect(screen.getByText("Not collected")).toBeTruthy();
    await user.type(screen.getByLabelText("One question per line"), "which crm do agencies use{enter}best crm for startups");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(api.apiAivAddQueries).toHaveBeenCalledWith("b1", [{ text: "which crm do agencies use", topic: null }, { text: "best crm for startups", topic: null }]);
    expect(await screen.findByText(/1 added, 1 already in the library/)).toBeTruthy();
    await user.type(screen.getByLabelText("One question per line"), "another");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Your role can view AI visibility data but not change it.")).toBeTruthy();
  });

  it("previews a run with blockers and only sends after an explicit, unblocked confirmation", async () => {
    const preview = (over: Record<string, unknown>) => ({ provider: { id: "openrouter_answer", name: "Model answer (OpenRouter)", status: "available", detail: "", costNote: "", limitations: ["Not a consumer product's answer."] }, model: "test/model", queries: 1, repeats: 2, requests: 2, usage: providers().usage, maxRequestsPerRun: 100, costEstimate: "No credits are spent.", canRun: true, blockers: [], ...over });
    vi.mocked(api.apiAivProviders).mockResolvedValue(ok(providers("available")));
    vi.mocked(api.apiAivPreviewRun).mockResolvedValueOnce(ok(preview({ canRun: false, blockers: ["Today's request quota has 0 of 30 requests left."] }))).mockResolvedValue(ok(preview({})));
    vi.mocked(api.apiAivStartRun).mockResolvedValue(ok({ run: { id: "r1", items_total: 2 }, deduplicated: false }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/queries");
    await screen.findByRole("table", { name: "Monitored queries" });
    await user.selectOptions(screen.getByLabelText("Answers per query"), "2");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const box = await screen.findByLabelText("Run preview");
    expect(box.textContent).toMatch(/0 of 30 requests left/);
    expect((within(box).getByRole("button", { name: "Send 2 requests" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiAivStartRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send 2 requests" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByLabelText("Run preview").textContent).toMatch(/Not a consumer product's answer/);
    await user.click(screen.getByRole("button", { name: "Send 2 requests" }));
    expect(api.apiAivStartRun).toHaveBeenCalledWith("b1", expect.objectContaining({ provider: "openrouter_answer", repeats: 2, idempotencyKey: expect.stringMatching(/^ui-/) }));
    expect(await screen.findByText("Run queued: 2 requests.")).toBeTruthy();
  });

  it("creates a new version when a query's text is edited", async () => {
    vi.mocked(api.apiAivUpdateQuery).mockResolvedValue(ok({ ...query({ version: 2 }), versionCreated: true }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/queries");
    await screen.findByRole("table", { name: "Monitored queries" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByLabelText("Query text");
    await user.clear(field);
    await user.type(field, "best crm for small startups");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.apiAivUpdateQuery).toHaveBeenCalledWith("b1", "q1", { text: "best crm for small startups" });
    expect(await screen.findByText(/Saved as version 2; earlier observations keep the version they used/)).toBeTruthy();
  });
});

describe("Observations", () => {
  it("lists observations with provenance and shows the full record, labeling imports as not API results", async () => {
    vi.mocked(api.apiAivObservations).mockResolvedValue(ok([obsRow], { nextCursor: null }));
    vi.mocked(api.apiAivObservation).mockResolvedValue(ok({
      ...obsRow, response_text: "Acme Corp and Globex are both good options.", response_chars: 43, response_sha256: "x", provider_request_id: null, usage: null, prompt_version: null, notes: null, run_id: null, run_trigger: null,
      import_id: "i1", import_label: "Team observations", import_filename: "obs.csv", exclusion_reason: null, detector_version: 1, mentionsCurrent: true,
      mentions: [{ brand_id: "b1", name: "Acme", kind: "target", match_count: 1, matched_terms: ["Acme Corp"], matched_by: ["alias"], excerpt: "Acme Corp and Globex" }],
      citations: [{ id: "c1", position: 1, original_url: "https://acme-test.com/pricing", title: null, kind: "imported", cited_brand_id: "b1", cited_brand: "Acme", source_id: "s1", normalized_url: "https://acme-test.com/pricing", host: "acme-test.com", registrable_domain: "acme-test.com", idn: false, verification_status: "unverified", verified_at: null }],
      events: [],
    }));
    vi.mocked(api.apiAivSetExcluded).mockResolvedValue(ok({ changed: true }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/observations");
    expect(await screen.findByText("best crm for startups", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Imported", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Mentions: Acme, Globex · 2 citations/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText(/Manually imported \(“Team observations”, obs.csv\) — not an API result/)).toBeTruthy();
    expect(screen.getByText(/1× via alias \(Acme Corp\)/)).toBeTruthy();
    expect(screen.getByText(/Imported citation · Acme's domain · Not verified/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Exclude from metrics" }));
    expect(screen.getByText("Give a reason (at least 3 characters).")).toBeTruthy();
    expect(api.apiAivSetExcluded).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Reason to exclude"), "Duplicate entry");
    await user.click(screen.getByRole("button", { name: "Exclude from metrics" }));
    expect(api.apiAivSetExcluded).toHaveBeenCalledWith("b1", "ob1", true, "Duplicate entry");
  });
  it("filters by brand mention and shows an empty filtered result", async () => {
    vi.mocked(api.apiAivObservations).mockResolvedValueOnce(ok([obsRow], { nextCursor: "next" })).mockResolvedValue(ok([], { nextCursor: null }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/observations");
    await screen.findByText("best crm for startups", { selector: "p" });
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Mentions brand"), "b1");
    await user.selectOptions(screen.getByLabelText("Mention"), "no");
    await waitFor(() => expect(api.apiAivObservations).toHaveBeenLastCalledWith("b1", expect.objectContaining({ mentions: "b1", notMentioned: true })));
    expect(await screen.findByText("No observations match these filters.")).toBeTruthy();
  });
});

describe("Citations, competitors and recommendations", () => {
  it("lists cited domains and URLs and verifies a source on request", async () => {
    vi.mocked(api.apiAivDomains).mockResolvedValue(ok({ window: { from: "2026-07-22", to: null }, domains: [{ host: "reviews-test.org", registrable_domain: "reviews-test.org", cited_brand: null, cited_brand_kind: null, observations: 3, queries: 2, urls: 2, first_observed_at: "2026-10-01T00:00:00Z", last_observed_at: "2026-10-03T00:00:00Z", imported_observations: 3 }], diversity: [{ week: "2026-W40", hosts: 2, observations: 3 }] }));
    vi.mocked(api.apiAivSources).mockResolvedValue(ok([{ id: "s1", normalized_url: "https://reviews-test.org/crm", host: "reviews-test.org", registrable_domain: "reviews-test.org", idn: false, title: null, first_observed_at: "2026-10-01T00:00:00Z", last_observed_at: "2026-10-02T00:00:00Z", verification_status: "unverified", verification_http_status: null, verified_at: null, cited_brand: null, cited_brand_kind: null, observations: 2, queries: 1, kinds: ["imported"] }], { total: 1 }));
    vi.mocked(api.apiAivVerifySource).mockResolvedValue(ok({ sourceId: "s1", url: "https://reviews-test.org/crm", status: "reachable_no_mention", httpStatus: 200 }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/citations");
    const table = await screen.findByRole("table", { name: "Cited domains" });
    expect(within(table).getByText("reviews-test.org")).toBeTruthy();
    expect(screen.getByText(/does not prove the page supports the answer/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(api.apiAivVerifySource).toHaveBeenCalledWith("b1", "s1");
    expect(await screen.findByText(/Loaded · does not name the brand \(HTTP 200\)/)).toBeTruthy();
  });

  it("compares competitors per comparable group with query-level evidence", async () => {
    vi.mocked(api.apiAivComparison).mockResolvedValue(ok({
      window: { from: "2026-07-22", to: null }, target: { id: "b1", name: "Acme" }, competitors: [{ id: "c1", name: "Initech" }], minSample: 10, truncated: false, note: "Comparisons only use observations from the same provider.",
      groups: [{ key: group.key, sample: { answered: 6, queries: 3, languages: [], countries: [], firstObservedAt: null, lastObservedAt: null }, competitors: [{
        brandId: "c1", name: "Initech", target: { mentioned: 2, rate: m(2, 6, true), cited: 1 }, competitor: { mentioned: 4, rate: m(4, 6, true), cited: 0 },
        competitorOnlyQueries: [{ queryId: "q3", query: "crm with ai features", observationIds: ["a", "b"] }], targetOnlyQueries: [], bothQueries: 1, sharedSourceHosts: [],
        history: { status: "insufficient", splitAt: null, earlier: null, later: null },
      }] }],
    }));
    at("/intelligence/ai-visibility/competitors");
    const section = await screen.findByRole("region", { name: "Imported · ChatGPT" });
    expect(within(section).getByText("crm with ai features")).toBeTruthy();
    expect(within(section).getByText(/Not enough history for a trend/)).toBeTruthy();
    expect(section.textContent).toContain("66.7%(4/6)");
  });

  it("asks for competitors when none are configured", async () => {
    vi.mocked(api.apiAivComparison).mockResolvedValue(ok({ window: { from: "x", to: null }, target: { id: "b1", name: "Acme" }, competitors: [], minSample: 10, truncated: false, note: "", groups: [] }));
    at("/intelligence/ai-visibility/competitors");
    expect(await screen.findByText("No competitors configured")).toBeTruthy();
  });

  it("shows recommendation evidence, limitations and the scoring formula, and records status changes", async () => {
    const opp = { id: "o1", kind: "frequently_cited_source", title: "reviews-test.org is cited in 3 answers", explanation: "Cited in 3 of 3 citing observations.", action: "Ask the publisher for a correction if inaccurate.", evidence: { observationIds: ["a"], queryIds: ["q1"], brandIds: ["b1"], hosts: ["reviews-test.org"], urls: [], counts: {} }, limitations: ["A citation does not prove the page supports the answer."], priority: 61, priority_factors: [{ name: "citation_frequency", weight: 0.4, value: 1, explanation: "3 of 3." }, { name: "target_absent", weight: 0.3, value: null, explanation: "n/a" }], confidence: "low", status: "open", owner_id: null, first_detected_at: "x", last_detected_at: "x", resolved_at: null };
    vi.mocked(api.apiAivOpportunities).mockResolvedValue(ok([opp], { formula: "priority = round(100 × Σ(weight × value) ÷ Σ(weight))" }));
    vi.mocked(api.apiAivOpportunity).mockResolvedValue(ok({ ...opp, formula: "priority = round(…)", events: [{ event: "detected", from_status: null, to_status: "open", note: null, created_at: "2026-10-08T00:00:00Z" }], observations: [{ id: "a", observed_at: "2026-10-01T00:00:00Z", query_text: "best crm for startups", provider: "chatgpt", surface: "chatgpt", collection_method: "manual_import", excluded_at: null }], queries: [{ id: "q1", text: "best crm for startups" }] }));
    vi.mocked(api.apiAivUpdateOpportunity).mockResolvedValue(ok({ updated: true }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/recommendations");
    expect(await screen.findByText(/internal heuristic: priority = round/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText(/Ask the publisher for a correction/)).toBeTruthy();
    expect(screen.getByText(/Supporting observations \(1\)/)).toBeTruthy();
    expect(screen.getByText(/target absent — weight 0.3, value no data/)).toBeTruthy();
    await user.type(screen.getByLabelText("Note"), "Emailed the editor");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(api.apiAivUpdateOpportunity).toHaveBeenCalledWith("b1", "o1", { status: "in_progress", note: "Emailed the editor" });
  });
});

describe("Import", () => {
  it("previews validation results and imports only with a source label", async () => {
    vi.mocked(api.apiAivPreviewImport).mockResolvedValue(ok({ format: "csv", rowsTotal: 3, accepted: 2, duplicatesInFile: 0, duplicatesExisting: 0, rejected: 1, rejectedSamples: [{ line: 4, reason: "invalid cited URL \"ftp://x\"" }], newQueries: 1, truncated: false, mapping: {}, sample: [{ line: 2, query: "best crm", surface: "chatgpt", model: null, observedAt: "2026-10-01T00:00:00Z", citations: 1, responseChars: 20 }], note: "Imported answers are labeled as manually supplied observations." }));
    vi.mocked(api.apiAivImport).mockResolvedValue(ok({ importId: "i1", duplicateImport: false, inserted: 2, duplicates: 0, rejected: 1, queriesCreated: 1 }));
    const user = userEvent.setup();
    at("/intelligence/ai-visibility/import");
    await screen.findByText("Import observed AI answers");
    expect(screen.getByText(/ChatGPT, Perplexity, Google AI Overviews/)).toBeTruthy();
    await user.type(screen.getByLabelText("Or paste CSV / JSON"), "query,observed_at,surface,response");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const box = await screen.findByLabelText("Import preview");
    expect(box.textContent).toMatch(/2 new · 0 already imported · 0 repeated in the file · 1 rejected · 1 new queries/);
    expect(box.textContent).toMatch(/Line 4: invalid cited URL/);
    const go = screen.getByRole("button", { name: "Import 2 observations" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(screen.getByLabelText("Source label (required)"), "Weekly check");
    expect(go.disabled).toBe(false);
    await user.click(go);
    expect(api.apiAivImport).toHaveBeenCalledWith("b1", expect.objectContaining({ sourceLabel: "Weekly check", createMissingQueries: true }));
    expect(await screen.findByText(/Imported 2 observations \(0 duplicates skipped, 1 rejected, 1 new queries\)/)).toBeTruthy();
  });
});
