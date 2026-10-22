import { describe, expect, it } from "vitest";
import {
  change,
  collect,
  deterministicSummary,
  evaluateInsights,
  freshness,
  issueCategory,
  contentOpportunityCategory,
  keywordChange,
  md,
  resolveRange,
  sortActions,
  urlKey,
  validateWorkspaceSummary,
  DateRangeError,
  type ActionItem,
  type InsightInput,
} from "../workspace/core.js";

// Synthetic fixtures only.
const NOW = new Date("2026-10-22T20:00:00Z"); // 2026-10-22 13:00 in Los Angeles

describe("date ranges", () => {
  it("resolves presets ending yesterday (Pacific Time) with an equal preceding period", () => {
    const r = resolveRange({ preset: "28d" }, NOW);
    expect(r).toMatchObject({ from: "2026-09-24", to: "2026-10-21", days: 28, previous: { from: "2026-08-27", to: "2026-09-23" }, timezone: "America/Los_Angeles" });
    expect(resolveRange({ preset: "7d", compare: "none" }, NOW)).toMatchObject({ from: "2026-10-15", to: "2026-10-21", days: 7, previous: null });
    expect(resolveRange({}, NOW).days).toBe(28);
  });
  it("uses the PT calendar near midnight UTC", () => {
    expect(resolveRange({ preset: "7d" }, new Date("2026-10-23T03:00:00Z")).to).toBe("2026-10-21"); // still Oct 22 in LA
  });
  it("validates custom ranges and bounds", () => {
    expect(resolveRange({ preset: "custom", from: "2026-10-01", to: "2026-10-10" }, NOW)).toMatchObject({ days: 10, previous: { from: "2026-09-21", to: "2026-09-30" } });
    expect(resolveRange({ preset: "custom", from: "2026-10-22", to: "2026-10-22" }, NOW).notes[0]).toMatch(/includes today/);
    const bad = (input: Parameters<typeof resolveRange>[0]) => () => resolveRange(input, NOW);
    expect(bad({ preset: "custom", from: "2026-10-10" })).toThrow(DateRangeError);
    expect(bad({ preset: "custom", from: "2026-10-10", to: "2026-10-01" })).toThrow(/after the end/);
    expect(bad({ preset: "custom", from: "2026-10-10", to: "2026-10-30" })).toThrow(/future/);
    expect(bad({ preset: "custom", from: "2024-01-01", to: "2026-10-01" })).toThrow(/at most 480/);
    expect(bad({ preset: "custom", from: "2025-06-01", to: "2025-06-30" })).toThrow(/older than 480/);
    expect(bad({ preset: "custom", from: "2026-02-30", to: "2026-03-01" })).toThrow(DateRangeError);
    expect(bad({ preset: "28d", from: "2026-10-01" })).toThrow(/only accepted with preset=custom/);
  });
});

