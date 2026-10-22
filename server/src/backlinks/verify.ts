import * as cheerio from "cheerio";
import { fetchRobots, type Fetcher } from "../scanner/crawl.js";
import { safeFetch } from "../scanner/fetch.js";
import { robotsAllows, type RobotsFetchOutcome } from "../scanner/robots.js";
import { domainOf, normalizeLinkUrl, type LinkType } from "./core.js";

/**
 * Live backlink verification: fetch the source page and look for a link to
 * the target. All network access goes through safeFetch (SSRF checks on the
 * URL and every redirect, the connection pinned to the validated address
 * against DNS rebinding, bounded redirects, timeouts and size caps), and
 * robots.txt of the source site is honoured. Only "link_found" on a
 * successfully fetched HTML page proves a link exists right now.
 */

export type CheckOutcome = "link_found" | "link_missing" | "page_unreachable" | "blocked_by_robots" | "not_html" | "unsafe_url" | "error";

export interface CheckResult {
  outcome: CheckOutcome;
  httpStatus: number | null;
  linkType: LinkType | null;
  anchor: string | null;
}

const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

function relType(rel: string | undefined): LinkType {
  const r = (rel ?? "").toLowerCase();
  if (/\bsponsored\b/.test(r)) return "sponsored";
  if (/\bugc\b/.test(r)) return "ugc";
  if (/\bnofollow\b/.test(r)) return "nofollow";
  return "follow";
}

const sameTarget = (a: string, b: string) => a === b || a.replace(/\/$/, "") === b.replace(/\/$/, "");

/** Finds a link to the target URL (or, without one, to any page of the target domain) in an HTML page. */
export function findLink(html: string, pageUrl: string, target: { url: string | null; domain: string }): { linkType: LinkType; anchor: string | null } | null {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").first().attr("href");
  let base = pageUrl;
  try {
    if (baseHref) base = new URL(baseHref, pageUrl).toString();
  } catch {
    /* ignore an invalid <base> */
  }
  for (const el of $("a[href]").toArray()) {
    let href: string | null = null;
    try {
      href = normalizeLinkUrl(new URL($(el).attr("href")!, base).toString());
    } catch {
      continue;
    }
    if (!href) continue;
    const hit = target.url ? sameTarget(href, target.url) : (() => { const d = domainOf(href); return d === target.domain || d.endsWith(`.${target.domain}`); })();
    if (hit) {
      const text = $(el).text().replace(/\s+/g, " ").trim() || $(el).find("img[alt]").attr("alt")?.trim() || null;
      return { linkType: relType($(el).attr("rel")), anchor: text ? text.slice(0, 500) : null };
    }
  }
  return null;
}

export interface Verifier {
  check(link: { sourceUrl: string; targetUrl: string | null; targetDomain: string }): Promise<CheckResult>;
}

/** A verifier with a per-origin robots cache (one per job slice). */
export function createVerifier(fetch: Fetcher = safeFetch): Verifier {
  const robots = new Map<string, Promise<RobotsFetchOutcome>>();
  const scope = { responseTimeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES };
  return {
    async check(link) {
      const origin = new URL(link.sourceUrl).origin;
      if (!robots.has(origin)) robots.set(origin, fetchRobots(origin, fetch, scope).catch(() => ({ kind: "unreachable" as const })));
      if (!robotsAllows(await robots.get(origin)!, link.sourceUrl)) return { outcome: "blocked_by_robots", httpStatus: null, linkType: null, anchor: null };
      let res;
      try {
        res = await fetch(link.sourceUrl, { ...scope, acceptBody: (ct) => !ct || ct === "text/html" || ct === "application/xhtml+xml" });
      } catch {
        return { outcome: "error", httpStatus: null, linkType: null, anchor: null };
      }
      if (res.error && /^SSRF:/.test(res.error)) return { outcome: "unsafe_url", httpStatus: null, linkType: null, anchor: null };
      if (!res.status || res.status >= 400 || res.error) return { outcome: "page_unreachable", httpStatus: res.status || null, linkType: null, anchor: null };
      if (res.bodySkipped) return { outcome: "not_html", httpStatus: res.status, linkType: null, anchor: null };
      if (res.status >= 300) return { outcome: "page_unreachable", httpStatus: res.status, linkType: null, anchor: null };
      const found = findLink(res.body, res.finalUrl || link.sourceUrl, { url: link.targetUrl, domain: link.targetDomain });
      return found ? { outcome: "link_found", httpStatus: res.status, ...found } : { outcome: "link_missing", httpStatus: res.status, linkType: null, anchor: null };
    },
  };
}
