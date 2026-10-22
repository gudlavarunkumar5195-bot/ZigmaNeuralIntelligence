import * as cheerio from "cheerio";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The AI executor is faked: no provider call, no cost. `available` toggles "AI not configured".
const ai = vi.hoisted(() => ({ available: false, answer: null as unknown, fail: false, calls: [] as Array<Record<string, unknown>> }));
vi.mock("../ai/ox-alpha.js", async () => {
  const actual = await vi.importActual<typeof import("../ai/ox-alpha.js")>("../ai/ox-alpha.js");
  return {
    ...actual,
    getOxAlphaExecutor: () => (ai.available ? {
      execute: async (req: Record<string, unknown>) => {
        ai.calls.push(req);
        return ai.fail ? { success: false, parsedJson: null, attempts: 1, totalDurationMs: 1, executionIds: [] } : { success: true, response: { model: "free/model:free" }, parsedJson: ai.answer, attempts: 1, totalDurationMs: 1, executionIds: ["e1"] };
      },
    } : null),
  };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";
import type { CrawlPage, CrawlResult } from "../scanner/crawl.js";
import { extractContentFeatures } from "../content/extract.js";

// Synthetic site, pages and Search Console rows only.
describe.skipIf(!INTEGRATION)("Content intelligence (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let site: string;
  let S: string;
  const as = (role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const url = (path: string, w = A.websiteId) => `/api/v1/websites/${w}/content${path}`;
  const get = (path: string, role: "owner" | "member" | "viewer" = "viewer") => h.request("GET", url(path), as(role));
  const body = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 41} word${i % 97}`).join(" ");

  const html = (o: { title: string; h1: string; h2?: string[]; words: number; seed: string; desc?: string; extra?: string }) =>
    `<html lang="en"><head><title>${o.title}</title>${o.desc ? `<meta name="description" content="${o.desc}">` : ""}</head><body><main><h1>${o.h1}</h1>${(o.h2 ?? []).map((x) => `<h2>${x}</h2>`).join("")}<p>${body(o.words, o.seed)}</p>${o.extra ?? ""}</main></body></html>`;
  const page = (path: string, doc: string | null, over: Partial<CrawlPage> = {}): CrawlPage => {
    const u = `${S}${path}`;
    const $ = doc ? cheerio.load(doc) : null;
    return {
      url: u, finalUrl: u, status: 200, finalStatus: 200, redirectChain: [], depth: 1, discoveredFrom: `${S}/`, contentType: "text/html",
      title: $ ? $("title").text() : null, metaDescription: $ ? $('meta[name="description"]').attr("content") ?? null : null, canonicals: [u], robotsMeta: null, h1Count: 1,
      internalLinks: [], indexable: true, inSitemap: false, fetchError: null, responseMs: 5, redirectTarget: null, outcome: "ok", xRobotsTag: null,
      imagesTotal: 0, imagesMissingAlt: 0, imagesMissingAltSample: [], indexabilityReasons: [], content: $ ? extractContentFeatures($, u, (x) => x.startsWith(S)) : null, ...over,
    };
  };
  const crawl = (pages: CrawlPage[], inlinks: Record<string, number> = {}): CrawlResult => ({
    pages, inlinks: Object.fromEntries(Object.entries(inlinks).map(([k, count]) => [`${S}${k}`, { count, sample: [] }])) as CrawlResult["inlinks"],
    summary: { startUrl: `${S}/`, origin: S, pagesCrawled: pages.length, pagesDiscovered: pages.length, truncated: false, truncatedReason: null, robotsStatus: "parsed", startBlockedByRobots: false, sitemapStatus: "found", sitemapFiles: [], sitemapUrlCount: 0, durationMs: 10, maxPages: 100, reconcilable: true, pagesBlockedByRobots: 0, maxDepth: 5 },
  });
  const persist = async (result: CrawlResult) => {
    const scanId = (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'completed','{crawl}') RETURNING id", [A.websiteId, A.id])).rows[0].id;
    const { persistCrawl } = await import("../services/site-audit.service.js");
    await db.withTransaction((tx) => persistCrawl(tx, { scanId, orgId: A.id, websiteId: A.websiteId, result, issues: [], completed: true }));
    return scanId;
  };
  const analyse = async () => {
    const { processContentTick } = await import("../services/content.service.js");
    for (let i = 0; i < 30; i++) {
      const pending = await db.query("SELECT 1 FROM content_audit_runs WHERE website_id = $1 AND status IN ('queued','running')", [A.websiteId]);
      if (!pending.rows.length) return;
      await processContentTick();
    }
    throw new Error("analysis did not finish");
  };

  const shoes = html({ title: "Trail running shoes", h1: "Trail running shoes", h2: ["Fit", "Grip"], words: 400, seed: "shoe", desc: "A specific description of trail running shoes for every kind of terrain and runner." });
  const v1 = () => crawl([
    page("/", html({ title: "Home of the trail running store", h1: "Welcome", words: 300, seed: "home", desc: "Everything for trail runners: shoes, packs and guides for every distance." })),
    page("/shoes", shoes),
    page("/thin", html({ title: "Thin page with a title", h1: "Thin", words: 40, seed: "thin", desc: "Short page description that is still long enough to pass the check." })),
    page("/copy-a", html({ title: "Copy page A for testing", h1: "Copy", words: 300, seed: "dup", desc: "Identical content example page with a long enough description here." })),
    page("/copy-b", html({ title: "Copy page B for testing", h1: "Copy", words: 300, seed: "dup", desc: "Identical content example page with a long enough description here." })),
    page("/broken", null, { outcome: "fetch_error" as CrawlPage["outcome"], status: 0, finalStatus: 0, fetchError: "ECONNRESET", indexable: false, indexabilityReasons: ["fetch_error"] }),
  ], { "/": 0, "/shoes": 1, "/thin": 3, "/copy-a": 3, "/copy-b": 3 });

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    A = await seedOrg(h, "content-a");
    B = await seedOrg(h, "content-b");
    site = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id = $1", [A.websiteId])).rows[0].domain;
    S = `https://${site}`;
    // Search Console: /shoes has many impressions but a low CTR; / has a normal CTR; /thin lost clicks; queries about trail shoes and pizza.
    const integ = (await db.query<{ id: string }>("INSERT INTO integrations (org_id, provider, external_account_id, scopes, refresh_token_enc, key_id, status) VALUES ($1,'google_search_console',$2,'{}','k1.x.y.z','k1','active') RETURNING id", [A.id, `sub-${A.id}`])).rows[0].id;
    const prop = (await db.query<{ id: string }>("INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level) VALUES ($1,$2,$3,$4,'domain','siteOwner') RETURNING id", [A.id, A.websiteId, integ, `sc-domain:${site}`])).rows[0].id;
    const seed = async (set: "page" | "query", dim: string, daysAgo: number, clicks: number, impressions: number, position: number) =>
      db.query("INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state) VALUES ($1,$2,$3,CURRENT_DATE - $4::int,$5,$6,$7,$8,$9,'final')", [prop, A.id, set, daysAgo, dim, clicks, impressions, impressions ? clicks / impressions : 0, position]);
    for (const d of [3, 10, 20]) {
      await seed("page", `${S}/shoes`, d, 1, 400, 5);
      await seed("page", `${S}/`, d, 40, 400, 5);
      await seed("page", `${S}/copy-a`, d, 35, 300, 6);
      await seed("page", `${S}/thin`, d, 3, 100, 12);
      await seed("query", "trail running shoes", d, 5, 300, 6);
      await seed("query", "best trail running shoes", d, 2, 200, 8);
      await seed("query", "pizza dough recipe", d, 1, 150, 15);
    }
    for (const d of [35, 45]) await seed("page", `${S}/thin`, d, 40, 100, 4);
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id, B?.id].filter(Boolean) as string[]);
    await h?.close();
  });
  beforeEach(() => { ai.available = false; ai.fail = false; ai.calls.length = 0; });

  it("a completed crawl builds a persistent inventory and queues exactly one analysis", async () => {
    expect((await get("/overview")).json().data.inventory.total).toBe(0);
    expect((await h.request("POST", url("/runs"), as())).json().error.code).toBe("NO_INVENTORY");
    const scanId = await persist(v1());
    const runs = (await db.query("SELECT scan_id, trigger, status FROM content_audit_runs WHERE website_id = $1", [A.websiteId])).rows;
    expect(runs).toEqual([{ scan_id: scanId, trigger: "crawl", status: "queued" }]);
    const pages = (await get("/pages?limit=10")).json();
    expect(pages.meta).toMatchObject({ total: 6, searchConsole: true });
    const broken = pages.data.find((p: { url: string }) => p.url.endsWith("/broken"));
    expect(broken).toMatchObject({ crawl_state: "fetch_failed", crawl_error: "ECONNRESET", word_count: null });
    const shoesRow = pages.data.find((p: { url: string }) => p.url.endsWith("/shoes"));
    expect(shoesRow).toMatchObject({ crawl_state: "ok", h1: "Trail running shoes", search: { clicks: 3, impressions: 1200, position: 5 } });
    // Unique per URL: re-persisting the same pages updates, never duplicates.
    await analyse();
    expect((await db.query("SELECT COUNT(*)::int AS n FROM content_pages WHERE website_id = $1", [A.websiteId])).rows[0].n).toBe(6);
  });

  it("findings carry evidence and rule versions; crawl failures are not content findings", async () => {
    const f = (await get("/findings?limit=100")).json().data;
    const rules = f.map((x: { rule_id: string }) => x.rule_id).sort();
    expect(rules).toEqual(["exact_duplicate_content", "thin_content"]);
    expect(f.find((x: { rule_id: string }) => x.rule_id === "thin_content")).toMatchObject({ rule_version: "content-1", heuristic: true, status: "open", evidence: { wordCount: 40 + 40 + 1, threshold: 200 } });
    expect(f.some((x: { url: string | null }) => x.url?.endsWith("/broken"))).toBe(false);
    const run = (await get("/runs")).json().data[0];
    expect(run).toMatchObject({ status: "completed", trigger: "crawl", pages_analyzed: 6, findings_new: 2, findings_open: 2 });
    expect((await get("/findings?severity=bogus")).statusCode).toBe(400);
    expect((await get("/findings?limit=500")).statusCode).toBe(400);
  });

  it("finding lifecycle: ignore needs a reason, resolve only by analysis, reopen on regression, unchanged issues never duplicate", async () => {
    const thin = (await get("/findings?rule=thin_content")).json().data[0];
    expect((await h.request("PATCH", url(`/findings/${thin.id}`), { ...as(), payload: { status: "resolved" } })).statusCode).toBe(400);
    expect((await h.request("PATCH", url(`/findings/${thin.id}`), { ...as(), payload: { status: "ignored" } })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await h.request("PATCH", url(`/findings/${thin.id}`), { ...as("viewer"), payload: { status: "in_progress" } })).statusCode).toBe(403);
    expect((await h.request("PATCH", url(`/findings/${thin.id}`), { ...as(), payload: { status: "in_progress" } })).json().data).toEqual({ from: "open", to: "in_progress" });
    // v2: /thin expanded, duplicates unchanged, /broken still failing. One new analysis, no duplicate findings.
    const v2 = v1();
    v2.pages[2] = page("/thin", html({ title: "Thin page with a title", h1: "Thin", words: 400, seed: "thin", desc: "Short page description that is still long enough to pass the check." }));
    await persist(v2);
    await analyse();
    const after = (await get("/findings?limit=100")).json().data;
    expect(after).toHaveLength(2);
    expect(after.find((x: { id: string }) => x.id === thin.id)).toMatchObject({ status: "resolved" });
    // v3: thin again → reopened.
    await persist(v1());
    await analyse();
    expect((await get(`/findings?rule=thin_content`)).json().data[0]).toMatchObject({ id: thin.id, status: "open" });
    const history = (await get(`/findings/${thin.id}/history`)).json().data.map((e: { event: string }) => e.event);
    expect(history).toEqual(["detected", "status_changed", "resolved", "reopened"]);
    // A page that could not be fetched this time was not re-checked: its findings stay as they are.
    const v4 = v1();
    v4.pages[2] = page("/thin", null, { outcome: "fetch_error" as CrawlPage["outcome"], status: 0, finalStatus: 0, fetchError: "timeout", indexable: false, indexabilityReasons: ["fetch_error"] });
    await persist(v4);
    await analyse();
    expect((await get(`/findings?rule=thin_content`)).json().data[0]).toMatchObject({ id: thin.id, status: "open" });
    expect((await get("/pages?search=thin")).json().data[0]).toMatchObject({ crawl_state: "fetch_failed", word_count: 81 }); // last known content kept
    await persist(v1());
    await analyse();
  });

  it("concurrent manual analysis requests create one run", async () => {
    const [a, b] = await Promise.all([h.request("POST", url("/runs"), as()), h.request("POST", url("/runs"), as())]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 202]);
    expect(a.json().data.run.id).toBe(b.json().data.run.id);
    await analyse();
    expect((await h.request("POST", url("/runs"), as("viewer"))).statusCode).toBe(403);
  });

  it("opportunities cite measured evidence with transparent factors; status, feedback and an observational baseline", async () => {
    const opps = (await get("/opportunities?limit=100")).json().data;
    const kinds = opps.map((o: { kind: string }) => o.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(["declining_page", "low_ctr_snippet"]));
    const low = opps.find((o: { kind: string }) => o.kind === "low_ctr_snippet");
    expect(low).toMatchObject({ url: `${S}/shoes`, evidence: { source: "Google Search Console (28 days)", impressions: 1200, clicks: 3 }, confidence: "high" });
    expect(low.priority_factors.map((f: { name: string }) => f.name)).toEqual(["impressions", "ctr_gap", "position"]);
    const decl = opps.find((o: { kind: string }) => o.kind === "declining_page");
    expect(decl.evidence).toMatchObject({ clicksLast28: 9, clicksPrevious28: 80 });
    const done = await h.request("PATCH", url(`/opportunities/${low.id}`), { ...as(), payload: { status: "done", feedback: "useful", note: "Rewrote the title" } });
    expect(done.json().data.opportunity).toMatchObject({ status: "done", baseline: { clicks: 3, impressions: 1200, position: 5 } });
    expect(done.json().data.outcome).toMatchObject({ enoughTimePassed: false, note: expect.stringMatching(/does not prove/) });
    expect(done.json().data.events.map((e: { event: string }) => e.event)).toEqual(["detected", "status_changed", "feedback"]);
    expect((await h.request("PATCH", url(`/opportunities/${low.id}`), { ...as(), payload: { ownerId: B.users.owner.id } })).json().error.code).toBe("VALIDATION_ERROR");
  });

  it("topics: deterministic clusters, manual names and assignments survive re-analysis", async () => {
    const topics = (await get("/topics")).json().data;
    const trail = topics.find((t: { terms: string[] }) => t.terms.includes("trail"));
    expect(trail).toMatchObject({ queries: 2, queryImpressions: 1500 });
    expect((await h.request("PATCH", url(`/topics/${trail.id}`), { ...as(), payload: { name: "Trail shoes" } })).statusCode).toBe(200);
    const pizza = topics.find((t: { terms: string[] }) => t.terms.includes("pizza"));
    const shoesPage = (await get("/pages?search=shoes")).json().data[0].id;
    expect((await h.request("POST", url(`/topics/${pizza.id}/members`), { ...as(), payload: { memberType: "page", memberKey: shoesPage, action: "assign" } })).json().data).toEqual({ assigned: true });
    expect((await h.request("POST", url(`/topics/${trail.id}/members`), { ...as(), payload: { memberType: "query", memberKey: "best trail running shoes", action: "exclude" } })).json().data).toEqual({ excluded: true });
    await h.request("POST", url("/runs"), as());
    await analyse();
    const again = (await get(`/topics/${trail.id}`)).json().data;
    expect(again.topic).toMatchObject({ name: "Trail shoes", name_locked: true });
    const members = again.members.map((m: { member_type: string; member_key: string; excluded: boolean }) => `${m.member_type}:${m.member_key}:${m.excluded}`);
    expect(members).toContain("query:best trail running shoes:true");
    expect(members).not.toContain(`page:${shoesPage}:false`);
    expect((await get(`/topics/${pizza.id}`)).json().data.members.map((m: { member_key: string; assignment: string }) => `${m.member_key}:${m.assignment}`)).toContain(`${shoesPage}:manual`);
    expect((await h.request("POST", url(`/topics/${trail.id}/members`), { ...as(), payload: { memberType: "page", memberKey: "not-a-uuid", action: "assign" } })).statusCode).toBe(400);
  });

  it("briefs: deterministic draft, revisions with conflict detection, approval needs the checklist", async () => {
    const shoesPage = (await get("/pages?search=shoes")).json().data[0].id;
    const created = await h.request("POST", url("/briefs"), { ...as(), payload: { pageId: shoesPage } });
    expect(created.statusCode).toBe(201);
    const b = created.json().data;
    expect(b).toMatchObject({ source: "deterministic", brief: { status: "draft", current_revision: 1 }, body: { h1: "Trail running shoes", sources: [] } });
    expect(b.body.missingEvidence).toContain("Search volume and difficulty (no licensed provider)");
    const id = b.brief.id;
    const edited = { ...b.body, suggestedTitle: "Trail running shoes: how to choose", internalLinks: [{ url: "https://evil.example/", anchorHint: "x" }, { url: `${S}/`, anchorHint: "Home" }] };
    const saved = await h.request("PUT", url(`/briefs/${id}`), { ...as(), payload: { baseRevision: 1, body: edited } });
    expect(saved.json().data).toMatchObject({ brief: { current_revision: 2 }, body: { suggestedTitle: "Trail running shoes: how to choose", internalLinks: [{ url: `${S}/`, anchorHint: "Home" }] } });
    expect((await h.request("PUT", url(`/briefs/${id}`), { ...as(), payload: { baseRevision: 1, body: edited } })).json().error.code).toBe("REVISION_CONFLICT");
    expect((await h.request("POST", url(`/briefs/${id}/status`), { ...as(), payload: { status: "approved" } })).json().error.code).toBe("CHECKLIST_INCOMPLETE");
    const checked = { ...saved.json().data.body, checklist: saved.json().data.body.checklist.map((c: { item: string }) => ({ ...c, done: true })) };
    await h.request("PUT", url(`/briefs/${id}`), { ...as(), payload: { baseRevision: 2, body: checked } });
    expect((await h.request("POST", url(`/briefs/${id}/status`), { ...as(), payload: { status: "approved" } })).json().data.brief.status).toBe("approved");
    // Editing an approved brief sends it back to draft.
    await h.request("PUT", url(`/briefs/${id}`), { ...as(), payload: { baseRevision: 3, body: { ...checked, h1: "Changed" } } });
    expect((await get(`/briefs/${id}`)).json().data.brief.status).toBe("draft");
    expect((await get(`/briefs/${id}/revisions/1`)).json().data.source).toBe("deterministic");
    expect((await h.request("PUT", url(`/briefs/${id}`), { ...as("viewer"), payload: { baseRevision: 4, body: checked } })).statusCode).toBe(403);
  });

  it("AI suggestions: unavailable without a provider; grounded, sanitized and flagged for review when available; failures change nothing", async () => {
    const id = (await get("/briefs")).json().data[0].id;
    const cur = (await get(`/briefs/${id}`)).json().data.brief.current_revision;
    expect((await h.request("POST", url(`/briefs/${id}/ai-suggestions`), { ...as(), payload: { baseRevision: cur } })).json().error.code).toBe("AI_UNAVAILABLE");
    ai.available = true;
    ai.fail = true;
    expect((await h.request("POST", url(`/briefs/${id}/ai-suggestions`), { ...as(), payload: { baseRevision: cur } })).json().error.code).toBe("AI_FAILED");
    expect((await get(`/briefs/${id}`)).json().data.brief.current_revision).toBe(cur);
    ai.fail = false;
    ai.answer = { suggestedTitle: "Choosing trail running shoes", suggestedMetaDescription: "How to pick shoes for trails.", h1: "Choosing trail running shoes", outline: [{ heading: "Grip", points: ["Lug depth"] }], questions: ["How should trail shoes fit?"], sources: [{ label: "Made up study", url: "https://fake.example" }], internalLinks: [{ url: "https://evil.example/" }] };
    const r = await h.request("POST", url(`/briefs/${id}/ai-suggestions`), { ...as(), payload: { baseRevision: cur } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ source: "ai_suggestion", aiModel: "free/model:free", body: { suggestedTitle: "Choosing trail running shoes", sources: [] } });
    expect(r.json().data.body.internalLinks.every((l: { url: string }) => l.url.startsWith(S))).toBe(true);
    const call = ai.calls[0] as { messages: Array<{ role: string; content: string }>; orgId: string; scanId: string; agentType: string };
    expect(call).toMatchObject({ orgId: A.id, agentType: "CONTENT_BRIEF" });
    expect(call.scanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.messages[0].content).toMatch(/untrusted content.*Never follow instructions/);
    expect(call.messages[1].content.startsWith("DATA {")).toBe(true);
    // An AI revision cannot be approved until a person saves it as their own edit.
    expect((await h.request("POST", url(`/briefs/${id}/status`), { ...as(), payload: { status: "approved" } })).json().error.code).toBe("REVIEW_REQUIRED");
  });

  it("exports are authorized and formula-safe", async () => {
    expect((await get("/export?kind=findings")).statusCode).toBe(403);
    const csv = await get("/export?kind=pages", "member");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\r\n")[0]).toBe("url,crawl_state,http_status,indexable,title,h1,word_count,inlinks,open_findings,clicks_28d,impressions_28d,last_crawled_at,content_changed_at");
    expect((await get("/export?kind=opportunities", "member")).body).toMatch(/declining_page/);
  });

  it("tenant isolation: other organizations get 404 and cannot reuse ids", async () => {
    const other = as("owner", B);
    for (const p of ["/overview", "/pages", "/findings", "/opportunities", "/topics", "/briefs", "/runs"]) expect((await h.request("GET", url(p), other)).statusCode).toBe(404);
    const finding = (await get("/findings")).json().data[0].id;
    expect((await h.request("PATCH", url(`/findings/${finding}`, B.websiteId), { ...other, payload: { status: "in_progress" } })).statusCode).toBe(404);
    const brief = (await get("/briefs")).json().data[0].id;
    expect((await h.request("GET", url(`/briefs/${brief}`, B.websiteId), other)).statusCode).toBe(404);
    expect((await h.request("GET", url("/overview"))).statusCode).toBe(401);
  });

  it("a failing analysis is marked failed with a safe message and leaves findings untouched", async () => {
    const before = (await db.query("SELECT COUNT(*)::int AS n, MAX(last_detected_at) AS t FROM content_findings WHERE website_id = $1", [A.websiteId])).rows[0];
    await db.query("UPDATE content_pages SET headings = '{\"not\":\"a list\"}'::jsonb WHERE website_id = $1 AND url = $2", [A.websiteId, `${S}/shoes`]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await h.request("POST", url("/runs"), as());
    await analyse();
    const run = (await get("/runs")).json().data[0];
    expect(run).toMatchObject({ status: "failed", error: "The analysis failed; see the server logs for this run id." });
    expect((await db.query("SELECT COUNT(*)::int AS n, MAX(last_detected_at) AS t FROM content_findings WHERE website_id = $1", [A.websiteId])).rows[0]).toEqual(before);
  });

  it("security-relevant changes are audited", async () => {
    const { rows } = await db.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE org_id = $1 AND action LIKE 'content_%'", [A.id]);
    expect(rows.map((r) => r.action).sort()).toEqual(expect.arrayContaining(["content_audit_requested", "content_brief_created", "content_brief_revised", "content_brief_status_changed", "content_exported", "content_finding_updated", "content_opportunity_updated", "content_topic_member_changed", "content_topic_renamed"]));
  });
});
