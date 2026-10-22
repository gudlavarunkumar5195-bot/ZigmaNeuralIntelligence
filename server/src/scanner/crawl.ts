import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from "./fetch.js";
import { parseRobotsTxt, robotsAllows, type RobotsFetchOutcome } from "./robots.js";
import { parseSitemapXml } from "./sitemap.js";
import type { ModuleResult, NewFinding, Severity } from "../types.js";

/**
 * Multi-page technical crawl of ONE verified site.
 *
 * Everything is measured by our own fetcher (MEASURED provenance); nothing is
 * estimated, and "indexable" only means "eligible by the signals we measured"
 * (status, robots directives, canonical), never "indexed by a search engine".
 *
 * Scope: the start URL's host and its www/apex twin, http(s) only. Every
 * request goes through the SSRF-safe pinned fetcher, and redirects that leave
 * the site are recorded but NOT followed. robots.txt is honoured for our
 * token; disallowed URLs are recorded as such and never fetched.
 *
 * Budgets: pages, depth, query-string variants per path, discovered URLs,
 * per-request timeout and body size, total wall-clock time, sitemap size.
 * Pages we did not reach are not reported as broken or fixed: analysis only
 * judges what was actually fetched and parsed.
 */

export type Fetcher = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;

export interface CrawlProgress {
  pagesCrawled: number;
  pagesDiscovered: number;
  queued: number;
}

export interface CrawlOptions {
  maxPages: number;
  maxDurationMs: number;
  /** Link depth from the start URL (start = 0). Sitemap-only URLs count as depth 1. */
  maxDepth?: number;
  concurrency?: number;
  /** Per-request body timeout for crawled pages. */
  requestTimeoutMs?: number;
  /** Per-page body size cap (decoded bytes); larger pages are recorded as too large, not audited. */
  maxPageBytes?: number;
  /** Distinct query strings followed per path (faceted navigation, session ids, calendars). */
  maxQueryVariantsPerPath?: number;
  maxSitemapUrls?: number;
  maxSitemapFiles?: number;
  /** Polled before every fetch; true stops the crawl (cancellation, lost lease). */
  shouldStop?: () => boolean;
  /** Called after every fetched page. */
  onProgress?: (progress: CrawlProgress) => void;
  fetch?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What happened to a URL:
 * - ok: HTML fetched completely and parsed;
 * - redirect: the URL redirected (its landing page is recorded separately when internal);
 * - redirect_out_of_scope: it redirected off the site; the target was not requested;
 * - redirect_loop: a loop or too many hops;
 * - http_error: final response 4xx/5xx;
 * - fetch_error: network, TLS, timeout or SSRF refusal (no usable response);
 * - too_large: body exceeded the page size cap, so the page was not audited;
 * - non_html: not an HTML document (not downloaded);
 * - blocked_by_robots: disallowed for our crawler; never requested.
 */
export type CrawlOutcome =
  | "ok"
  | "redirect"
  | "redirect_out_of_scope"
  | "redirect_loop"
  | "http_error"
  | "fetch_error"
  | "too_large"
  | "non_html"
  | "blocked_by_robots";

export interface CrawlPage {
  url: string;
  finalUrl: string;
  /** Status of the first response for `url` (3xx when it redirected; 0 when never requested or no response). */
  status: number;
  /** Status of the final response after redirects (0 = no response). */
  finalStatus: number;
  redirectChain: Array<{ url: string; status: number }>;
  /** Off-site Location that was not followed. */
  redirectTarget: string | null;
  outcome: CrawlOutcome;
  depth: number;
  discoveredFrom: string | null;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonicals: string[];
  /** Content of <meta name="robots"> (and our own token's meta), lowercased. */
  robotsMeta: string | null;
  /** X-Robots-Tag response header, lowercased. */
  xRobotsTag: string | null;
  h1Count: number | null;
  imagesTotal: number | null;
  /** <img> elements with no alt attribute at all (alt="" is a valid decorative image). */
  imagesMissingAlt: number | null;
  imagesMissingAltSample: string[];
  internalLinks: string[];
  /** Eligible for indexing by the measured signals; not a claim that it is indexed. */
  indexable: boolean;
  /** Why the page is not eligible (empty when indexable). */
  indexabilityReasons: string[];
  inSitemap: boolean;
  fetchError: string | null;
  responseMs: number;
}

export type TruncatedReason = "page_limit" | "time_limit" | "depth_limit" | "discovery_limit" | "cancelled";

export interface CrawlSummary {
  startUrl: string;
  origin: string;
  /** Pages requested (everything except robots-blocked URLs). */
  pagesCrawled: number;
  pagesDiscovered: number;
  pagesBlockedByRobots: number;
  truncated: boolean;
  truncatedReason: TruncatedReason | null;
  robotsStatus: "parsed" | "missing" | "unreachable";
  startBlockedByRobots: boolean;
  sitemapStatus: "found" | "missing" | "invalid" | "unsupported";
  sitemapFiles: Array<{ url: string; status: number; kind: string }>;
  sitemapUrlCount: number;
  durationMs: number;
  maxPages: number;
  maxDepth: number;
  /**
   * True only when the crawl actually re-checked the site: robots.txt was
   * readable or absent, the start URL was allowed and answered 2xx, and the
   * crawl was not cancelled. When false, the issue lifecycle must not mark
   * page-level issues as FIXED.
   */
  reconcilable: boolean;
}

export interface CrawlResult {
  pages: CrawlPage[];
  summary: CrawlSummary;
  /** Incoming internal links per normalized target URL: total count + a bounded sample of source pages. */
  inlinks: Record<string, { count: number; sample: string[] }>;
}

export type SeoCategory =
  | "crawlability"
  | "status_codes"
  | "links"
  | "redirects"
  | "content"
  | "canonicalization"
  | "indexability"
  | "sitemaps"
  | "images";

export interface CrawlIssue {
  ruleId: string;
  severity: Severity;
  category: SeoCategory;
  url: string;
  /** Extra discriminator for issues that are not per-URL (e.g. a duplicate title). */
  key?: string;
  title: string;
  details: Record<string, unknown>;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_QUERY_VARIANTS = 10;
const MAX_LINKS_PER_PAGE = 1_000;
const INLINK_SAMPLE = 20;
const DISCOVERY_FACTOR = 20; // discovered URLs kept per page of budget
const IMAGE_SAMPLE = 5;

const SKIP_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|mp[34]|m4[av]|mov|avi|webm|ogg|wav|flac|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|txt|csv|xlsx?|docx?|pptx?|exe|dmg|apk)$/i;
/** Click/campaign identifiers that never change page content. */
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid)$/i;

