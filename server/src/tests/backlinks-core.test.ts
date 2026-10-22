import { describe, expect, it } from "vitest";
import {
  compareSnapshots,
  domainOf,
  encodingProblem,
  gapCompatibility,
  linkKey,
  mapHeaders,
  normalizeDomain,
  normalizeLinkUrl,
  parseCsv,
  referringDomainGap,
  scoreOpportunity,
  validateRows,
  type SnapshotLink,
} from "../backlinks/core.js";
import { createVerifier, findLink } from "../backlinks/verify.js";
import type { SafeFetchResult } from "../scanner/fetch.js";

// Synthetic fixtures only.

describe("URL and domain normalization", () => {
  it("normalizes scheme, host, port and fragment; rejects non-http and credentials", () => {
    expect(normalizeLinkUrl("HTTPS://WWW.Example.COM:443/Path?q=1#frag")).toBe("https://www.example.com/Path?q=1");
    expect(normalizeLinkUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeLinkUrl("http://example.com:80")).toBe("http://example.com/");
    expect(normalizeLinkUrl("http://bücher.example/")).toBe("http://xn--bcher-kva.example/");
    for (const bad of ["javascript:alert(1)", "ftp://example.com/", "https://user:pw@example.com/", "https://localhost/", "", "x".repeat(3000)]) expect(normalizeLinkUrl(bad)).toBeNull();
    expect(domainOf("https://www.blog.example.com/x")).toBe("blog.example.com");
    expect(normalizeDomain("WWW.Rival.example")).toBe("rival.example");
  });
  it("link keys are stable and distinguish targets", () => {
    expect(linkKey("https://a.example/", "https://b.example/")).toBe(linkKey("https://a.example/", "https://b.example/"));
    expect(linkKey("https://a.example/", "https://b.example/x")).not.toBe(linkKey("https://a.example/", "https://b.example/"));
    expect(linkKey("https://a.example/", null)).toHaveLength(64);
  });
});

describe("CSV parsing and validation", () => {
  it("parses quotes, escaped quotes, CRLF, BOM and detects ; and tab delimiters", () => {
    const p = parseCsv('﻿Source URL,Anchor\r\n"https://a.example/x","say ""hi"", ok"\r\nhttps://b.example/,plain\r\n', 100);
    expect(p.header).toEqual(["Source URL", "Anchor"]);
    expect(p.rows).toEqual([["https://a.example/x", 'say "hi", ok'], ["https://b.example/", "plain"]]);
    expect(parseCsv("a;b\n1;2", 10).delimiter).toBe(";");
    expect(parseCsv("a\tb\n1\t2", 10).delimiter).toBe("\t");
  });
  it("stops at the row limit and reports truncation", () => {
    const csv = "Source URL\n" + Array.from({ length: 20 }, (_, i) => `https://s${i}.example/`).join("\n");
    const p = parseCsv(csv, 5);
    expect(p.truncated).toBe(true);
    expect(p.rows).toHaveLength(5);
  });
  it("maps headers of common exports and requires a source URL column", () => {
    expect(mapHeaders(["Linking page", "Last crawled"]).mapping).toEqual({ source_url: 0, last_seen: 1 });
    const ahrefs = mapHeaders(["Referring page URL", "Target URL", "Anchor", "Nofollow", "UGC", "Sponsored", "First seen", "Last seen", "Lost"]);
    expect(ahrefs.missingRequired).toEqual([]);
    expect(Object.keys(ahrefs.mapping).sort()).toEqual(["anchor", "first_seen", "last_seen", "lost", "nofollow", "source_url", "sponsored", "target_url", "ugc"]);
    expect(mapHeaders(["Domain", "Links"]).missingRequired).toEqual(["source_url"]);
  });
  it("accepts, rejects, skips and deduplicates rows accurately, keeping text inert", () => {
    const header = ["Source URL", "Target URL", "Anchor", "Rel", "First seen", "Last seen"];
    const rows = [
      ["https://blog.example/post", "https://mysite.example/", "=HYPERLINK(\"x\")", "nofollow", "2025-01-02", "2025-02-01"],
      ["https://blog.example/post", "https://mysite.example/", "", "", "", ""], // duplicate of row 2
      ["not a url", "https://mysite.example/", "a", "", "", ""],
      ["https://forum.example/t/1", "nonsense url", "a", "", "", ""],
      ["", "", "", "", "", ""],
      ["https://news.example/a", "", "<script>x</script>", "sponsored ugc", "yesterday-ish", ""],
    ];
    const r = validateRows(header, rows, mapHeaders(header).mapping, { maxRows: 100, maxField: 2048, targetDomain: "mysite.example" });
    expect({ total: r.rowsTotal, accepted: r.links.length, rejected: r.rejected.length, dup: r.duplicates, skipped: r.skipped }).toEqual({ total: 6, accepted: 2, rejected: 2, dup: 1, skipped: 1 });
    expect(r.rejected).toEqual([{ row: 4, reason: "Missing or invalid source URL" }, { row: 5, reason: "Invalid target URL" }]);
    expect(r.links[0]).toMatchObject({ anchor: '=HYPERLINK("x")', linkType: "nofollow", firstSeen: "2025-01-02", lastSeen: "2025-02-01", targetDomain: "mysite.example" });
    expect(r.links[1]).toMatchObject({ anchor: "<script>x</script>", linkType: "sponsored", targetUrl: null, firstSeen: null });
    expect(r.warnings.join(" ")).toMatch(/unreadable date/);
  });
  it("never infers follow without evidence; boolean flag columns all false mean follow", () => {
    const h = ["Source URL", "Nofollow", "Sponsored", "UGC"];
    const r = validateRows(h, [["https://a.example/", "FALSE", "FALSE", "FALSE"]], mapHeaders(h).mapping, { maxRows: 10, maxField: 2048 });
    expect(r.links[0].linkType).toBe("follow");
    const none = validateRows(["Source URL"], [["https://a.example/"]], { source_url: 0 }, { maxRows: 10, maxField: 2048 });
    expect(none.links[0].linkType).toBeNull();
    expect(none.warnings.join(" ")).toMatch(/follow\/nofollow is unknown/);
  });
  it("rejects oversized fields and detects bad encodings", () => {
    const r = validateRows(["Source URL"], [["https://a.example/" + "x".repeat(3000)]], { source_url: 0 }, { maxRows: 10, maxField: 2048 });
    expect(r.rejected[0].reason).toMatch(/longer than 2048/);
    expect(encodingProblem("S\u0000o\u0000u\u0000r")).toMatch(/UTF-16/);
    expect(encodingProblem("�".repeat(10))).toMatch(/not valid UTF-8/);
    expect(encodingProblem("Source URL\nhttps://a.example/")).toBeNull();
  });
});

