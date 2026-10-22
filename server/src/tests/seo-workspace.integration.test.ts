import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Optional modules can be made to fail on demand; the AI executor is faked (no provider call).
const ctl = vi.hoisted(() => ({ backlinksFail: false, ai: false, aiAnswer: null as unknown }));
vi.mock("../services/backlinks.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/backlinks.service.js")>("../services/backlinks.service.js");
  return { ...actual, getSummary: async (...a: Parameters<typeof actual.getSummary>) => { if (ctl.backlinksFail) throw new Error("simulated module failure"); return actual.getSummary(...a); } };
});
vi.mock("../ai/ox-alpha.js", async () => {
  const actual = await vi.importActual<typeof import("../ai/ox-alpha.js")>("../ai/ox-alpha.js");
  return { ...actual, getOxAlphaExecutor: () => (ctl.ai ? { execute: async () => ({ success: true, response: { model: "free/model:free" }, parsedJson: ctl.aiAnswer, attempts: 1, totalDurationMs: 1, executionIds: ["e1"] }) } : null) };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";
import type { CrawlPage, CrawlResult } from "../scanner/crawl.js";
import { addDays, resolveRange } from "../workspace/core.js";

// Synthetic website, crawl, Search Console rows, rankings, backlinks and AI observations only.
describe.skipIf(!INTEGRATION)("Unified SEO workspace (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let S: string;
  let site: string;
  const range = resolveRange({ preset: "28d" });
  const as = (role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const url = (path: string, w = A.websiteId) => `/api/v1/websites/${w}/seo-workspace${path}`;
  const get = (path: string, role: "owner" | "member" | "viewer" = "viewer", org: SeededOrg = A, w?: string) => h.request("GET", url(path, w), as(role, org));
  const send = (method: "POST" | "PATCH", path: string, payload: unknown, role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => h.request(method, url(path), { ...as(role, org), payload });

  const page = (path: string, over: Partial<CrawlPage> = {}): CrawlPage => {
    const u = `${S}${path}`;
    return {
      url: u, finalUrl: u, status: 200, finalStatus: 200, redirectChain: [], depth: 1, discoveredFrom: `${S}/`, contentType: "text/html", title: `Page ${path}`, metaDescription: `Description of ${path} long enough for checks.`,
      canonicals: [u], robotsMeta: null, h1Count: 1, internalLinks: [], indexable: true, inSitemap: false, fetchError: null, responseMs: 5, redirectTarget: null, outcome: "ok", xRobotsTag: null,
      imagesTotal: 0, imagesMissingAlt: 0, imagesMissingAltSample: [], indexabilityReasons: [], content: null, ...over,
    };
  };

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    A = await seedOrg(h, "ws-a");
    B = await seedOrg(h, "ws-b");
    site = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id = $1", [A.websiteId])).rows[0].domain;
    S = `https://${site}`;

    // Crawl: /shoes has no title; /noindex is excluded; /gone is a 404 linked from / and /shoes.
    const { analyzeCrawl } = await import("../scanner/crawl.js");
    const { persistCrawl } = await import("../services/site-audit.service.js");
    const result: CrawlResult = {
      pages: [page("/"), page("/shoes", { title: null }), page("/noindex", { indexable: false, indexabilityReasons: ["noindex"], robotsMeta: "noindex" }), page("/gone", { status: 404, finalStatus: 404, outcome: "http_error" as CrawlPage["outcome"], indexable: false, indexabilityReasons: ["status_404"] })],
      inlinks: { [`${S}/gone`]: { count: 2, sample: [`${S}/`, `${S}/shoes`] } } as CrawlResult["inlinks"],
      summary: { startUrl: `${S}/`, origin: S, pagesCrawled: 4, pagesDiscovered: 4, truncated: false, truncatedReason: null, robotsStatus: "parsed", startBlockedByRobots: false, sitemapStatus: "found", sitemapFiles: [], sitemapUrlCount: 0, durationMs: 10, maxPages: 100, reconcilable: true, pagesBlockedByRobots: 0, maxDepth: 5 },
    };
    const scanId = (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules, completed_at) VALUES ($1,$2,'completed','{crawl}',NOW()) RETURNING id", [A.websiteId, A.id])).rows[0].id;
    await db.withTransaction((tx) => persistCrawl(tx, { scanId, orgId: A.id, websiteId: A.websiteId, result, issues: analyzeCrawl(result), completed: true }));

    // Search Console: 5 synced days in the range and 5 in the previous period.
    const integ = (await db.query<{ id: string }>("INSERT INTO integrations (org_id, provider, external_account_id, scopes, refresh_token_enc, key_id, status) VALUES ($1,'google_search_console',$2,'{}','k1.x.y.z','k1','active') RETURNING id", [A.id, `sub-${A.id}`])).rows[0].id;
    const prop = (await db.query<{ id: string }>("INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level, last_sync_success_at) VALUES ($1,$2,$3,$4,'domain','siteOwner',NOW()) RETURNING id", [A.id, A.websiteId, integ, `sc-domain:${site}`])).rows[0].id;
    const row = (setName: string, day: string, dim: string, clicks: number, impressions: number, position: number) =>
      db.query("INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'final')", [prop, A.id, setName, day, dim, clicks, impressions, impressions ? clicks / impressions : 0, position]);
    const cover = (setName: string, day: string) => db.query("INSERT INTO gsc_coverage (property_id, org_id, dimension_set, day, outcome, row_count, data_state) VALUES ($1,$2,$3,$4,'complete',1,'final') ON CONFLICT DO NOTHING", [prop, A.id, setName, day]);
    for (let i = 0; i < 5; i++) {
      const cur = addDays(range.to, -i);
      const prev = addDays(range.previous!.to, -i);
      for (const set of ["total", "page", "query"]) { await cover(set, cur); await cover(set, prev); }
      await row("total", cur, "", 61, 1010, 4);
      await row("total", prev, "", 40, 800, 5);
      await row("page", cur, `${S}/`, 60, 600, 2);
      await row("page", cur, `${S}/shoes`, 1, 400, 6);
      await row("page", cur, `${S}/noindex`, 0, 10, 9);
      await row("page", prev, `${S}/`, 40, 800, 3);
      await row("query", cur, "=HYPERLINK(\"x\") shoes", 61, 1010, 4);
    }

    // Rank tracking: "trail shoes" (landing /shoes) declined 3 → 9; a competitor is ahead on two keywords.
    const project = (await db.query<{ id: string }>("INSERT INTO rank_projects (org_id, website_id, name, search_engine) VALUES ($1,$2,'Main','google') RETURNING id", [A.id, A.websiteId])).rows[0].id;
    const kw = async (keyword: string, landing: string | null) => (await db.query<{ id: string }>("INSERT INTO rank_keywords (org_id, project_id, keyword, keyword_key, landing_page, source) VALUES ($1,$2,$3,$3,$4,'manual') RETURNING id", [A.id, project, keyword, landing])).rows[0].id;
    const k1 = await kw("trail shoes", `${S}/shoes`);
    const k2 = await kw("running shoes", null);
    await db.query("INSERT INTO rank_competitors (org_id, project_id, domain) VALUES ($1,$2,'rival-test.com')", [A.id, project]);
    const obs = (keyword: string, subject: string, day: string, status: string, position: number | null, rankUrl: string | null) =>
      db.query("INSERT INTO rank_observations (org_id, project_id, keyword_id, subject_domain, observed_date, observed_at, status, position, result_depth, ranking_url, search_engine, source, source_label) VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,100,$8,'google','csv_import','Report')", [A.id, project, keyword, subject, day, status, position, rankUrl]);
    const before = addDays(range.from, -3);
    const recent = addDays(range.to, -2);
    await obs(k1, site, before, "ranked", 3, `${S}/shoes`);
    await obs(k1, site, recent, "ranked", 9, `${S}/shoes`);
    await obs(k2, site, recent, "not_in_results", null, null);
    await obs(k1, "rival-test.com", recent, "ranked", 2, "https://rival-test.com/a");
    await obs(k2, "rival-test.com", recent, "ranked", 4, "https://rival-test.com/b");

    // Backlinks: own and competitor datasets imported through the backlink module.
    const { createImport } = await import("../services/backlinks.service.js");
    const w = { id: A.websiteId, orgId: A.id, domain: site };
    await createImport(w, A.users.owner.id, { subject: "own", csv: `Source URL,Target URL\nhttps://blog-test.org/a,${S}/\nhttps://news-test.net/b,${S}/shoes\n`, sourceLabel: "Own export", coverage: "partial", exportedAt: addDays(range.to, -5) });
    await createImport(w, A.users.owner.id, { subject: "competitor", competitorDomain: "rival-test.com", csv: "Source URL,Target URL\nhttps://a-test.org/1,https://rival-test.com/\nhttps://b-test.org/1,https://rival-test.com/\nhttps://c-test.org/1,https://rival-test.com/\n", sourceLabel: "Rival export", coverage: "partial", exportedAt: addDays(range.to, -5) });

    // AI visibility: a brand linked to this website, with imported answers citing a third-party host.
    const brand = (await h.request("POST", "/api/v1/ai-visibility/brands", { ...as("member"), payload: { name: "Shoeco", websiteId: A.websiteId } })).json().data.id;
    const csv = ["query,observed_at,surface,response,cited_urls", `best trail shoes,${addDays(range.to, -3)},chatgpt,Rival is good.,https://reviews-test.org/x`, `best trail shoes,${addDays(range.to, -4)},chatgpt,Shoeco and Rival.,https://reviews-test.org/y`].join("\n");
    expect((await h.request("POST", `/api/v1/ai-visibility/brands/${brand}/imports`, { ...as("member"), payload: { content: csv, sourceLabel: "Manual" } })).statusCode).toBe(201);
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id, B?.id].filter(Boolean) as string[]);
    await h?.close();
  });

  it("aggregates every module for the website with freshness, range support and completeness", async () => {
    expect((await h.request("GET", url("/overview"))).statusCode).toBe(401);
    expect((await get("/overview", "owner", B)).statusCode).toBe(404); // another tenant cannot read this website
    const r = await get("/overview");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const d = r.json().data;
    expect(d.range).toMatchObject({ from: range.from, to: range.to, days: 28, previous: range.previous });
    const s = d.sections.search;
    expect(s).toMatchObject({ status: "partial", range: { support: "full" } });
    expect(s.data.current).toMatchObject({ clicks: 305, impressions: 5050 });
    expect(s.data.previous).toMatchObject({ clicks: 200, impressions: 4000 });
    expect(s.data.comparison.clicks.changePct).toBeCloseTo(0.525, 3);
    expect(s.data.coverage.current).toMatchObject({ days: 28, daysWithData: 5, daysMissing: 23 });
    expect(s.notes.join(" ")).toMatch(/23 of 28 days in the range are not synced yet/);
    expect(s.notes.join(" ")).toMatch(/not all website traffic/);
    expect(s.data.topPages[0]).toMatchObject({ key: `${S}/`, clicks: 300 });
    expect(s.data.movers.find((m: { dimension: string }) => m.dimension === "page")).toMatchObject({ key: `${S}/`, clicks: 300, previousClicks: 200, change: 100 });
    const t = d.sections.technical;
    expect(t.status).toBe("ok");
    expect(t.data.openBySeverity.high).toBeGreaterThanOrEqual(2);
    expect(t.data.brokenInternalLinks).toBe(1);
    expect(t.data.latestCrawl).toMatchObject({ pagesCrawled: 4, truncated: false });
    expect(t.data.indexability).toMatchObject({ indexable: 2, not_indexable: 2 });
    const rk = d.sections.rankings;
    expect(rk.data).toMatchObject({ tracked: 2, observedInRange: 2 });
    expect(rk.data.changes).toMatchObject({ declined: 1, no_comparison: 1 });
    expect(rk.data.competitors[0]).toMatchObject({ domain: "rival-test.com", ahead: 2 });
    const bl = d.sections.backlinks;
    expect(bl.data).toMatchObject({ referringDomains: 2, links: 2, dataset: { sourceLabel: "Own export", coverage: "partial" } });
    expect(bl.notes.join(" ")).toMatch(/not an internet-wide backlink count/);
    expect(d.sections.aiVisibility.data.brands[0]).toMatchObject({ name: "Shoeco", observations: 2 });
    expect(d.sections.keywords.status).toBe("no_data");
    expect(d.completeness.search).toMatchObject({ status: "partial", freshness: "fresh" });
    expect(d.summary[0]).toMatch(/^Search Console: 305 clicks and 5050 impressions/);
    expect(d.jobs.some((j: { module: string }) => j.module === "crawl_scan")).toBe(true);
  });

  it("validates date ranges and honours custom ranges and compare=none", async () => {
    expect((await get("/overview?preset=custom&from=2026-01-01")).json().error.code).toBe("INVALID_RANGE");
    expect((await get("/overview?preset=custom&from=2000-01-01&to=2000-02-01")).json().error.code).toBe("INVALID_RANGE");
    expect((await get("/overview?preset=365d")).statusCode).toBe(400);
    expect((await get("/overview?preset=7d&unknown=1")).statusCode).toBe(400);
    const d = (await get(`/overview?preset=custom&from=${addDays(range.to, -1)}&to=${range.to}&compare=none`)).json().data;
    expect(d.range).toMatchObject({ days: 2, previous: null });
    expect(d.sections.search.data.current.clicks).toBe(122);
    expect(d.sections.search.data.comparison).toBeNull();
  });

  it("keeps the dashboard up when one module fails", async () => {
    ctl.backlinksFail = true;
    try {
      const d = (await get("/overview")).json().data;
      expect(d.sections.backlinks).toMatchObject({ status: "error", data: null });
      expect(JSON.stringify(d.sections.backlinks)).not.toMatch(/simulated module failure/);
      expect(d.sections.search.status).toBe("partial");
      expect(d.completeness.backlinks.status).toBe("error");
    } finally {
      ctl.backlinksFail = false;
    }
  });

  it("generates cross-module insights from real evidence, idempotently, with a lifecycle", async () => {
    expect((await send("POST", "/insights/refresh", {}, "viewer")).statusCode).toBe(403);
    const r1 = await send("POST", "/insights/refresh", {});
    expect(r1.statusCode).toBe(200);
    const list = (await get("/insights?limit=50")).json();
    const rules = list.data.map((i: { rule_id: string }) => i.rule_id).sort();
    expect(rules).toEqual(["ai_cited_source_without_link", "broken_links_on_landing_page", "competitor_outranks_with_backlink_evidence", "declining_keyword_with_page_issue", "low_ctr_with_snippet_issue", "search_page_not_indexable"]);
    expect(list.meta.lastRun).toMatchObject({ detected: 6, window_from: range.from, window_to: range.to });
    // A second evaluation updates in place: no duplicates.
    await send("POST", "/insights/refresh", {});
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM seo_insights WHERE website_id = $1", [A.websiteId]);
    expect(rows[0].n).toBe(6);
    const low = list.data.find((i: { rule_id: string }) => i.rule_id === "low_ctr_with_snippet_issue");
    expect(low.evidence.map((e: { kind: string }) => e.kind)).toEqual(["page_metrics", "site_issue"]);
    expect((await get(`/insights/${low.id}`, "owner", B, A.websiteId)).statusCode).toBe(404);
    expect((await send("PATCH", `/insights/${low.id}`, { status: "in_progress", note: "Writing a title" })).statusCode).toBe(200);
    await send("POST", "/insights/refresh", {});
    const detail = (await get(`/insights/${low.id}`)).json().data;
    expect(detail.status).toBe("in_progress"); // re-evaluation keeps the user's status
    expect(detail.events.map((e: { event: string }) => e.event)).toEqual(["detected", "status_changed"]);
    expect((await get("/insights?module=backlinks")).json().data).toHaveLength(2);
    expect((await get("/insights?search=noindex")).json().data.map((i: { rule_id: string }) => i.rule_id)).toEqual(["search_page_not_indexable"]);
    // The summary counts every open insight, not only the top five shown.
    const ov = (await get("/overview")).json().data;
    expect(ov.insightsOpen).toBe(6);
    expect(ov.summary.at(-1)).toMatch(/^6 cross-module insights/);
  });

  it("aggregates actions without duplicating sources and persists workflow state", async () => {
    const first = (await get("/actions?limit=100")).json();
    const sources = new Set(first.data.map((a: { source: string }) => a.source));
    for (const s of ["site_issue", "insight", "backlink_opportunity", "integration"]) expect(sources.has(s), s).toBe(true);
    expect(first.meta.effortNote).toMatch(/heuristic/);
    const again = (await get("/actions?limit=100")).json();
    expect(again.meta.total).toBe(first.meta.total);
    const issue = first.data.find((a: { source: string; category: string }) => a.source === "site_issue" && a.category === "critical_technical");
    expect(issue).toBeTruthy();
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: issue.sourceRef, status: "in_progress" }, "viewer")).statusCode).toBe(403);
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: "00000000-0000-0000-0000-000000000000", status: "in_progress" })).statusCode).toBe(404);
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: issue.sourceRef, ownerId: B.users.owner.id })).json().error.code).toBe("INVALID_OWNER");
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: issue.sourceRef, status: "in_progress", ownerId: A.users.member.id, dueDate: "2026-12-01", note: "Fixing the 404" })).statusCode).toBe(200);
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: issue.sourceRef, status: "in_progress" })).statusCode).toBe(200); // idempotent
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM seo_action_states WHERE website_id = $1", [A.websiteId]);
    expect(rows[0].n).toBe(1);
    const updated = (await get("/actions?limit=100")).json().data.find((a: { key: string }) => a.key === issue.key);
    expect(updated.state).toMatchObject({ status: "in_progress", ownerId: A.users.member.id, dueDate: "2026-12-01", note: "Fixing the 404" });
    expect((await send("PATCH", "/actions", { source: "site_issue", sourceRef: issue.sourceRef, status: "completed" })).statusCode).toBe(200);
    expect((await get("/actions?limit=100")).json().data.some((a: { key: string }) => a.key === issue.key)).toBe(false);
    expect((await get("/actions?status=completed")).json().data.map((a: { key: string }) => a.key)).toEqual([issue.key]);
    const hist = (await get(`/actions/history?source=site_issue&sourceRef=${issue.sourceRef}`)).json().data;
    expect(hist.map((e: { event: string }) => e.event)).toEqual(["status_changed", "assigned", "due_date_changed", "status_changed"]);
    expect((await h.request("PATCH", url("/actions"), { ...as("owner", B), payload: { source: "site_issue", sourceRef: issue.sourceRef, status: "dismissed" } })).statusCode).toBe(404);
  });

  it("reports integration health from real timestamps, never from credentials alone", async () => {
    const hs = (await get("/integrations")).json().data;
    const state = Object.fromEntries(hs.map((x: { id: string; state: string }) => [x.id, x.state]));
    expect(state).toMatchObject({ crawl: "healthy", backlink_provider: "healthy", content_analysis: "healthy", database: "healthy", rank_provider: "healthy", ai_visibility: "healthy" });
    expect(["healthy", "configuration_required"]).toContain(state.search_console);
    await db.query("UPDATE integrations SET status = 'reauth_required' WHERE org_id = $1", [A.id]);
    expect((await get("/integrations")).json().data.find((x: { id: string }) => x.id === "search_console").state).toMatch(/auth_expired|configuration_required/);
    await db.query("UPDATE integrations SET status = 'active' WHERE org_id = $1", [A.id]);
    expect(JSON.stringify(hs)).not.toMatch(/k1\.x\.y\.z|refresh_token/);
  });

  it("builds reports and CSV exports with provenance, access control and formula protection", async () => {
    const rep = (await get("/report?sections=summary,search,actions,sources")).json().data;
    expect(rep.sections).toEqual(["summary", "search", "actions", "sources"]);
    expect(Object.keys(rep.data)).toEqual(["search"]);
    expect(rep.definitions.length).toBeGreaterThan(3);
    expect(rep.limitations.join(" ")).toMatch(/not total website traffic/);
    expect((await get("/report?sections=bogus")).json().error.code).toBe("VALIDATION_ERROR");
    expect((await get("/report.md", "viewer")).statusCode).toBe(403);
    const mdRes = await get("/report.md", "member");
    expect(mdRes.headers["content-type"]).toMatch(/text\/markdown/);
    expect(mdRes.body).toMatch(/^# SEO report for /);
    expect(mdRes.body).toContain("## Definitions");
    const q = await get("/export?dataset=search_queries", "member");
    expect(q.headers["content-type"]).toMatch(/text\/csv/);
    expect(q.body).toContain("'=HYPERLINK");
    expect(q.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await get("/export?dataset=actions", "member")).body.split("\r\n")[0]).toMatch(/^priority,category,title/);
    expect((await get("/export?dataset=actions", "owner", B, A.websiteId)).statusCode).toBe(404);
    const { rows } = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'seo_%' ORDER BY timestamp", [A.id]);
    expect(rows.map((x) => x.action)).toEqual(expect.arrayContaining(["seo_insights_refreshed", "seo_action_updated", "seo_report_exported", "seo_workspace_exported"]));
  });

  it("offers an AI summary only when configured, validated against provided sources", async () => {
    expect((await send("POST", "/summary", {})).json().error.code).toBe("AI_NOT_CONFIGURED");
    ctl.ai = true;
    ctl.aiAnswer = { summary: "Search clicks grew.", points: [{ statement: "Search Console is partly synced", sources: ["section:search"] }, { statement: "Made up", sources: ["section:nonexistent"] }], insufficientEvidence: ["Keyword volumes are unavailable."] };
    try {
      const r = (await send("POST", "/summary", {})).json().data;
      expect(r.ai.points).toEqual([{ statement: "Search Console is partly synced", sources: ["section:search"] }]);
      expect(r.dropped).toBe(1);
      expect(r.deterministic[0]).toMatch(/^Search Console: 305 clicks/);
      ctl.aiAnswer = { summary: "x", points: [], insufficientEvidence: [], clicks: 1_000_000 };
      expect((await send("POST", "/summary", {})).json().error.code).toBe("AI_INVALID_OUTPUT");
    } finally {
      ctl.ai = false;
    }
  });
});