const bareHost = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * Normalize an href against a base: http(s) only, no fragment, lowercase
 * host, no default port, no userinfo, tracking parameters removed.
 */
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
  if (u.search) {
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    if ([...u.searchParams.keys()].length === 0) u.search = "";
  }
  return u.href;
}

export function isSameSite(siteHost: string, url: string): boolean {
  try {
    return bareHost(new URL(url).hostname) === bareHost(siteHost);
  } catch {
    return false;
  }
}

/**
 * Crawl scope of a start URL: same host or its www/apex twin, http(s), and
 * the same port. A site on default ports may switch between http and https
 * (both default); a site on an explicit port stays on that port. Another
 * port is another origin and is never requested.
 */
export function crawlScope(startUrl: string): (url: string) => boolean {
  const start = new URL(startUrl);
  return (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    return (u.protocol === "http:" || u.protocol === "https:") && bareHost(u.hostname) === bareHost(start.hostname) && u.port === start.port;
  };
}

function isHtml(contentType: string | undefined | null): boolean {
  return !contentType || contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function parsePage(html: string, pageUrl: string, inScope: (url: string) => boolean) {
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
      if (abs && inScope(abs)) links.add(abs);
      if (links.size >= MAX_LINKS_PER_PAGE) break;
    }
  }
  const images = $("img").toArray();
  const missingAlt = images.filter((el) => $(el).attr("alt") === undefined);
  const title = $("head > title").first().text().trim() || $("title").first().text().trim() || null;
  const metaDescription = ($('meta[name="description" i]').attr("content") ?? "").trim() || null;
  return {
    robotsMeta,
    canonicals,
    links: [...links],
    title,
    metaDescription,
    h1Count: $("h1").length,
    imagesTotal: images.length,
    imagesMissingAlt: missingAlt.length,
    imagesMissingAltSample: missingAlt
      .slice(0, IMAGE_SAMPLE)
      .map((el) => normalizeUrl($(el).attr("src") ?? "", resolveBase) ?? ($(el).attr("src") ?? "").slice(0, 300)),
  };
}

const NOINDEX = /\bnoindex\b|\bnone\b/;

export async function fetchRobots(origin: string, fetch: Fetcher, scope: SafeFetchOptions): Promise<RobotsFetchOutcome> {
  const res = await fetch(`${origin}/robots.txt`, scope);
  // An oversized file is still parsed: RFC 9309 requires only the first 500 KiB.
  if (res.status >= 200 && res.status < 300 && (res.ok || res.limited)) return { kind: "parsed", policy: parseRobotsTxt(res.body) };
  if (res.status >= 400 && res.status < 500) return { kind: "missing" };
  return { kind: "unreachable" };
}

async function collectSitemapUrls(
  candidates: string[],
  inScope: (url: string) => boolean,
  fetch: Fetcher,
  scope: SafeFetchOptions,
  maxUrls: number,
  maxFiles: number,
  hasTime: () => boolean = () => true,
  declared: Set<string> = new Set(),
): Promise<{ urls: string[]; files: CrawlSummary["sitemapFiles"]; status: CrawlSummary["sitemapStatus"] }> {
  const urls = new Set<string>();
  const files: CrawlSummary["sitemapFiles"] = [];
  const queue = [...new Set(candidates)];
  const seen = new Set<string>();
  let anyValid = false;
  let anyUnsupported = false;
  while (queue.length > 0 && files.length < maxFiles && urls.size < maxUrls && hasTime()) {
    const target = queue.shift()!;
    if (seen.has(target) || !inScope(target)) continue;
    seen.add(target);
    if (/\.gz$/i.test(new URL(target).pathname)) {
      files.push({ url: target, status: 0, kind: "unsupported_gzip" });
      anyUnsupported = true;
      continue;
    }
    const res = await fetch(target, scope);
    if (!res.ok) {
      // Only a sitemap someone declared (robots.txt, an index) is "unavailable";
      // our own /sitemap.xml probe answering 404 just means there is none.
      files.push({ url: target, status: res.status, kind: declared.has(target) ? "unavailable" : "not_found" });
      continue;
    }
    const parsed = parseSitemapXml(res.body);
    files.push({ url: target, status: res.status, kind: parsed.kind });
    if (parsed.kind === "invalid") continue;
    anyValid = true;
    for (const s of parsed.sitemaps) {
      const n = normalizeUrl(s);
      if (n) {
        declared.add(n);
        queue.push(n);
      }
    }
    for (const u of parsed.urls) {
      const n = normalizeUrl(u);
      if (n && inScope(n)) urls.add(n);
      if (urls.size >= maxUrls) break;
    }
  }
  const fetched = files.filter((f) => f.kind !== "unavailable" && f.kind !== "not_found");
  const status: CrawlSummary["sitemapStatus"] = anyValid
    ? "found"
    : fetched.some((f) => f.kind === "invalid")
      ? "invalid"
      : anyUnsupported
        ? "unsupported"
        : "missing";
  return { urls: [...urls], files, status };
}