describe("snapshot change detection", () => {
  const l = (src: string, tgt: string | null, extra: Partial<SnapshotLink> = {}): SnapshotLink => ({ linkKey: linkKey(src, tgt), sourceUrl: src, targetUrl: tgt, anchor: "a", linkType: "follow", providerLost: null, ...extra });
  const A = l("https://a.example/1", "https://me.example/");
  const B = l("https://b.example/1", "https://me.example/");

  it("an absence from a partial snapshot is only 'potentially lost' (no false loss)", () => {
    const c = compareSnapshots([A, B], [A], "partial");
    expect(c).toEqual([expect.objectContaining({ type: "potentially_lost", linkKey: B.linkKey })]);
    expect(compareSnapshots([A, B], [A], "unknown")[0].type).toBe("potentially_lost");
  });
  it("an absence from a complete snapshot, or a source-reported loss, is 'lost'", () => {
    expect(compareSnapshots([A, B], [A], "complete")[0].type).toBe("lost");
    expect(compareSnapshots([A], [{ ...A, providerLost: true }], "partial")[0]).toMatchObject({ type: "lost", evidence: "The source reports this link as lost." });
  });
  it("detects new links, anchor, attribute and target changes", () => {
    const moved = l("https://b.example/1", "https://me.example/new");
    const c = compareSnapshots([A, B], [{ ...A, anchor: "b", linkType: "nofollow" }, moved, l("https://c.example/", "https://me.example/")], "partial");
    expect(c.map((x) => x.type).sort()).toEqual(["anchor_changed", "attributes_changed", "new", "target_changed"]);
    expect(c.find((x) => x.type === "target_changed")!.details).toEqual({ from: "https://me.example/", to: "https://me.example/new" });
  });
  it("unknown attributes or anchors never count as a change", () => {
    expect(compareSnapshots([A], [{ ...A, anchor: null, linkType: null }], "complete")).toEqual([]);
  });
});

describe("referring-domain gap and compatibility", () => {
  it("classifies shared, competitor-only and own-only domains", () => {
    const rows = referringDomainGap({ subject: "me", domains: new Set(["x.example", "y.example"]) }, [
      { subject: "r1", domains: new Set(["x.example", "z.example"]) },
      { subject: "r2", domains: new Set(["z.example"]) },
    ]);
    expect(rows).toEqual([
      { domain: "z.example", category: "competitor_only", competitors: ["r1", "r2"] },
      { domain: "x.example", category: "shared", competitors: ["r1"] },
      { domain: "y.example", category: "own_only", competitors: [] },
    ]);
  });
  it("refuses datasets exported too far apart or empty; warns about mixed sources and partial coverage", () => {
    const d = (subject: string, date: string, over: object = {}) => ({ id: subject, subject, sourceLabel: "Ahrefs", coverage: "complete" as const, retrievedAt: new Date(date), exportedAt: date, links: 5, ...over });
    expect(gapCompatibility([d("me", "2030-01-01"), d("r", "2030-12-01")]).compatible).toBe(false);
    expect(gapCompatibility([d("me", "2030-01-01"), d("r", "2030-01-10", { links: 0 })]).problems[0]).toMatch(/no links/);
    const w = gapCompatibility([d("me", "2030-01-01"), d("r", "2030-02-20", { sourceLabel: "Semrush", coverage: "partial" })]);
    expect(w.compatible).toBe(true);
    expect(w.warnings.join(" ")).toMatch(/50 days apart.*Different sources.*Not declared complete: r/s);
  });
});

