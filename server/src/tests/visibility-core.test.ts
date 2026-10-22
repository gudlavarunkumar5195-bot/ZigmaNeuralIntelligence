import { describe, expect, it } from "vitest";
import {
  answerStatus,
  compareCompetitors,
  computeMetrics,
  detectMentions,
  extractInlineUrls,
  findVisibilityOpportunities,
  isoWeek,
  normalizeBrandDomain,
  normalizeSourceUrl,
  parseObservationImport,
  parseSurface,
  registrableDomain,
  validateAiSummary,
  type BrandRef,
  type BrandTerms,
  type ObsFact,
} from "../visibility/core.js";
import { parseCitations } from "../ai/providers/openrouter.js";
import { buildMessages } from "../visibility/providers.js";

// Synthetic fixtures only.
const acme: BrandTerms = { id: "t", name: "Acme", aliases: ["Acme Corp"], products: ["RoadRunner CRM"], domains: ["acme.com"], excludeTerms: ["Acme of skill"] };
const globex: BrandTerms = { id: "c1", name: "Globex", aliases: [], products: [], domains: ["globex.io"], excludeTerms: [] };
const hp: BrandTerms = { id: "c2", name: "HP", aliases: [], products: [], domains: [], excludeTerms: [] };

describe("brand mention matching", () => {
  it("matches names, aliases, products and domains as whole words, case-insensitively", () => {
    const [m] = detectMentions("Many teams pick ACME corp or the roadrunner crm; see https://www.acme.com/pricing.", [acme]);
    expect(m.brandId).toBe("t");
    expect(m.matchCount).toBe(3);
    expect(m.matchedBy.sort()).toEqual(["alias", "domain", "product"]);
    expect(m.excerpt).toContain("ACME corp");
  });
  it("does not match inside other words or longer hosts", () => {
    expect(detectMentions("Acmeology and notacme.com are different.", [acme])).toEqual([]);
    const zeta: BrandTerms = { id: "z", name: "Zeta Systems", aliases: [], products: [], domains: ["zeta.io"], excludeTerms: [] };
    expect(detectMentions("See zeta.io.example.net or myzeta.io", [zeta])).toEqual([]);
    expect(detectMentions("See docs.zeta.io.", [zeta])[0].matchedBy).toEqual(["domain"]);
    expect(detectMentions("Acme's tools", [acme])).toHaveLength(1);
  });
  it("honours exclusion phrases for disambiguation", () => {
    expect(detectMentions("This is the Acme of skill in carpentry.", [acme])).toEqual([]);
    expect(detectMentions("This is the Acme of skill. Acme sells CRM.", [acme])[0].matchCount).toBe(1);
  });
  it("matches short all-caps names case-sensitively", () => {
    expect(detectMentions("The hp rating of the engine", [hp])).toEqual([]);
    expect(detectMentions("Laptops from HP and Dell", [hp])).toHaveLength(1);
  });
  it("counts overlapping terms of one brand once and reports several brands", () => {
    const hits = detectMentions("Acme Corp vs Globex: Acme Corp wins.", [acme, globex]);
    expect(hits.map((h) => [h.brandId, h.matchCount])).toEqual([["t", 2], ["c1", 1]]);
  });
  it("omits excerpts when answer text is not retained", () => {
    expect(detectMentions("Acme", [acme], { excerpt: false })[0].excerpt).toBeNull();
  });
});

