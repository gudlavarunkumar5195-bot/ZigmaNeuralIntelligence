import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 2 end to end: a REAL local HTTP fixture site, the REAL safeFetch
// (redirect handling, body timeout, size cap, scope stop) and the REAL scan
// worker and PostgreSQL. Only the SSRF check is relaxed, and only for the
// fixture's exact host:port; every other address (including 127.0.0.1 on
// another port) still goes through the production SSRF rules.
const { fixture, crash } = vi.hoisted(() => {
  process.env.SCANNER_CRAWL_REQUEST_TIMEOUT_MS = "1000";
  process.env.SCANNER_CRAWL_CONCURRENCY = "2";
  return { fixture: { hostPort: "" }, crash: { armed: false } };
});
vi.mock("../scanner/ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/ssrf.js")>();
  return {
    ...actual,
    checkUrlSafety: async (raw: string, ...rest: unknown[]) => {
      let host = "";
      try { host = new URL(raw).host; } catch { /* actual() reports it */ }
      if (fixture.hostPort && host === fixture.hostPort) return { safe: true, resolvedIPs: ["127.0.0.1"] };
      return (actual.checkUrlSafety as (...a: unknown[]) => ReturnType<typeof actual.checkUrlSafety>)(raw, ...rest);
    },
  };
});
vi.mock("../ai/agents/scan-pipeline.js", () => ({ runScanIntelligence: async () => ({ status: "UNAVAILABLE", discoveryCount: 0 }) }));
// Crash injection for the retry test: fail the crawl module's commit once.
vi.mock("../analytics/events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics/events.js")>();
  return {
    ...actual,
    isClickHouseConfigured: () => true,
    enqueueAnalyticsEvent: async () => {
      if (crash.armed) {
        crash.armed = false;
        throw new Error("simulated worker crash during crawl commit");
      }
    },
  };
});