describe("opportunity score", () => {
  const today = new Date("2030-06-01");
  const base = { domain: "x.example", kind: "competitor_only" as const, competitorsLinking: 2, competitorsCompared: 2, anyFollow: true, lastSeen: "2030-05-01", verifiedLive: true, topicMatches: { matched: ["shoes", "running", "trail"], terms: 5 }, previouslyLinked: true };
  it("is 100 with every signal at its maximum and explains each signal", () => {
    const s = scoreOpportunity(base, today);
    expect(s).toMatchObject({ score: 100, basis: 1 });
    expect(s.signals.map((x) => x.id)).toEqual(["competitor_linking", "topical_relevance", "follow_links", "freshness", "verified_live", "prior_relationship"]);
  });
  it("excludes unavailable inputs from the denominator and reports them", () => {
    const s = scoreOpportunity({ ...base, anyFollow: null, lastSeen: null, verifiedLive: null, topicMatches: null, previouslyLinked: false, competitorsLinking: 1 }, today);
    // available: competitor_linking (0.3 × 0.5) + prior_relationship (0.1 × 0) over 0.4
    expect(s).toMatchObject({ score: 38, basis: 0.4 });
    expect(s.signals.filter((x) => x.value === null).map((x) => x.explanation).join(" ")).toMatch(/Unavailable: no topic terms.*Unavailable: the data has no link attributes.*Unavailable: no last-seen dates.*Unavailable: not verified/s);
  });
  it("is deterministic and monotonic in competitor evidence", () => {
    const one = scoreOpportunity({ ...base, competitorsLinking: 1 }, today).score;
    expect(scoreOpportunity({ ...base, competitorsLinking: 1 }, today).score).toBe(one);
    expect(scoreOpportunity(base, today).score).toBeGreaterThan(one);
  });
});

describe("live link verification", () => {
  it("finds links by exact target or target domain, reads rel and anchor, honours <base>", () => {
    const html = `<html><head><base href="https://blog.example/dir/"></head><body>
      <a href="https://other.example/">x</a>
      <a href="https://me.example/page/" rel="nofollow ugc"> Great   shoes </a>
      <a href="../rel"><img alt="logo"></a></body></html>`;
    expect(findLink(html, "https://blog.example/dir/post", { url: "https://me.example/page", domain: "me.example" })).toEqual({ linkType: "ugc", anchor: "Great shoes" });
    expect(findLink(html, "https://blog.example/dir/post", { url: null, domain: "me.example" })).toMatchObject({ linkType: "ugc" });
    expect(findLink(html, "https://blog.example/dir/post", { url: "https://blog.example/rel", domain: "blog.example" })).toEqual({ linkType: "follow", anchor: "logo" });
    expect(findLink(html, "https://blog.example/dir/post", { url: "https://me.example/other", domain: "me.example" })).toBeNull();
  });

  const res = (over: Partial<SafeFetchResult>): SafeFetchResult => ({ ok: true, status: 200, headers: {}, body: "", finalUrl: "https://blog.example/p", redirectCount: 0, durationMs: 1, ...over });
  it("maps fetch results to outcomes and never calls a link live without seeing it", async () => {
    const pages: Record<string, SafeFetchResult> = {
      "https://blog.example/robots.txt": res({ status: 200, body: "User-agent: *\nDisallow: /private" }),
      "https://blog.example/has": res({ body: '<a href="https://me.example/">me</a>' }),
      "https://blog.example/hasnot": res({ body: "<p>nothing</p>" }),
      "https://blog.example/gone": res({ ok: false, status: 404 }),
      "https://blog.example/pdf": res({ bodySkipped: true }),
      "https://internal.example/robots.txt": res({ status: 404 }),
      "https://internal.example/x": res({ ok: false, status: 0, error: "SSRF: resolves to a private address" }),
    };
    const calls: string[] = [];
    const v = createVerifier(async (url) => { calls.push(url); return pages[url] ?? res({ ok: false, status: 0, error: "network" }); });
    const check = (sourceUrl: string) => v.check({ sourceUrl, targetUrl: null, targetDomain: "me.example" });
    expect((await check("https://blog.example/has")).outcome).toBe("link_found");
    expect((await check("https://blog.example/hasnot")).outcome).toBe("link_missing");
    expect((await check("https://blog.example/gone"))).toMatchObject({ outcome: "page_unreachable", httpStatus: 404 });
    expect((await check("https://blog.example/pdf")).outcome).toBe("not_html");
    expect((await check("https://blog.example/private/a")).outcome).toBe("blocked_by_robots");
    expect((await check("https://internal.example/x")).outcome).toBe("unsafe_url");
    expect(calls.filter((c) => c.endsWith("robots.txt"))).toEqual(["https://blog.example/robots.txt", "https://internal.example/robots.txt"]); // cached per origin
    expect(calls).not.toContain("https://blog.example/private/a");
  });
});