describe("freshness, changes and sections", () => {
  it("classifies freshness from real timestamps", () => {
    expect(freshness(null, 48, NOW)).toMatchObject({ state: "never", lastUpdatedAt: null });
    expect(freshness("2026-10-22T00:00:00Z", 48, NOW)).toMatchObject({ state: "fresh", ageHours: 20 });
    expect(freshness("2026-10-01", 48, NOW).state).toBe("stale");
  });
  it("never turns missing values into zero changes", () => {
    expect(change(10, null)).toEqual({ change: null, changePct: null });
    expect(change(null, 5)).toEqual({ change: null, changePct: null });
    expect(change(0, 0)).toEqual({ change: 0, changePct: null });
    expect(change(15, 10)).toEqual({ change: 5, changePct: 0.5 });
  });
  it("isolates a failing or slow module", async () => {
    const ok = await collect("a", "/a", "full", "n", 1000, async () => ({ status: "ok", freshness: null, notes: [], data: { x: 1 } }));
    expect(ok).toMatchObject({ module: "a", status: "ok", data: { x: 1 }, range: { support: "full" } });
    const err = await collect("b", "/b", "snapshot", "n", 1000, async () => { throw new Error("secret connection string postgres://u:p@h"); });
    expect(err).toMatchObject({ status: "error", data: null });
    expect(JSON.stringify(err)).not.toMatch(/postgres:\/\//);
    const slow = await collect("c", "/c", "full", "n", 20, () => new Promise(() => undefined));
    expect(slow).toMatchObject({ status: "timeout", data: null });
  });
});

describe("helpers", () => {
  it("compares page URLs across modules", () => {
    expect(urlKey("https://WWW.Example.com/a/#x")).toBe("example.com/a");
    expect(urlKey("http://example.com")).toBe("example.com/");
    expect(urlKey("https://example.com/a?q=1")).toBe("example.com/a?q=1");
    expect(urlKey("javascript:alert(1)")).toBeNull();
    expect(urlKey(null)).toBeNull();
  });
  it("classifies keyword changes like rank tracking (same source, conclusive only)", () => {
    expect(keywordChange({ status: "ranked", position: 3, depth: 100 }, { status: "ranked", position: 7 })).toBe("improved");
    expect(keywordChange({ status: "ranked", position: 9, depth: 100 }, { status: "ranked", position: 3 })).toBe("declined");
    expect(keywordChange({ status: "not_in_results", position: null, depth: 100 }, { status: "ranked", position: 30 })).toBe("dropped_out");
    expect(keywordChange({ status: "not_in_results", position: null, depth: 10 }, { status: "ranked", position: 30 })).toBe("no_comparison");
    expect(keywordChange({ status: "ranked", position: 5, depth: 100 }, { status: "not_in_results", position: null })).toBe("entered");
    expect(keywordChange({ status: "ranked", position: 5, depth: 100 }, null)).toBe("no_comparison");
  });
  it("maps categories and sorts actions deterministically", () => {
    expect(issueCategory("status_codes", "high")).toBe("critical_technical");
    expect(issueCategory("content", "high")).toBe("page_improvement");
    expect(issueCategory("links", "medium")).toBe("page_improvement");
    expect(contentOpportunityCategory("low_ctr_snippet")).toBe("search_performance");
    expect(contentOpportunityCategory("under_covered_topic")).toBe("content_gap");
    const a = (key: string, priority: number, detectedAt: string | null) => ({ key, priority, detectedAt }) as ActionItem;
    expect(sortActions([a("b", 50, "2026-01-02"), a("a", 50, "2026-01-02"), a("c", 90, null), a("d", 50, "2026-01-01")]).map((x) => x.key)).toEqual(["c", "d", "a", "b"]);
  });
  it("escapes untrusted text for Markdown reports", () => {
    expect(md("[click](javascript:x) | <script>\n# h")).toBe("\\[click\\]\\(javascript:x\\) \\| \\<script\\> \\# h");
    expect(md(null)).toBe("");
  });
});

const S = "https://shop.example";
const base = (): InsightInput => ({
  websiteId: "w1", domain: "shop.example", range: { from: "2026-09-24", to: "2026-10-21" },
  search: { available: true, siteCtr: 0.05, pages: [
    { url: `${S}/shoes`, clicks: 4, impressions: 2000, ctr: 0.002, position: 6 },
    { url: `${S}/`, clicks: 300, impressions: 3000, ctr: 0.1, position: 2 },
    { url: `${S}/noindex`, clicks: 1, impressions: 50, ctr: 0.02, position: 9 },
  ] },
  issues: [
    { id: "i1", ruleId: "title_missing", severity: "high", url: `${S}/shoes`, firstSeenAt: "2026-10-01T00:00:00Z" },
    { id: "i2", ruleId: "broken_internal_link", severity: "high", url: `${S}/gone`, firstSeenAt: "2026-10-02T00:00:00Z", details: { linkedFrom: [`${S}/`, `${S}/shoes`] } },
  ],
  contentFindings: [],
  crawlPages: [{ url: `${S}/noindex`, indexable: false, reasons: ["noindex"], statusCode: 200, scanId: "s1", crawledAt: "2026-10-20T00:00:00Z" }, { url: `${S}/shoes`, indexable: true, reasons: [], statusCode: 200, scanId: "s1", crawledAt: "2026-10-20T00:00:00Z" }],
  keywords: [{ keywordId: "k1", keyword: "trail shoes", projectId: "p1", change: "declined", position: 9, previousPosition: 3, url: `${S}/shoes`, landingPage: null, observedDate: "2026-10-18", previousDate: "2026-10-10", observationId: "o1" }],
  competitorWins: [{ domain: "rival.example", projectId: "p1", keywords: [{ keyword: "trail shoes", own: 9, competitor: 2, observedDate: "2026-10-18", observationId: "c1" }, { keyword: "running shoes", own: null, competitor: 4, observedDate: "2026-10-18", observationId: "c2" }] }],
  competitorDatasets: [{ domain: "rival.example", datasetId: "d2", referringDomains: 40, collectedOn: "2026-10-01", coverage: "partial" }],
  ownBacklinks: { datasetId: "d1", referringDomains: new Set(["blog.example", "news.example"]), collectedOn: "2026-10-01" },
  citedHosts: [{ host: "reviews.example", brandId: "b1", observationIds: ["a1", "a2"], lastObservedAt: "2026-10-15T00:00:00Z" }, { host: "news.example", brandId: "b1", observationIds: ["a3", "a4"], lastObservedAt: null }, { host: "once.example", brandId: "b1", observationIds: ["a5"], lastObservedAt: null }],
});

describe("insight rules", () => {
  it("derives each rule only from present evidence, with references, factors and limitations", () => {
    const { insights, skipped } = evaluateInsights(base());
    expect(skipped).toEqual([]);
    const by = (r: string) => insights.filter((i) => i.ruleId === r);
    expect(by("low_ctr_with_snippet_issue").map((i) => i.entityValue)).toEqual([`${S}/shoes`]);
    expect(by("low_ctr_with_snippet_issue")[0].evidence.map((e) => `${e.module}:${e.kind}:${e.id ?? e.url}`)).toEqual([`search_console:page_metrics:${S}/shoes`, "technical:site_issue:i1"]);
    expect(by("search_page_not_indexable").map((i) => i.entityValue)).toEqual([`${S}/noindex`]);
    expect(by("broken_links_on_landing_page")[0].title).toMatch(/2 top landing pages link to a broken URL/);
    expect(by("declining_keyword_with_page_issue")[0]).toMatchObject({ entityValue: "trail shoes", modules: ["rankings", "technical"] });
    expect(by("declining_keyword_with_page_issue")[0].limitations.join(" ")).toMatch(/correlation/);
    expect(by("competitor_outranks_with_backlink_evidence")[0].explanation).toMatch(/40 referring domains \(yours: 2\)/);
    // news.example already links to the site; once.example has a single citation.
    expect(by("ai_cited_source_without_link").map((i) => i.entityValue)).toEqual(["reviews.example"]);
    for (const i of insights) {
      expect(i.fingerprint).toHaveLength(64);
      expect(i.priority).toBeGreaterThanOrEqual(0);
      expect(i.factors.length).toBeGreaterThan(0);
      expect(i.evidence.length).toBeGreaterThan(0);
    }
    // Deterministic: the same input gives the same fingerprints and priorities.
    expect(evaluateInsights(base()).insights.map((i) => `${i.fingerprint}:${i.priority}`)).toEqual(insights.map((i) => `${i.fingerprint}:${i.priority}`));
  });
  it("skips rules with missing inputs and says why, instead of inventing relationships", () => {
    const input = { ...base(), search: { available: false, siteCtr: null, pages: [] }, keywords: [], competitorWins: [], citedHosts: [], ownBacklinks: null };
    const { insights, skipped } = evaluateInsights(input);
    expect(insights).toEqual([]);
    expect(skipped.map((s) => s.ruleId).sort()).toEqual(["ai_cited_source_without_link", "broken_links_on_landing_page", "competitor_outranks_with_backlink_evidence", "declining_keyword_with_page_issue", "low_ctr_with_snippet_issue", "search_page_not_indexable"]);
  });
  it("does not flag pages without a supporting finding, or competitors without backlink evidence", () => {
    const input = base();
    input.issues = [];
    input.competitorDatasets = [];
    const r = evaluateInsights(input).insights.map((i) => i.ruleId);
    expect(r).not.toContain("low_ctr_with_snippet_issue");
    expect(r).not.toContain("competitor_outranks_with_backlink_evidence");
    expect(r).not.toContain("declining_keyword_with_page_issue");
  });
});

describe("summaries", () => {
  it("builds the deterministic summary from measured values and names missing modules", () => {
    const lines = deterministicSummary({
      range: { from: "2026-09-24", to: "2026-10-21", previous: { from: "2026-08-27", to: "2026-09-23" } },
      search: { status: "partial", clicks: 0, clicksChangePct: null, impressions: 10, incomplete: true },
      technical: null, rankings: { status: "not_configured", tracked: 0, improved: 0, declined: 0 }, backlinks: null, content: null, aiVisibility: null, insights: 0, actions: 3,
    });
    expect(lines[0]).toBe("Search Console: 0 clicks and 10 impressions in 2026-09-24 – 2026-10-21 (no comparable previous value); some days are incomplete or not yet synced.");
    expect(lines).toContain("No completed crawl yet: technical health is unavailable.");
    expect(lines).toContain("No rank-tracking project for this website.");
    expect(lines.at(-1)).toBe("0 cross-module insights and 3 open actions.");
  });
  it("validates AI summaries and drops points citing unknown sources", () => {
    const raw = { summary: "Clicks are steady.", points: [{ statement: "Search is connected", sources: ["section:search", "made-up"] }, { statement: "Invented", sources: ["insight:nope"] }], insufficientEvidence: ["No backlink data."] };
    const v = validateWorkspaceSummary(raw, new Set(["section:search"]))!;
    expect(v.summary.points).toEqual([{ statement: "Search is connected", sources: ["section:search"] }]);
    expect(v.dropped).toBe(1);
    expect(validateWorkspaceSummary({ ...raw, clicks: 999 }, new Set())).toBeNull();
    expect(validateWorkspaceSummary("text", new Set())).toBeNull();
  });
});
