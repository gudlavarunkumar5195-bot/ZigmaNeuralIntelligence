import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// End to end through the real worker path: createScan -> runScan -> crawl
// module -> atomic commit (findings + crawl pages + issue lifecycle) -> scores.
// Only the network is faked (SSRF rules forbid a loopback fixture server).
const { site } = vi.hoisted(() => ({ site: { routes: {} as Record<string, { status: number; body?: string; location?: string }> } }));
vi.mock("../scanner/fetch.js", () => ({
  safeFetch: async (url: string) => {
    let current = url;
    const chain: Array<{ url: string; status: number }> = [];
    for (;;) {
      const r = site.routes[current] ?? { status: 404, body: "" };
      if (r.location) { chain.push({ url: current, status: r.status }); current = new URL(r.location, current).href; continue; }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: {}, body: r.body ?? "", finalUrl: current, redirectCount: chain.length, redirectChain: chain, durationMs: 1, contentType: url.endsWith(".xml") ? "application/xml" : "text/html" };
    }
  },
}));
vi.mock("../ai/agents/scan-pipeline.js", () => ({ runScanIntelligence: async () => ({ status: "UNAVAILABLE", discoveryCount: 0 }) }));

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("crawl module through the scan worker (PostgreSQL)", () => {
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/scan.service.js");
  let orgId: string;
  let websiteId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const S = `https://crawl-${suffix}.example`;
  const page = (title: string, links: string[]) => `<html><head><title>${title}</title><meta name="description" content="About ${title}"><link rel="canonical" href="CANON"></head><body><h1>x</h1>${links.map((l) => `<a href="${l}">l</a>`).join("")}</body></html>`;
  const withCanon = (path: string, html: string) => html.replace("CANON", `${S}${path}`);

  beforeAll(async () => {
    db = await import("../db/client.js");
    svc = await import("../services/scan.service.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`Crawl ${suffix}`, `crawl-${suffix}`])).rows[0].id;
    websiteId = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id", [orgId, S, new URL(S).hostname])).rows[0].id;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    if (!db) return;
    const { cleanupOrgs } = await import("./helpers/http.js");
    await cleanupOrgs([orgId]);
  });

  const scanOnce = async () => {
    const scan = await svc.createScan({ websiteId, orgId, triggeredBy: null, modules: ["crawl"] });
    await svc.runScan(scan.id);
    return scan.id;
  };

  it("persists the crawl, opens issues, scores technical health, then marks fixes on the next scan", async () => {
    site.routes = {
      [`${S}/robots.txt`]: { status: 200, body: `User-agent: *\nDisallow:\nSitemap: ${S}/sitemap.xml` },
      [`${S}/sitemap.xml`]: { status: 200, body: `<urlset><url><loc>${S}/</loc></url></urlset>` },
      [`${S}/`]: { status: 200, body: withCanon("/", page("Home", ["/a", "/dead"])) },
      [`${S}/a`]: { status: 200, body: withCanon("/a", page("A", ["/"])) },
    };
    const first = await scanOnce();
    const scan = (await db.query<{ status: string }>("SELECT status FROM scans WHERE id=$1", [first])).rows[0];
    expect(scan.status).toBe("completed");
    const pages = (await db.query<{ url: string; status_code: number }>("SELECT url, status_code FROM crawl_pages WHERE scan_id=$1 ORDER BY url", [first])).rows;
    expect(pages.map((p) => [p.url.replace(S, ""), p.status_code])).toEqual([["/", 200], ["/a", 200], ["/dead", 404]]);
    const issues = (await db.query<{ rule_id: string; status: string }>("SELECT rule_id, status FROM site_issues WHERE website_id=$1 ORDER BY rule_id", [websiteId])).rows;
    expect(issues).toEqual([{ rule_id: "broken_internal_link", status: "OPEN" }, { rule_id: "page_4xx", status: "OPEN" }]);
    const score = (await db.query<{ status: string; score: number }>("SELECT status, score FROM scan_scores WHERE scan_id=$1 AND category='technicalHealth'", [first])).rows[0];
    expect(score.status).toBe("scored");
    expect(score.score).toBeLessThan(100);
    const findings = (await db.query<{ title: string; provenance: string }>("SELECT title, provenance FROM findings WHERE scan_id=$1 ORDER BY title", [first])).rows;
    expect(findings).toEqual([{ title: "Broken internal links", provenance: "MEASURED" }, { title: "Pages return client errors", provenance: "MEASURED" }]);

    // The broken link is removed. The crawl is complete, so the link issue
    // (source re-crawled) and the 404 (no longer reachable) both resolve.
    site.routes[`${S}/`] = { status: 200, body: withCanon("/", page("Home", ["/a"])) };
    await scanOnce();
    const after = (await db.query<{ rule_id: string; status: string }>("SELECT rule_id, status FROM site_issues WHERE website_id=$1 ORDER BY rule_id", [websiteId])).rows;
    expect(after).toEqual([{ rule_id: "broken_internal_link", status: "FIXED" }, { rule_id: "page_4xx", status: "FIXED" }]);
  });
});