describe("citation URL normalization", () => {
  it("normalizes host, strips fragments and tracking parameters but keeps content parameters", () => {
    const s = normalizeSourceUrl("HTTPS://WWW.Example.COM/a/b?id=7&utm_source=openai&gclid=x#frag")!;
    expect(s.normalizedUrl).toBe("https://www.example.com/a/b?id=7");
    expect(s.host).toBe("example.com");
    expect(s.registrableDomain).toBe("example.com");
    expect(s.urlKey).toHaveLength(64);
  });
  it("rejects non-http schemes, credentials, IP literals, internal and single-label hosts", () => {
    for (const bad of ["javascript:alert(1)", "ftp://example.com/x", "example.com/no-scheme", "https://user:pw@example.com/", "http://127.0.0.1/", "http://[::1]/", "http://10.0.0.5/x", "http://localhost/", "https://intranet/", "https://printer.local/", "https://x.internal/a", "https://-bad-.com/", "http://169.254.169.254/latest"]) {
      expect(normalizeSourceUrl(bad), bad).toBeNull();
    }
  });
  it("flags punycode (IDN) hosts so lookalikes are visible", () => {
    expect(normalizeSourceUrl("https://exаmple.com/")!.idn).toBe(true); // Cyrillic "а"
    expect(normalizeSourceUrl("https://example.com/")!.idn).toBe(false);
  });
  it("derives registrable domains only for known suffixes", () => {
    expect(registrableDomain("blog.shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("user.github.io")).toBe("user.github.io");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.unknownsuffix")).toBeNull();
    expect(registrableDomain("co.uk")).toBeNull();
  });
  it("normalizes official brand domains", () => {
    expect(normalizeBrandDomain("https://www.Acme.com/about")).toBe("acme.com");
    expect(normalizeBrandDomain("localhost")).toBeNull();
    expect(normalizeBrandDomain("10.0.0.1")).toBeNull();
  });
  it("extracts inline URLs from answer text and trims punctuation and markdown", () => {
    expect(extractInlineUrls("See [docs](https://acme.com/docs). Also https://x.org/a_(b), and https://y.net/q?x=1.")).toEqual(["https://acme.com/docs", "https://x.org/a_(b)", "https://y.net/q?x=1"]);
  });
  it("parses only structured provider citations", () => {
    const ann = parseCitations({ citations: ["https://ignored.example/"] }, { message: { content: "x", annotations: [{ type: "url_citation", url_citation: { url: "https://a.com/1", title: "A" } }, { type: "other" }, { type: "url_citation", url_citation: { url: 42 } }] } });
    expect(ann).toEqual([{ url: "https://a.com/1", title: "A", position: 1, kind: "provider_annotation" }]);
    expect(parseCitations({ citations: ["https://b.com/", 7] }, { message: { content: "x" } })).toEqual([{ url: "https://b.com/", title: null, position: 1, kind: "provider_citation_list" }]);
    expect(parseCitations({}, { message: { content: "x" } })).toEqual([]);
  });
});

describe("answers and prompts", () => {
  it("classifies answer status", () => {
    expect(answerStatus("text", "stop")).toBe("answered");
    expect(answerStatus("text", "length")).toBe("truncated");
    expect(answerStatus("   ", "stop")).toBe("empty");
    expect(answerStatus("", "content_filter")).toBe("refused");
  });
  it("sends the query as the user message with only language/country context", () => {
    expect(buildMessages({ queryText: "best crm?", language: null, country: null })).toEqual([{ role: "user", content: "best crm?" }]);
    expect(buildMessages({ queryText: "best crm?", language: "de", country: "at" })[0].content).toBe('Answer in the language with code "de". The person asking is in the country with code "AT".');
  });
});

