import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeCrawl,
  crawlSite,
  issueFingerprint,
  makeCrawlRunner,
  normalizeUrl,
  ruleInfo,
  SEO_RULES,
  type CrawlProgress,
  type Fetcher,
} from "../scanner/crawl.js";
import type { SafeFetchOptions, SafeFetchResult } from "../scanner/fetch.js";

// Phase 2 crawler limits, outcomes and rule families. The fixture fetcher
// honours the same options as safeFetch (scope-bounded redirects, body
// skipping, size cap) so the crawler's use of them is exercised.

type Route = { status: number; body?: string; type?: string; location?: string; headers?: Record<string, string>; tooLarge?: boolean; error?: string };
const S = "https://shop.example";
const page = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const good = (title: string, links: string[] = [], extraHead = "") =>
  page(`<title>${title}</title><meta name="description" content="About ${title}"><link rel="canonical" href="__SELF__">${extraHead}`, `<h1>${title}</h1>${links.map((l) => `<a href="${l}">x</a>`).join("")}`);

function site(routes: Record<string, Route>): { fetch: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetch: Fetcher = async (url: string, opts: SafeFetchOptions = {}) => {
    requested.push(url);
    let current = url;
    const chain: Array<{ url: string; status: number }> = [];
    for (;;) {
      const r = routes[current] ?? { status: 404, body: "nf" };
      if (r.status >= 300 && r.status < 400 && r.location) {
        const next = new URL(r.location, current).href;
        chain.push({ url: current, status: r.status });
        if (opts.followRedirect && !opts.followRedirect(next)) {
          return { ...res(current, r.status, "", chain), ok: false, redirectBlockedTo: next, error: "Redirect target is outside the permitted scope; not requested" };
        }
        if (chain.length > 5) return { ...res(current, 0, "", chain), ok: false, error: "Too many redirects (max 5)" };
        requested.push(next);
        current = next;
        continue;
      }
      if (r.error) return { ...res(current, 0, "", chain), ok: false, error: r.error };
      const type = r.type ?? "text/html";
      if (opts.acceptBody && !opts.acceptBody(type)) return { ...res(current, r.status, "", chain, type), bodySkipped: true };
      if (r.tooLarge) return { ...res(current, r.status, "<html>", chain, type), ok: false, limited: true, error: "Response exceeded 2097152 bytes" };
      return { ...res(current, r.status, (r.body ?? "").replaceAll("__SELF__", current), chain, type), headers: r.headers ?? {} };
    }
  };
  return { fetch, requested };
}
function res(finalUrl: string, status: number, body: string, chain: Array<{ url: string; status: number }>, type = "text/html"): SafeFetchResult {
  return { ok: status >= 200 && status < 300, status, headers: {}, body, finalUrl, redirectCount: chain.length, redirectChain: [...chain], durationMs: 1, contentType: type };
}
const base = (extra: Record<string, Route>): Record<string, Route> => ({
  [`${S}/robots.txt`]: { status: 404 },
  [`${S}/sitemap.xml`]: { status: 404 },
  ...extra,
});
const crawl = (routes: Record<string, Route>, opts: Partial<Parameters<typeof crawlSite>[1]> = {}) => {
  const s = site(routes);
  return crawlSite(`${S}/`, { maxPages: 50, maxDurationMs: 60_000, fetch: s.fetch, ...opts }).then((r) => ({ r, requested: s.requested }));
};
const ruleSet = (issues: ReturnType<typeof analyzeCrawl>) => issues.map((i) => `${i.ruleId} ${i.url.replace(S, "") || "/"}`).sort();
/** Page-level rules only (the fixtures have no robots.txt or sitemap on purpose). */
const pageRules = (issues: ReturnType<typeof analyzeCrawl>) => ruleSet(issues).filter((r) => !/^(robots_txt_missing|sitemap_missing) /.test(r));

