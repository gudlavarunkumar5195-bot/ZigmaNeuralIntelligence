import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Keyword research API end to end with the real Search Console provider over
// synthetic Search Console rows seeded into PostgreSQL. No network, no paid
// provider, no customer data. AI is not configured (no OPENROUTER key).
vi.hoisted(() => {
  process.env.KEYWORD_RESEARCH_MAX_RUNS_PER_ORG_PER_DAY = "60";
  delete process.env.OPENROUTER_API_KEY;
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("keyword research API (PostgreSQL + HTTP, Search Console provider)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let siteA2: string; // a second website of org A with Search Console data (the "competitor")
  let siteNoGsc: string;
  let domainA: string;
  let domainA2: string;
  let latest: string;
  const as = (role: "owner" | "admin" | "member" | "viewer", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const post = (kind: string, payload: Record<string, unknown>, who = as("member")) => h.request("POST", `/api/v1/keyword-research/${kind}`, { ...who, payload });
  const get = (url: string, who = as("viewer")) => h.request("GET", `/api/v1/keyword-research${url}`, who);

  /** Synthetic Search Console query rows for a website (integration + property + coverage + daily rows). */
  async function seedGsc(org: SeededOrg, websiteId: string, rows: Array<[string, number, number, number]>, sub: string) {
    const integ = (await db.query<{ id: string }>(
      `INSERT INTO integrations (org_id, provider, external_account_id, scopes, refresh_token_enc, key_id, status)
       VALUES ($1,'google_search_console',$2,'{}','k1.x.y.z','k1','active')
       ON CONFLICT (org_id, provider, external_account_id) DO UPDATE SET status = 'active' RETURNING id`,
      [org.id, sub],
    )).rows[0].id;
    const prop = (await db.query<{ id: string }>(
      "INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level) VALUES ($1,$2,$3,$4,'domain','siteOwner') RETURNING id",
      [org.id, websiteId, integ, `sc-domain:${websiteId.slice(0, 8)}.example`],
    )).rows[0].id;
    for (const offset of [0, 1]) {
      const day = (await db.query<{ d: string }>("SELECT to_char($1::date - $2::int, 'YYYY-MM-DD') AS d", [latest, offset])).rows[0].d;
      await db.query("INSERT INTO gsc_coverage (property_id, org_id, dimension_set, day, outcome, row_count, data_state) VALUES ($1,$2,'query',$3,'complete',$4,'final')", [prop, org.id, day, rows.length]);
      for (const [q, clicks, impressions, position] of rows) {
        await db.query(
          "INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state) VALUES ($1,$2,'query',$3,$4,$5,$6,$7,$8,'final')",
          [prop, org.id, day, q, clicks, impressions, impressions ? clicks / impressions : 0, position],
        );
      }
    }
    return prop;
  }

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "kw-a");
    B = await seedOrg(h, "kw-b");
    db = await import("../db/client.js");
    latest = (await db.query<{ d: string }>("SELECT to_char(CURRENT_DATE - 3, 'YYYY-MM-DD') AS d")).rows[0].d;
    domainA = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id=$1", [A.websiteId])).rows[0].domain;
    domainA2 = `rival-${Date.now()}.example`;
    siteA2 = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [A.id, `https://${domainA2}`, domainA2])).rows[0].id;
    siteNoGsc = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [A.id, `https://nogsc-${Date.now()}.example`, `nogsc-${Date.now()}.example`])).rows[0].id;
    await seedGsc(A, A.websiteId, [
      ["running shoes", 10, 200, 4],
      ["buy running shoes", 5, 50, 6],
      ["how to clean running shoes", 2, 80, 9],
      ["trail shoes", 1, 30, 12],
      ["=HYPERLINK(\"http://evil.example\")", 0, 5, 30],
    ], "sub-a1");
    await seedGsc(A, siteA2, [
      ["running shoes", 20, 300, 2],
      ["shoe laces", 3, 40, 5],
    ], "sub-a2");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
  });

  it("lists capabilities honestly: what Search Console supplies and what needs a licensed provider", async () => {
    const r = (await get("/capabilities")).json().data;
    const gsc = r.providers.find((p: { id: string }) => p.id === "google_search_console");
    expect(gsc).toMatchObject({ kind: "first_party", configured: true, metrics: ["clicks", "impressions", "ctr", "position"] });
    expect(gsc.unsupported).toEqual(["competitor_domains", "serp_results"]);
    expect(gsc.metrics).not.toContain("search_volume");
    expect(r.limits).toMatchObject({ maxCompetitors: 5, runsPerDay: 60 });
  });

  let organicRunId = "";
  it("organic keywords: real site metrics with provenance, rule-based intent, and no fabricated volume/difficulty/CPC", async () => {
    const r = await post("organic", { websiteId: A.websiteId });
    expect(r.statusCode).toBe(201);
    const { run, results } = r.json().data;
    organicRunId = run.id;
    expect(run).toMatchObject({ kind: "organic", provider: "google_search_console", status: "completed", sample: true, observed_through: latest, result_count: 5 });
    expect(run.notes.join(" ")).toMatch(/omits rare and anonymized queries/);
    expect(results[0]).toMatchObject({ keyword: "running shoes", metrics: { clicks: 20, impressions: 400, ctr: 0.05, position: 4 } });
    for (const row of results) {
      for (const m of ["search_volume", "keyword_difficulty", "cpc", "competition"]) expect(row.metrics).not.toHaveProperty(m);
    }
    const intents = Object.fromEntries(results.map((x: { keyword: string; intent: string | null }) => [x.keyword, x.intent]));
    expect(intents).toMatchObject({ "buy running shoes": "transactional", "how to clean running shoes": "informational", "running shoes": null });
  });

  it("overview: known keywords get the site's metrics; unknown ones are reported as no data, not zero", async () => {
    const r = await post("overview", { websiteId: A.websiteId, keywords: ["Running Shoes", "never searched"] });
    const { run, results } = r.json().data;
    expect(run.status).toBe("partial");
    expect(results.map((x: { keyword: string }) => x.keyword)).toEqual(["running shoes"]);
    expect(run.notes.join(" ")).toMatch(/1 keyword\(s\) did not appear .* \(no data, not zero\)/);
  });

  it("ideas and related come from queries the site already appears for; nothing is generated", async () => {
    const ideas = (await post("ideas", { websiteId: A.websiteId, seed: "running shoes" })).json().data;
    expect(ideas.results.map((x: { keyword: string }) => x.keyword).sort()).toEqual(["buy running shoes", "how to clean running shoes", "running shoes"]);
    const related = (await post("related", { websiteId: A.websiteId, keyword: "trail shoes" })).json().data;
    const keys = related.results.map((x: { keyword: string }) => x.keyword);
    expect(keys).not.toContain("trail shoes");
    expect(keys).toEqual(expect.arrayContaining(["running shoes", "buy running shoes"]));
  });

  it("rejects unsupported capabilities, targeting and missing data sources with clear errors", async () => {
    const comp = await post("gap", { websiteId: A.websiteId, competitors: ["unknown-competitor.example"] });
    expect(comp.statusCode).toBe(422);
    expect(comp.json().error).toMatchObject({ code: "COMPETITOR_DATA_UNAVAILABLE" });
    const targeted = await post("organic", { websiteId: A.websiteId, country: "us" });
    expect(targeted.json().error.code).toBe("TARGETING_UNSUPPORTED");
    expect(targeted.json().error.runId).toBeTruthy();
    const failedRun = (await get(`/runs/${targeted.json().error.runId}`)).json().data.run;
    expect(failedRun).toMatchObject({ status: "failed", error_code: "TARGETING_UNSUPPORTED" });
    const noGsc = await post("organic", { websiteId: siteNoGsc });
    expect(noGsc.json().error).toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    const otherProvider = await post("organic", { websiteId: A.websiteId, provider: "semrush" });
    expect(otherProvider.json().error.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("gap: shared / missing / unique between two of the organization's sites, partial when a competitor has no data", async () => {
    const r = await post("gap", { websiteId: A.websiteId, competitors: [domainA2, "unknown-competitor.example"] });
    expect(r.statusCode).toBe(201);
    const { run } = r.json().data;
    expect(run.status).toBe("partial");
    expect(run.summary.counts).toEqual({ shared: 1, missing: 1, unique: 4 });
    expect(run.summary.unavailable).toEqual([expect.objectContaining({ domain: "unknown-competitor.example" })]);
    expect(run.notes.join(" ")).toMatch(/"missing" and "unique" mean "not observed"/);
    const missing = (await get(`/runs/${run.id}?gap=missing`)).json().data.results;
    expect(missing).toEqual([expect.objectContaining({ keyword: "shoe laces", gap_category: "missing", absence_from_sample: true, competitors_present: 1, metrics: {} })]);
    const shared = (await get(`/runs/${run.id}?gap=shared`)).json().data.results[0];
    expect(shared.observations[domainA2.toLowerCase()]).toMatchObject({ position: 2 });
  });

  it("reuses a cached identical run, and concurrent identical requests create one run", async () => {
    const again = await post("organic", { websiteId: A.websiteId });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ data: { run: { id: organicRunId } }, meta: { reused: "cache" } });
    const before = Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id=$1", [A.id])).rows[0].n);
    const burst = await Promise.all(Array.from({ length: 5 }, () => post("ideas", { websiteId: A.websiteId, seed: "trail" })));
    expect(new Set(burst.map((x) => x.json().data.run.id)).size).toBe(1);
    expect(Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id=$1", [A.id])).rows[0].n)).toBe(before + 1);
  });

  it("history: newest first with cursor pagination; results sort, filter and page stably", async () => {
    const first = (await get(`/runs?websiteId=${A.websiteId}&limit=2`)).json();
    expect(first.data).toHaveLength(2);
    const second = (await get(`/runs?websiteId=${A.websiteId}&limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`)).json();
    expect(second.data.map((x: { id: string }) => x.id)).not.toEqual(expect.arrayContaining(first.data.map((x: { id: string }) => x.id)));
    const byClicks = (await get(`/runs/${organicRunId}?sort=clicks&order=desc&limit=2`)).json();
    expect(byClicks.data.results.map((x: { keyword: string }) => x.keyword)).toEqual(["running shoes", "buy running shoes"]);
    const rest = (await get(`/runs/${organicRunId}?sort=clicks&order=desc&limit=10&cursor=${encodeURIComponent(byClicks.meta.nextCursor)}`)).json();
    expect(rest.data.results).toHaveLength(3);
    expect((await get(`/runs/${organicRunId}?intent=transactional`)).json().data.results.map((x: { keyword: string }) => x.keyword)).toEqual(["buy running shoes"]);
    expect((await get(`/runs/${organicRunId}?search=trail`)).json().data.results).toHaveLength(1);
    expect((await get(`/runs/${organicRunId}?sort=clicks&order=asc&cursor=${encodeURIComponent(byClicks.meta.nextCursor)}`)).statusCode).toBe(400);
    expect((await get(`/runs/${organicRunId}?sort=volume`)).statusCode).toBe(400);
    // Sorting by a metric the source never returns pages through the "not returned" rows too.
    for (const order of ["desc", "asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await get(`/runs/${organicRunId}?sort=search_volume&order=${order}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(page.statusCode).toBe(200);
        seen.push(...page.json().data.results.map((x: { keyword: string }) => x.keyword));
        cursor = page.json().meta.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    }
  });

  it("compares two snapshots of the same kind and website", async () => {
    await db.query("UPDATE gsc_search_daily SET clicks = clicks + 5 WHERE org_id=$1 AND dim_value='trail shoes'", [A.id]);
    const newer = (await post("organic", { websiteId: A.websiteId, limit: 99 })).json().data.run; // a different limit bypasses the cache
    const diff = (await get(`/runs/${newer.id}/compare/${organicRunId}`)).json().data;
    expect(diff.older.id).toBe(organicRunId);
    expect(diff.changed).toEqual([expect.objectContaining({ key: "trail shoes", changes: expect.objectContaining({ clicks: { from: 2, to: 12 } }) })]);
    const gapRun = (await db.query<{ id: string }>("SELECT id FROM research_runs WHERE org_id=$1 AND kind='gap' LIMIT 1", [A.id])).rows[0].id;
    expect((await get(`/runs/${newer.id}/compare/${gapRun}`)).json().error.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("exports CSV for members only, neutralising spreadsheet formulas and omitting unsupported metrics", async () => {
    expect((await h.request("GET", `/api/v1/keyword-research/runs/${organicRunId}/export`, as("viewer"))).statusCode).toBe(403);
    const r = await h.request("GET", `/api/v1/keyword-research/runs/${organicRunId}/export`, as("member"));
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="keyword-research-organic-[0-9a-f]{8}\.csv"$/);
    const lines = r.body.trim().split("\r\n");
    expect(lines[0]).toBe("keyword,clicks,impressions,ctr,position,intent,intent_source,source,observed_through");
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(r.body).not.toMatch(/^=|,=/m);
    expect(lines[0]).not.toMatch(/search_volume|cpc/);
  });

  it("AI prioritization degrades clearly when AI is not configured; research still works", async () => {
    const r = await h.request("POST", `/api/v1/keyword-research/runs/${organicRunId}/insights`, as("member"));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("AI_UNAVAILABLE");
    expect((await get(`/runs/${organicRunId}`)).json().data.insight).toBeNull();
  });

  it("saved lists: create, add from a run (deduplicated), remove, delete", async () => {
    const list = (await h.request("POST", "/api/v1/keyword-research/lists", { ...as("member"), payload: { name: "Content plan" } })).json().data;
    expect((await h.request("POST", "/api/v1/keyword-research/lists", { ...as("member"), payload: { name: "Content plan" } })).json().error.code).toBe("LIST_CONFLICT");
    const add = (kws: string[]) => h.request("POST", `/api/v1/keyword-research/lists/${list.id}/items`, { ...as("member"), payload: { runId: organicRunId, keywords: kws } });
    expect((await add(["Running Shoes", "trail shoes", "not in run"])).json().data).toEqual({ added: 2 });
    expect((await add(["running shoes"])).json().data).toEqual({ added: 0 });
    const got = (await h.request("GET", `/api/v1/keyword-research/lists/${list.id}`, as("viewer"))).json().data;
    expect(got.items.map((i: { keyword: string }) => i.keyword).sort()).toEqual(["running shoes", "trail shoes"]);
    expect((await h.request("DELETE", `/api/v1/keyword-research/lists/${list.id}/items?keyword=trail%20shoes`, as("member"))).statusCode).toBe(204);
    expect((await h.request("GET", "/api/v1/keyword-research/lists", as("viewer"))).json().data[0]).toMatchObject({ name: "Content plan", items: 1 });
    expect((await h.request("POST", "/api/v1/keyword-research/lists", { ...as("viewer"), payload: { name: "x" } })).statusCode).toBe(403);
    expect((await h.request("DELETE", `/api/v1/keyword-research/lists/${list.id}`, as("member"))).statusCode).toBe(204);
  });

  it("validates and bounds every input", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["organic", { websiteId: "nope" }],
      ["organic", { websiteId: A.websiteId, extra: 1 }],
      ["organic", { websiteId: A.websiteId, limit: 100_000 }],
      ["overview", { websiteId: A.websiteId }],
      ["overview", { websiteId: A.websiteId, keyword: "a", keywords: ["b"] }],
      ["overview", { websiteId: A.websiteId, keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) }],
      ["ideas", { websiteId: A.websiteId, seed: "   " }],
      ["ideas", { websiteId: A.websiteId, seed: "x".repeat(500) }],
      ["gap", { websiteId: A.websiteId, competitors: [] }],
      ["gap", { websiteId: A.websiteId, competitors: ["not a domain"] }],
      ["gap", { websiteId: A.websiteId, competitors: ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"] }],
      ["organic", { websiteId: A.websiteId, country: "USA" }],
    ];
    for (const [kind, body] of cases) expect((await post(kind, body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it("enforces roles and tenant isolation on every route", async () => {
    expect((await post("organic", { websiteId: A.websiteId }, as("viewer"))).statusCode).toBe(403);
    const foreign = as("owner", B);
    expect((await post("organic", { websiteId: A.websiteId }, foreign)).statusCode).toBe(404);
    for (const url of [`/runs/${organicRunId}`, `/runs/${organicRunId}/compare/${organicRunId}`]) {
      expect((await get(url, foreign)).statusCode, url).toBe(404);
    }
    expect((await h.request("GET", `/api/v1/keyword-research/runs/${organicRunId}/export`, foreign)).statusCode).toBe(404);
    expect((await h.request("POST", `/api/v1/keyword-research/runs/${organicRunId}/insights`, foreign)).statusCode).toBe(404);
    expect((await get("/runs", foreign)).json().data).toEqual([]);
    const listB = (await h.request("POST", "/api/v1/keyword-research/lists", { ...foreign, payload: { name: "B list" } })).json().data;
    const steal = await h.request("POST", `/api/v1/keyword-research/lists/${listB.id}/items`, { ...foreign, payload: { runId: organicRunId, keywords: ["running shoes"] } });
    expect(steal.statusCode).toBe(404);
    expect((await h.request("GET", `/api/v1/keyword-research/lists/${listB.id}`, as("viewer"))).statusCode).toBe(404);
  });

  it("enforces the daily run quota exactly under concurrent requests", async () => {
    const used = Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id=$1 AND created_at > NOW() - interval '24 hours'", [A.id])).rows[0].n);
    // Fill the quota to 2 below the limit with old-style synthetic rows.
    await db.query(
      `INSERT INTO research_runs (org_id, website_id, kind, provider, capability, params, params_hash, status)
       SELECT $1, $2, 'organic', 'google_search_console', 'organic_keywords', '{}'::jsonb, md5(g::text) || md5((g+1)::text), 'completed'
         FROM generate_series(1, $3) g`,
      [A.id, A.websiteId, 60 - 2 - used],
    );
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => post("ideas", { websiteId: A.websiteId, seed: `seed${i}` })));
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201 || c === 422)).toHaveLength(2); // a run was admitted (data may be empty or unavailable)
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
    expect(burst.find((r) => r.statusCode === 429)!.json().error.code).toBe("QUOTA_EXCEEDED");
  });
});