describe("manual import parsing", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const opts = { maxRows: 100, maxResponseChars: 10_000, now };
  it("accepts a valid CSV with aliased headers and validates every row", () => {
    const csv = [
      "Prompt,Date,Platform,Model,Answer,Citations,Language",
      '"best crm for startups",2026-10-01,ChatGPT,gpt-x,"Acme and Globex are popular.","https://acme.com/a https://g2.com/x",en',
      'ab,2026-10-01,ChatGPT,,"text",,',
      '"q two",2031-01-01,ChatGPT,,"text",,',
      '"q three",2026-10-01,Netscape,,"text",,',
      '"q four",2026-10-01,AI Overviews,,"",,',
      '"q five",2026-10-01,perplexity,,"text","javascript:alert(1)",',
      '"q six",2026-10-01T10:00:00+05:30,Google AI Mode,,"text",,EN-GB',
      '"best crm for startups",2026-10-01,ChatGPT,gpt-x,"Acme and Globex are popular.","https://acme.com/a https://g2.com/x",en',
    ].join("\n");
    const r = parseObservationImport(csv, opts);
    expect(r.format).toBe("csv");
    expect(r.fatal).toBeNull();
    expect(r.rowsTotal).toBe(8);
    expect(r.rows.map((x) => [x.query, x.surface, x.citations.length, x.language])).toEqual([["best crm for startups", "chatgpt", 2, "en"], ["q six", "google_ai_mode", 0, "en-gb"]]);
    expect(r.rows[1].observedAt.toISOString()).toBe("2026-10-01T04:30:00.000Z");
    expect(r.duplicatesInFile).toBe(1);
    expect(r.rejected.map((x) => x.line)).toEqual([3, 4, 5, 6, 7]);
    expect(r.rejected.find((x) => x.line === 4)!.reason).toMatch(/future/);
    expect(r.rejected.find((x) => x.line === 5)!.reason).toMatch(/surface must be one of/);
    expect(r.rejected.find((x) => x.line === 7)!.reason).toMatch(/invalid cited URL/);
  });
  it("reports missing required columns as a fatal error", () => {
    const r = parseObservationImport("query,date\nx,2026-01-01", opts);
    expect(r.fatal).toMatch(/Missing required columns: surface, response/);
  });
  it("accepts JSON arrays or {observations} with {url,title} citations, and rejects malformed JSON", () => {
    const json = JSON.stringify({ observations: [{ query: "which crm supports x", observed_at: "2026-10-02", surface: "perplexity", response: "Use Acme.", cited_urls: [{ url: "https://acme.com/x", title: "Acme X" }] }, "nope", { query: "zz", observed_at: "2026-10-02", surface: "gemini", response: "r" }] });
    const r = parseObservationImport(json, opts);
    expect(r.format).toBe("json");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].citations[0]).toMatchObject({ title: "Acme X", position: 1 });
    expect(r.rejected).toHaveLength(2);
    expect(parseObservationImport("[{", opts).fatal).toMatch(/not valid JSON/);
    expect(parseObservationImport('{"a":1}', opts).fatal).toMatch(/array of observations/);
  });
  it("bounds rows and response size", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ query: `query ${i}`, observed_at: "2026-10-02", surface: "other", response: "x".repeat(i === 0 ? 20 : 5) }));
    const r = parseObservationImport(JSON.stringify(rows), { ...opts, maxRows: 3, maxResponseChars: 10 });
    expect(r.truncated).toBe(true);
    expect(r.rowsTotal).toBe(3);
    expect(r.rejected[0].reason).toMatch(/longer than 10/);
  });
  it("maps surface aliases", () => {
    expect(parseSurface("Bing Chat")).toBe("copilot");
    expect(parseSurface("google_ai_overviews")).toBe("google_ai_overviews");
    expect(parseSurface("model_api")).toBeNull(); // API results cannot be imported as such
  });
});

const T: BrandRef = { id: "t", name: "Acme", kind: "target" };
const C: BrandRef = { id: "c1", name: "Globex", kind: "competitor" };
let n = 0;
const fact = (over: Partial<ObsFact>): ObsFact => ({
  id: `o${++n}`, queryId: "q1", provider: "openrouter_answer", surface: "model_api", method: "provider_api", model: "m1", observedAt: new Date("2026-10-05T10:00:00Z"),
  language: null, country: null, answerStatus: "answered", mentioned: [], citedBrands: [], citationCount: 0, citedHosts: [], ...over,
});