describe("URL normalization and crawl bounds", () => {
  it("drops fragments and tracking parameters but keeps meaningful query strings", () => {
    expect(normalizeUrl(`${S}/p?utm_source=x&id=7&gclid=abc#top`)).toBe(`${S}/p?id=7`);
    expect(normalizeUrl(`${S}/p?fbclid=1&utm_medium=y`)).toBe(`${S}/p`);
    expect(normalizeUrl(`${S}/p?page=2`)).toBe(`${S}/p?page=2`);
  });

  it("follows at most N query-string variants per path and reports the discovery limit", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `/list?page=${i}`);
    const routes = base({ [`${S}/`]: { status: 200, body: good("Home", links) } });
    for (let i = 0; i < 30; i++) routes[`${S}/list?page=${i}`] = { status: 200, body: good(`List ${i}`) };
    const { r, requested } = await crawl(routes, { maxQueryVariantsPerPath: 4 });
    expect(requested.filter((u) => u.includes("/list?"))).toHaveLength(4);
    expect(r.summary).toMatchObject({ truncated: true, truncatedReason: "discovery_limit" });
  });

  it("never fetches beyond the maximum depth and says the crawl was depth-limited", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/d1"]) },
      [`${S}/d1`]: { status: 200, body: good("D1", ["/d2"]) },
      [`${S}/d2`]: { status: 200, body: good("D2", ["/d3"]) },
      [`${S}/d3`]: { status: 200, body: good("D3") },
    });
    const { r, requested } = await crawl(routes, { maxDepth: 2 });
    expect(requested).toContain(`${S}/d2`);
    expect(requested).not.toContain(`${S}/d3`);
    expect(Math.max(...r.pages.map((p) => p.depth))).toBe(2);
    expect(r.summary).toMatchObject({ truncated: true, truncatedReason: "depth_limit", maxDepth: 2 });
  });

  it("does not follow a redirect off the verified site and records where it pointed", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/out"]) },
      [`${S}/out`]: { status: 302, location: "https://evil.example/landing" },
    });
    const { r, requested } = await crawl(routes);
    expect(requested.some((u) => u.includes("evil.example"))).toBe(false);
    expect(r.pages.find((p) => p.url === `${S}/out`)).toMatchObject({ outcome: "redirect_out_of_scope", redirectTarget: "https://evil.example/landing", indexable: false });
    expect(ruleSet(analyzeCrawl(r))).toEqual(expect.arrayContaining(["redirect_off_site /out", "internal_link_to_redirect /out"]));
    expect(ruleSet(analyzeCrawl(r))).not.toContain("broken_internal_link /out");
  });

  it("www/apex twins are in scope; other subdomains are not", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/twin", "/sub"]) },
      [`${S}/twin`]: { status: 301, location: "https://www.shop.example/twin" },
      ["https://www.shop.example/twin"]: { status: 200, body: good("Twin") },
      [`${S}/sub`]: { status: 301, location: "https://blog.shop.example/" },
    });
    const { r, requested } = await crawl(routes);
    expect(requested).toContain("https://www.shop.example/twin");
    expect(requested).not.toContain("https://blog.shop.example/");
    expect(r.pages.find((p) => p.url === `${S}/sub`)?.outcome).toBe("redirect_out_of_scope");
  });

  it("records non-HTML, oversized and failed responses without auditing their content", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/report", "/huge", "/slow"]) },
      [`${S}/report`]: { status: 200, type: "application/pdf", body: "%PDF" },
      [`${S}/huge`]: { status: 200, tooLarge: true },
      [`${S}/slow`]: { status: 0, error: "Response body not received within 10000ms" },
    });
    const { r } = await crawl(routes, { maxPageBytes: 2_097_152 });
    const by = (u: string) => r.pages.find((p) => p.url === `${S}${u}`)!;
    expect(by("/report")).toMatchObject({ outcome: "non_html", indexable: false, title: null });
    expect(by("/huge")).toMatchObject({ outcome: "too_large", indexable: false, h1Count: null });
    expect(by("/slow")).toMatchObject({ outcome: "fetch_error", fetchError: expect.stringMatching(/not received/) });
    const rules = ruleSet(analyzeCrawl(r));
    expect(rules).toEqual(expect.arrayContaining(["page_too_large /huge", "page_fetch_error /slow", "broken_internal_link /slow"]));
    // No content rule ever fires for pages we could not audit.
    expect(rules.filter((x) => /\/(report|huge|slow)$/.test(x) && /^(title|meta|h1|img|canonical)/.test(x))).toEqual([]);
  });

  it("stops when cancelled, is then not reconcilable, and the runner discards the partial crawl", async () => {
    const links = Array.from({ length: 20 }, (_, i) => `/p${i}`);
    const routes = base({ [`${S}/`]: { status: 200, body: good("Home", links) } });
    for (let i = 0; i < 20; i++) routes[`${S}/p${i}`] = { status: 200, body: good(`P${i}`) };
    let fetched = 0;
    const progress: CrawlProgress[] = [];
    const { r } = await crawl(routes, { concurrency: 1, shouldStop: () => fetched >= 3, onProgress: (p) => { fetched = p.pagesCrawled; progress.push(p); } });
    expect(r.summary).toMatchObject({ truncated: true, truncatedReason: "cancelled", reconcilable: false });
    expect(r.summary.pagesCrawled).toBe(3);
    expect(progress.map((p) => p.pagesCrawled)).toEqual([1, 2, 3]);

    const run = makeCrawlRunner({ maxPages: 50, maxDurationMs: 60_000 }, site(routes).fetch);
    const out = await run(`${S}/`, { shouldStop: () => true });
    expect(out).toMatchObject({ status: "failed", findings: [], error: expect.stringMatching(/^CRAWL_CANCELLED/) });
    expect(out.crawl).toBeUndefined();
  });

  it("per-scan crawl options can only lower the server limits", async () => {
    const links = Array.from({ length: 10 }, (_, i) => `/p${i}`);
    const routes = base({ [`${S}/`]: { status: 200, body: good("Home", links) } });
    for (let i = 0; i < 10; i++) routes[`${S}/p${i}`] = { status: 200, body: good(`P${i}`) };
    const run = makeCrawlRunner({ maxPages: 5, maxDurationMs: 60_000, maxDepth: 3 }, site(routes).fetch);
    const lowered = await run(`${S}/`, { crawlOptions: { maxPages: 2, maxDepth: 1 } });
    expect(lowered.crawl!.result.summary).toMatchObject({ pagesCrawled: 2, maxPages: 2, maxDepth: 1 });
    const raised = await run(`${S}/`, { crawlOptions: { maxPages: 500, maxDepth: 50 } });
    expect(raised.crawl!.result.summary).toMatchObject({ pagesCrawled: 5, maxPages: 5, maxDepth: 3 });
  });
});

