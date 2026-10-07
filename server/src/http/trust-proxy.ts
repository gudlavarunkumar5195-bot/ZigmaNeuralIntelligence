import { isIP } from "node:net";

export type TrustProxySetting = false | number | string[];

const MAX_HOPS = 5;
const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

function validTrustedEntry(entry: string): boolean {
  if (KEYWORDS.has(entry.toLowerCase())) return true;
  const [addr, prefix, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/**
 * Strict parser for TRUST_PROXY.
 *  - unset / "" / "false" / "0": do not trust forwarded headers (default).
 *  - integer 1..5: trust that many proxy hops (the Nth address from the right).
 *  - comma-separated IPs / CIDRs (or loopback, linklocal, uniquelocal).
 * Blanket "true" is rejected: it makes the left-most X-Forwarded-For entry
 * client-controlled and lets anyone mint a fresh rate-limit key per request.
 */
export function parseTrustProxy(value: unknown, name = "TRUST_PROXY"): TrustProxySetting {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const raw = value.trim();
  if (raw === "" || raw.toLowerCase() === "false" || raw === "0") return false;
  if (raw.toLowerCase() === "true") {
    throw new Error(`${name}=true is not allowed; set a hop count (e.g. 1) or a list of proxy IPs/CIDRs`);
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1 || hops > MAX_HOPS) throw new Error(`${name} hop count must be between 1 and ${MAX_HOPS}`);
    return hops;
  }
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.some((e) => e === "" || !validTrustedEntry(e))) {
    throw new Error(`${name} must be false, a hop count, or a comma-separated list of IPs/CIDRs`);
  }
  return entries;
}

/** Lower-cased, trimmed, NFKC-normalised email for use in rate-limit keys. */
export function normalizeEmailForKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().toLowerCase().slice(0, 254);
}

/**
 * Minimal in-memory fixed-window counter. @fastify/rate-limit runs only one
 * limiter per request, so the per-IP ceiling for auth endpoints (which bounds
 * email rotation) uses this alongside the per-(IP,email) route limiter.
 */
export function createFixedWindowCounter(max: number, windowMs: number, now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Returns true when the request is allowed. */
    hit(key: string): boolean {
      const t = now();
      if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
  };
}

/**
 * Fastify's own numeric trustProxy fails closed (trusts nothing), so a hop
 * count is translated to an explicit predicate: the socket peer plus the next
 * N-1 right-most X-Forwarded-For entries are proxies; the first address beyond
 * them is the client. Only use a hop count when the app is reachable solely
 * through that proxy chain (as on App Platform), because the socket peer itself
 * is not validated.
 */
export function toFastifyTrustProxy(setting: TrustProxySetting): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof setting === "number") return (_address: string, hop: number) => hop < setting;
  return setting;
}