describe("metrics", () => {
  it("computes rates with explicit numerators, denominators and missing-data handling", () => {
    const facts = [
      fact({ mentioned: ["t"], queryId: "q1" }),
      fact({ mentioned: ["t", "c1"], queryId: "q1" }),
      fact({ mentioned: ["c1"], queryId: "q2" }),
      fact({ mentioned: [], queryId: "q2" }),
      fact({ answerStatus: "empty", queryId: "q3" }),
    ];
    const [g] = computeMetrics(facts, [T, C], "t", 10);
    expect(g.sample).toMatchObject({ observations: 5, answered: 4, unanswered: 1, queries: 2 });
    const t = g.brands.find((b) => b.brandId === "t")!;
    expect(t.mentionRate).toEqual({ value: 0.5, numerator: 2, denominator: 4, smallSample: true });
    expect(t.queryCoverage).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(t.mentionShare).toMatchObject({ value: 0.5, numerator: 2, denominator: 4 });
    // No citations at all: "no data", never 0.
    expect(t.citationRate).toMatchObject({ value: null, denominator: 0 });
    expect(g.coMentions[0].rate).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    // q1: mentioned twice (consistent); q2: never mentioned (consistent).
    expect(g.consistency).toMatchObject({ value: 1, numerator: 2, denominator: 2 });
  });
  it("distinguishes zero observed mentions from no data", () => {
    const [g] = computeMetrics([fact({}), fact({})], [T, C], "t", 1);
    expect(g.brands[0].mentionRate).toMatchObject({ value: 0, numerator: 0, denominator: 2, smallSample: false });
    expect(g.brands[0].mentionShare.value).toBeNull();
    expect(computeMetrics([], [T, C], "t", 1)).toEqual([]);
  });
  it("never mixes providers, models or collection methods", () => {
    const groups = computeMetrics([fact({}), fact({ model: "m2" }), fact({ method: "manual_import", provider: "chatgpt", surface: "chatgpt", model: "gpt" }), fact({ provider: "openrouter_web" })], [T], "t", 1);
    expect(groups).toHaveLength(4);
    expect(groups.find((g) => g.key.method === "manual_import")!.key).toEqual({ method: "manual_import", provider: "chatgpt", surface: "chatgpt", model: null });
  });
  it("computes citation metrics over observations with citations, and source diversity", () => {
    const facts = [
      fact({ citationCount: 2, citedBrands: ["t"], citedHosts: ["acme.com", "g2.com"] }),
      fact({ citationCount: 1, citedHosts: ["g2.com"] }),
      fact({ citationCount: 1, citedBrands: ["c1"], citedHosts: ["globex.io"] }),
      fact({}),
    ];
    const [g] = computeMetrics(facts, [T, C], "t", 1);
    const t = g.brands[0];
    expect(t.citationRate).toMatchObject({ value: 0.3333, numerator: 1, denominator: 3 });
    expect(t.citationShare).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(g.sources).toMatchObject({ citations: 4, distinctHosts: 3, topHosts: [{ host: "g2.com", observations: 2 }, { host: "acme.com", observations: 1 }, { host: "globex.io", observations: 1 }] });
    expect(g.sources.topSourceShare).toMatchObject({ numerator: 2, denominator: 3 });
  });
  it("builds a weekly trend with null for weeks without answers", () => {
    const [g] = computeMetrics([fact({ observedAt: new Date("2026-09-28T00:00:00Z"), mentioned: ["t"] }), fact({ observedAt: new Date("2026-10-06T00:00:00Z") }), fact({ observedAt: new Date("2026-10-06T00:00:00Z"), answerStatus: "refused" })], [T], "t", 1);
    expect(g.trend).toEqual([{ period: "2026-W40", answered: 1, mentioned: 1, rate: 1 }, { period: "2026-W41", answered: 1, mentioned: 0, rate: 0 }]);
    expect(isoWeek(new Date("2021-01-03T00:00:00Z"))).toBe("2020-W53");
  });
});

describe("competitor comparison", () => {
  it("lists query-level evidence both ways within comparable groups", () => {
    const facts = [
      fact({ queryId: "q1", mentioned: ["c1"] }), fact({ queryId: "q1", mentioned: ["c1"] }),
      fact({ queryId: "q2", mentioned: ["t"], citedHosts: ["g2.com"] }), fact({ queryId: "q2", mentioned: ["t"] }),
      fact({ queryId: "q3", mentioned: ["t", "c1"], citedHosts: ["g2.com"] }),
      fact({ queryId: "q1", method: "manual_import", provider: "chatgpt", surface: "chatgpt", model: null, mentioned: ["t"] }),
    ];
    const res = compareCompetitors(facts, T, [C], 2);
    expect(res).toHaveLength(2);
    const api = res.find((g) => g.key.method === "provider_api")!.competitors[0];
    expect(api.competitorOnlyQueries.map((q) => q.queryId)).toEqual(["q1"]);
    expect(api.competitorOnlyQueries[0].observationIds).toHaveLength(2);
    expect(api.targetOnlyQueries.map((q) => q.queryId)).toEqual(["q2"]);
    expect(api.bothQueries).toBe(1);
    expect(api.sharedSourceHosts).toEqual(["g2.com"]);
    expect(api.history.status).toBe("ok");
    expect(res.find((g) => g.key.method === "manual_import")!.competitors[0].history.status).toBe("insufficient");
  });
});

