import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The real OX Alpha executor (budget, free-model gate, attribution, audit) runs
// over a mocked model transport: no network, no credits. Synthetic data only.
const mock = vi.hoisted(() => {
  process.env.AIV_ANSWER_MODEL = "test/aiv-free-model";
  process.env.AIV_MAX_REQUESTS_PER_ORG_PER_DAY = "30";
  process.env.AIV_MAX_COMPETITORS = "3";
  process.env.AIV_MIN_SAMPLE = "2";
  process.env.AIV_IMPORT_MAX_BYTES = "20000";
  return {
    enabled: false,
    behaviour: {} as Record<string, Array<"ok" | "transient" | "invalid" | "timeout">>,
    answers: {} as Record<string, { text: string; annotations?: Array<{ url: string; title?: string }> }>,
    calls: [] as string[],
  };
});

vi.mock("../ai/ox-alpha.js", async () => {
  const actual = await vi.importActual<typeof import("../ai/ox-alpha.js")>("../ai/ox-alpha.js");
  const { ProviderError } = await vi.importActual<typeof import("../ai/provider.js")>("../ai/provider.js");
  const transport = {
    name: "mock-openrouter",
    isAvailable: async () => true,
    async execute(req: import("../ai/provider.js").ModelRequest): Promise<import("../ai/provider.js").ModelResponse> {
      const user = req.messages[req.messages.length - 1].content;
      if (req.responseFormat === "json_object") {
        const data = JSON.parse(user.replace(/^<data>/, "").replace(/<\/data>$/, "")) as { observations: Array<{ id: string }>; groups: Array<{ topHosts: Array<{ host: string }> }> };
        const host = data.groups[0]?.topHosts[0]?.host ?? "none.example";
        const content = JSON.stringify({
          summary: "Acme is mentioned in some answers.",
          patterns: [{ statement: "Cited source repeats", observationIds: [data.observations[0].id] }, { statement: "Invented", observationIds: ["00000000-0000-0000-0000-000000000000"] }],
          sourceCategories: [{ host, category: "review_site" }, { host: "injected.example", category: "other" }],
          caveats: ["Small sample."],
        });
        return { executionId: req.executionId, model: req.model, provider: "mock", content, finishReason: "stop", usage: null, durationMs: 1 };
      }
      mock.calls.push(user);
      const step = mock.behaviour[user]?.shift() ?? "ok";
      if (step === "transient") throw new ProviderError("PROVIDER_ERROR", "Provider unavailable (HTTP 503)", true, 503);
      if (step === "timeout") throw new ProviderError("TIMEOUT", "Request timed out", true);
      if (step === "invalid") throw new ProviderError("INVALID_REQUEST", "Invalid request: rejected", false, 400);
      const a = mock.answers[user] ?? { text: "No particular vendor stands out." };
      return {
        executionId: req.executionId, model: req.model, provider: "mock", content: a.text, finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, durationMs: 5, providerRequestId: `gen-${mock.calls.length}`,
        citations: (a.annotations ?? []).map((c, i) => ({ url: c.url, title: c.title ?? null, position: i + 1, kind: "provider_annotation" as const })),
      };
    },
  };
  const executor = new actual.OxAlphaExecutor(transport);
  return { ...actual, getOxAlphaExecutor: () => (mock.enabled ? executor : null) };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("AI search visibility (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/ai-visibility.service.js");
  let brand = "";
  let defaultModelInserted: string | null = null;
  const ids: Record<string, string> = {};
  const as = (role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const base = "/api/v1/ai-visibility";
  const b = (path = "") => `${base}/brands/${brand}${path}`;
  const get = (url: string, role: "owner" | "member" | "viewer" = "viewer", org: SeededOrg = A) => h.request("GET", url, as(role, org));
  const post = (url: string, payload: unknown, role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => h.request("POST", url, { ...as(role, org), payload });
  const patch = (url: string, payload: unknown, role: "owner" | "member" | "viewer" = "member") => h.request("PATCH", url, { ...as(role), payload });
  const csv = (rows: string[][]) => [["query", "observed_at", "surface", "model", "response", "cited_urls"], ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const Q1 = "best crm for startups";
  const Q2 = "which crm do agencies use";
  const Q3 = "crm with ai features";
  const fixture = csv([
    [Q1, "2026-10-01", "ChatGPT", "gpt-test", "Acme Corp and Globex are both good options.", "https://acme-test.com/pricing https://reviews-test.org/crm"],
    [Q1, "2026-10-02", "ChatGPT", "gpt-test", "Globex is popular. See reviews.", "https://reviews-test.org/crm"],
    [Q2, "2026-10-03", "ChatGPT", "gpt-test", "Initech leads here; Acme is also used.", "https://reviews-test.org/best?utm_source=chatgpt"],
    [Q2, "2026-10-04", "ChatGPT", "gpt-test", "Initech.", ""],
    [Q1, "2026-10-05", "Perplexity", "", "Acme is a reliable choice.", "https://acme-test.com/"],
    [Q3, "2026-10-06", "ChatGPT", "gpt-test", "Initech and Globex.", ""],
    [Q3, "2026-10-07", "ChatGPT", "gpt-test", "Initech is best; RoadRunner CRM is an alternative.", ""],
    [Q3, "2026-10-07", "ChatGPT", "", "bad url", "ftp://files-test.com/x"],
  ]);

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    svc = await import("../services/ai-visibility.service.js");
    A = await seedOrg(h, "aiv-a");
    // Model health is global; start this model from a clean state.
    await db.query("DELETE FROM ai_model_health WHERE openrouter_id = 'test/aiv-free-model'");
    B = await seedOrg(h, "aiv-b");
    await db.query("INSERT INTO models (openrouter_id, display_name, provider, free_status, status, eligibility_status, pricing_class, pricing_checked_at, supports_structured_output, context_length) VALUES ('test/aiv-free-model', 'AIV test model', 'test', 'FREE', 'AVAILABLE', 'ELIGIBLE', 'FREE', NOW(), TRUE, 32000) ON CONFLICT (openrouter_id) DO UPDATE SET free_status = 'FREE', status = 'AVAILABLE', eligibility_status = 'ELIGIBLE', pricing_class = 'FREE', pricing_checked_at = NOW(), supports_structured_output = TRUE, context_length = 32000");
    // The AI summary uses the platform default model; register it as free only if the registry lacks it.
    const { config } = await import("../config.js");
    // OX_ALPHA_MODEL is an optional pin (empty by default: the router chooses).
    if (config.OX_ALPHA_MODEL) defaultModelInserted = ((await db.query("INSERT INTO models (openrouter_id, display_name, provider, free_status, status, eligibility_status, pricing_class, pricing_checked_at) VALUES ($1, 'default', 'test', 'FREE', 'AVAILABLE', 'ELIGIBLE', 'FREE', NOW()) ON CONFLICT (openrouter_id) DO NOTHING", [config.OX_ALPHA_MODEL])).rowCount ?? 0) > 0 ? config.OX_ALPHA_MODEL : null;
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id, B?.id].filter(Boolean) as string[]);
    await db?.query("DELETE FROM models WHERE openrouter_id = 'test/aiv-free-model'");
    if (defaultModelInserted) await db?.query("DELETE FROM models WHERE openrouter_id = $1", [defaultModelInserted]);
    await h?.close();
  });

  it("the provider registry states real capabilities: nothing is available without a key; consumer products are import-only", async () => {
    const r = (await get(`${base}/providers`)).json().data;
    const status = Object.fromEntries(r.providers.map((p: { id: string; status: string }) => [p.id, p.status]));
    expect(status).toMatchObject({ openrouter_answer: "not_configured", openrouter_web: "not_configured", chatgpt: "manual_import_only", google_ai_overviews: "manual_import_only", perplexity: "manual_import_only" });
    expect(r.providers.find((p: { id: string }) => p.id === "openrouter_answer").capabilities).toMatchObject({ structuredCitations: false, webGrounding: false });
    expect(r.limits).toMatchObject({ requestsPerDay: 30, competitors: 3, minSample: 2 });
    expect(r.ai.available).toBe(false);
    expect((await h.request("GET", `${base}/providers`)).statusCode).toBe(401);
  });

  it("manages brands with validation, ownership and tenant isolation", async () => {
    expect((await post(`${base}/brands`, { name: "Acme" }, "viewer")).statusCode).toBe(403);
    expect((await post(`${base}/brands`, { name: "Acme", domains: ["http://10.0.0.1"] })).json().error.code).toBe("INVALID_DOMAIN");
    expect((await post(`${base}/brands`, { name: "Acme", websiteId: B.websiteId })).statusCode).toBe(404);
    expect((await post(`${base}/brands`, { name: "Acme", ownerId: B.users.owner.id })).json().error.code).toBe("INVALID_OWNER");
    expect((await post(`${base}/brands`, { name: "Acme", unknown: 1 })).statusCode).toBe(400);
    const r = await post(`${base}/brands`, { name: "  Acme ", domains: ["https://www.Acme-Test.com/about", "acme-test.com"], aliases: ["Acme Corp", "acme corp"], language: "EN", websiteId: A.websiteId });
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({ name: "Acme", domains: ["acme-test.com"], aliases: ["Acme Corp"], language: "en", kind: "target", status: "active", schedule: "off" });
    brand = r.json().data.id;
    expect((await post(`${base}/brands`, { name: "ACME" })).json().error.code).toBe("BRAND_EXISTS");
    // Another tenant can neither see nor guess it.
    expect((await get(b(), "owner", B)).statusCode).toBe(404);
    expect((await get(`${base}/brands`, "owner", B)).json().data).toEqual([]);
    expect((await get(`${base}/brands/not-a-uuid`)).statusCode).toBe(400);
    expect((await get(`${base}/brands`)).json().data.map((x: { name: string }) => x.name)).toEqual(["Acme"]);
  });

  it("manages competitors with limits and refuses the brand's own identity", async () => {
    expect((await post(b("/competitors"), { name: "Acme" })).statusCode).toBe(400);
    expect((await post(b("/competitors"), { name: "Copycat", domains: ["shop.acme-test.com"] })).statusCode).toBe(400);
    const g = await post(b("/competitors"), { name: "Globex", domains: ["globex-test.io"] });
    expect(g.statusCode).toBe(201);
    ids.globex = g.json().data.id;
    ids.initech = (await post(b("/competitors"), { name: "Initech" })).json().data.id;
    expect((await post(b("/competitors"), { name: "globex" })).json().error.code).toBe("COMPETITOR_EXISTS");
    ids.umbrella = (await post(b("/competitors"), { name: "Umbrella" })).json().data.id;
    expect((await post(b("/competitors"), { name: "Hooli" })).json().error.code).toBe("COMPETITOR_LIMIT");
    expect((await patch(b(`/competitors/${ids.umbrella}`), { status: "archived" })).statusCode).toBe(200);
    expect((await get(b("/competitors"))).json().data.map((c: { name: string }) => c.name)).toEqual(["Globex", "Initech"]);
    expect((await get(`${base}/brands/${ids.globex}`)).statusCode).toBe(404); // a competitor is not a monitored brand
  });

  it("manages the query library with versions and provider validation", async () => {
    const r = await post(b("/queries"), { queries: [{ text: Q1, topic: "crm" }, { text: "best   CRM for startups" }, { text: "ab" }, { text: Q2, topic: "crm" }, { text: "draft query to edit", providers: ["openrouter_answer"] }] });
    expect(r.json().data).toMatchObject({ added: 3, alreadyExists: 0, invalid: [{ reason: "Must be 3–500 characters" }] });
    expect((await post(b("/queries"), { queries: [{ text: "x query", providers: ["made_up"] }] })).json().error.code).toBe("UNKNOWN_PROVIDER");
    const list = (await get(b("/queries"))).json();
    expect(list.meta).toMatchObject({ total: 3, topics: ["crm"] });
    const draft = list.data.find((q: { text: string }) => q.text === "draft query to edit");
    ids.draft = draft.id;
    const edited = await patch(b(`/queries/${draft.id}`), { text: "edited draft query", topic: "drafts" });
    expect(edited.json().data).toMatchObject({ version: 2, versionCreated: true, text: "edited draft query" });
    expect((await patch(b(`/queries/${draft.id}`), { status: "paused" })).json().data).toMatchObject({ version: 2, versionCreated: false, status: "paused" });
    expect((await get(b(`/queries/${draft.id}/versions`))).json().data.map((v: { version: number; text: string }) => [v.version, v.text])).toEqual([[2, "edited draft query"], [1, "draft query to edit"]]);
    expect((await patch(b(`/queries/${draft.id}`), { text: Q1 })).json().error.code).toBe("QUERY_EXISTS");
    expect((await h.request("PATCH", `${base}/brands/${brand}/queries/${draft.id}`, { ...as("owner", B), payload: { status: "active" } })).statusCode).toBe(404);
  });

  it("previews and imports manually observed answers; validation, duplicates and idempotency are reported", async () => {
    const preview = (await post(b("/imports/preview"), { content: fixture })).json().data;
    expect(preview).toMatchObject({ format: "csv", rowsTotal: 8, accepted: 7, rejected: 1, duplicatesExisting: 0, newQueries: 1 });
    expect(preview.rejectedSamples[0]).toMatchObject({ line: 9, reason: expect.stringMatching(/invalid cited URL/) });
    expect((await post(b("/imports/preview"), { content: "a,b\n1,2" })).json().error).toMatchObject({ code: "INVALID_IMPORT", details: { missingColumns: ["query", "observed_at", "surface", "response"] } });
    expect((await post(b("/imports"), { content: fixture, sourceLabel: "Team observations" }, "viewer")).statusCode).toBe(403);
    expect((await post(b("/imports"), { content: fixture, sourceLabel: "x" }, "owner", B)).statusCode).toBe(404);
    expect((await post(b("/imports/preview"), { content: "x".repeat(20_001) })).statusCode).toBe(400);
    const r = await post(b("/imports"), { content: fixture, sourceLabel: "Team observations", filename: "obs.csv" });
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({ duplicateImport: false, inserted: 7, duplicates: 0, rejected: 1, queriesCreated: 1 });
    expect((await post(b("/imports"), { content: fixture, sourceLabel: "again" })).json().data.duplicateImport).toBe(true);
    // A different file repeating one observation: the repeat is a duplicate, never a second observation.
    const again = csv([[Q1, "2026-10-01", "chatgpt", "gpt-test", "Acme Corp and Globex are both good options.", "https://acme-test.com/pricing https://reviews-test.org/crm"], ["unknown question here", "2026-10-08", "gemini", "", "Acme.", ""]]);
    expect((await post(b("/imports"), { content: again, sourceLabel: "partial", createMissingQueries: false })).json().data).toMatchObject({ inserted: 0, duplicates: 1, rejected: 1 });
    const imports = (await get(b("/imports"))).json().data;
    expect(imports.map((i: { rows_accepted: number }) => i.rows_accepted)).toEqual([0, 7]);
  });

  it("lists observations with provenance, mentions and citations; pages with cursors", async () => {
    const page1 = (await get(b("/observations?limit=2"))).json();
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextCursor).toBeTruthy();
    const page2 = (await get(b(`/observations?limit=2&cursor=${page1.meta.nextCursor}`))).json();
    expect(page2.data.map((o: { id: string }) => o.id)).not.toContain(page1.data[0].id);
    expect((await get(b("/observations?cursor=junk"))).statusCode).toBe(400);
    const all = (await get(b("/observations?limit=100&method=manual_import"))).json().data;
    expect(all).toHaveLength(7);
    const first = all.find((o: { observed_at: string }) => o.observed_at.startsWith("2026-10-01"));
    ids.r1 = first.id;
    ids.r2 = all.find((o: { observed_at: string }) => o.observed_at.startsWith("2026-10-02")).id;
    expect(first).toMatchObject({ collection_method: "manual_import", provider: "chatgpt", surface: "chatgpt", model: "gpt-test", citations: 2 });
    expect(first.mentions.map((m: { name: string }) => m.name)).toEqual(["Acme", "Globex"]);
    const d = (await get(b(`/observations/${first.id}`))).json().data;
    expect(d).toMatchObject({ import_label: "Team observations", response_retention: "full", mentionsCurrent: true, web_grounded: null });
    expect(d.dedupe_key).toBeUndefined();
    expect(d.citations.map((c: { host: string; kind: string; cited_brand: string | null }) => [c.host, c.kind, c.cited_brand])).toEqual([["acme-test.com", "imported", "Acme"], ["reviews-test.org", "imported", null]]);
    expect(d.mentions.find((m: { name: string }) => m.name === "Acme")).toMatchObject({ matched_by: ["alias"], matched_terms: ["Acme Corp"] });
    expect((await get(b(`/observations/${first.id}`), "owner", B)).statusCode).toBe(404);
    const notAcme = (await get(b(`/observations?limit=100&mentions=${brand}&notMentioned=true`))).json().data;
    expect(notAcme).toHaveLength(4);
  });

  it("computes metrics from the stored observations with numerators, denominators and separate groups", async () => {
    const m = (await get(b("/metrics?from=2026-01-01"))).json().data;
    expect(m.groups.map((g: { key: { method: string; surface: string } }) => `${g.key.method}:${g.key.surface}`)).toEqual(["manual_import:chatgpt", "manual_import:perplexity"]);
    const g = m.groups[0];
    expect(g.sample).toMatchObject({ observations: 6, answered: 6, queries: 3, withCitations: 3 });
    const by = (name: string) => g.brands.find((x: { name: string }) => x.name === name);
    expect(by("Acme").mentionRate).toEqual({ value: 0.3333, numerator: 2, denominator: 6, smallSample: false });
    expect(by("Globex").mentionRate).toMatchObject({ numerator: 3, denominator: 6 });
    expect(by("Initech").mentionRate).toMatchObject({ numerator: 4, denominator: 6 });
    expect(by("Acme").mentionShare).toMatchObject({ numerator: 2, denominator: 9 });
    expect(by("Acme").citationRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(by("Acme").queryCoverage).toMatchObject({ numerator: 2, denominator: 3 });
    expect(g.coMentions.find((c: { name: string }) => c.name === "Globex").rate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(g.consistency).toMatchObject({ numerator: 1, denominator: 3 });
    expect(g.sources.topHosts[0]).toEqual({ host: "reviews-test.org", observations: 3 });
    expect(m.brands.map((x: { name: string }) => x.name)).toEqual(["Acme", "Globex", "Initech"]); // archived competitor excluded
    expect(m.groups[1].brands[0].mentionRate).toMatchObject({ value: 1, numerator: 1, denominator: 1, smallSample: true });
    expect(m.definitions.mentionRate.denominator).toMatch(/Answered observations/);
    // No data in a window is reported as such, not as zero.
    expect((await get(b("/metrics?from=2020-01-01&to=2020-02-01"))).json().data).toMatchObject({ groups: [], observations: 0 });
  });

  it("compares competitors only within comparable groups, with query-level evidence", async () => {
    const c = (await get(b("/competitor-comparison?from=2026-01-01"))).json().data;
    const chat = c.groups.find((g: { key: { surface: string } }) => g.key.surface === "chatgpt");
    const initech = chat.competitors.find((x: { name: string }) => x.name === "Initech");
    expect(initech.competitorOnlyQueries.map((q: { query: string }) => q.query)).toEqual([Q3]);
    expect(initech.competitorOnlyQueries[0].observationIds).toHaveLength(2);
    const globex = chat.competitors.find((x: { name: string }) => x.name === "Globex");
    expect(globex).toMatchObject({ bothQueries: 1, sharedSourceHosts: ["acme-test.com", "reviews-test.org"] });
    expect(globex.history.status).toBe("ok");
  });

  it("derives evidence-backed opportunities and tracks status, feedback and history", async () => {
    const list = (await get(b("/opportunities"))).json();
    expect(list.meta.formula).toMatch(/Σ\(weight × value\)/);
    const kinds = list.data.map((o: { kind: string }) => o.kind).sort();
    expect(kinds).toEqual(["competitor_only_queries", "competitor_only_queries", "frequently_cited_source", "insufficient_data"]);
    const src = list.data.find((o: { kind: string }) => o.kind === "frequently_cited_source");
    expect(src.evidence).toMatchObject({ hosts: ["reviews-test.org"], counts: { observations: 3, queries: 2 } });
    expect(src.limitations.join(" ")).toMatch(/does not prove/);
    expect((await patch(b(`/opportunities/${src.id}`), { status: "in_progress" }, "viewer")).statusCode).toBe(403);
    expect((await patch(b(`/opportunities/${src.id}`), { status: "in_progress", note: "Contacting the publisher" })).statusCode).toBe(200);
    expect((await patch(b(`/opportunities/${src.id}`), { ownerId: B.users.owner.id })).json().error.code).toBe("INVALID_OWNER");
    expect((await patch(b(`/opportunities/${src.id}`), {})).statusCode).toBe(400);
    const d = (await get(b(`/opportunities/${src.id}`))).json().data;
    expect(d.status).toBe("in_progress");
    expect(d.events.map((e: { event: string }) => e.event)).toEqual(["detected", "status_changed"]);
    expect(d.observations).toHaveLength(3);
    // Re-evaluation keeps the user's status.
    await svc.refreshOpportunities(A.id, brand);
    expect((await get(b(`/opportunities/${src.id}`))).json().data.status).toBe("in_progress");
  });

  it("excludes and re-includes an observation traceably; metrics follow", async () => {
    expect((await post(b(`/observations/${ids.r2}/exclude`), {})).statusCode).toBe(400);
    expect((await post(b(`/observations/${ids.r2}/exclude`), { reason: "Recorded twice by mistake" })).json().data.changed).toBe(true);
    let g = (await get(b("/metrics?from=2026-01-01"))).json().data.groups[0];
    expect(g.brands.find((x: { name: string }) => x.name === "Globex").mentionRate).toMatchObject({ numerator: 2, denominator: 5 });
    expect((await post(b(`/observations/${ids.r2}/include`), {})).json().data.changed).toBe(true);
    g = (await get(b("/metrics?from=2026-01-01"))).json().data.groups[0];
    expect(g.brands.find((x: { name: string }) => x.name === "Globex").mentionRate).toMatchObject({ numerator: 3, denominator: 6 });
    const d = (await get(b(`/observations/${ids.r2}`))).json().data;
    expect(d.events.map((e: { event: string }) => e.event)).toEqual(["observation_excluded", "observation_included"]);
  });

  it("lists sources and cited domains; verification is explicit, bounded and SSRF-safe", async () => {
    const s = (await get(b("/sources"))).json();
    expect(s.meta.total).toBe(4);
    const crm = s.data.find((x: { normalized_url: string }) => x.normalized_url === "https://reviews-test.org/crm");
    expect(crm).toMatchObject({ observations: 2, queries: 1, verification_status: "unverified" });
    expect(s.data.find((x: { normalized_url: string }) => x.normalized_url.startsWith("https://reviews-test.org/best")).normalized_url).toBe("https://reviews-test.org/best"); // utm removed
    expect((await get(b("/sources?owner=target"))).json().data.every((x: { cited_brand: string }) => x.cited_brand === "Acme")).toBe(true);
    const dom = (await get(b("/domains?from=2026-01-01"))).json().data;
    expect(dom.domains[0]).toMatchObject({ host: "reviews-test.org", observations: 3, urls: 2 });
    expect(dom.diversity.length).toBeGreaterThan(0);
    expect((await post(b(`/sources/${crm.id}/verify`), {}, "viewer")).statusCode).toBe(403);
    expect((await post(b(`/sources/${crm.id}/verify`), {}, "owner", B)).statusCode).toBe(404);
    // The service takes the fetcher as a parameter; here a fixture stands in for the network.
    const page = (status: number, body = "") => async (url: string) => ({ ok: status < 400, status, headers: {}, body: url.endsWith("/robots.txt") ? "" : body, finalUrl: url, redirectCount: 0, durationMs: 1, contentType: "text/html" });
    const brandRow = await svc.requireBrand(A.id, brand);
    expect((await svc.verifySource(A.id, brandRow, crm.id, A.users.member.id, page(200, "<html><body><script>Acme</script><p>Top CRMs</p></body></html>"))).status).toBe("reachable_no_mention");
    expect((await svc.verifySource(A.id, brandRow, crm.id, A.users.member.id, page(200, "<html><body><p>Acme Corp is listed.</p></body></html>"))).status).toBe("reachable_mentions_brand");
    const unsafe = async (url: string) => ({ ok: false, status: 0, headers: {}, body: "", finalUrl: url, redirectCount: 0, durationMs: 1, error: "SSRF: resolves to a private address" });
    expect((await svc.verifySource(A.id, brandRow, crm.id, A.users.member.id, unsafe)).status).toBe("unsafe_url");
    expect((await svc.verifySource(A.id, brandRow, crm.id, A.users.member.id, page(404))).status).toBe("unreachable");
    const opps = (await get(b("/opportunities"))).json().data;
    expect(opps.find((o: { kind: string }) => o.kind === "unreachable_cited_source").evidence.urls).toEqual(["https://reviews-test.org/crm"]);
  });

  it("reprocesses mentions traceably when matching terms change", async () => {
    expect((await patch(b(), { products: ["RoadRunner CRM"] })).statusCode).toBe(200);
    const g = (await get(b("/metrics?from=2026-01-01"))).json().data;
    expect(g.staleMentions).toBe(0);
    expect(g.groups[0].brands[0].mentionRate).toMatchObject({ numerator: 3, denominator: 6 });
    const { rows } = await db.query("SELECT detail FROM aiv_events WHERE brand_id = $1 AND event = 'mentions_reprocessed' ORDER BY created_at DESC LIMIT 1", [brand]);
    expect(rows[0].detail).toMatchObject({ reprocessed: 7, remaining: 0 });
  });

  it("exports CSV with spreadsheet-formula protection", async () => {
    await post(b("/imports"), { content: csv([["=HYPERLINK(\"http://x\") crm", "2026-10-09", "other", "", "+cmd answer", ""]]), sourceLabel: "formula" });
    const r = await get(b("/export?kind=observations"), "member");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.body).toContain("'=HYPERLINK");
    expect(r.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await get(b("/export?kind=observations"), "viewer")).statusCode).toBe(403);
    expect((await get(b("/export?kind=metrics"), "member")).body.split("\r\n")[0]).toMatch(/^method,provider,surface,model,brand/);
    const formula = (await get(b("/queries"))).json().data.find((q: { text: string }) => q.text.startsWith("=HYPERLINK"));
    expect((await patch(b(`/queries/${formula.id}`), { status: "paused" })).statusCode).toBe(200);
  });

  it("refuses provider runs while no provider is configured", async () => {
    const p = (await post(b("/runs/preview"), { provider: "openrouter_answer" })).json().data;
    expect(p.canRun).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/No OpenRouter API key/);
    expect((await post(b("/runs/preview"), { provider: "chatgpt" })).json().data.blockers[0]).toMatch(/no supported API; import observed answers instead/);
    const r = await post(b("/runs"), { provider: "openrouter_answer", confirm: true });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("PROVIDER_NOT_AVAILABLE");
  });

  it("collects through the provider end to end: confirmation, idempotency, retries, failures, provenance and AI attribution", async () => {
    mock.enabled = true;
    const reg = (await get(`${base}/providers`)).json().data.providers;
    expect(Object.fromEntries(reg.map((p: { id: string; status: string }) => [p.id, p.status]))).toMatchObject({ openrouter_answer: "available", openrouter_web: "requires_approval" });
    // Active queries assigned to this provider: Q1, Q2, Q3 (the draft is paused).
    mock.answers[Q1] = { text: "Acme and Globex. Docs: https://acme-test.com/docs.", annotations: [{ url: "https://reviews-test.org/crm", title: "CRM reviews" }, { url: "http://127.0.0.1/admin" }] };
    mock.behaviour[Q2] = ["transient", "ok"];
    mock.behaviour[Q3] = ["invalid"];
    const preview = (await post(b("/runs/preview"), { provider: "openrouter_answer", repeats: 1 })).json().data;
    expect(preview).toMatchObject({ canRun: true, queries: 3, requests: 3, model: "test/aiv-free-model", blockers: [] });
    expect(preview.costEstimate).toMatch(/No credits/);
    expect(mock.calls).toEqual([]); // a preview never calls the provider
    expect((await post(b("/runs"), { provider: "openrouter_answer" })).statusCode).toBe(400); // confirmation required
    const run = await post(b("/runs"), { provider: "openrouter_answer", confirm: true, idempotencyKey: "run-key-0001" });
    expect(run.statusCode).toBe(202);
    const runId = run.json().data.run.id;
    expect((await post(b("/runs"), { provider: "openrouter_answer", confirm: true, idempotencyKey: "run-key-0001" })).json().data).toMatchObject({ deduplicated: true, run: { id: runId } });
    expect((await post(b("/runs"), { provider: "openrouter_answer", confirm: true })).json().data).toMatchObject({ deduplicated: true, run: { id: runId } }); // one active run per brand
    for (let i = 0; i < 6; i++) {
      await db.query("UPDATE aiv_runs SET next_attempt_at = NOW() WHERE id = $1", [runId]);
      if ((await svc.runVisibilitySlice(10_000)) === "idle") break;
    }
    const done = (await get(b(`/runs/${runId}`))).json().data;
    expect(done).toMatchObject({ status: "partial", items_total: 3, items_done: 2, items_failed: 1 });
    expect(done.items.find((i: { query_text: string }) => i.query_text === Q3)).toMatchObject({ status: "failed", error_code: "INVALID_REQUEST", observation_id: null });
    expect(done.items.find((i: { query_text: string }) => i.query_text === Q2)).toMatchObject({ status: "done", attempts: 2 });
    const api = (await get(b("/observations?method=provider_api&limit=100"))).json().data;
    expect(api).toHaveLength(2); // the failed request created no observation
    const o1 = (await get(b(`/observations/${api.find((o: { query_text: string }) => o.query_text === Q1).id}`))).json().data;
    expect(o1).toMatchObject({ provider: "openrouter_answer", surface: "model_api", collection_method: "provider_api", model: "test/aiv-free-model", web_grounded: false, prompt_version: "aiv-prompt-1", run_id: runId, run_trigger: "manual", language: null });
    expect(o1.provider_request_id).toMatch(/^gen-/);
    expect(o1.usage).toMatchObject({ totalTokens: 30 });
    // Provider annotation kept; unsafe annotation dropped; URL in the text recorded as an inline URL.
    expect(o1.citations.map((c: { kind: string; host: string }) => [c.kind, c.host])).toEqual([["provider_annotation", "reviews-test.org"], ["inline_text_url", "acme-test.com"]]);
    const { rows: execs } = await db.query("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE aiv_brand_id = $2)::int AS attributed FROM agent_executions WHERE org_id = $1 AND agent_type = 'ai_visibility_collection'", [A.id, brand]);
    expect(execs[0]).toEqual({ n: 4, attributed: 4 });
    const usage = (await get(`${base}/providers`)).json().data.usage;
    expect(usage).toMatchObject({ used: 4, limit: 30 });
    // API and import metrics stay in separate groups.
    const groups = (await get(b("/metrics?from=2020-01-01"))).json().data.groups.map((g: { key: { method: string } }) => g.key.method);
    expect(groups).toContain("provider_api");
    expect(groups).toContain("manual_import");
  });

  it("enforces the daily quota, retries timeouts and supports cancellation", async () => {
    await db.query("UPDATE aiv_provider_usage SET requests = 30 WHERE org_id = $1 AND provider = 'openrouter_answer' AND day = CURRENT_DATE", [A.id]);
    const blocked = (await post(b("/runs/preview"), { provider: "openrouter_answer" })).json().data;
    expect(blocked.blockers.join(" ")).toMatch(/0 of 30 requests left/);
    await db.query("UPDATE aiv_provider_usage SET requests = 4 WHERE org_id = $1 AND provider = 'openrouter_answer' AND day = CURRENT_DATE", [A.id]);
    mock.behaviour[Q1] = ["timeout", "ok"];
    const runRes = (await post(b("/runs"), { provider: "openrouter_answer", confirm: true, queryIds: [(await get(b("/queries"))).json().data.find((q: { text: string }) => q.text === Q1).id] }, "owner")).json(); // separate session: POST /runs is rate-limited per session
    expect(runRes.error).toBeUndefined();
    const run = runRes.data.run;
    await svc.runVisibilitySlice(10_000);
    let r = (await get(b(`/runs/${run.id}`))).json().data;
    expect(r).toMatchObject({ status: "queued" });
    expect(r.error).toMatch(/Retrying: Execution timed out|Retrying/);
    await db.query("UPDATE aiv_runs SET next_attempt_at = NOW() WHERE id = $1", [run.id]);
    await svc.runVisibilitySlice(10_000);
    await svc.runVisibilitySlice(10_000);
    r = (await get(b(`/runs/${run.id}`))).json().data;
    expect(r).toMatchObject({ status: "completed", items_done: 1, items_failed: 0 });
    const queuedRes = (await post(b("/runs"), { provider: "openrouter_answer", confirm: true, repeats: 2 }, "owner")).json();
    expect(queuedRes.error).toBeUndefined();
    const queued = queuedRes.data.run;
    expect((await post(b(`/runs/${queued.id}/cancel`), {}, "viewer")).statusCode).toBe(403);
    expect((await post(b(`/runs/${queued.id}/cancel`), {})).json().data.cancelled).toBe(true);
    expect(await svc.runVisibilitySlice(10_000)).toBe("idle");
    expect((await get(b(`/runs/${queued.id}`))).json().data).toMatchObject({ status: "cancelled", items_done: 0 });
  });

  it("enables a weekly schedule only with confirmation and limits, and never duplicates scheduled runs", async () => {
    const put = (payload: unknown) => h.request("PUT", b("/schedule"), { ...as(), payload });
    expect((await put({ schedule: "weekly", provider: "openrouter_answer", repeats: 1, maxRequests: 10 })).statusCode).toBe(400);
    expect((await put({ schedule: "weekly", provider: "openrouter_answer", repeats: 1, maxRequests: 2, confirm: true })).json().error.code).toBe("SCHEDULE_NOT_ALLOWED");
    expect((await put({ schedule: "weekly", provider: "chatgpt", repeats: 1, maxRequests: 10, confirm: true })).json().error.code).toBe("SCHEDULE_NOT_ALLOWED");
    const ok = await put({ schedule: "weekly", provider: "openrouter_answer", repeats: 1, maxRequests: 10, confirm: true });
    expect(ok.json().data).toMatchObject({ schedule: "weekly", schedule_provider: "openrouter_answer", schedule_max_requests: 10 });
    expect(await svc.scheduleDueVisibilityRuns()).toBe(1);
    expect(await svc.scheduleDueVisibilityRuns()).toBe(0);
    await db.query("UPDATE aiv_runs SET status = 'cancelled' WHERE brand_id = $1 AND status IN ('queued','running')", [brand]);
    expect(await svc.scheduleDueVisibilityRuns()).toBe(0); // same ISO week: already scheduled once
    const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM aiv_runs WHERE brand_id = $1 AND trigger = 'scheduled'", [brand]);
    expect(rows[0].n).toBe(1);
    expect((await put({ schedule: "off" })).json().data.schedule).toBe("off");
    const { rows: ev } = await db.query("SELECT COUNT(*)::int AS n FROM aiv_events WHERE brand_id = $1 AND event = 'schedule_changed'", [brand]);
    expect(ev[0].n).toBe(2);
  });

  it("stores schema-validated AI summaries that only reference provided evidence", async () => {
    const r = await post(b("/ai/summaries"), {});
    expect(r.statusCode).toBe(201);
    expect(r.json().data.dropped).toBe(2);
    expect(r.json().data.body.patterns).toHaveLength(1);
    expect(r.json().data.body.sourceCategories.map((s: { host: string }) => s.host)).not.toContain("injected.example");
    mock.enabled = false;
    expect((await post(b("/ai/summaries"), {})).json().error.code).toBe("AI_NOT_CONFIGURED");
    expect((await get(b("/ai/summaries"))).json()).toMatchObject({ meta: { available: false } });
    expect((await get(b("/ai/summaries"))).json().data).toHaveLength(1);
  });

  it("returns 404 for every brand route of another tenant", async () => {
    for (const path of ["/overview", "/queries", "/observations", "/metrics", "/competitor-comparison", "/sources", "/domains", "/opportunities", "/imports", "/runs", "/competitors", "/ai/summaries"]) {
      expect((await get(b(path), "owner", B)).statusCode, path).toBe(404);
    }
    const o = (await get(b("/overview"))).json().data;
    expect(o.counts).toMatchObject({ imported_observations: 8, api_observations: 3 });
    expect(o.providers.length).toBeGreaterThan(5);
  });

  it("archiving a brand stops collection and its schedule", async () => {
    expect((await patch(b(), { status: "archived" })).json().data).toMatchObject({ status: "archived", schedule: "off" });
    expect((await post(b("/runs/preview"), { provider: "openrouter_answer" })).json().data.blockers).toContain("The brand is not active.");
    expect((await get(`${base}/brands`)).json().data).toEqual([]);
    expect((await get(`${base}/brands?includeArchived=true`)).json().data).toHaveLength(1);
  });
});