import { startFixtureSite, fixturePage, type FixtureSite } from "./helpers/fixture-site.js";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("technical audit against a real fixture website (HTTP + PostgreSQL)", () => {
  let site: FixtureSite;
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/scan.service.js");
  let audit: typeof import("../services/site-audit.service.js");
  let orgId: string;
  let websiteId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const scanOnce = async (crawl?: { maxPages?: number; maxDepth?: number }) => {
    const scan = await svc.createScan({ websiteId, orgId, triggeredBy: null, modules: ["crawl"], crawlOptions: crawl });
    await svc.runScan(scan.id);
    return scan.id;
  };
  const issues = async () =>
    Object.fromEntries((await db.query<{ rule_id: string; url: string; status: string }>(
      "SELECT rule_id, url, status FROM site_issues WHERE org_id=$1 AND website_id=$2", [orgId, websiteId],
    )).rows.map((r) => [`${r.rule_id} ${r.url.replace(site.origin, "") || "/"}`, r.status]));
  const pageRow = async (scanId: string, path: string) =>
    (await db.query("SELECT * FROM crawl_pages WHERE scan_id=$1 AND url=$2", [scanId, `${site.origin}${path}`])).rows[0];

  beforeAll(async () => {
    site = await startFixtureSite();
    fixture.hostPort = new URL(site.origin).host;
    db = await import("../db/client.js");
    svc = await import("../services/scan.service.js");
    audit = await import("../services/site-audit.service.js");
    orgId = (await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", [`Fixture ${suffix}`, `fixture-${suffix}`])).rows[0].id;
    websiteId = (await db.query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,'127.0.0.1',TRUE) RETURNING id", [orgId, `${site.origin}/`])).rows[0].id;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    await site?.close();
    if (!db) return;
    const { cleanupOrgs } = await import("./helpers/http.js");
    await cleanupOrgs([orgId]);
  });

  let firstScan = "";

  it("crawls the fixture: robots, sitemap, normalization, scope, SSRF, timeouts and content types", async () => {
    firstScan = await scanOnce();
    const scan = (await db.query<{ status: string }>("SELECT status FROM scans WHERE id=$1", [firstScan])).rows[0];
    expect(scan.status).toBe("completed");

    // robots.txt: the disallowed page was never requested, but is recorded.
    expect(site.requests).not.toContain("/private/secret");
    expect(await pageRow(firstScan, "/private/secret")).toMatchObject({ outcome: "blocked_by_robots", in_sitemap: true, indexable: false });
    // Normalization: fragment and tracking-parameter variants collapse to one fetch.
    expect(site.requests.filter((r) => r.startsWith("/about"))).toEqual(["/about"]);
    // Assets by extension are skipped; a non-HTML document is not downloaded or audited.
    expect(site.requests).not.toContain("/report.pdf");
    expect(await pageRow(firstScan, "/report")).toMatchObject({ outcome: "non_html", title: null });
    // Content pages are fetched exactly once (a redirect's landing is re-requested
    // only as the hop's own target, which cannot be known in advance).
    for (const path of ["/about", "/dup-a", "/dup-b", "/no-title", "/no-alt", "/canon-bad", "/hop3", "/broken"]) {
      expect(site.requests.filter((r) => r === path), path).toHaveLength(1);
    }

    // Off-site redirect: target recorded, not requested.
    expect(await pageRow(firstScan, "/offsite")).toMatchObject({ outcome: "redirect_out_of_scope", redirect_target: "https://partner.example/landing" });
    // Same host, other port: another origin, so out of scope and never requested.
    expect(await pageRow(firstScan, "/ssrf")).toMatchObject({ outcome: "redirect_out_of_scope", redirect_target: "http://127.0.0.1:1/admin" });
    expect((await db.query("SELECT 1 FROM crawl_pages WHERE scan_id=$1 AND url LIKE 'http://127.0.0.1:1/%'", [firstScan])).rows).toHaveLength(0);
    // Body timeout: recorded as a failure, not as an audited page.
    expect(await pageRow(firstScan, "/slow")).toMatchObject({ outcome: "fetch_error", indexable: false, title: null });
    expect((await pageRow(firstScan, "/slow")).fetch_error).toMatch(/not received within 1000ms/);
    // Multi-hop redirect and loop.
    expect(await pageRow(firstScan, "/hop1")).toMatchObject({ outcome: "redirect", status_code: 301, final_status_code: 200 });
    expect((await pageRow(firstScan, "/hop1")).redirect_chain.map((h: { status: number }) => h.status)).toEqual([301, 302]);
    expect(await pageRow(firstScan, "/loop1")).toMatchObject({ outcome: "redirect_loop" });

    const summary = (await db.query("SELECT * FROM crawl_summaries WHERE scan_id=$1", [firstScan])).rows[0];
    expect(summary).toMatchObject({ robots_status: "parsed", sitemap_status: "found", truncated: false, reconcilable: true, pages_blocked_by_robots: 1 });
  });

  it("derives findings from real page evidence with rule ids, categories and MEASURED provenance", async () => {
    const found = await issues();
    expect(found).toMatchObject({
      "broken_internal_link /broken": "OPEN",
      "page_4xx /broken": "OPEN",
      "page_4xx /gone": "OPEN",
      "sitemap_url_not_indexable /gone": "OPEN",
      "sitemap_url_not_indexable /moved": "OPEN",
      "sitemap_url_blocked_by_robots /private/secret": "OPEN",
      "redirect_chain /hop1": "OPEN",
      "internal_link_to_redirect /hop1": "OPEN",
      "redirect_loop /loop1": "OPEN",
      "broken_internal_link /loop1": "OPEN",
      "redirect_off_site /offsite": "OPEN",
      "redirect_off_site /ssrf": "OPEN",
      "page_fetch_error /slow": "OPEN",
      "broken_internal_link /slow": "OPEN",
      "title_missing /no-title": "OPEN",
      "meta_description_missing /no-title": "OPEN",
      "title_duplicate /dup-a": "OPEN",
      "meta_description_duplicate /dup-a": "OPEN",
      "canonical_target_not_ok /canon-bad": "OPEN",
      "img_alt_missing /no-alt": "OPEN",
    });
    // Nothing is said about content we could not audit, or pages that are fine.
    for (const key of Object.keys(found)) {
      expect(key, key).not.toMatch(/^(title|meta_description|h1|img_alt|canonical)_\w+ \/(slow|broken|ssrf|report|private\/secret|offsite)$/);
      expect(key, key).not.toMatch(/ \/about$/);
    }
    const { rows } = await db.query<{ rule_id: string; category: string; severity: string; details: Record<string, unknown> }>(
      "SELECT rule_id, category, severity, details FROM site_issues WHERE org_id=$1 AND rule_id IN ('img_alt_missing','broken_internal_link') ORDER BY rule_id, url", [orgId],
    );
    expect(rows.find((r) => r.rule_id === "img_alt_missing")).toMatchObject({ category: "images", severity: "low", details: { missing: 1, total: 2 } });
    expect(rows.find((r) => r.rule_id === "broken_internal_link")).toMatchObject({ category: "links", severity: "high", details: { status: 404, linkedFrom: [`${site.origin}/`] } });
    const findings = (await db.query<{ provenance: string; category: string }>("SELECT DISTINCT provenance, category FROM findings WHERE scan_id=$1", [firstScan])).rows;
    expect(findings).toEqual([{ provenance: "MEASURED", category: "technicalHealth" }]);
  });

  it("redirects cannot bypass SSRF: the real fetcher refuses private and metadata targets after a redirect", async () => {
    const { safeFetch } = await import("../scanner/fetch.js");
    site.routes["/to-metadata"] = { status: 302, location: "http://169.254.169.254/latest/meta-data/" };
    site.routes["/to-other-port"] = { status: 302, location: "http://127.0.0.1:1/admin" };
    for (const path of ["/to-metadata", "/to-other-port"]) {
      const res = await safeFetch(`${site.origin}${path}`); // no scope restriction: only SSRF rules apply
      expect(res, path).toMatchObject({ ok: false, status: 0 });
      expect(res.error, path).toMatch(/^SSRF:/);
      expect(res.redirectChain?.[0]).toMatchObject({ status: 302 });
    }
  });

  it("re-scan: fixed pages become FIXED, IGNORED stays ignored, everything else stays OPEN with the same issue rows", async () => {
    const before = (await db.query<{ id: string; rule_id: string; url: string }>("SELECT id, rule_id, url FROM site_issues WHERE org_id=$1", [orgId])).rows;
    const dup = before.find((r) => r.rule_id === "title_duplicate")!;
    await audit.setIssueIgnored({ orgId, websiteId, issueId: dup.id, actorId: (await db.query<{ id: string }>("INSERT INTO users (email, password_hash, full_name) VALUES ($1,'!x','Fixture User') RETURNING id", [`fixture-${suffix}@x.example`])).rows[0].id, ignore: true, reason: "Product variants share a title" });

    site.routes["/no-title"] = { status: 200, body: fixturePage({ title: "Now titled", description: "Now described", canonical: `${site.origin}/no-title` }) };
    site.routes["/no-alt"] = { status: 200, body: fixturePage({ title: "Alt", description: "Alt d", canonical: `${site.origin}/no-alt`, extraBody: `<img src="/a.png" alt="A">` }) };
    await scanOnce();
    const after = await issues();
    expect(after["title_missing /no-title"]).toBe("FIXED");
    expect(after["meta_description_missing /no-title"]).toBe("FIXED");
    expect(after["img_alt_missing /no-alt"]).toBe("FIXED");
    expect(after["title_duplicate /dup-a"]).toBe("IGNORED");
    expect(after["broken_internal_link /broken"]).toBe("OPEN");
    // Same fingerprints, same rows: nothing duplicated across scans.
    const ids = (await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM site_issues WHERE org_id=$1", [orgId])).rows[0].n;
    expect(Number(ids)).toBe(before.length);
    const brokenScans = (await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM site_issue_scans o JOIN site_issues i ON i.id=o.issue_id WHERE i.org_id=$1 AND i.rule_id='broken_internal_link' AND i.url=$2",
      [orgId, `${site.origin}/broken`],
    )).rows[0].n;
    expect(Number(brokenScans)).toBe(2);
  });

  it("a scan that cannot re-check the site (robots.txt 500) or is truncated before a page fixes nothing there", async () => {
    site.routes["/broken"] = { status: 200, body: fixturePage({ title: "Back", description: "Back d", canonical: `${site.origin}/broken` }) };
    const robots = site.routes["/robots.txt"];
    site.routes["/robots.txt"] = { status: 500, body: "boom" };
    await scanOnce();
    expect((await issues())["broken_internal_link /broken"]).toBe("OPEN");
    expect((await issues())["robots_txt_unreachable /robots.txt"]).toBe("OPEN");
    site.routes["/robots.txt"] = robots;

    // Depth 0: only the start page is fetched; /broken is not re-checked.
    const shallow = await scanOnce({ maxDepth: 0 });
    expect((await db.query("SELECT truncated_reason, max_depth FROM crawl_summaries WHERE scan_id=$1", [shallow])).rows[0]).toMatchObject({ truncated_reason: "depth_limit", max_depth: 0 });
    expect((await issues())["page_4xx /broken"]).toBe("OPEN");
    // robots.txt is back: its issue resolves (site-level rules are always re-checked).
    expect((await issues())["robots_txt_unreachable /robots.txt"]).toBe("FIXED");

    await scanOnce();
    expect((await issues())["page_4xx /broken"]).toBe("FIXED");
    expect((await issues())["broken_internal_link /broken"]).toBe("FIXED");
  });

  it("cancelling mid-crawl stops further requests and leaves issue state untouched", async () => {
    // Re-break a page so a full crawl WOULD change state, and make the crawl
    // long: 40 linked pages that each take 400 ms.
    site.routes["/broken"] = { status: 404, body: "nf" };
    const home = site.routes["/"];
    const slowLinks = Array.from({ length: 40 }, (_, i) => `/slow-${i}`);
    site.routes["/"] = { status: 200, body: fixturePage({ title: "Home", description: "Home d", canonical: `${site.origin}/`, links: ["/broken", ...slowLinks] }) };
    for (const l of slowLinks) site.routes[l] = { status: 200, body: fixturePage({ title: l, description: l, canonical: `${site.origin}${l}` }).slice(27), delayBodyMs: 400 };
    const before = await issues();
    const scan = await svc.createScan({ websiteId, orgId, triggeredBy: null, modules: ["crawl"] });
    const requestsBefore = site.requests.length;
    const running = svc.runScan(scan.id);
    // Cancel as soon as the crawl has started fetching pages.
    await vi.waitFor(() => expect(site.requests.length).toBeGreaterThan(requestsBefore + 2), { timeout: 5_000, interval: 20 });
    await db.query("UPDATE scans SET status='cancelled', completed_at=NOW() WHERE id=$1", [scan.id]);
    await running;
    const fetchedDuringScan = site.requests.length - requestsBefore;
    // Without cancellation the crawl would request all 40 slow pages.
    expect(fetchedDuringScan).toBeLessThan(25);
    site.routes["/"] = home;
    expect((await db.query("SELECT 1 FROM crawl_summaries WHERE scan_id=$1", [scan.id])).rows).toHaveLength(0);
    expect(await issues()).toEqual(before);
  });

  it("a worker crash during the crawl commit is retried without duplicate issues", async () => {
    const countBefore = Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM site_issues WHERE org_id=$1", [orgId])).rows[0].n);
    const scan = await svc.createScan({ websiteId, orgId, triggeredBy: null, modules: ["crawl"] });
    crash.armed = true;
    await expect(svc.runScan(scan.id)).rejects.toThrow(/simulated worker crash/);
    expect((await db.query("SELECT 1 FROM crawl_summaries WHERE scan_id=$1", [scan.id])).rows).toHaveLength(0);
    // The dead worker's lease expires; the sweeper requeues; a new worker finishes.
    await db.query("UPDATE scans SET status='running', execution_owner=gen_random_uuid(), execution_lease_until=NOW() - interval '1 minute' WHERE id=$1", [scan.id]);
    expect((await svc.recoverExpiredScanLeases({ orgId })).requeued.map((r) => r.scanId)).toContain(scan.id);
    const claimed = await svc.claimNextQueuedScan(orgId);
    await svc.runScan(scan.id, claimed!.ownerId);
    expect((await db.query<{ status: string }>("SELECT status FROM scans WHERE id=$1", [scan.id])).rows[0].status).toBe("completed");
    const countAfter = Number((await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM site_issues WHERE org_id=$1", [orgId])).rows[0].n);
    expect(countAfter).toBe(countBefore);
    expect((await issues())["page_4xx /broken"]).toBe("OPEN"); // reopened by the completed retry
  });
});