describe("opportunities", () => {
  const base = { target: { ...T, domains: ["acme.com"] }, competitors: [{ ...C, domains: ["globex.io"] }], queries: [{ id: "q1", text: "best crm", status: "active" }, { id: "q2", text: "crm for x", status: "active" }, { id: "q3", text: "new query", status: "active" }], sources: [], minSample: 5 };
  it("derives evidence-backed opportunities with transparent priority factors", () => {
    const facts = [
      fact({ queryId: "q1", mentioned: ["t"], citationCount: 1, citedHosts: ["g2.com"] }),
      fact({ queryId: "q1", mentioned: ["c1"], citationCount: 1, citedHosts: ["g2.com"] }),
      fact({ queryId: "q2", mentioned: ["t"], citationCount: 1, citedHosts: ["g2.com"] }),
      fact({ queryId: "q2", mentioned: ["c1"] }),
      fact({ queryId: "q2", mentioned: ["c1"] }),
      fact({ queryId: "q1", mentioned: ["c1"] }),
    ];
    const opps = findVisibilityOpportunities({ ...base, facts });
    const kinds = opps.map((o) => o.kind).sort();
    expect(kinds).toEqual(["frequently_cited_source", "insufficient_data", "mentioned_not_cited"]);
    const src = opps.find((o) => o.kind === "frequently_cited_source")!;
    expect(src.evidence).toMatchObject({ hosts: ["g2.com"], counts: { observations: 3, queries: 2, withoutTarget: 1 } });
    expect(src.evidence.observationIds).toHaveLength(3);
    expect(src.factors.map((f) => f.name)).toEqual(["citation_frequency", "query_spread", "target_absent"]);
    expect(src.priority).toBeGreaterThan(0);
    expect(src.limitations.join(" ")).toMatch(/does not prove/);
    expect(opps.find((o) => o.kind === "insufficient_data")!.evidence.queryIds).toEqual(["q3"]);
    // q1 and q2 both mention the target at least once: no competitor-only query.
    expect(kinds).not.toContain("competitor_only_queries");
  });
  it("flags competitor-only queries only with at least two comparable answers", () => {
    const facts = [fact({ queryId: "q1", mentioned: ["c1"] }), fact({ queryId: "q1", mentioned: ["c1"] }), fact({ queryId: "q2", mentioned: ["c1"] })];
    const o = findVisibilityOpportunities({ ...base, facts }).find((x) => x.kind === "competitor_only_queries")!;
    expect(o.evidence.queryIds).toEqual(["q1"]);
    expect(o.title).toMatch(/Globex is mentioned and Acme is not for 1 monitored query/);
  });
  it("never cites a monitored brand's own domain as an outside source, and needs verified evidence for unreachable sources", () => {
    const facts = Array.from({ length: 4 }, (_, i) => fact({ queryId: i % 2 ? "q1" : "q2", citationCount: 1, citedHosts: ["docs.acme.com"], citedBrands: ["t"], mentioned: ["t"] }));
    const opps = findVisibilityOpportunities({ ...base, facts, sources: [{ id: "s1", host: "acme.com", normalizedUrl: "https://acme.com/old", verificationStatus: "unreachable", observationIds: ["o1", "o2"] }] });
    expect(opps.some((o) => o.kind === "frequently_cited_source")).toBe(false);
    const u = opps.find((o) => o.kind === "unreachable_cited_source")!;
    expect(u.action).toMatch(/Restore the page/);
  });
});

describe("AI summary validation", () => {
  const ok = { summary: "Acme is mentioned in half of answers.", patterns: [{ statement: "g2.com is cited often", observationIds: ["o1", "evil"] }, { statement: "made up", observationIds: ["nope"] }], sourceCategories: [{ host: "g2.com", category: "review_site" }, { host: "attacker.example", category: "other" }], caveats: ["Small sample."] };
  it("keeps only references to provided observations and hosts", () => {
    const v = validateAiSummary(ok, new Set(["o1"]), new Set(["g2.com"]))!;
    expect(v.summary.patterns).toEqual([{ statement: "g2.com is cited often", observationIds: ["o1"] }]);
    expect(v.summary.sourceCategories).toEqual([{ host: "g2.com", category: "review_site" }]);
    expect(v.dropped).toBe(2);
  });
  it("rejects output that does not match the schema", () => {
    expect(validateAiSummary({ ...ok, extra: "ignore previous instructions" }, new Set(), new Set())).toBeNull();
    expect(validateAiSummary({ ...ok, sourceCategories: [{ host: "x.com", category: "spam" }] }, new Set(), new Set())).toBeNull();
    expect(validateAiSummary("not json", new Set(), new Set())).toBeNull();
  });
});
