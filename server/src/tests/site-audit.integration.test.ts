import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";
import type { CrawlIssue, CrawlPage, CrawlResult } from "../scanner/crawl.js";

const S = "https://lifecycle.example";
function page(path: string, over: Partial<CrawlPage> = {}): CrawlPage {
  return {
    url: `${S}${path}`, finalUrl: `${S}${path}`, status: 200, finalStatus: 200, redirectChain: [], depth: 1, discoveredFrom: `${S}/`,
    contentType: "text/html", title: path, metaDescription: null, canonicals: [`${S}${path}`], robotsMeta: null, h1Count: 1,
    internalLinks: [], indexable: true, inSitemap: false, fetchError: null, responseMs: 5, ...over,
  };
}
function crawl(pages: CrawlPage[], truncated = false): CrawlResult {
  return {
    pages,
    inlinks: {},
    summary: {
      startUrl: `${S}/`, origin: S, pagesCrawled: pages.length, pagesDiscovered: pages.length, truncated, truncatedReason: truncated ? "page_limit" : null,
      robotsStatus: "parsed", startBlockedByRobots: false, sitemapStatus: "found", sitemapFiles: [], sitemapUrlCount: 0, durationMs: 10, maxPages: 100,
    },
  };
}
const issue = (ruleId: string, path: string, extra: Partial<CrawlIssue> = {}): CrawlIssue => ({ ruleId, severity: "high", url: `${S}${path}`, title: ruleId, details: {}, ...extra });

