import { promises as dns } from "node:dns";

// ─── Private ranges ──────────────────────────────────────────────────────────

function ip4ToInt(addr: string): number {
  const p = addr.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const PRIVATE_RANGES: Array<[number, number]> = [
  [ip4ToInt("0.0.0.0"),       ip4ToInt("0.255.255.255")],    // 0/8
  [ip4ToInt("10.0.0.0"),      ip4ToInt("10.255.255.255")],   // 10/8
  [ip4ToInt("100.64.0.0"),    ip4ToInt("100.127.255.255")],  // CGNAT
  [ip4ToInt("127.0.0.0"),     ip4ToInt("127.255.255.255")],  // loopback /8
  [ip4ToInt("169.254.0.0"),   ip4ToInt("169.254.255.255")],  // link-local
  [ip4ToInt("172.16.0.0"),    ip4ToInt("172.31.255.255")],   // 172.16/12
  [ip4ToInt("192.0.0.0"),     ip4ToInt("192.0.0.255")],      // IETF protocol
  [ip4ToInt("192.0.2.0"),     ip4ToInt("192.0.2.255")],      // TEST-NET-1
  [ip4ToInt("192.88.99.0"),   ip4ToInt("192.88.99.255")],    // 6to4 relay anycast
  [ip4ToInt("192.168.0.0"),   ip4ToInt("192.168.255.255")],  // 192.168/16
  [ip4ToInt("198.18.0.0"),    ip4ToInt("198.19.255.255")],   // benchmarking
  [ip4ToInt("198.51.100.0"),  ip4ToInt("198.51.100.255")],   // TEST-NET-2
  [ip4ToInt("203.0.113.0"),   ip4ToInt("203.0.113.255")],    // TEST-NET-3
  [ip4ToInt("224.0.0.0"),     ip4ToInt("255.255.255.255")],  // multicast + reserved
];

const BLOCKED_EXACT = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
  "169.254.169.254",
]);

const BLOCKED_TLDS = new Set(["local", "internal", "corp", "home", "lan", "test", "example"]);
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Strict dotted-quad parse; returns octets or null. */
function parseIPv4(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => n > 255)) return null;
  return nums;
}

export function isPrivateIPv4(addr: string): boolean {
  if (!parseIPv4(addr)) return false;
  const n = ip4ToInt(addr);
  return PRIVATE_RANGES.some(([start, end]) => n >= start && n <= end);
}

/** Parse an IPv6 literal (brackets / zone id / IPv4 suffix tolerated) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(":") || /[^0-9a-f:.]/.test(s)) return null;

  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  if (!head) return null;
  let groups: number[];
  if (halves.length === 2) {
    const rest = parseGroups(halves[1]);
    if (!rest) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True if the string is an IPv6 literal that is unsafe (or unparseable). */
export function isUnsafeIPv6(addr: string): boolean {
  const g = parseIPv6(addr);
  if (!g) return true; // fail closed on anything that claims to be IPv6 but can't be parsed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;

  // :: (unspecified), ::1 (loopback), ::/96 IPv4-compatible (deprecated)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // IPv4-mapped ::ffff:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4(embeddedV4(g6, g7));
  }
  // NAT64 well-known 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(embeddedV4(g6, g7));
  }
  // NAT64 local-use 64:ff9b:1::/48 — operator-defined embedding, block entirely
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 6to4 2002::/16
  if (g0 === 0x2002) return isPrivateIPv4(embeddedV4(g1, g2));
  // Teredo 2001::/32 and IETF protocol assignments 2001::/23
  if (g0 === 0x2001 && g1 < 0x200) return true;
  // Documentation 2001:db8::/32 and 3fff::/20
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  if (g0 === 0x3fff && g1 < 0x1000) return true;
  // Discard-only 100::/64
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // fc00::/7, fe80::/10, fec0::/10, ff00::/8 and everything else outside global unicast 2000::/3
  if ((g0 & 0xe000) !== 0x2000) return true;
  return false;
}

/** Applies IP-range checks to an IP literal (v4 or v6). Returns false for non-IPs. */
export function isUnsafeIp(addr: string): boolean {
  const s = addr.replace(/^\[|\]$/g, "");
  if (s.includes(":")) return isUnsafeIPv6(s);
  return isPrivateIPv4(s);
}

export function isIpLiteral(host: string): boolean {
  const s = host.replace(/^\[|\]$/g, "");
  return s.includes(":") || parseIPv4(s) !== null;
}

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const NON_PUBLIC_REASON = "host resolves to a non-public address (DNS rebinding protection)";

export interface SSRFCheckResult {
  safe: boolean;
  reason?: string;
  /** Internal detail (e.g. resolved IP). For server logs only; never forward to API callers. */
  detail?: string;
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
export async function checkUrlSafety(rawUrl: string, resolver: DnsResolver = dns): Promise<SSRFCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `Scheme '${parsed.protocol}' is not permitted. Only http and https are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  if (!hostname) {
    return { safe: false, reason: "Missing hostname" };
  }

  if (BLOCKED_EXACT.has(hostname)) {
    return { safe: false, reason: `Host '${hostname}' is blocked` };
  }

  if (isIpLiteral(hostname)) {
    if (isUnsafeIp(hostname)) {
      return { safe: false, reason: `Private or reserved IP address '${hostname}' is not permitted` };
    }
    return { safe: true, resolvedIPs: [hostname] };
  }

  const tld = hostname.split(".").at(-1) ?? "";
  if (BLOCKED_TLDS.has(tld)) {
    return { safe: false, reason: `TLD '.${tld}' is reserved for internal networks` };
  }

  // DNS resolution — must have at least one routable IP
  const resolvedIPs: string[] = [];
  let dnsError: string | null = null;

  await Promise.all([
    resolver.resolve4(hostname).then((v4) => resolvedIPs.push(...v4)).catch((e) => { dnsError = e.message; }),
    resolver.resolve6(hostname).then((v6) => resolvedIPs.push(...v6)).catch(() => {}),
  ]);

  if (resolvedIPs.length === 0) {
    return { safe: false, reason: `DNS resolution failed for '${hostname}': ${dnsError ?? "no records"}` };
  }

  for (const ip of resolvedIPs) {
    if (BLOCKED_EXACT.has(ip)) {
      return { safe: false, reason: NON_PUBLIC_REASON, detail: `'${hostname}' resolves to blocked address '${ip}'` };
    }
    if (isUnsafeIp(ip)) {
      return { safe: false, reason: NON_PUBLIC_REASON, detail: `'${hostname}' resolves to private or reserved IP '${ip}'` };
    }
  }

  return { safe: true, resolvedIPs };
}
