import { config } from "../../config.js";
import { GoogleNetworkError, googleRequest } from "./http.js";

/**
 * Search Console API adapter (webmasters v3): property listing and Search
 * Analytics queries, with bounded retries and per-integration pacing.
 *
 * Error classes callers act on:
 * - auth:        the access token is rejected even after one refresh, or the
 *                refresh token is revoked -> integration needs reauthorization
 * - permission:  the Google account cannot read this property (403/404)
 * - quota:       429 or a quota/rate 403 -> pause, retry later (not a failure)
 * - bad_request: invalid query (dimensions, dates) -> do not retry
 * - transient:   5xx, timeouts, network errors after bounded retries
 */

const API = "https://www.googleapis.com/webmasters/v3";
const QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RESOURCE_EXHAUSTED"]);
/** Google's own advice for the short-term load quota: wait 15 minutes. */
export const QUOTA_BACKOFF_MS = 15 * 60_000;

export type GscErrorKind = "auth" | "permission" | "quota" | "bad_request" | "transient";

export class GscApiError extends Error {
  constructor(readonly kind: GscErrorKind, message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "GscApiError";
  }
}

export interface AccessTokenProvider {
  /** A valid access token; `forceRefresh` after a 401. Throws GscApiError("auth") when reauthorization is needed. */
  get(forceRefresh?: boolean): Promise<string>;
}

/** Minimum spacing between requests per key (one key per integration). */
export class Pacer {
  private next = new Map<string, number>();
  constructor(private perMinute: number, private now: () => number = Date.now, private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}
  async wait(key: string): Promise<void> {
    const interval = 60_000 / this.perMinute;
    const now = this.now();
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + interval);
    if (at > now) await this.sleep(at - now);
  }
}

export const sharedPacer = new Pacer(config.GSC_MAX_REQUESTS_PER_MINUTE ?? 60);

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  type?: "web";
  dataState?: "all" | "final";
  rowLimit?: number;
  startRow?: number;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows: SearchAnalyticsRow[];
  firstIncompleteDate: string | null;
}

function errorReason(body: unknown): { reason: string; status: string; message: string } {
  const e = (body as { error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string } } | null)?.error;
  return { reason: e?.errors?.[0]?.reason ?? "", status: e?.status ?? "", message: (e?.message ?? "").slice(0, 200) };
}

export interface GscClientOptions {
  key: string;
  pacer?: Pacer;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
}

export class GscClient {
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly tokens: AccessTokenProvider, private readonly opts: GscClientOptions) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Bounded exponential backoff with full jitter: ~1s, ~2s, ~4s ... capped at 10s. */
  backoffMs(attempt: number): number {
    return Math.min(10_000, 1_000 * 2 ** (attempt - 1)) * (0.5 + this.random() / 2);
  }

  private async request(url: string, init: { method: string; body?: unknown }): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      await (this.opts.pacer ?? sharedPacer).wait(this.opts.key);
      const token = await this.tokens.get(refreshed);
      let res;
      try {
        res = await googleRequest(url, {
          method: init.method,
          headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          timeoutMs: this.opts.timeoutMs ?? config.GSC_REQUEST_TIMEOUT_MS ?? 30_000,
        });
      } catch (err) {
        if (!(err instanceof GoogleNetworkError)) throw err;
        if (attempt >= this.maxAttempts) throw new GscApiError("transient", err.message, 0);
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res.body;
      const reason = errorReason(res.body);
      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          attempt--; // a token refresh is not a retry of a failure
          continue;
        }
        throw new GscApiError("auth", "Google rejected the access token after a refresh", 401);
      }
      if (res.status === 429 || (res.status === 403 && (QUOTA_REASONS.has(reason.reason) || QUOTA_REASONS.has(reason.status) || /quota/i.test(reason.message)))) {
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new GscApiError("quota", "Search Console API quota or rate limit reached", res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : QUOTA_BACKOFF_MS);
      }
      if (res.status === 403 || res.status === 404) {
        throw new GscApiError("permission", "The connected Google account cannot access this Search Console property", res.status);
      }
      if (res.status >= 400 && res.status < 500) {
        throw new GscApiError("bad_request", `Search Console rejected the request: ${reason.message || `HTTP ${res.status}`}`, res.status);
      }
      if (attempt >= this.maxAttempts) throw new GscApiError("transient", `Search Console error HTTP ${res.status}`, res.status);
      await this.sleep(this.backoffMs(attempt));
    }
  }

  async listSites(): Promise<GscSite[]> {
    const body = (await this.request(`${API}/sites`, { method: "GET" })) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> } | null;
    return (body?.siteEntry ?? [])
      .filter((s): s is { siteUrl: string; permissionLevel: string } => typeof s.siteUrl === "string" && typeof s.permissionLevel === "string")
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
  }

  async searchAnalytics(siteUrl: string, req: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    const body = (await this.request(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: "POST", body: req })) as {
      rows?: SearchAnalyticsRow[];
      metadata?: { first_incomplete_date?: string; firstIncompleteDate?: string };
    } | null;
    const rows = (body?.rows ?? []).filter((r) => Array.isArray(r.keys));
    return { rows, firstIncompleteDate: body?.metadata?.first_incomplete_date ?? body?.metadata?.firstIncompleteDate ?? null };
  }
}

/** Permission levels that can read Search Analytics data (siteUnverifiedUser cannot). */
export const READABLE_PERMISSIONS = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

export function propertyType(siteUrl: string): "domain" | "url_prefix" | null {
  if (/^sc-domain:[a-z0-9.-]+$/i.test(siteUrl)) return "domain";
  try {
    const u = new URL(siteUrl);
    // Search Console URL-prefix properties are always written with a trailing slash.
    return (u.protocol === "http:" || u.protocol === "https:") && siteUrl.endsWith("/") && !u.search && !u.hash && !u.username ? "url_prefix" : null;
  } catch {
    return null;
  }
}

/**
 * Does a Search Console property cover a ZigmaNeural website?
 * - Domain property `sc-domain:example.com`: the site's host is example.com or
 *   one of its subdomains (any protocol).
 * - URL-prefix property: same scheme, same host (exactly: www and apex are
 *   different prefixes), same port, and the site's path starts with the prefix path.
 */
export function propertyCoversWebsite(siteUrl: string, websiteUrl: string): boolean {
  let site: URL;
  try {
    site = new URL(websiteUrl);
  } catch {
    return false;
  }
  const host = site.hostname.toLowerCase().replace(/\.$/, "");
  const type = propertyType(siteUrl);
  if (type === "domain") {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase().replace(/\.$/, "");
    return host === domain || host.endsWith(`.${domain}`);
  }
  if (type === "url_prefix") {
    const prefix = new URL(siteUrl);
    const sitePath = site.pathname.endsWith("/") ? site.pathname : `${site.pathname}/`;
    return prefix.protocol === site.protocol && prefix.hostname.toLowerCase() === host && prefix.port === site.port && sitePath.startsWith(prefix.pathname);
  }
  return false;
}