function classify(res: SafeFetchResult, html: boolean): CrawlOutcome {
  if (res.redirectBlockedTo) return "redirect_out_of_scope";
  if (res.status === 0 && /too many redirects/i.test(res.error ?? "")) return "redirect_loop";
  if (res.status === 0) return "fetch_error";
  if (res.status >= 400) return "http_error";
  if (res.limited) return "too_large";
  if (!res.ok) return "fetch_error";
  if (!html || res.bodySkipped) return "non_html";
  return "ok";
}

export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const fetch: Fetcher = options.fetch ?? ((url, o) => safeFetch(url, o));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldStop = options.shouldStop ?? (() => false);
  const started = now();
  const deadline = started + options.maxDurationMs;
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxQueryVariants = Math.max(1, options.maxQueryVariantsPerPath ?? DEFAULT_QUERY_VARIANTS);
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error("Invalid start URL");
  const origin = new URL(start).origin;
  // Never request anything off the verified site, even through a redirect.
  const inScope = crawlScope(start);
  const scope: SafeFetchOptions = { followRedirect: inScope, responseTimeoutMs: options.requestTimeoutMs };
  const pageFetchOptions: SafeFetchOptions = { ...scope, maxBytes: options.maxPageBytes, acceptBody: isHtml };

  const robots = await fetchRobots(origin, fetch, scope);
  const timeLeft = () => deadline - now();
  const robotsSitemaps = robots.kind === "parsed" ? robots.policy.sitemaps.map((s) => normalizeUrl(s)).filter((s): s is string => !!s) : [];
  // Sitemap discovery never starts after the deadline.
  const sitemap = timeLeft() > 0 && !shouldStop()
    ? await collectSitemapUrls(
        robotsSitemaps.length > 0 ? robotsSitemaps : [`${origin}/sitemap.xml`],
        inScope,
        fetch,
        scope,
        options.maxSitemapUrls ?? 5_000,
        options.maxSitemapFiles ?? 10,
        () => timeLeft() > 0 && !shouldStop(),
        new Set(robotsSitemaps),
      )
    : { urls: [] as string[], files: [] as CrawlSummary["sitemapFiles"], status: "missing" as const };
  const sitemapSet = new Set(sitemap.urls);
  const crawlDelayMs = robots.kind === "parsed" && robots.policy.crawlDelay ? Math.min(robots.policy.crawlDelay, 5) * 1_000 : 0;
  const concurrency = crawlDelayMs > 0 ? 1 : Math.max(1, Math.min(options.concurrency ?? 3, 5));

  const pages = new Map<string, CrawlPage>();
  let blockedCount = 0;
  const inlinks: Record<string, { count: number; sample: string[] }> = {};
  const maxDiscovered = Math.max(options.maxPages * DISCOVERY_FACTOR, 1_000);
  let discoveryCapped = false;
  let depthCapped = false;
  const queryVariants = new Map<string, Set<string>>();
  /** Bounded query-string variants per path; true when the URL may be followed. */
  const admitVariant = (url: string): boolean => {
    const u = new URL(url);
    if (!u.search) return true;
    const key = `${u.origin}${u.pathname}`;
    const set = queryVariants.get(key) ?? new Set<string>();
    if (set.has(u.search)) return true;
    if (set.size >= maxQueryVariants) return false;
    set.add(u.search);
    queryVariants.set(key, set);
    return true;
  };
  const discovered = new Set<string>([start]);
  const linkQueue: Array<{ url: string; depth: number; from: string | null }> = [{ url: start, depth: 0, from: null }];
  const sitemapQueue: Array<{ url: string; depth: number; from: string | null }> = [];
  for (const url of sitemap.urls) {
    if (discovered.has(url)) continue;
    if (!admitVariant(url)) {
      discoveryCapped = true;
      continue;
    }
    discovered.add(url);
    if (maxDepth >= 1) sitemapQueue.push({ url, depth: 1, from: "sitemap" });
    else depthCapped = true;
  }
  let truncatedReason: CrawlSummary["truncatedReason"] = null;
  const startBlocked = !robotsAllows(robots, start);

  const next = () => linkQueue.shift() ?? sitemapQueue.shift();
  // URLs handed to a fetch (in flight or done), so concurrent workers never
  // fetch the same URL twice.
  const scheduled = new Set<string>();
  const auditedCount = () => pages.size - blockedCount;

  const emptyContent = {
    title: null, metaDescription: null, canonicals: [] as string[], robotsMeta: null, h1Count: null,
    imagesTotal: null, imagesMissingAlt: null, imagesMissingAltSample: [] as string[], internalLinks: [] as string[],
  };

  const recordBlocked = (item: { url: string; depth: number; from: string | null }) => {
    if (pages.has(item.url) || blockedCount >= options.maxPages) return;
    blockedCount++;
    pages.set(item.url, {
      ...emptyContent,
      url: item.url, finalUrl: item.url, status: 0, finalStatus: 0, redirectChain: [], redirectTarget: null,
      outcome: "blocked_by_robots", depth: item.depth, discoveredFrom: item.from, contentType: null, xRobotsTag: null,
      indexable: false, indexabilityReasons: ["blocked_by_robots"], inSitemap: sitemapSet.has(item.url),
      fetchError: null, responseMs: 0,
    });
  };

  const visit = async (item: { url: string; depth: number; from: string | null }) => {
    if (pages.has(item.url)) return;
    const t0 = now();
    const res = await fetch(item.url, pageFetchOptions);
    const chain = res.redirectChain ?? [];
    const finalUrl = normalizeUrl(res.finalUrl) ?? res.finalUrl;
    const htmlType = isHtml(res.contentType);
    const outcome = classify(res, htmlType && inScope(finalUrl));
    const parsed = outcome === "ok" ? parsePage(res.body, finalUrl, inScope) : null;
    const xRobotsTag = res.headers?.["x-robots-tag"]?.toLowerCase() ?? null;
    const canonicalTargets = (parsed?.canonicals ?? []).map((c) => normalizeUrl(c, finalUrl));
    const selfCanonical = canonicalTargets.length === 0 || canonicalTargets.every((c) => c === finalUrl);
    const reasons: string[] = [];
    if (outcome !== "ok") reasons.push(outcome);
    else {
      if (res.status !== 200) reasons.push("status_not_200");
      if (NOINDEX.test(parsed?.robotsMeta ?? "")) reasons.push("noindex_meta");
      if (NOINDEX.test(xRobotsTag ?? "")) reasons.push("noindex_header");
      if (!selfCanonical) reasons.push("canonicalized_elsewhere");
    }
    const landing: Omit<CrawlPage, "url" | "status" | "redirectChain" | "redirectTarget" | "discoveredFrom" | "depth" | "outcome" | "inSitemap"> = {
      finalUrl,
      finalStatus: res.status,
      contentType: res.contentType ?? null,
      title: parsed?.title ?? null,
      metaDescription: parsed?.metaDescription ?? null,
      canonicals: parsed?.canonicals ?? [],
      robotsMeta: parsed?.robotsMeta ?? null,
      xRobotsTag,
      h1Count: parsed ? parsed.h1Count : null,
      imagesTotal: parsed ? parsed.imagesTotal : null,
      imagesMissingAlt: parsed ? parsed.imagesMissingAlt : null,
      imagesMissingAltSample: parsed?.imagesMissingAltSample ?? [],
      internalLinks: parsed?.links ?? [],
      indexable: outcome === "ok" && reasons.length === 0,
      indexabilityReasons: reasons,
      fetchError: outcome === "ok" || outcome === "non_html" || outcome === "redirect" ? null : res.error ?? null,
      responseMs: Math.max(0, now() - t0),
    };
    // A redirect that stayed on the site and completed: the requested URL is a
    // "redirect" with no content of its own; the body belongs to the landing
    // page, which is recorded separately below.
    const followedRedirect = chain.length > 0 && !res.redirectBlockedTo && outcome !== "redirect_loop";
    pages.set(item.url, {
      ...landing,
      ...(followedRedirect || outcome === "redirect_out_of_scope"
        ? { ...emptyContent, xRobotsTag: null, indexable: false, indexabilityReasons: [followedRedirect ? "redirect" : outcome] }
        : {}),
      url: item.url,
      status: chain[0]?.status ?? res.status,
      redirectChain: chain,
      redirectTarget: res.redirectBlockedTo ?? null,
      outcome: followedRedirect ? "redirect" : outcome,
      depth: item.depth,
      discoveredFrom: item.from,
      inSitemap: sitemapSet.has(item.url),
    });
    // A redirect landed on an internal page we have not recorded: record the
    // landing page from the same response instead of fetching it again.
    let landingRecorded = false;
    if (followedRedirect && finalUrl !== item.url && inScope(finalUrl) && !pages.has(finalUrl)) {
      landingRecorded = true;
      discovered.add(finalUrl);
      pages.set(finalUrl, {
        ...landing, url: finalUrl, status: res.status, redirectChain: [], redirectTarget: null, outcome,
        depth: item.depth, discoveredFrom: item.url, inSitemap: sitemapSet.has(finalUrl),
      });
    }
    // Links are attributed once, to the page whose content they came from.
    for (const link of !followedRedirect || landingRecorded ? landing.internalLinks : []) {
      if (!discovered.has(link)) {
        if (discovered.size >= maxDiscovered || !admitVariant(link)) {
          discoveryCapped = true;
          continue;
        }
        if (item.depth + 1 > maxDepth) {
          depthCapped = true;
        } else {
          discovered.add(link);
          if (!SKIP_EXTENSIONS.test(new URL(link).pathname)) linkQueue.push({ url: link, depth: item.depth + 1, from: finalUrl });
        }
      }
      const entry = (inlinks[link] ??= { count: 0, sample: [] });
      entry.count++;
      if (entry.sample.length < INLINK_SAMPLE) entry.sample.push(finalUrl);
    }
    options.onProgress?.({ pagesCrawled: auditedCount(), pagesDiscovered: discovered.size, queued: linkQueue.length + sitemapQueue.length });
  };

  if (startBlocked) {
    recordBlocked({ url: start, depth: 0, from: null });
  } else {
    const inFlight = new Set<Promise<void>>();
    while (true) {
      if (shouldStop()) {
        truncatedReason = "cancelled";
        break;
      }
      // In-flight fetches count toward the page budget, so concurrency can
      // never overshoot it (a redirect's landing page is recorded from the
      // same response and costs no extra request).
      if (auditedCount() + inFlight.size >= options.maxPages) {
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
          continue;
        }
        if (linkQueue.length > 0 || sitemapQueue.length > 0) truncatedReason = "page_limit";
        break;
      }
      if (now() >= deadline) {
        if (linkQueue.length > 0 || sitemapQueue.length > 0 || inFlight.size > 0) truncatedReason = "time_limit";
        break;
      }
      const item = inFlight.size < concurrency ? next() : undefined;
      if (item) {
        if (pages.has(item.url) || scheduled.has(item.url)) continue;
        if (!robotsAllows(robots, item.url)) {
          recordBlocked(item);
          continue;
        }
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

  if (!truncatedReason && discoveryCapped) truncatedReason = "discovery_limit";
  if (!truncatedReason && depthCapped) truncatedReason = "depth_limit";
  const startPage = pages.get(start);
  const reconcilable =
    truncatedReason !== "cancelled" &&
    robots.kind !== "unreachable" &&
    !startBlocked &&
    !!startPage &&
    startPage.finalStatus >= 200 &&
    startPage.finalStatus < 300;
  return {
    pages: [...pages.values()],
    inlinks,
    summary: {
      startUrl: start,
      origin,
      pagesCrawled: auditedCount(),
      pagesDiscovered: discovered.size,
      pagesBlockedByRobots: blockedCount,
      truncated: truncatedReason !== null,
      truncatedReason,
      robotsStatus: robots.kind,
      startBlockedByRobots: startBlocked,
      sitemapStatus: sitemap.status,
      sitemapFiles: sitemap.files,
      sitemapUrlCount: sitemap.urls.length,
      durationMs: now() - started,
      maxPages: options.maxPages,
      maxDepth,
      reconcilable,
    },
  };
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export interface SeoRule {
  category: SeoCategory;
  severity: Severity;
  /** Title of one occurrence (per URL or group). */
  title: string;
  /** Title of the aggregated per-scan finding. */
  groupTitle: string;
  /** What was measured and why it matters. */
  explanation: string;
  remediation: string;
}

/**
 * Every crawl rule: stable id, category, default severity, explanation and
 * remediation. All are MEASURED from our own fetches (source: site_crawler).
 */
export const SEO_RULES: Record<string, SeoRule> = {
  robots_txt_unreachable: { category: "crawlability", severity: "high", title: "robots.txt is unreachable", groupTitle: "robots.txt is unreachable", explanation: "robots.txt answered with a server error or could not be fetched. Under RFC 9309 crawlers then treat the whole site as disallowed, so this crawl did not fetch any page.", remediation: "Serve robots.txt with a 200 (or a 404 if you have no rules). Server errors make crawlers stop crawling the site." },
  robots_txt_missing: { category: "crawlability", severity: "low", title: "robots.txt not found", groupTitle: "robots.txt not found", explanation: "robots.txt returned a 4xx, which crawlers read as \"everything allowed\". Nothing is blocked, but there is also no Sitemap: declaration.", remediation: "Add a robots.txt, at least to declare your sitemap location." },
  start_url_blocked_by_robots: { category: "crawlability", severity: "high", title: "Start URL is disallowed by robots.txt", groupTitle: "Start URL blocked by robots.txt", explanation: "robots.txt disallows the website's start URL for our crawler, so no page was crawled.", remediation: "Allow the page in robots.txt if it should be crawled." },
  sitemap_missing: { category: "sitemaps", severity: "low", title: "No XML sitemap found", groupTitle: "No XML sitemap found", explanation: "Neither a Sitemap: line in robots.txt nor /sitemap.xml returned a sitemap.", remediation: "Publish an XML sitemap and reference it from robots.txt with a Sitemap: line." },
  sitemap_invalid: { category: "sitemaps", severity: "medium", title: "Sitemap is not valid sitemap XML", groupTitle: "Invalid sitemap", explanation: "The sitemap file was fetched but is not a sitemaps.org urlset or sitemapindex document.", remediation: "Serve valid sitemaps.org XML (urlset or sitemapindex)." },
  sitemap_unavailable: { category: "sitemaps", severity: "medium", title: "Declared sitemap could not be fetched", groupTitle: "Declared sitemap unavailable", explanation: "A declared sitemap did not return a 2xx response.", remediation: "Fix or remove Sitemap: entries that do not return 200." },
  sitemap_url_not_indexable: { category: "sitemaps", severity: "medium", title: "Sitemap lists a URL that is not an indexable 200 page", groupTitle: "Non-indexable URLs in the sitemap", explanation: "A URL listed in the sitemap redirected, failed, or carried a noindex or a canonical pointing elsewhere when we fetched it.", remediation: "List only canonical, indexable 200 pages in sitemaps." },
  sitemap_url_blocked_by_robots: { category: "sitemaps", severity: "medium", title: "Sitemap lists a URL disallowed by robots.txt", groupTitle: "Sitemap URLs blocked by robots.txt", explanation: "The sitemap asks crawlers to visit a URL that robots.txt forbids them to fetch.", remediation: "Remove the URL from the sitemap or allow it in robots.txt." },
  page_fetch_error: { category: "status_codes", severity: "high", title: "Page could not be fetched", groupTitle: "Pages could not be fetched", explanation: "No usable response: network or TLS error, timeout, or the request was refused as unsafe.", remediation: "Check server availability, timeouts and response size for these URLs." },
  page_too_large: { category: "status_codes", severity: "medium", title: "Page exceeds the size limit and was not audited", groupTitle: "Pages too large to audit", explanation: "The HTML body was larger than the crawler's per-page limit, so its content was not analysed.", remediation: "Reduce the HTML size (inline data, huge lists) or split the page." },
  page_5xx: { category: "status_codes", severity: "critical", title: "Server error", groupTitle: "Pages return server errors", explanation: "The final response was a 5xx server error.", remediation: "Fix the server errors; crawlers drop pages that keep failing." },
  page_4xx: { category: "status_codes", severity: "high", title: "Client error", groupTitle: "Pages return client errors", explanation: "The final response was a 4xx error.", remediation: "Restore the pages, redirect them to a relevant URL, or remove links to them." },
  broken_internal_link: { category: "links", severity: "high", title: "Broken internal link target", groupTitle: "Broken internal links", explanation: "Internal links point at a URL whose final response is an error.", remediation: "Fix or remove internal links whose targets return errors." },
  internal_link_to_redirect: { category: "links", severity: "low", title: "Internal links point at a redirecting URL", groupTitle: "Internal links to redirects", explanation: "Internal links point at a URL that redirects, which costs a round trip and dilutes link signals.", remediation: "Update internal links to point at the final URL." },
  redirect_loop: { category: "redirects", severity: "high", title: "Redirect loop or excessive redirects", groupTitle: "Redirect loops", explanation: "Following the redirects never reached a page within the hop limit.", remediation: "Break the loop so each URL resolves to one final page." },
  redirect_chain: { category: "redirects", severity: "medium", title: "Redirect chain", groupTitle: "Redirect chains", explanation: "The URL needs two or more redirect hops to reach its final page.", remediation: "Redirect straight to the final URL in one hop." },
  redirect_off_site: { category: "redirects", severity: "low", title: "Internal URL redirects to another site", groupTitle: "Internal URLs redirecting off-site", explanation: "An internal URL redirects to a different domain. The target was not requested (outside the verified site).", remediation: "Confirm the off-site redirect is intended; link to the destination directly." },
  title_missing: { category: "content", severity: "high", title: "Missing <title>", groupTitle: "Pages without a title", explanation: "The page has no <title> element or it is empty.", remediation: "Give every indexable page a unique, descriptive <title>." },
  title_duplicate: { category: "content", severity: "medium", title: "Duplicate title", groupTitle: "Duplicate titles", explanation: "Several indexable pages share the same <title>.", remediation: "Write a unique title for each indexable page." },
  meta_description_missing: { category: "content", severity: "low", title: "Missing meta description", groupTitle: "Pages without a meta description", explanation: "The page has no meta description or it is empty.", remediation: "Add a concise, page-specific meta description." },
  meta_description_duplicate: { category: "content", severity: "low", title: "Duplicate meta description", groupTitle: "Duplicate meta descriptions", explanation: "Several indexable pages share the same meta description.", remediation: "Write a unique meta description for each indexable page." },
  h1_missing: { category: "content", severity: "medium", title: "No <h1> heading", groupTitle: "Pages without an H1", explanation: "The page has no <h1> element.", remediation: "Add one <h1> that states the page's main topic." },
  h1_multiple: { category: "content", severity: "low", title: "Multiple <h1> headings", groupTitle: "Pages with multiple H1s", explanation: "The page has more than one <h1> element.", remediation: "Keep one <h1> per page and use <h2>-<h6> for sections." },
  canonical_missing: { category: "canonicalization", severity: "low", title: "No canonical link", groupTitle: "Pages without a canonical link", explanation: "The indexable page declares no rel=canonical.", remediation: "Add a self-referencing rel=canonical to indexable pages." },
  canonical_multiple: { category: "canonicalization", severity: "medium", title: "Multiple canonical links", groupTitle: "Pages with multiple canonicals", explanation: "The page declares more than one rel=canonical; search engines may ignore all of them.", remediation: "Declare exactly one canonical URL per page." },
  canonical_invalid: { category: "canonicalization", severity: "medium", title: "Canonical link is not a valid URL", groupTitle: "Invalid canonical URLs", explanation: "The rel=canonical href could not be resolved to an http(s) URL.", remediation: "Use an absolute, valid URL in rel=canonical." },
  canonical_cross_domain: { category: "canonicalization", severity: "low", title: "Canonical points to another domain", groupTitle: "Cross-domain canonicals", explanation: "The canonical URL is on a different domain.", remediation: "Confirm the cross-domain canonical is intentional." },
  canonical_target_not_ok: { category: "canonicalization", severity: "high", title: "Canonical target redirects or errors", groupTitle: "Canonicals pointing at redirects or errors", explanation: "The canonical URL itself redirects or returns an error when fetched.", remediation: "Point canonicals at the final, 200-status URL." },
  page_noindex: { category: "indexability", severity: "info", title: "Page excludes itself from indexing (noindex)", groupTitle: "Pages with noindex", explanation: "A robots meta tag or X-Robots-Tag header says noindex. This is a measured directive, reported so unintended noindex can be caught.", remediation: "Remove noindex if the page should appear in search results." },
  page_nofollow: { category: "indexability", severity: "info", title: "Page asks crawlers not to follow its links (nofollow)", groupTitle: "Pages with nofollow", explanation: "A robots meta tag or X-Robots-Tag header says nofollow, so crawlers ignore the page's links.", remediation: "Remove nofollow unless you intend crawlers to ignore every link on the page." },
  img_alt_missing: { category: "images", severity: "low", title: "Images without an alt attribute", groupTitle: "Images missing alt attributes", explanation: "<img> elements have no alt attribute at all (an empty alt=\"\" for decorative images is fine).", remediation: "Add descriptive alt text, or alt=\"\" for purely decorative images." },
};

export function ruleInfo(ruleId: string): SeoRule & { ruleId: string; provenance: "MEASURED"; source: "site_crawler" } {
  const rule = SEO_RULES[ruleId] ?? { category: "crawlability", severity: "info", title: ruleId, groupTitle: ruleId, explanation: "", remediation: "" };
  return { ...rule, ruleId, provenance: "MEASURED", source: "site_crawler" };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/** Stable per-website identity of an issue: rule + normalized URL (+ group key). No volatile fields. */
export function issueFingerprint(issue: Pick<CrawlIssue, "ruleId" | "url" | "key">): string {
  return createHash("sha256").update(`${issue.ruleId}|${issue.url}|${issue.key ?? ""}`).digest("hex");
}

const isBroken = (p: CrawlPage) => p.outcome === "http_error" || p.outcome === "fetch_error" || p.outcome === "redirect_loop";
const sample = <T>(xs: T[], n = 20) => xs.slice(0, n);

/** Pure: derive issues from what the crawl actually observed. */
export function analyzeCrawl(result: CrawlResult): CrawlIssue[] {
  const { pages, summary, inlinks } = result;
  const issues: CrawlIssue[] = [];
  const add = (ruleId: string, url: string, details: Record<string, unknown> = {}, extra: { key?: string; title?: string; severity?: Severity } = {}) => {
    const rule = ruleInfo(ruleId);
    issues.push({ ruleId, category: rule.category, severity: extra.severity ?? rule.severity, url, title: extra.title ?? rule.title, details, ...(extra.key ? { key: extra.key } : {}) });
  };
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const robotsUrl = `${summary.origin}/robots.txt`;

  if (summary.robotsStatus === "unreachable") {
    add("robots_txt_unreachable", robotsUrl, { note: "A server error or network failure on robots.txt makes crawlers treat the whole site as disallowed." });
  } else if (summary.robotsStatus === "missing") {
    add("robots_txt_missing", robotsUrl);
  }
  if (summary.startBlockedByRobots) add("start_url_blocked_by_robots", summary.startUrl);
  // A declared sitemap that fails is reported as unavailable, not also as missing.
  if (summary.sitemapStatus === "missing" && !summary.sitemapFiles.some((f) => f.kind === "unavailable")) add("sitemap_missing", `${summary.origin}/sitemap.xml`, { checked: summary.sitemapFiles.map((f) => f.url) });
  for (const f of summary.sitemapFiles) {
    if (f.kind === "invalid") add("sitemap_invalid", f.url, { status: f.status });
    if (f.kind === "unavailable") add("sitemap_unavailable", f.url, { status: f.status });
  }

  for (const p of pages) {
    if (p.outcome === "blocked_by_robots") {
      if (p.inSitemap) add("sitemap_url_blocked_by_robots", p.url);
      continue;
    }
    if (p.outcome === "fetch_error") add("page_fetch_error", p.url, { error: p.fetchError });
    else if (p.outcome === "too_large") add("page_too_large", p.url, { error: p.fetchError, contentType: p.contentType });
    else if (p.finalStatus >= 500) add("page_5xx", p.url, { status: p.finalStatus, finalUrl: p.finalUrl }, { title: `Server error (${p.finalStatus})` });
    else if (p.finalStatus >= 400) add("page_4xx", p.url, { status: p.finalStatus, finalUrl: p.finalUrl }, { title: `Client error (${p.finalStatus})` });

    const hops = p.redirectChain.length;
    const chainUrls = p.redirectChain.map((h) => h.url);
    const looped = p.outcome === "redirect_loop" || new Set(chainUrls).size !== chainUrls.length;
    if (looped) add("redirect_loop", p.url, { chain: p.redirectChain, error: p.fetchError });
    else if (hops >= 2) add("redirect_chain", p.url, { chain: p.redirectChain, finalUrl: p.finalUrl }, { title: `Redirect chain of ${hops} hops` });
    if (p.outcome === "redirect_out_of_scope") add("redirect_off_site", p.url, { chain: p.redirectChain, target: p.redirectTarget });

    const incoming = inlinks[p.url];
    if (p.redirectChain.length > 0 && !looped && incoming) {
      add("internal_link_to_redirect", p.url, { finalUrl: p.finalUrl, target: p.redirectTarget, linkedFrom: incoming.sample, linkCount: incoming.count });
    }
    if (isBroken(p) && incoming) {
      add("broken_internal_link", p.url, { status: p.finalStatus, error: p.fetchError, linkedFrom: incoming.sample, linkCount: incoming.count }, { title: `Broken internal link target (${p.finalStatus || "error"})` });
    }

    if (p.inSitemap && (p.outcome === "ok" ? !p.indexable : p.outcome !== "non_html")) {
      add("sitemap_url_not_indexable", p.url, { status: p.status, finalStatus: p.finalStatus, finalUrl: p.finalUrl, reasons: p.indexabilityReasons });
    }

    // Content rules only for pages we fetched completely and parsed as HTML.
    if (p.outcome !== "ok" || p.finalStatus !== 200) continue;
    const directives = `${p.robotsMeta ?? ""},${p.xRobotsTag ?? ""}`;
    const noindex = NOINDEX.test(directives);
    if (noindex) add("page_noindex", p.url, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag });
    if (/\bnofollow\b|\bnone\b/.test(directives)) add("page_nofollow", p.url, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag });
    if (!p.title) add("title_missing", p.url);
    if (!p.metaDescription && !noindex) add("meta_description_missing", p.url);
    if (p.h1Count === 0) add("h1_missing", p.url);
    else if ((p.h1Count ?? 0) > 1) add("h1_multiple", p.url, { h1Count: p.h1Count });
    if ((p.imagesMissingAlt ?? 0) > 0) add("img_alt_missing", p.url, { missing: p.imagesMissingAlt, total: p.imagesTotal, sample: p.imagesMissingAltSample });
    if (p.canonicals.length === 0 && !noindex) {
      add("canonical_missing", p.url);
    } else if (p.canonicals.length > 1) {
      add("canonical_multiple", p.url, { canonicals: p.canonicals });
    } else if (p.canonicals.length === 1) {
      const target = normalizeUrl(p.canonicals[0], p.finalUrl);
      if (!target) {
        add("canonical_invalid", p.url, { canonical: p.canonicals[0] });
      } else if (!isSameSite(new URL(summary.startUrl).hostname, target)) {
        add("canonical_cross_domain", p.url, { canonical: target });
      } else if (target !== p.url) {
        const t = byUrl.get(target);
        if (t && t.outcome !== "blocked_by_robots" && (t.redirectChain.length > 0 || t.finalStatus !== 200)) {
          add("canonical_target_not_ok", p.url, { canonical: target, targetStatus: t.status, targetFinalStatus: t.finalStatus, targetOutcome: t.outcome });
        }
      }
    }
  }

  // Duplicates across indexable pages only (a canonicalised or noindex page is
  // not a duplicate problem).
  const dupes = (field: "title" | "metaDescription", ruleId: string, label: string) => {
    const groups = new Map<string, string[]>();
    for (const p of pages) {
      const v = p[field]?.replace(/\s+/g, " ").trim().toLowerCase();
      if (!p.indexable || !v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const [value, urls] of groups) {
      if (urls.length < 2) continue;
      const sorted = [...urls].sort();
      add(ruleId, sorted[0], { value, pages: sample(sorted, 50), pageCount: urls.length }, {
        key: createHash("sha256").update(value).digest("hex").slice(0, 32),
        title: `${label} shared by ${urls.length} pages`,
      });
    }
  };
  dupes("title", "title_duplicate", "Duplicate title");
  dupes("metaDescription", "meta_description_duplicate", "Duplicate meta description");

  return issues;
}

/** One aggregated finding per rule for the scan report and category score. */
export function crawlFindings(issues: CrawlIssue[]): NewFinding[] {
  const byRule = new Map<string, CrawlIssue[]>();
  for (const i of issues) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return [...byRule.entries()].map(([ruleId, list]) => {
    const rule = ruleInfo(ruleId);
    const severity = order.find((s) => list.some((i) => i.severity === s)) ?? "info";
    const urls = [...new Set(list.map((i) => i.url))];
    return {
      category: "technicalHealth",
      severity,
      title: rule.groupTitle,
      description: `${list.length} occurrence${list.length === 1 ? "" : "s"} found by the site crawl. ${rule.explanation}`.trim(),
      recommendation: rule.remediation,
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

export interface CrawlLimits {
  maxPages: number;
  maxDurationMs: number;
  maxDepth?: number;
  concurrency?: number;
  requestTimeoutMs?: number;
  maxPageBytes?: number;
}

export interface CrawlRunContext {
  deadlineAt?: number;
  /** Per-scan options chosen by the user, already validated and capped by the API. */
  crawlOptions?: { maxPages?: number; maxDepth?: number } | null;
  shouldStop?: () => boolean;
  onProgress?: (progress: CrawlProgress) => void;
}

export function makeCrawlRunner(limits: CrawlLimits, fetch?: Fetcher) {
  return async (url: string, ctx: CrawlRunContext = {}): Promise<CrawlModuleResult> => {
    const t0 = Date.now();
    // Never outlive the scan: the crawl budget is the smaller of its own
    // limit and the time left before the scan deadline.
    const maxDurationMs = Math.max(0, Math.min(limits.maxDurationMs, (ctx.deadlineAt ?? Number.POSITIVE_INFINITY) - t0));
    if (maxDurationMs < 5_000) {
      return { moduleName: "crawl", status: "failed", durationMs: 0, findings: [], error: "CRAWL_TIME_BUDGET_EXHAUSTED: not enough scan time left to crawl" };
    }
    // Per-scan choices can only lower the server's limits.
    const maxPages = Math.max(1, Math.min(limits.maxPages, ctx.crawlOptions?.maxPages ?? limits.maxPages));
    const maxDepth = Math.max(0, Math.min(limits.maxDepth ?? DEFAULT_MAX_DEPTH, ctx.crawlOptions?.maxDepth ?? limits.maxDepth ?? DEFAULT_MAX_DEPTH));
    try {
      const result = await crawlSite(url, {
        ...limits,
        maxPages,
        maxDepth,
        maxDurationMs,
        fetch,
        shouldStop: ctx.shouldStop,
        onProgress: ctx.onProgress,
      });
      if (result.summary.truncatedReason === "cancelled") {
        return { moduleName: "crawl", status: "failed", durationMs: Date.now() - t0, findings: [], error: "CRAWL_CANCELLED: the scan was cancelled or lost its lease; partial results were discarded" };
      }
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
