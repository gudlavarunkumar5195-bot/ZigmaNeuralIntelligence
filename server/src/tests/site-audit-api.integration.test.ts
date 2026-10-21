import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";
import { analyzeCrawl, type CrawlIssue, type CrawlPage, type CrawlResult } from "../scanner/crawl.js";

// Phase 2 issue lifecycle edge cases and the technical audit API, against
// PostgreSQL and the real Fastify app (RBAC, tenant isolation, cursors).

const S = "https://audit-api.example";
function page(path: string, over: Partial<CrawlPage> = {}): CrawlPage {
  return {
    url: `${S}${path}`, finalUrl: `${S}${path}`, status: 200, finalStatus: 200, redirectChain: [], redirectTarget: null, outcome: "ok",
    depth: 1, discoveredFrom: `${S}/`, contentType: "text/html", title: `T ${path}`, metaDescription: `D ${path}`, canonicals: [`${S}${path}`],
    robotsMeta: null, xRobotsTag: null, h1Count: 1, imagesTotal: 0, imagesMissingAlt: 0, imagesMissingAltSample: [], internalLinks: [],
    indexable: true, indexabilityReasons: [], inSitemap: false, fetchError: null, responseMs: 5, ...over,
  };
}
function crawl(pages: CrawlPage[], over: Partial<CrawlResult["summary"]> = {}): CrawlResult {
  return {
    pages,
    inlinks: {},
    summary: {
      startUrl: `${S}/`, origin: S, pagesCrawled: pages.length, pagesDiscovered: pages.length, pagesBlockedByRobots: 0, truncated: false,
      truncatedReason: null, robotsStatus: "parsed", startBlockedByRobots: false, sitemapStatus: "found", sitemapFiles: [], sitemapUrlCount: 0,
      durationMs: 10, maxPages: 100, maxDepth: 5, reconcilable: true, ...over,
    },
  };
}

