import { describe, expect, it } from "vitest";
import { isAllowedByRobots, parseRobotsTxt, robotsPatternMatches } from "../scanner/robots.js";
import { parseSitemapXml } from "../scanner/sitemap.js";
import { analyzeCrawl, crawlFindings, crawlSite, issueFingerprint, makeCrawlRunner, normalizeUrl, type Fetcher } from "../scanner/crawl.js";
import type { SafeFetchResult } from "../scanner/fetch.js";

// ─── Fixture site ────────────────────────────────────────────────────────────

type Route = { status: number; body?: string; type?: string; location?: string; headers?: Record<string, string> };
const html = (title: string | null, links: string[], extra = "") =>
  `<html><head>${title === null ? "" : `<title>${title}</title>`}${extra}</head><body><h1>h</h1>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

function fixture(routes: Record<string, Route>, maxRedirects = 5): { fetch: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetch: Fetcher = async (url) => {
    requested.push(url);
    let current = url;
    const chain: Array<{ url: string; status: number }> = [];
    for (;;) {
      const r = routes[current];
      if (!r) return res(current, 404, "not found", chain);
      if (r.status >= 300 && r.status < 400 && r.location) {
        chain.push({ url: current, status: r.status });
        if (chain.length > maxRedirects) return { ...res(current, 0, "", chain), ok: false, error: `Too many redirects (max ${maxRedirects})` };
        current = new URL(r.location, current).href;
        continue;
      }
      return { ...res(current, r.status, r.body ?? "", chain, r.type), headers: r.headers ?? {} };
    }
  };
  return { fetch, requested };
}
function res(finalUrl: string, status: number, body: string, chain: Array<{ url: string; status: number }>, type = "text/html"): SafeFetchResult {
  return { ok: status >= 200 && status < 300, status, headers: {}, body, finalUrl, redirectCount: chain.length, redirectChain: [...chain], durationMs: 1, contentType: type };
}

const S = "https://shop.example";
const SITE: Record<string, Route> = {
  [`${S}/robots.txt`]: { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${S}/sitemap.xml\n` },
  [`${S}/sitemap.xml`]: { status: 200, type: "application/xml", body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${S}/</loc></url><url><loc>${S}/orphan</loc></url><url><loc>${S}/gone</loc></url><url><loc>${S}/noindex</loc></url></urlset>` },
  [`${S}/`]: { status: 200, body: html("Home", ["/a", "/b", "/old", "/missing", "/private/x", "https://other.example/", "/hop1", "/img.png", "mailto:x@y"], `<link rel="canonical" href="${S}/">`) },
  [`${S}/a`]: { status: 200, body: html("Same title", ["/"], `<link rel="canonical" href="${S}/a">`) },
  [`${S}/b`]: { status: 200, body: html("Same title", ["/"], `<link rel="canonical" href="${S}/old">`) },
  [`${S}/old`]: { status: 301, location: "/a" },
  [`${S}/hop1`]: { status: 301, location: "/hop2" },
  [`${S}/hop2`]: { status: 302, location: "/hop3" },
  [`${S}/hop3`]: { status: 200, body: html("Hop", []) },
  [`${S}/orphan`]: { status: 200, body: html(null, []) },
  [`${S}/gone`]: { status: 410, body: "gone" },
  [`${S}/noindex`]: { status: 200, body: html("No", [], '<meta name="robots" content="noindex">') },
  [`${S}/private/x`]: { status: 200, body: html("Secret", []) },
};

const rules = (issues: ReturnType<typeof analyzeCrawl>) => issues.map((i) => `${i.ruleId} ${i.url.replace(S, "")}`).sort();

describe("robots.txt (RFC 9309)", () => {
  it("prefers our own group, longest match wins, allow wins ties, $ anchors", () => {
    const p = parseRobotsTxt("User-agent: *\nDisallow: /\n\nUser-agent: ZigmaNeural-Scanner\nDisallow: /a\nAllow: /a/public\nDisallow: /*.pdf$\nCrawl-delay: 2\nSitemap: https://x.example/s.xml");
    expect(p.sitemaps).toEqual(["https://x.example/s.xml"]);
    expect(p.crawlDelay).toBe(2);
    expect(isAllowedByRobots(p, "https://x.example/b")).toBe(true);
    expect(isAllowedByRobots(p, "https://x.example/a/secret")).toBe(false);
    expect(isAllowedByRobots(p, "https://x.example/a/public/1")).toBe(true);
    expect(isAllowedByRobots(p, "https://x.example/doc.pdf")).toBe(false);
    expect(isAllowedByRobots(p, "https://x.example/doc.pdf?x=1")).toBe(true);
    expect(isAllowedByRobots(p, "https://x.example/robots.txt")).toBe(true);
  });
  it("falls back to * and treats an empty Disallow as allow-all", () => {
    const p = parseRobotsTxt("# c\nUser-agent: otherbot\nDisallow: /\nUser-agent: *\nDisallow:\n");
    expect(isAllowedByRobots(p, "https://x.example/anything")).toBe(true);
  });
});

describe("robots.txt hardening", () => {
  it("matches wildcards in linear time (hostile patterns cannot stall the event loop)", () => {
    const t0 = Date.now();
    const target = "/" + "a".repeat(5_000);
    for (let i = 0; i < 1_000; i++) robotsPatternMatches("/*a*a*a*a*a*a*a*a*b$", target);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(robotsPatternMatches("/*a*a*b$", "/xaxab")).toBe(true);
    expect(robotsPatternMatches("/*a*a*b$", "/xaxabc")).toBe(false);
    expect(robotsPatternMatches("/p*", "/p")).toBe(true);
    expect(robotsPatternMatches("/p$", "/p/")).toBe(false);
  });
  it("ignores absurdly long or wildcard-heavy rules instead of evaluating them", () => {
    const p = parseRobotsTxt(`User-agent: *\nDisallow: /${"*x".repeat(40)}\nDisallow: /${"y".repeat(600)}\n`);
    expect(isAllowedByRobots(p, `https://x.example/${"x".repeat(50)}`)).toBe(true);
  });
});

