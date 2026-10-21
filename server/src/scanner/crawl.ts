import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchResult } from "./fetch.js";
import { parseRobotsTxt, robotsAllows, type RobotsFetchOutcome } from "./robots.js";
import { parseSitemapXml } from "./sitemap.js";
import type { ModuleResult, NewFinding, Severity } from "../types.js";

/**
 * Multi-page technical crawl of ONE verified site.
 *
 * Everything is measured by our own fetcher (MEASURED provenance); nothing is
 * estimated. Scope: the start URL's host and its www/apex twin, http(s) only,
 * robots.txt honoured for our token, every request through the SSRF-safe
 * pinned fetcher. Budgets: page count, wall-clock time, sitemap size.
 *
 * Pages we did not reach (budget) are not reported as broken or fixed:
 * analysis only judges what was actually fetched.
 */

export type Fetcher = (url: string) => Promise<SafeFetchResult>;

export interface CrawlOptions {
  maxPages: number;
  maxDurationMs: number;
  concurrency?: number;
  maxSitemapUrls?: number;
  maxSitemapFiles?: number;
  fetch?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawlPage {
  url: string;
  finalUrl: string;
  /** Status of the first response for `url` (3xx when it redirected). */
  status: number;
  /** Status of the final response after redirects (0 = network/read error). */
  finalStatus: number;
  redirectChain: Array<{ url: string; status: number }>;
  depth: number;
  discoveredFrom: string | null;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonicals: string[];
  robotsMeta: string | null;
  h1Count: number | null;
  internalLinks: string[];
  indexable: boolean;
  inSitemap: boolean;
  fetchError: string | null;
  responseMs: number;
}

export interface CrawlSummary {
  startUrl: string;
  origin: string;
  pagesCrawled: number;
  pagesDiscovered: number;
  truncated: boolean;
  truncatedReason: "page_limit" | "time_limit" | null;
  robotsStatus: "parsed" | "missing" | "unreachable";
  startBlockedByRobots: boolean;
  sitemapStatus: "found" | "missing" | "invalid" | "unsupported";
  sitemapFiles: Array<{ url: string; status: number; kind: string }>;
  sitemapUrlCount: number;
  durationMs: number;
  maxPages: number;
  /**
   * True only when the crawl actually re-checked the site: robots.txt was
   * readable or absent, the start URL was allowed and answered 2xx. When
   * false, the issue lifecycle must not mark page-level issues as FIXED.
   */
  reconcilable: boolean;
}

export interface CrawlResult {
  pages: CrawlPage[];
  summary: CrawlSummary;
  /** Incoming internal links per normalized target URL: total count + a bounded sample of source pages. */
  inlinks: Record<string, { count: number; sample: string[] }>;
}

export interface CrawlIssue {
  ruleId: string;
  severity: Severity;
  url: string;
  /** Extra discriminator for issues that are not per-URL (e.g. a duplicate title). */
  key?: string;
  title: string;
  details: Record<string, unknown>;
}

const MAX_LINKS_PER_PAGE = 1_000;
const INLINK_SAMPLE = 20;
const DISCOVERY_FACTOR = 20; // discovered URLs kept per page of budget

const SKIP_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|mp[34]|m4[av]|mov|avi|webm|ogg|wav|flac|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|txt|csv|xlsx?|docx?|pptx?|exe|dmg|apk)$/i;

const bareHost = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Normalize an href against a base: http(s) only, no fragment, lowercase host, no default port. */
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  return u.href;
}

export function isSameSite(siteHost: string, url: string): boolean {
  try {
    return bareHost(new URL(url).hostname) === bareHost(siteHost);
  } catch {
    return false;
  }
}