describe.skipIf(!INTEGRATION)("technical audit lifecycle and API (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/site-audit.service.js");

  const run = async (result: CrawlResult, org = A, issues: CrawlIssue[] = analyzeCrawl(result)) => {
    const scanId = (await db.query<{ id: string }>("INSERT INTO scans (website_id, org_id, status, modules) VALUES ($1,$2,'completed','{crawl}') RETURNING id", [org.websiteId, org.id])).rows[0].id;
    const out = await db.withTransaction((tx) => svc.persistCrawl(tx, { scanId, orgId: org.id, websiteId: org.websiteId, result, issues, completed: true }));
    return { scanId, ...out };
  };
  const status = async (rule: string, path: string, org = A) =>
    (await db.query<{ status: string }>("SELECT status FROM site_issues WHERE org_id=$1 AND website_id=$2 AND rule_id=$3 AND url=$4", [org.id, org.websiteId, rule, `${S}${path}`])).rows[0]?.status;
  const as = (role: "owner" | "admin" | "member" | "viewer", org = A) => ({ token: org.users[role].token, orgId: org.id });
  const base = () => `/api/v1/websites/${A.websiteId}`;

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "audit-a");
    B = await seedOrg(h, "audit-b");
    db = await import("../db/client.js");
    svc = await import("../services/site-audit.service.js");
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
  });

  describe("lifecycle", () => {
    it("a content issue is not FIXED when its page could not be re-audited (too large, failed, robots-blocked)", async () => {
      await run(crawl([page("/"), page("/x", { title: null }), page("/y", { title: null }), page("/z", { title: null })]));
      expect(await status("title_missing", "/x")).toBe("OPEN");

      await run(crawl([
        page("/"),
        page("/x", { outcome: "too_large", title: null, h1Count: null, indexable: false, fetchError: "Response exceeded 2097152 bytes" }),
        page("/y", { outcome: "fetch_error", status: 0, finalStatus: 0, title: null, h1Count: null, indexable: false, fetchError: "timeout" }),
        page("/z", { outcome: "blocked_by_robots", status: 0, finalStatus: 0, title: null, h1Count: null, indexable: false }),
      ]));
      for (const p of ["/x", "/y", "/z"]) expect(await status("title_missing", p), p).toBe("OPEN");

      // Re-audited and fixed: only now does it resolve.
      await run(crawl([page("/"), page("/x"), page("/y"), page("/z")]));
      for (const p of ["/x", "/y", "/z"]) expect(await status("title_missing", p), p).toBe("FIXED");
    });

    it("cancelled and truncated-before-the-page crawls fix nothing on that page; IGNORED survives every scan", async () => {
      await run(crawl([page("/"), page("/m", { metaDescription: null })]));
      const issueId = (await db.query<{ id: string }>("SELECT id FROM site_issues WHERE org_id=$1 AND rule_id='meta_description_missing' AND url=$2", [A.id, `${S}/m`])).rows[0].id;

      await run(crawl([page("/")], { truncated: true, truncatedReason: "cancelled", reconcilable: false }));
      expect(await status("meta_description_missing", "/m")).toBe("OPEN");
      await run(crawl([page("/")], { truncated: true, truncatedReason: "depth_limit" }));
      expect(await status("meta_description_missing", "/m")).toBe("OPEN");

      const ignored = await h.request("POST", `${base()}/issues/${issueId}/ignore`, { ...as("member"), payload: { reason: "Intentional: landing page" } });
      expect(ignored.statusCode).toBe(200);
      await run(crawl([page("/"), page("/m", { metaDescription: null })])); // still observed
      await run(crawl([page("/"), page("/m")])); // and later gone
      expect(await status("meta_description_missing", "/m")).toBe("IGNORED");

      const reopened = await h.request("POST", `${base()}/issues/${issueId}/reopen`, as("admin"));
      expect(reopened.json().data).toMatchObject({ status: "OPEN", ignore_reason: null });
    });

    it("records every scan that observed an issue, and a retried commit creates no duplicate issue", async () => {
      const result = crawl([page("/"), page("/dup", { h1Count: 0 })]);
      const first = await run(result);
      const second = await run(result);
      const { rows } = await db.query<{ id: string; n: string }>(
        `SELECT i.id, COUNT(o.scan_id)::text AS n FROM site_issues i JOIN site_issue_scans o ON o.issue_id=i.id
          WHERE i.org_id=$1 AND i.rule_id='h1_missing' AND i.url=$2 GROUP BY i.id`,
        [A.id, `${S}/dup`],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].n)).toBe(2);
      // Re-committing the same scan (duplicate delivery) is idempotent.
      await db.withTransaction((tx) => svc.persistCrawl(tx, { scanId: second.scanId, orgId: A.id, websiteId: A.websiteId, result, issues: analyzeCrawl(result), completed: true }));
      const again = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM site_issues WHERE org_id=$1 AND rule_id='h1_missing' AND url=$2", [A.id, `${S}/dup`]);
      expect(Number(again.rows[0].n)).toBe(1);
      expect(first.detected).toBeGreaterThan(0);
      expect(second.detected).toBe(0);
    });
  });

  describe("API", () => {
    it("filters issues by status, severity, category, rule and URL, with stable cursor pages", async () => {
      const pages = [page("/")];
      for (let i = 0; i < 7; i++) pages.push(page(`/img${i}`, { imagesMissingAlt: 1, imagesTotal: 2, imagesMissingAltSample: [`${S}/i${i}.png`] }));
      await run(crawl(pages));
      const q = (qs: string) => h.request("GET", `${base()}/issues?${qs}`, as("viewer"));

      const byCategory = await q("category=images&status=OPEN&limit=3");
      expect(byCategory.statusCode).toBe(200);
      const body = byCategory.json();
      expect(body.data).toHaveLength(3);
      expect(body.meta.total).toBe(7);
      expect(body.data.every((i: { category: string; rule_id: string }) => i.category === "images" && i.rule_id === "img_alt_missing")).toBe(true);

      const seen: string[] = body.data.map((i: { id: string }) => i.id);
      let cursor = body.meta.nextCursor as string | null;
      while (cursor) {
        const next = (await q(`category=images&status=OPEN&limit=3&cursor=${encodeURIComponent(cursor)}`)).json();
        seen.push(...next.data.map((i: { id: string }) => i.id));
        cursor = next.meta.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);

      expect((await q("url=%2Fimg3")).json().data.map((i: { url: string }) => i.url)).toEqual([`${S}/img3`]);
      expect((await q("rule=img_alt_missing&severity=low")).json().meta.total).toBe(7);
      // LIKE metacharacters are literal.
      expect((await q("url=%25")).json().data).toEqual([]);
      for (const bad of ["category=nope", "severity=urgent", "status=open", "rule=Bad-Rule", "orgId=x", "limit=0", "limit=101", "cursor=not-base64-json"]) {
        const res = await q(bad);
        expect(res.statusCode, bad).toBe(400);
      }
    });

    it("issue detail carries rule guidance, evidence from the latest crawl and occurrences; history names the actor", async () => {
      const list = await h.request("GET", `${base()}/issues?rule=img_alt_missing&url=%2Fimg0`, as("viewer"));
      const id = list.json().data[0].id as string;
      const detail = await h.request("GET", `${base()}/issues/${id}`, as("viewer"));
      expect(detail.statusCode).toBe(200);
      const d = detail.json().data;
      expect(d.rule).toMatchObject({ id: "img_alt_missing", category: "images", provenance: "MEASURED", source: "site_crawler" });
      expect(d.rule.explanation).toMatch(/alt/);
      expect(d.rule.remediation).toMatch(/alt/);
      expect(d.details).toMatchObject({ missing: 1, total: 2 });
      expect(d.latestCrawl.page).toMatchObject({ url: `${S}/img0`, outcome: "ok", images_missing_alt: 1 });
      expect(d.occurrenceCount).toBe(1);

      await h.request("POST", `${base()}/issues/${id}/ignore`, { ...as("owner"), payload: { reason: "Decorative sprites" } });
      const history = (await h.request("GET", `${base()}/issues/${id}/history`, as("viewer"))).json().data;
      expect(history.map((e: { event: string }) => e.event)).toEqual(["DETECTED", "IGNORED"]);
      expect(history[1]).toMatchObject({ note: "Decorative sprites", actor_id: A.users.owner.id, actor_name: "owner audit-a" });
    });

    it("crawl overview compares with the previous crawl; the inventory pages by URL and filters", async () => {
      const overview = (await h.request("GET", `${base()}/crawl`, as("viewer"))).json();
      expect(overview.data.scan_id).toBeTruthy();
      expect(overview.meta.previous.scan_id).toBeTruthy();
      expect(overview.meta.changes).toMatchObject({ detected: expect.any(Number), fixed: expect.any(Number), reopened: expect.any(Number) });

      const inv = (await h.request("GET", `${base()}/crawl/pages?limit=5`, as("viewer"))).json();
      expect(inv.data).toHaveLength(5);
      const urls = inv.data.map((p: { url: string }) => p.url);
      expect([...urls].sort()).toEqual(urls);
      const rest = (await h.request("GET", `${base()}/crawl/pages?limit=100&cursor=${encodeURIComponent(inv.meta.nextCursor)}`, as("viewer"))).json();
      expect(rest.data.every((p: { url: string }) => p.url > urls[urls.length - 1])).toBe(true);
      const indexable = (await h.request("GET", `${base()}/crawl/pages?indexable=true&outcome=ok&url=img`, as("viewer"))).json();
      expect(indexable.data.every((p: { indexable: boolean; outcome: string; url: string }) => p.indexable && p.outcome === "ok" && p.url.includes("img"))).toBe(true);
      expect((await h.request("GET", `${base()}/crawl/pages?outcome=bogus`, as("viewer"))).statusCode).toBe(400);
    });

    it("isolates tenants: another org's website or issue is 404 on every route, and viewers cannot mutate", async () => {
      const id = (await db.query<{ id: string }>("SELECT id FROM site_issues WHERE org_id=$1 LIMIT 1", [A.id])).rows[0].id;
      const foreign = as("owner", B);
      for (const [method, url] of [
        ["GET", `${base()}/crawl`],
        ["GET", `${base()}/crawl/pages`],
        ["GET", `${base()}/issues`],
        ["GET", `${base()}/issues/${id}`],
        ["GET", `${base()}/issues/${id}/history`],
        ["POST", `${base()}/issues/${id}/ignore`],
        ["POST", `${base()}/issues/${id}/reopen`],
        // B's own website, A's issue id.
        ["GET", `/api/v1/websites/${B.websiteId}/issues/${id}`],
        ["POST", `/api/v1/websites/${B.websiteId}/issues/${id}/ignore`],
      ] as const) {
        const res = await h.request(method, url, { ...foreign, payload: method === "POST" ? { reason: "x" } : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      // A body cannot redirect the request to another organization.
      const smuggle = await h.request("POST", `/api/v1/websites/${B.websiteId}/issues/${id}/ignore`, { ...foreign, payload: { reason: "x", orgId: A.id } });
      expect(smuggle.statusCode).toBe(400);
      const viewer = await h.request("POST", `${base()}/issues/${id}/reopen`, as("viewer"));
      expect(viewer.statusCode).toBe(403);
      expect((await h.request("GET", `${base()}/issues/not-a-uuid`, as("viewer"))).statusCode).toBe(400);
    });
  });
});
