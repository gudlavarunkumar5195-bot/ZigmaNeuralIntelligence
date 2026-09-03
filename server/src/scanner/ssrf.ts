import { promises as dns } from "node:dns";

// ─── Private ranges ──────────────────────────────────────────────────────────

function ip4ToInt(addr: string): number {
  const p = addr.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const PRIVATE_RANGES: Array<[number, number]> = [
  [ip4ToInt("10.0.0.0"),    ip4ToInt("10.255.255.255")],   // 10/8
  [ip4ToInt("172.16.0.0"),  ip4ToInt("172.31.255.255")],   // 172.16/12
  [ip4ToInt("192.168.0.0"), ip4ToInt("192.168.255.255")],  // 192.168/16
  [ip4ToInt("127.0.0.0"),   ip4ToInt("127.255.255.255")],  // loopback /8
  [ip4ToInt("169.254.0.0"), ip4ToInt("169.254.255.255")],  // link-local
  [ip4ToInt("100.64.0.0"),  ip4ToInt("100.127.255.255")],  // CGNAT
  [ip4ToInt("0.0.0.0"),     ip4ToInt("0.255.255.255")],    // 0/8
  [ip4ToInt("192.0.0.0"),   ip4ToInt("192.0.0.255")],      // IETF protocol
  [ip4ToInt("198.18.0.0"),  ip4ToInt("198.19.255.255")],   // benchmarking
  [ip4ToInt("224.0.0.0"),   ip4ToInt("255.255.255.255")],  // multicast + reserved
];

const BLOCKED_EXACT = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
  "169.254.169.254",
]);

const BLOCKED_TLDS = new Set(["local", "internal", "corp", "home", "lan", "test", "example"]);
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d+$/.test(p))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const n = ip4ToInt(addr);
  return PRIVATE_RANGES.some(([start, end]) => n >= start && n <= end);
}

function isUnsafeIPv6(addr: string): boolean {
  const norm = addr.replace(/^\[|\]$/g, "").toLowerCase();
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1") return true;   // loopback
  if (norm.startsWith("fe80:")) return true;                         // link-local
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true;  // unique local fc00::/7
  if (norm.startsWith("::ffff:")) {                                  // IPv4-mapped
    return isPrivateIPv4(norm.slice(7));
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SSRFCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIPs?: string[];
}

/**
 * Full server-side SSRF check:
 * 1. Scheme whitelist
 * 2. Hostname/IP blocklist
 * 3. Internal TLD blocklist
 * 4. DNS resolution → validate all resolved IPs
 *
 * Must be called for both the initial URL and every redirect target.
 */
export async function checkUrlSafety(rawUrl: string): Promise<SSRFCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `Scheme '${parsed.protocol}' is not permitted. Only http and https are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!hostname) {
    return { safe: false, reason: "Missing hostname" };
  }

  if (BLOCKED_EXACT.has(hostname)) {
    return { safe: false, reason: `Host '${hostname}' is blocked` };
  }

  if (isPrivateIPv4(hostname)) {
    return { safe: false, reason: `Private IPv4 address '${hostname}' is not permitted` };
  }

  if (isUnsafeIPv6(hostname)) {
    return { safe: false, reason: `Unsafe IPv6 address '${hostname}' is not permitted` };
  }

  const tld = hostname.split(".").at(-1) ?? "";
  if (BLOCKED_TLDS.has(tld)) {
    return { safe: false, reason: `TLD '.${tld}' is reserved for internal networks` };
  }

  // DNS resolution — must have at least one routable IP
  const resolvedIPs: string[] = [];
  let dnsError: string | null = null;

  await Promise.all([
    dns.resolve4(hostname).then((v4) => resolvedIPs.push(...v4)).catch((e) => { dnsError = e.message; }),
    dns.resolve6(hostname).then((v6) => resolvedIPs.push(...v6)).catch(() => {}),
  ]);

  if (resolvedIPs.length === 0) {
    return { safe: false, reason: `DNS resolution failed for '${hostname}': ${dnsError ?? "no records"}` };
  }

  for (const ip of resolvedIPs) {
    if (BLOCKED_EXACT.has(ip)) {
      return { safe: false, reason: `'${hostname}' resolves to blocked address '${ip}' — DNS rebinding protection triggered` };
    }
    if (isPrivateIPv4(ip)) {
      return { safe: false, reason: `'${hostname}' resolves to private IP '${ip}' — DNS rebinding protection triggered` };
    }
    if (isUnsafeIPv6(ip)) {
      return { safe: false, reason: `'${hostname}' resolves to unsafe IPv6 address '${ip}'` };
    }
  }

  return { safe: true, resolvedIPs };
}