describe("technical SEO rule families", () => {
  it("content: missing title, missing/duplicate description, missing/multiple H1", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/no-title", "/no-desc", "/no-h1", "/two-h1", "/dup1", "/dup2"]) },
      [`${S}/no-title`]: { status: 200, body: page(`<meta name="description" content="x1"><link rel="canonical" href="__SELF__">`, "<h1>a</h1>") },
      [`${S}/no-desc`]: { status: 200, body: page(`<title>No desc</title><link rel="canonical" href="__SELF__">`, "<h1>a</h1>") },
      [`${S}/no-h1`]: { status: 200, body: page(`<title>No h1</title><meta name="description" content="x2"><link rel="canonical" href="__SELF__">`, "<p>a</p>") },
      [`${S}/two-h1`]: { status: 200, body: page(`<title>Two</title><meta name="description" content="x3"><link rel="canonical" href="__SELF__">`, "<h1>a</h1><h1>b</h1>") },
      [`${S}/dup1`]: { status: 200, body: page(`<title>Dup A</title><meta name="description" content="Same words"><link rel="canonical" href="__SELF__">`, "<h1>a</h1>") },
      [`${S}/dup2`]: { status: 200, body: page(`<title>Dup B</title><meta name="description" content="same   WORDS"><link rel="canonical" href="__SELF__">`, "<h1>a</h1>") },
    });
    const issues = analyzeCrawl((await crawl(routes)).r);
    expect(pageRules(issues)).toEqual([
      "h1_missing /no-h1",
      "h1_multiple /two-h1",
      "meta_description_duplicate /dup1",
      "meta_description_missing /no-desc",
      "title_missing /no-title",
    ]);
    const dup = issues.find((i) => i.ruleId === "meta_description_duplicate")!;
    expect(dup).toMatchObject({ category: "content", severity: "low", details: { pageCount: 2, pages: [`${S}/dup1`, `${S}/dup2`] } });
    expect(issues.find((i) => i.ruleId === "h1_multiple")!.details).toEqual({ h1Count: 2 });
  });

  it("images: reports <img> without alt, accepts alt=\"\" as decorative, samples the sources", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", [], "") .replace("</body>", `<img src="/a.png"><img src="/b.png" alt=""><img src="c.png" alt="Chart"><img src="/d.png"></body>`) },
    });
    const issues = analyzeCrawl((await crawl(routes)).r);
    const alt = issues.find((i) => i.ruleId === "img_alt_missing")!;
    expect(alt).toMatchObject({ category: "images", url: `${S}/`, details: { missing: 2, total: 4, sample: [`${S}/a.png`, `${S}/d.png`] } });
  });

  it("indexability: noindex/nofollow from meta and X-Robots-Tag; noindex pages are not duplicates and need no canonical", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/meta-noindex", "/header-noindex", "/nofollow"]) },
      [`${S}/meta-noindex`]: { status: 200, body: page(`<title>Home</title><meta name="robots" content="noindex">`, "<h1>x</h1>") },
      [`${S}/header-noindex`]: { status: 200, headers: { "x-robots-tag": "noindex" }, body: page("<title>Home</title>", "<h1>x</h1>") },
      [`${S}/nofollow`]: { status: 200, body: good("Nofollow", ["/never"], `<meta name="robots" content="nofollow">`) },
    });
    const { r, requested } = await crawl(routes);
    const issues = analyzeCrawl(r);
    expect(pageRules(issues)).toEqual(["page_nofollow /nofollow", "page_noindex /header-noindex", "page_noindex /meta-noindex"]);
    expect(requested).not.toContain(`${S}/never`);
    expect(r.pages.find((p) => p.url === `${S}/header-noindex`)).toMatchObject({ indexable: false, indexabilityReasons: ["noindex_header"] });
    expect(r.pages.find((p) => p.url === `${S}/`)).toMatchObject({ indexable: true, indexabilityReasons: [] });
  });

  it("canonicals: multiple, invalid, cross-domain and a target that redirects", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/multi", "/invalid", "/cross", "/to-redirect", "/moved"]) },
      [`${S}/multi`]: { status: 200, body: page(`<title>M</title><meta name="description" content="m"><link rel="canonical" href="/multi"><link rel="canonical" href="/other">`, "<h1>m</h1>") },
      [`${S}/invalid`]: { status: 200, body: page(`<title>I</title><meta name="description" content="i"><link rel="canonical" href="javascript:void(0)">`, "<h1>i</h1>") },
      [`${S}/cross`]: { status: 200, body: page(`<title>C</title><meta name="description" content="c"><link rel="canonical" href="https://partner.example/c">`, "<h1>c</h1>") },
      [`${S}/to-redirect`]: { status: 200, body: page(`<title>T</title><meta name="description" content="t"><link rel="canonical" href="/moved">`, "<h1>t</h1>") },
      [`${S}/moved`]: { status: 301, location: "/" },
    });
    const rules = ruleSet(analyzeCrawl((await crawl(routes)).r));
    expect(rules).toEqual(expect.arrayContaining([
      "canonical_cross_domain /cross",
      "canonical_invalid /invalid",
      "canonical_multiple /multi",
      "canonical_target_not_ok /to-redirect",
    ]));
  });

  it("sitemaps: listed URLs that are blocked by robots.txt, redirect or fail are reported", async () => {
    const routes: Record<string, Route> = {
      [`${S}/robots.txt`]: { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${S}/sitemap.xml\n` },
      [`${S}/sitemap.xml`]: { status: 200, type: "application/xml", body: `<urlset><url><loc>${S}/</loc></url><url><loc>${S}/private/a</loc></url><url><loc>${S}/moved</loc></url><url><loc>${S}/dead</loc></url></urlset>` },
      [`${S}/`]: { status: 200, body: good("Home") },
      [`${S}/moved`]: { status: 301, location: "/" },
      [`${S}/dead`]: { status: 500, body: "boom" },
    };
    const rules = ruleSet(analyzeCrawl((await crawl(routes)).r));
    expect(rules).toEqual(expect.arrayContaining([
      "sitemap_url_blocked_by_robots /private/a",
      "sitemap_url_not_indexable /moved",
      "sitemap_url_not_indexable /dead",
      "page_5xx /dead",
    ]));
    expect(rules).not.toContain("sitemap_url_not_indexable /");
  });

  it("a missing default /sitemap.xml is reported once as missing, a declared one that fails as unavailable", async () => {
    const none = ruleSet(analyzeCrawl((await crawl(base({ [`${S}/`]: { status: 200, body: good("Home") } }))).r));
    expect(none.filter((r) => r.startsWith("sitemap_"))).toEqual(["sitemap_missing /sitemap.xml"]);
    const declared = ruleSet(analyzeCrawl((await crawl({
      [`${S}/robots.txt`]: { status: 200, type: "text/plain", body: `Sitemap: ${S}/maps/main.xml\n` },
      [`${S}/`]: { status: 200, body: good("Home") },
    })).r));
    expect(declared.filter((r) => r.startsWith("sitemap_"))).toEqual(["sitemap_unavailable /maps/main.xml"]);
  });

  it("concurrent fetches never exceed the page budget", async () => {
    const links = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const routes = base({ [`${S}/`]: { status: 200, body: good("Home", links) } });
    for (let i = 0; i < 40; i++) routes[`${S}/p${i}`] = { status: 200, body: good(`P${i}`) };
    for (const maxPages of [1, 2, 7]) {
      const { r, requested } = await crawl(routes, { maxPages, concurrency: 5 });
      expect(r.summary.pagesCrawled).toBe(maxPages);
      expect(requested.filter((u) => !/robots\.txt|sitemap\.xml/.test(u))).toHaveLength(maxPages);
    }
  });

  it("every rule has a category, explanation and remediation, and is MEASURED by the site crawler", () => {
    for (const id of Object.keys(SEO_RULES)) {
      const info = ruleInfo(id);
      expect(info.explanation.length, id).toBeGreaterThan(20);
      expect(info.remediation.length, id).toBeGreaterThan(10);
      expect(info).toMatchObject({ provenance: "MEASURED", source: "site_crawler" });
    }
  });

  it("migration 031 backfills every rule into the same category as the catalog", () => {
    const sql = readFileSync(join(__dirname, "..", "db", "migrations", "031_technical_seo_audit.sql"), "utf8");
    const mapped = Object.fromEntries([...sql.matchAll(/WHEN '([a-z0-9_]+)' THEN '([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
    expect(mapped).toEqual(Object.fromEntries(Object.entries(SEO_RULES).map(([id, r]) => [id, r.category])));
  });

  it("issues carry their rule's category, and the fingerprint ignores evidence that varies between scans", async () => {
    const routes = base({
      [`${S}/`]: { status: 200, body: good("Home", ["/missing"]) },
      [`${S}/a`]: { status: 200, body: good("A", ["/missing"]) },
    });
    const first = analyzeCrawl((await crawl(routes)).r).find((i) => i.ruleId === "broken_internal_link")!;
    const later = analyzeCrawl((await crawl({ ...routes, [`${S}/`]: { status: 200, body: good("Home", ["/a", "/missing"]) } })).r).find((i) => i.ruleId === "broken_internal_link")!;
    expect(first.category).toBe("links");
    expect(later.details.linkCount).not.toBe(first.details.linkCount);
    expect(issueFingerprint(later)).toBe(issueFingerprint(first));
  });
});