function isHtml(contentType: string | undefined | null): boolean {
  return !contentType || contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function parsePage(html: string, pageUrl: string, siteHost: string) {
  const $ = cheerio.load(html);
  const base = $("base[href]").attr("href");
  const resolveBase = base ? normalizeUrl(base, pageUrl) ?? pageUrl : pageUrl;
  const robotsMeta = $('meta[name="robots" i], meta[name="zigmaneural-scanner" i]')
    .toArray()
    .map((el) => ($(el).attr("content") ?? "").toLowerCase())
    .join(",") || null;
  const canonicals = $('link[rel~="canonical" i]')
    .toArray()
    .map((el) => ($(el).attr("href") ?? "").trim());
  const links = new Set<string>();
  const nofollowPage = !!robotsMeta && /\bnofollow\b|\bnone\b/.test(robotsMeta);
  if (!nofollowPage) {
    for (const el of $("a[href]").toArray()) {
      const rel = ($(el).attr("rel") ?? "").toLowerCase();
      if (/\bnofollow\b/.test(rel)) continue;
      const abs = normalizeUrl($(el).attr("href") ?? "", resolveBase);
      if (abs && isSameSite(siteHost, abs)) links.add(abs);
      if (links.size >= MAX_LINKS_PER_PAGE) break;
    }
  }
  const title = $("head > title").first().text().trim() || $("title").first().text().trim() || null;
  const metaDescription = ($('meta[name="description" i]').attr("content") ?? "").trim() || null;
  return { robotsMeta, canonicals, links: [...links], title, metaDescription, h1Count: $("h1").length };
}

const isNoindex = (robotsMeta: string | null, xRobots: string | undefined) =>
  /\bnoindex\b|\bnone\b/.test(robotsMeta ?? "") || /\bnoindex\b|\bnone\b/i.test(xRobots ?? "");

async function fetchRobots(origin: string, fetch: Fetcher): Promise<RobotsFetchOutcome> {
  const res = await fetch(`${origin}/robots.txt`);
  // An oversized file is still parsed: RFC 9309 requires only the first 500 KiB.
  if (res.status >= 200 && res.status < 300 && (res.ok || res.limited)) return { kind: "parsed", policy: parseRobotsTxt(res.body) };
  if (res.status >= 400 && res.status < 500) return { kind: "missing" };
  return { kind: "unreachable" };
}

async function collectSitemapUrls(
  candidates: string[],
  siteHost: string,
  fetch: Fetcher,
  maxUrls: number,
  maxFiles: number,
  hasTime: () => boolean = () => true,
): Promise<{ urls: string[]; files: CrawlSummary["sitemapFiles"]; status: CrawlSummary["sitemapStatus"] }> {
  const urls = new Set<string>();
  const files: CrawlSummary["sitemapFiles"] = [];
  const queue = [...new Set(candidates)];
  const seen = new Set<string>();
  let anyValid = false;
  let anyUnsupported = false;
  while (queue.length > 0 && files.length < maxFiles && urls.size < maxUrls && hasTime()) {
    const target = queue.shift()!;
    if (seen.has(target) || !isSameSite(siteHost, target)) continue;
    seen.add(target);
    if (/\.gz$/i.test(new URL(target).pathname)) {
      files.push({ url: target, status: 0, kind: "unsupported_gzip" });
      anyUnsupported = true;
      continue;
    }
    const res = await fetch(target);
    if (!res.ok) {
      files.push({ url: target, status: res.status, kind: "unavailable" });
      continue;
    }
    const parsed = parseSitemapXml(res.body);
    files.push({ url: target, status: res.status, kind: parsed.kind });
    if (parsed.kind === "invalid") continue;
    anyValid = true;
    for (const s of parsed.sitemaps) {
      const n = normalizeUrl(s);
      if (n) queue.push(n);
    }
    for (const u of parsed.urls) {
      const n = normalizeUrl(u);
      if (n && isSameSite(siteHost, n)) urls.add(n);
      if (urls.size >= maxUrls) break;
    }
  }
  const fetched = files.filter((f) => f.kind !== "unavailable");
  const status: CrawlSummary["sitemapStatus"] = anyValid
    ? "found"
    : fetched.some((f) => f.kind === "invalid")
      ? "invalid"
      : anyUnsupported
        ? "unsupported"
        : "missing";
  return { urls: [...urls], files, status };
}

export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const fetch = options.fetch ?? ((url: string) => safeFetch(url));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = started + options.maxDurationMs;
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error("Invalid start URL");
  const siteHost = new URL(start).hostname;
  const origin = new URL(start).origin;

  const robots = await fetchRobots(origin, fetch);
  const timeLeft = () => deadline - now();
  const robotsSitemaps = robots.kind === "parsed" ? robots.policy.sitemaps.map((s) => normalizeUrl(s)).filter((s): s is string => !!s) : [];
  // Sitemap discovery gets at most a third of the budget's file allowance
  // when time is short; it never starts after the deadline.
  const sitemap = timeLeft() > 0
    ? await collectSitemapUrls(
        robotsSitemaps.length > 0 ? robotsSitemaps : [`${origin}/sitemap.xml`],
        siteHost,
        fetch,
        options.maxSitemapUrls ?? 5_000,
        options.maxSitemapFiles ?? 10,
        () => timeLeft() > 0,
      )
    : { urls: [] as string[], files: [] as CrawlSummary["sitemapFiles"], status: "missing" as const };
  const sitemapSet = new Set(sitemap.urls);
  const crawlDelayMs = robots.kind === "parsed" && robots.policy.crawlDelay ? Math.min(robots.policy.crawlDelay, 5) * 1_000 : 0;
  const concurrency = crawlDelayMs > 0 ? 1 : Math.max(1, Math.min(options.concurrency ?? 3, 5));

  const pages = new Map<string, CrawlPage>();
  const inlinks: Record<string, { count: number; sample: string[] }> = {};
  const maxDiscovered = Math.max(options.maxPages * DISCOVERY_FACTOR, 1_000);
  let discoveryCapped = false;
  const discovered = new Set<string>([start]);
  const linkQueue: Array<{ url: string; depth: number; from: string | null }> = [{ url: start, depth: 0, from: null }];
  const sitemapQueue = sitemap.urls.map((url) => ({ url, depth: 1, from: "sitemap" as string | null }));
  for (const s of sitemap.urls) discovered.add(s);
  let truncatedReason: CrawlSummary["truncatedReason"] = null;
  const startBlocked = !robotsAllows(robots, start);

  const next = () => linkQueue.shift() ?? sitemapQueue.shift();
  // URLs handed to a fetch (in flight or done), so concurrent workers never
  // fetch the same URL twice.
  const scheduled = new Set<string>();

  const visit = async (item: { url: string; depth: number; from: string | null }) => {
    if (pages.has(item.url)) return;
    const t0 = now();
    const res = await fetch(item.url);
    const chain = res.redirectChain ?? [];
    const finalUrl = normalizeUrl(res.finalUrl) ?? res.finalUrl;
    const html = res.ok && isHtml(res.contentType) && isSameSite(siteHost, finalUrl);
    const parsed = html ? parsePage(res.body, finalUrl, siteHost) : null;
    const xRobots = res.headers?.["x-robots-tag"];
    const canonicalTargets = (parsed?.canonicals ?? []).map((c) => normalizeUrl(c, finalUrl));
    const selfCanonical = canonicalTargets.length === 0 || canonicalTargets.every((c) => c === finalUrl);
    const base: Omit<CrawlPage, "url" | "status" | "redirectChain" | "discoveredFrom" | "depth"> = {
      finalUrl,
      finalStatus: res.status,
      contentType: res.contentType ?? null,
      title: parsed?.title ?? null,
      metaDescription: parsed?.metaDescription ?? null,
      canonicals: parsed?.canonicals ?? [],
      robotsMeta: parsed?.robotsMeta ?? (xRobots ? `x-robots-tag:${xRobots.toLowerCase()}` : null),
      h1Count: parsed ? parsed.h1Count : null,
      internalLinks: parsed?.links ?? [],
      indexable: !!parsed && res.status === 200 && !isNoindex(parsed.robotsMeta, xRobots) && selfCanonical,
      inSitemap: sitemapSet.has(item.url),
      fetchError: res.status === 0 || !res.ok && res.error ? res.error ?? null : null,
      responseMs: Math.max(0, now() - t0),
    };
    const redirected = chain.length > 0
    pages.set(item.url, {
      ...base,
      // A redirecting URL has no content of its own: the body belongs to the
      // landing page, which is recorded separately below.
      ...(redirected
        ? { title: null, metaDescription: null, canonicals: [], h1Count: null, internalLinks: [], indexable: false }
        : {}),
      url: item.url,
      status: chain[0]?.status ?? res.status,
      redirectChain: chain,
      depth: item.depth,
      discoveredFrom: item.from,
    });
    // A redirect landed on an internal page we have not recorded: record the
    // landing page from the same response instead of fetching it again.
    let landingRecorded = false;
    if (redirected && finalUrl !== item.url && isSameSite(siteHost, finalUrl) && !pages.has(finalUrl)) {
      landingRecorded = true;
      discovered.add(finalUrl);
      pages.set(finalUrl, { ...base, url: finalUrl, status: res.status, redirectChain: [], depth: item.depth, discoveredFrom: item.url, inSitemap: sitemapSet.has(finalUrl) });
    }
    // Links are attributed once, to the page whose content they came from.
    for (const link of !redirected || landingRecorded ? base.internalLinks : []) {
      if (!discovered.has(link)) {
        if (discovered.size >= maxDiscovered) {
          discoveryCapped = true;
          continue;
        }
        discovered.add(link);
        if (!SKIP_EXTENSIONS.test(new URL(link).pathname)) linkQueue.push({ url: link, depth: item.depth + 1, from: finalUrl });
      }
      const entry = (inlinks[link] ??= { count: 0, sample: [] });
      entry.count++;
      if (entry.sample.length < INLINK_SAMPLE) entry.sample.push(finalUrl);
    }
  };

  if (!startBlocked) {
    const inFlight = new Set<Promise<void>>();
    while (true) {
      if (pages.size >= options.maxPages) {
        if (linkQueue.length > 0 || sitemapQueue.length > 0) truncatedReason = "page_limit";
        break;
      }
      if (now() >= deadline) {
        if (linkQueue.length > 0 || sitemapQueue.length > 0 || inFlight.size > 0) truncatedReason = "time_limit";
        break;
      }
      const item = inFlight.size < concurrency ? next() : undefined;
      if (item) {
        if (pages.has(item.url) || scheduled.has(item.url) || !robotsAllows(robots, item.url)) continue;
        scheduled.add(item.url);
        const p: Promise<void> = visit(item).finally(() => inFlight.delete(p));
        inFlight.add(p);
        if (crawlDelayMs > 0) {
          await p;
          await sleep(crawlDelayMs);
        }
        continue;
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
    await Promise.allSettled(inFlight);
  }

  if (discoveryCapped && !truncatedReason) truncatedReason = "page_limit";
  const startPage = pages.get(start);
  const reconcilable =
    robots.kind !== "unreachable" && !startBlocked && !!startPage && startPage.finalStatus >= 200 && startPage.finalStatus < 300;
  return {
    pages: [...pages.values()],
    inlinks,
    summary: {
      startUrl: start,
      origin,
      pagesCrawled: pages.size,
      pagesDiscovered: discovered.size,
      truncated: truncatedReason !== null,
      truncatedReason,
      robotsStatus: robots.kind,
      startBlockedByRobots: startBlocked,
      sitemapStatus: sitemap.status,
      sitemapFiles: sitemap.files,
      sitemapUrlCount: sitemap.urls.length,
      durationMs: now() - started,
      maxPages: options.maxPages,
      reconcilable,
    },
  };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export function issueFingerprint(issue: Pick<CrawlIssue, "ruleId" | "url" | "key">): string {
  return createHash("sha256").update(`${issue.ruleId}|${issue.url}|${issue.key ?? ""}`).digest("hex");
}

const isBroken = (p: CrawlPage) => p.finalStatus === 0 || p.finalStatus >= 400;
const sample = <T>(xs: T[], n = 20) => xs.slice(0, n);

/** Pure: derive issues from what the crawl actually observed. */
export function analyzeCrawl(result: CrawlResult): CrawlIssue[] {
  const { pages, summary, inlinks } = result;
  const issues: CrawlIssue[] = [];
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const robotsUrl = `${summary.origin}/robots.txt`;

  if (summary.robotsStatus === "unreachable") {
    issues.push({ ruleId: "robots_txt_unreachable", severity: "high", url: robotsUrl, title: "robots.txt is unreachable", details: { note: "A server error or network failure on robots.txt makes crawlers treat the whole site as disallowed." } });
  } else if (summary.robotsStatus === "missing") {
    issues.push({ ruleId: "robots_txt_missing", severity: "low", url: robotsUrl, title: "robots.txt not found", details: {} });
  }
  if (summary.startBlockedByRobots) {
    issues.push({ ruleId: "start_url_blocked_by_robots", severity: "high", url: summary.startUrl, title: "Start URL is disallowed by robots.txt", details: {} });
  }
  if (summary.sitemapStatus === "missing") {
    issues.push({ ruleId: "sitemap_missing", severity: "low", url: `${summary.origin}/sitemap.xml`, title: "No XML sitemap found", details: { checked: summary.sitemapFiles.map((f) => f.url) } });
  }
  for (const f of summary.sitemapFiles) {
    if (f.kind === "invalid") issues.push({ ruleId: "sitemap_invalid", severity: "medium", url: f.url, title: "Sitemap is not valid sitemap XML", details: { status: f.status } });
    if (f.kind === "unavailable") issues.push({ ruleId: "sitemap_unavailable", severity: "medium", url: f.url, title: "Declared sitemap could not be fetched", details: { status: f.status } });
  }

  for (const p of pages) {
    if (p.finalStatus === 0) {
      issues.push({ ruleId: "page_fetch_error", severity: "high", url: p.url, title: "Page could not be fetched", details: { error: p.fetchError } });
    } else if (p.finalStatus >= 500) {
      issues.push({ ruleId: "page_5xx", severity: "critical", url: p.url, title: `Server error (${p.finalStatus})`, details: { status: p.finalStatus } });
    } else if (p.finalStatus >= 400) {
      issues.push({ ruleId: "page_4xx", severity: "high", url: p.url, title: `Client error (${p.finalStatus})`, details: { status: p.finalStatus } });
    }

    const hops = p.redirectChain.length;
    const chainUrls = p.redirectChain.map((h) => h.url);
    const looped = new Set(chainUrls).size !== chainUrls.length || /too many redirects/i.test(p.fetchError ?? "");
    if (looped) {
      issues.push({ ruleId: "redirect_loop", severity: "high", url: p.url, title: "Redirect loop or excessive redirects", details: { chain: p.redirectChain } });
    } else if (hops >= 2) {
      issues.push({ ruleId: "redirect_chain", severity: "medium", url: p.url, title: `Redirect chain of ${hops} hops`, details: { chain: p.redirectChain, finalUrl: p.finalUrl } });
    }

    const incoming = inlinks[p.url];
    if (p.redirectChain.length > 0 && incoming) {
      issues.push({ ruleId: "internal_link_to_redirect", severity: "low", url: p.url, title: "Internal links point at a redirecting URL", details: { finalUrl: p.finalUrl, linkedFrom: incoming.sample, linkCount: incoming.count } });
    }

    if (isBroken(p) && incoming) {
      issues.push({ ruleId: "broken_internal_link", severity: "high", url: p.url, title: `Broken internal link target (${p.finalStatus || "error"})`, details: { status: p.finalStatus, linkedFrom: incoming.sample, linkCount: incoming.count } });
    }

    const htmlOk = p.redirectChain.length === 0 && p.finalStatus === 200 && p.h1Count !== null;
    if (htmlOk) {
      const noindex = /\bnoindex\b|\bnone\b/.test(p.robotsMeta ?? "");
      if (!p.title) issues.push({ ruleId: "title_missing", severity: "high", url: p.url, title: "Missing <title>", details: {} });
      if (p.canonicals.length === 0 && !noindex) {
        issues.push({ ruleId: "canonical_missing", severity: "low", url: p.url, title: "No canonical link", details: {} });
      } else if (p.canonicals.length > 1) {
        issues.push({ ruleId: "canonical_multiple", severity: "medium", url: p.url, title: "Multiple canonical links", details: { canonicals: p.canonicals } });
      } else if (p.canonicals.length === 1) {
        const target = normalizeUrl(p.canonicals[0], p.finalUrl);
        if (!target) {
          issues.push({ ruleId: "canonical_invalid", severity: "medium", url: p.url, title: "Canonical link is not a valid URL", details: { canonical: p.canonicals[0] } });
        } else if (!isSameSite(new URL(summary.startUrl).hostname, target)) {
          issues.push({ ruleId: "canonical_cross_domain", severity: "low", url: p.url, title: "Canonical points to another domain", details: { canonical: target } });
        } else if (target !== p.url) {
          const t = byUrl.get(target);
          if (t && (t.redirectChain.length > 0 || t.finalStatus !== 200)) {
            issues.push({ ruleId: "canonical_target_not_ok", severity: "high", url: p.url, title: "Canonical target redirects or errors", details: { canonical: target, targetStatus: t.status, targetFinalStatus: t.finalStatus } });
          }
        }
      }
    }

    if (p.inSitemap && (p.redirectChain.length > 0 || p.finalStatus !== 200 || (p.h1Count !== null && !p.indexable))) {
      issues.push({ ruleId: "sitemap_url_not_indexable", severity: "medium", url: p.url, title: "Sitemap lists a URL that is not an indexable 200 page", details: { status: p.status, finalStatus: p.finalStatus, finalUrl: p.finalUrl } });
    }
  }

  // Duplicates across indexable pages only (a canonicalised or noindex page is
  // not a duplicate problem).
  const dupes = (field: "title" | "metaDescription", ruleId: string, severity: Severity, label: string) => {
    const groups = new Map<string, string[]>();
    for (const p of pages) {
      const v = p[field]?.replace(/\s+/g, " ").trim().toLowerCase();
      if (!p.indexable || !v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const [value, urls] of groups) {
      if (urls.length < 2) continue;
      const sorted = [...urls].sort();
      issues.push({
        ruleId,
        severity,
        url: sorted[0],
        key: createHash("sha256").update(value).digest("hex").slice(0, 32),
        title: `${label} shared by ${urls.length} pages`,
        details: { value, pages: sample(sorted, 50), pageCount: urls.length },
      });
    }
  };
  dupes("title", "title_duplicate", "medium", "Duplicate title");
  dupes("metaDescription", "meta_description_duplicate", "low", "Duplicate meta description");

  return issues;
}

const RULE_LABELS: Record<string, { title: string; recommendation: string }> = {
  robots_txt_unreachable: { title: "robots.txt is unreachable", recommendation: "Serve robots.txt with a 200 (or 404 if you have no rules). Server errors make crawlers stop crawling the site." },
  robots_txt_missing: { title: "robots.txt not found", recommendation: "Add a robots.txt, at least to declare your sitemap location." },
  start_url_blocked_by_robots: { title: "Start URL blocked by robots.txt", recommendation: "Allow the page in robots.txt if it should be crawled." },
  sitemap_missing: { title: "No XML sitemap found", recommendation: "Publish an XML sitemap and reference it from robots.txt with a Sitemap: line." },
  sitemap_invalid: { title: "Invalid sitemap", recommendation: "Serve valid sitemaps.org XML (urlset or sitemapindex)." },
  sitemap_unavailable: { title: "Declared sitemap unavailable", recommendation: "Fix or remove Sitemap: entries that do not return 200." },
  page_fetch_error: { title: "Pages could not be fetched", recommendation: "Check server availability, timeouts and response size for these URLs." },
  page_5xx: { title: "Pages return server errors", recommendation: "Fix the server errors; crawlers drop pages that keep failing." },
  page_4xx: { title: "Pages return client errors", recommendation: "Restore the pages, redirect them to a relevant URL, or remove links to them." },
  redirect_loop: { title: "Redirect loops", recommendation: "Break the loop so each URL resolves to one final page." },
  redirect_chain: { title: "Redirect chains", recommendation: "Redirect straight to the final URL in one hop." },
  internal_link_to_redirect: { title: "Internal links to redirects", recommendation: "Update internal links to point at the final URL." },
  broken_internal_link: { title: "Broken internal links", recommendation: "Fix or remove internal links whose targets return errors." },
  title_missing: { title: "Pages without a title", recommendation: "Give every indexable page a unique, descriptive <title>." },
  canonical_missing: { title: "Pages without a canonical link", recommendation: "Add a self-referencing rel=canonical to indexable pages." },
  canonical_multiple: { title: "Pages with multiple canonicals", recommendation: "Declare exactly one canonical URL per page." },
  canonical_invalid: { title: "Invalid canonical URLs", recommendation: "Use an absolute, valid URL in rel=canonical." },
  canonical_cross_domain: { title: "Cross-domain canonicals", recommendation: "Confirm the cross-domain canonical is intentional." },
  canonical_target_not_ok: { title: "Canonicals pointing at redirects or errors", recommendation: "Point canonicals at the final, 200-status URL." },
  sitemap_url_not_indexable: { title: "Non-indexable URLs in the sitemap", recommendation: "List only canonical, indexable 200 pages in sitemaps." },
  title_duplicate: { title: "Duplicate titles", recommendation: "Write a unique title for each indexable page." },
  meta_description_duplicate: { title: "Duplicate meta descriptions", recommendation: "Write a unique meta description for each indexable page." },
};

/** One aggregated finding per rule for the scan report and category score. */
export function crawlFindings(issues: CrawlIssue[]): NewFinding[] {
  const byRule = new Map<string, CrawlIssue[]>();
  for (const i of issues) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return [...byRule.entries()].map(([ruleId, list]) => {
    const label = RULE_LABELS[ruleId] ?? { title: ruleId, recommendation: "" };
    const severity = order.find((s) => list.some((i) => i.severity === s)) ?? "info";
    const urls = [...new Set(list.map((i) => i.url))];
    return {
      category: "technicalHealth",
      severity,
      title: label.title,
      description: `${list.length} occurrence${list.length === 1 ? "" : "s"} found by the site crawl.`,
      recommendation: label.recommendation,
      affectedUrls: urls.slice(0, 10),
      confidence: 100,
      provenance: "MEASURED",
      evidence: list.slice(0, 5).map((i) => ({ type: "crawl_observation", url: i.url, observedValue: i.title, rule: ruleId, tool: "site_crawler" })),
    } satisfies NewFinding;
  });
}

export interface CrawlModuleResult extends ModuleResult {
  crawl?: { result: CrawlResult; issues: CrawlIssue[] };
}

export function makeCrawlRunner(limits: { maxPages: number; maxDurationMs: number }, fetch?: Fetcher) {
  return async (url: string, ctx: { deadlineAt?: number } = {}): Promise<CrawlModuleResult> => {
    const t0 = Date.now();
    // Never outlive the scan: the crawl budget is the smaller of its own
    // limit and the time left before the scan deadline.
    const maxDurationMs = Math.max(0, Math.min(limits.maxDurationMs, (ctx.deadlineAt ?? Number.POSITIVE_INFINITY) - t0));
    if (maxDurationMs < 5_000) {
      return { moduleName: "crawl", status: "failed", durationMs: 0, findings: [], error: "CRAWL_TIME_BUDGET_EXHAUSTED: not enough scan time left to crawl" };
    }
    try {
      const result = await crawlSite(url, { ...limits, maxDurationMs, fetch });
      const issues = analyzeCrawl(result);
      // A crawl that fetched nothing at all (start unreachable) still reports
      // what it observed, but is not a "completed" measurement of the site.
      const start = result.pages.find((p) => p.url === result.summary.startUrl);
      const failed = !result.summary.startBlockedByRobots && (!start || start.finalStatus === 0);
      return {
        moduleName: "crawl",
        status: failed ? "failed" : "completed",
        durationMs: Date.now() - t0,
        findings: crawlFindings(issues),
        error: failed ? start?.fetchError ?? "Start URL could not be fetched" : undefined,
        crawl: { result, issues },
      };
    } catch (err) {
      return { moduleName: "crawl", status: "failed", durationMs: Date.now() - t0, findings: [], error: (err as Error).message };
    }
  };
}
