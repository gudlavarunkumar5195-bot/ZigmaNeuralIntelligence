import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { config } from "../../config.js";
import { collectEvidence } from "../evidence/store.js";
import type { EvidenceRecord } from "../evidence/types.js";
import { safeFetch } from "../../scanner/fetch.js";
import { filterHeaders } from "../safety/prompt-sanitizer.js";

/** Hard cap on pages crawled for AI discovery regardless of SCANNER_MAX_PAGES. */
export const AI_DISCOVERY_MAX_PAGES = 25;
/** Fraction of SCANNER_MAX_SCAN_DURATION_MS the AI crawl may use by default. */
export const AI_DISCOVERY_DURATION_FRACTION = 0.5;

export interface DiscoveryContext {
  scanId: string;
  organizationId: string;
  websiteId: string;
  target: string;
  maxPages?: number;
  /** Overall crawl time budget; defaults to 50% of config.SCANNER_MAX_SCAN_DURATION_MS. */
  maxDurationMs?: number;
  /** Cooperative cancellation: crawl stops (with a warning) once this returns true or the signal aborts. */
  signal?: AbortSignal;
  isAborted?: () => boolean;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

export interface DiscoveryPage {
  url: string;
  finalUrl: string;
  status: number;
  responseSize: number;
  durationMs: number;
  title: string;
  metaDescription: string;
  headings: string[];
  canonical: string | null;
  robots: string | null;
  internalLinks: string[];
  externalLinks: string[];
  images: Array<{ url: string; alt: string | null }>;
  structuredData: unknown[];
  hreflang: Array<{ href: string; lang: string | null }>;
  headers: Record<string, string>;
}

export interface DiscoveryResult {
  pages: DiscoveryPage[];
  evidence: EvidenceRecord[];
  warnings: string[];
}

function key(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runDiscovery(input: DiscoveryContext): Promise<DiscoveryResult> {
  const origin = new URL(input.target).origin;
  const limit = Math.max(1, Math.min(input.maxPages ?? config.SCANNER_MAX_PAGES, config.SCANNER_MAX_PAGES, AI_DISCOVERY_MAX_PAGES));
  const now = input.now ?? Date.now;
  const budgetMs = input.maxDurationMs ?? Math.floor(config.SCANNER_MAX_SCAN_DURATION_MS * AI_DISCOVERY_DURATION_FRACTION);
  const crawlDeadline = now() + Math.max(0, budgetMs);
  const queue = [canonicalUrl(input.target)];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const pages: DiscoveryPage[] = [];
  const evidence: EvidenceRecord[] = [];
  const warnings: string[] = [];

  let stoppedEarly = false;
  while (queue.length && pages.length < limit) {
    if (input.signal?.aborted || input.isAborted?.()) {
      warnings.push("Discovery stopped: scan aborted");
      stoppedEarly = true;
      break;
    }
    if (now() >= crawlDeadline) {
      warnings.push(`Discovery time budget exhausted (${budgetMs}ms); crawl stopped with ${pages.length} page(s)`);
      stoppedEarly = true;
      break;
    }
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const result = await safeFetch(url);
    if (result.limited) {
      warnings.push(`${url}: response exceeded scanner limit and was not parsed`);
      continue;
    }
    if (!result.ok && result.status === 0) {
      warnings.push(`${url}: ${result.error ?? "request failed"}`);
      continue;
    }
    if (new URL(result.finalUrl).origin !== origin) {
      warnings.push(`${url}: redirect left the authorized origin`);
      continue;
    }

    if (result.contentType && !["text/html", "application/xhtml+xml"].includes(result.contentType)) {
      warnings.push(`${url}: skipped non-HTML content type ${result.contentType}`);
      continue;
    }

    const page = parsePage(result.finalUrl, result.status, result.body, result.headers, result.durationMs, origin);
    pages.push(page);
    const content = { ...page, bodyAvailable: result.body.length > 0 };
    evidence.push(await collectEvidence({
      tenantId: input.organizationId,
      taskId: input.scanId,
      evidenceType: "HTML_DOCUMENT",
      sourceType: "CRAWLER",
      sourceReference: "discovery",
      resourceReference: page.finalUrl,
      observedAt: new Date().toISOString(),
      content,
      logicalKey: key({ websiteId: input.websiteId, url: page.finalUrl, content }),
      agentId: "DISCOVERY",
      agentVersion: "1",
      metadata: { websiteId: input.websiteId, scanId: input.scanId, extractor: "discovery" },
    }));

    for (const href of page.internalLinks) {
      if (!queued.has(href) && !visited.has(href) && queue.length + pages.length < limit) {
        queued.add(href);
        queue.push(href);
      }
    }
  }

  if (queue.length && !stoppedEarly) warnings.push(`Discovery page limit reached (${limit})`);
  return { pages, evidence, warnings };
}

function canonicalUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = "";
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

function parsePage(url: string, status: number, body: string, headers: Record<string, string>, durationMs: number, origin: string): DiscoveryPage {
  const $ = cheerio.load(body);
  const absolute = (value: string): string | null => {
    try { return canonicalUrl(new URL(value, url).href); } catch { return null; }
  };
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  $("a[href]").each((_, element) => {
    const href = absolute($(element).attr("href") ?? "");
    if (!href) return;
    (new URL(href).origin === origin ? internalLinks : externalLinks).push(href);
  });
  const structuredData = $("script[type='application/ld+json']").toArray().flatMap((element) => {
    try { return [JSON.parse($(element).text())]; } catch { return []; }
  });
  const images = $("img[src]").toArray().flatMap((element) => {
    const imageUrl = absolute($(element).attr("src") ?? "");
    return imageUrl ? [{ url: imageUrl, alt: $(element).attr("alt") ?? null }] : [];
  });
  const hreflang = $("link[rel='alternate'][hreflang][href]").toArray().flatMap((element) => {
    const href = absolute($(element).attr("href") ?? "");
    return href ? [{ href, lang: $(element).attr("hreflang") ?? null }] : [];
  });
  return {
    url,
    finalUrl: url,
    status,
    responseSize: Buffer.byteLength(body),
    durationMs,
    title: $("title").first().text().trim(),
    metaDescription: $("meta[name='description']").attr("content")?.trim() ?? "",
    headings: $("h1, h2, h3").toArray().map((element) => $(element).text().trim()).filter(Boolean),
    canonical: $("link[rel='canonical']").attr("href") ?? null,
    robots: $("meta[name='robots']").attr("content") ?? null,
    internalLinks: [...new Set(internalLinks)],
    externalLinks: [...new Set(externalLinks)],
    images,
    structuredData,
    hreflang,
    // Never retain credentials/session material (Set-Cookie, Authorization, ...) in stored evidence.
    headers: filterHeaders(headers) as Record<string, string>,
  };
}