describe.skipIf(!INTEGRATION)("persistent site issues (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/site-audit.service.js");

  const newScan = async (org = A) =>
    (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'completed','{crawl}') RETURNING id", [org.websiteId, org.id])).rows[0].id;
  const run = async (pages: CrawlPage[], issues: CrawlIssue[], opts: { truncated?: boolean; org?: SeededOrg } = {}) => {
    const org = opts.org ?? A;
    const scanId = await newScan(org);
    const out = await db.withTransaction((tx) => svc.persistCrawl(tx, { scanId, orgId: org.id, websiteId: org.websiteId, result: crawl(pages, opts.truncated), issues, completed: true }));
    return { scanId, ...out };
  };
  const statuses = async (org = A) =>
    Object.fromEntries((await db.query<{ rule_id: string; url: string; status: string }>("SELECT rule_id, url, status FROM site_issues WHERE org_id=$1 AND website_id=$2", [org.id, org.websiteId])).rows.map((r) => [`${r.rule_id} ${r.url.replace(S, "")}`, r.status]));

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "issues-a");
    B = await seedOrg(h, "issues-b");
    db = await import("../db/client.js");
    svc = await import("../services/site-audit.service.js");
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
  });

  it("OPEN -> FIXED when re-checked and absent; FIXED -> OPEN (reopened) when it returns; unreached pages are left alone", async () => {
    const first = await run([page("/"), page("/a", { finalStatus: 404, status: 404 }), page("/b")], [issue("page_4xx", "/a"), issue("title_missing", "/b")]);
    expect(first).toMatchObject({ detected: 2, reopened: 0, fixed: 0 });
    expect(await statuses()).toEqual({ "page_4xx /a": "OPEN", "title_missing /b": "OPEN" });

    // /a fixed and re-crawled; /b not reached this time (budget): stays OPEN.
    const second = await run([page("/"), page("/a")], [], { truncated: true });
    expect(second).toMatchObject({ detected: 0, fixed: 1 });
    expect(await statuses()).toEqual({ "page_4xx /a": "FIXED", "title_missing /b": "OPEN" });

    const third = await run([page("/"), page("/a", { finalStatus: 404, status: 404 })], [issue("page_4xx", "/a")], { truncated: true });
    expect(third).toMatchObject({ reopened: 1 });
    const { rows } = await db.query<{ status: string; times_reopened: number; fixed_at: Date | null }>("SELECT status, times_reopened, fixed_at FROM site_issues WHERE org_id=$1 AND rule_id='page_4xx'", [A.id]);
    expect(rows[0]).toMatchObject({ status: "OPEN", times_reopened: 1, fixed_at: null });
  });

  it("serves issues, history and ignore/reopen over HTTP with RBAC and tenant isolation", async () => {
    const as = (role: "owner" | "member" | "viewer", org = A) => ({ token: org.users[role].token, orgId: org.id });
    const list = await h.request("GET", `/api/v1/websites/${A.websiteId}/issues?status=OPEN`, as("viewer"));
    expect(list.statusCode).toBe(200);
    expect(list.json().meta.counts).toMatchObject({ OPEN: 2, FIXED: 0, IGNORED: 0 });
    const target = list.json().data.find((i: { rule_id: string }) => i.rule_id === "page_4xx");

    const url = `/api/v1/websites/${A.websiteId}/issues/${target.id}`;
    expect((await h.request("POST", `${url}/ignore`, { ...as("viewer"), payload: { reason: "x" } })).statusCode).toBe(403);
    expect((await h.request("POST", `${url}/ignore`, { ...as("member"), payload: {} })).statusCode).toBe(400);
    // Another org cannot see or change it, even with the right website id in the path.
    expect((await h.request("GET", `/api/v1/websites/${A.websiteId}/issues`, as("owner", B))).statusCode).toBe(404);
    expect((await h.request("POST", `/api/v1/websites/${B.websiteId}/issues/${target.id}/ignore`, { ...as("owner", B), payload: { reason: "x" } })).statusCode).toBe(404);

    const ignored = await h.request("POST", `${url}/ignore`, { ...as("member"), payload: { reason: "Intentional 404 for retired product" } });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().data).toMatchObject({ status: "IGNORED", ignore_reason: "Intentional 404 for retired product" });
    expect((await h.request("POST", `${url}/ignore`, { ...as("member"), payload: { reason: "again" } })).statusCode).toBe(409);

    // A crawl that still sees it keeps it IGNORED.
    await run([page("/"), page("/a", { finalStatus: 404, status: 404 })], [issue("page_4xx", "/a")]);
    expect((await statuses())["page_4xx /a"]).toBe("IGNORED");

    const reopened = await h.request("POST", `${url}/reopen`, as("member"));
    expect(reopened.json().data.status).toBe("OPEN");
    const history = await h.request("GET", `${url}/history`, as("viewer"));
    expect(history.json().data.map((e: { event: string }) => e.event)).toEqual(["DETECTED", "FIXED", "REOPENED", "IGNORED", "UNIGNORED"]);

    expect((await h.request("GET", `/api/v1/websites/${A.websiteId}/issues/not-a-uuid/history`, as("viewer"))).statusCode).toBe(400);
    expect((await h.request("GET", `/api/v1/websites/${A.websiteId}/issues?status=BOGUS`, as("viewer"))).statusCode).toBe(400);
  });

  it("serves the latest crawl summary and status inventory, scoped to the org", async () => {
    await run([page("/"), page("/x", { status: 500, finalStatus: 500 }), page("/r", { status: 301, finalStatus: 200, redirectChain: [{ url: `${S}/r`, status: 301 }] })], []);
    const summary = await h.request("GET", `/api/v1/websites/${A.websiteId}/crawl`, { token: A.users.viewer.token, orgId: A.id });
    expect(summary.json().data).toMatchObject({ pages_crawled: 3, robots_status: "parsed", status_counts: { "2xx": 1, "5xx": 1, "3xx": 1 } });
    const errors = await h.request("GET", `/api/v1/websites/${A.websiteId}/crawl/pages?status=5xx`, { token: A.users.viewer.token, orgId: A.id });
    expect(errors.json().data.map((p: { url: string }) => p.url)).toEqual([`${S}/x`]);
    expect((await h.request("GET", `/api/v1/websites/${A.websiteId}/crawl/pages`, { token: B.users.owner.token, orgId: B.id })).statusCode).toBe(404);
    // Only the latest crawls keep page rows.
    const { rows } = await db.query<{ n: string }>("SELECT COUNT(DISTINCT scan_id)::text AS n FROM crawl_pages WHERE org_id=$1", [A.id]);
    expect(Number(rows[0].n)).toBeLessThanOrEqual(2);
  });
});