describe("sitemap parsing", () => {
  it("reads urlsets and indexes and rejects non-XML", () => {
    expect(parseSitemapXml("<urlset><url><loc> https://a.example/1 </loc></url></urlset>")).toEqual({ kind: "urlset", urls: ["https://a.example/1"], sitemaps: [] });
    expect(parseSitemapXml("<sitemapindex><sitemap><loc>https://a.example/s2.xml</loc></sitemap></sitemapindex>").sitemaps).toEqual(["https://a.example/s2.xml"]);
    expect(parseSitemapXml("<html>not a sitemap</html>").kind).toBe("invalid");
    expect(parseSitemapXml("plain text").kind).toBe("invalid");
  });
});

describe("site crawl", () => {
  it("crawls same-site pages from links and the sitemap, honouring robots.txt", async () => {
    const { fetch, requested } = fixture(SITE);
    const r = await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch });
    expect(r.summary).toMatchObject({ robotsStatus: "parsed", sitemapStatus: "found", sitemapUrlCount: 4, truncated: false, startBlockedByRobots: false });
    expect(new Set(requested).size).toBe(requested.length); // never fetched twice
    expect(requested).not.toContain(`${S}/private/x`); // disallowed
    expect(requested.some((u) => u.includes("other.example"))).toBe(false); // off-site
    expect(requested).not.toContain(`${S}/img.png`); // asset
    const urls = r.pages.map((p) => p.url.replace(S, "")).sort();
    expect(urls).toEqual(["/", "/a", "/b", "/gone", "/hop1", "/hop3", "/missing", "/noindex", "/old", "/orphan"].sort());
    const hop = r.pages.find((p) => p.url === `${S}/hop1`)!;
    expect(hop.status).toBe(301);
    expect(hop.finalStatus).toBe(200);
    expect(hop.redirectChain.map((h) => h.status)).toEqual([301, 302]);
  });

  it("derives status, link, redirect, canonical, duplicate and sitemap issues from observations only", async () => {
    const { fetch } = fixture(SITE);
    const issues = analyzeCrawl(await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch }));
    expect(rules(issues)).toEqual([
      "broken_internal_link /missing",
      "canonical_missing /hop3",
      "canonical_missing /orphan",
      "canonical_target_not_ok /b",
      "internal_link_to_redirect /hop1",
      "internal_link_to_redirect /old",
      "page_4xx /gone",
      "page_4xx /missing",
      "redirect_chain /hop1",
      "sitemap_url_not_indexable /gone",
      "sitemap_url_not_indexable /noindex",
      "title_missing /orphan",
    ].sort());
    // /a and /b share a title but /b canonicalises elsewhere, so it is not indexable: no duplicate.
    expect(issues.find((i) => i.ruleId === "title_duplicate")).toBeUndefined();
  });

  it("reports duplicate titles across indexable pages with a stable fingerprint", async () => {
    const site = { ...SITE, [`${S}/b`]: { status: 200, body: html("Same title", ["/"], `<link rel="canonical" href="${S}/b">`) } };
    const issues = analyzeCrawl(await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture(site).fetch }));
    const dup = issues.filter((i) => i.ruleId === "title_duplicate");
    expect(dup).toHaveLength(1);
    expect(dup[0].details).toMatchObject({ pageCount: 2, pages: [`${S}/a`, `${S}/b`] });
    const again = analyzeCrawl(await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture(site).fetch })).find((i) => i.ruleId === "title_duplicate")!;
    expect(issueFingerprint(again)).toBe(issueFingerprint(dup[0]));
    expect(issueFingerprint(again)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects redirect loops", async () => {
    const site = { [`${S}/robots.txt`]: { status: 404 }, [`${S}/`]: { status: 200, body: html("Home", ["/loop"]) }, [`${S}/loop`]: { status: 301, location: "/loop2" }, [`${S}/loop2`]: { status: 301, location: "/loop" } };
    const issues = analyzeCrawl(await crawlSite(`${S}/`, { maxPages: 10, maxDurationMs: 60_000, fetch: fixture(site).fetch }));
    expect(rules(issues)).toEqual(expect.arrayContaining(["redirect_loop /loop", "robots_txt_missing /robots.txt", "sitemap_missing /sitemap.xml"]));
  });

  it("stops at the page budget and says so", async () => {
    const many: Record<string, Route> = { [`${S}/robots.txt`]: { status: 404 }, [`${S}/`]: { status: 200, body: html("Home", Array.from({ length: 30 }, (_, i) => `/p${i}`)) } };
    for (let i = 0; i < 30; i++) many[`${S}/p${i}`] = { status: 200, body: html(`P${i}`, []) };
    const r = await crawlSite(`${S}/`, { maxPages: 5, maxDurationMs: 60_000, fetch: fixture(many).fetch });
    expect(r.pages.length).toBeLessThanOrEqual(5 + 2);
    expect(r.summary).toMatchObject({ truncated: true, truncatedReason: "page_limit" });
  });

  it("treats an unreachable robots.txt as disallow-all and crawls nothing", async () => {
    const site = { [`${S}/robots.txt`]: { status: 503 }, [`${S}/`]: { status: 200, body: html("Home", []) } };
    const { fetch, requested } = fixture(site);
    const r = await crawlSite(`${S}/`, { maxPages: 10, maxDurationMs: 60_000, fetch });
    expect(r.summary).toMatchObject({ robotsStatus: "unreachable", startBlockedByRobots: true, pagesCrawled: 0 });
    expect(requested).not.toContain(`${S}/`);
    expect(rules(analyzeCrawl(r))).toEqual(expect.arrayContaining(["robots_txt_unreachable /robots.txt", "start_url_blocked_by_robots /"]));
  });

  it("aggregates one MEASURED technicalHealth finding per rule", async () => {
    const issues = analyzeCrawl(await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture(SITE).fetch }));
    const findings = crawlFindings(issues);
    expect(new Set(findings.map((f) => f.title)).size).toBe(findings.length);
    for (const f of findings) expect(f).toMatchObject({ category: "technicalHealth", provenance: "MEASURED", confidence: 100 });
    expect(findings.find((f) => f.title === "Pages return client errors")!.description).toMatch(/^2 occurrences/);
  });

  it("bounds per-page links and total discovered URLs, and reports truncation", async () => {
    const huge: Record<string, Route> = { [`${S}/robots.txt`]: { status: 404 }, [`${S}/`]: { status: 200, body: html("Home", Array.from({ length: 5_000 }, (_, i) => `/x${i}`)) } };
    const r = await crawlSite(`${S}/`, { maxPages: 3, maxDurationMs: 60_000, fetch: fixture(huge).fetch });
    expect(r.summary.pagesDiscovered).toBeLessThanOrEqual(1_001);
    expect(Object.keys(r.inlinks).length).toBeLessThanOrEqual(1_000);
    expect(r.summary.truncated).toBe(true);
  });

  it("is only reconcilable when the start page was really re-checked", async () => {
    const ok = await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture(SITE).fetch });
    expect(ok.summary.reconcilable).toBe(true);
    const down = await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture({ ...SITE, [`${S}/`]: { status: 503 } }).fetch });
    expect(down.summary.reconcilable).toBe(false);
    const robotsDown = await crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: fixture({ ...SITE, [`${S}/robots.txt`]: { status: 500 } }).fetch });
    expect(robotsDown.summary.reconcilable).toBe(false);
  });

  it("refuses to start when the scan has no time left for a crawl", async () => {
    const run = makeCrawlRunner({ maxPages: 10, maxDurationMs: 60_000 }, fixture(SITE).fetch);
    const r = await run(`${S}/`, { deadlineAt: Date.now() + 1_000 });
    expect(r).toMatchObject({ status: "failed", error: expect.stringMatching(/^CRAWL_TIME_BUDGET_EXHAUSTED/) });
  });

  it("normalizes URLs: no fragments, default ports, non-http schemes or userinfo", () => {
    expect(normalizeUrl("HTTPS://Shop.Example:443/a#top")).toBe("https://shop.example/a");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("https://u:p@shop.example/")).toBeNull();
    expect(normalizeUrl("../x?y=1", "https://shop.example/a/b")).toBe("https://shop.example/x?y=1");
  });
});
