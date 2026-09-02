import type { URLValidationResult } from "../types";

// RFC1918 private ranges + loopback + link-local + cloud metadata
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
  "169.254.169.254", // AWS/GCP/Azure metadata
  "fd00::ec2", // IPv6 metadata
]);

const BLOCKED_TLDS = new Set(["local", "internal", "corp", "home", "lan"]);

// Private IP CIDRs
const PRIVATE_RANGES: Array<{ start: number; end: number }> = [
  // 10.0.0.0/8
  { start: ip("10.0.0.0"), end: ip("10.255.255.255") },
  // 172.16.0.0/12
  { start: ip("172.16.0.0"), end: ip("172.31.255.255") },
  // 192.168.0.0/16
  { start: ip("192.168.0.0"), end: ip("192.168.255.255") },
  // 127.0.0.0/8 loopback
  { start: ip("127.0.0.0"), end: ip("127.255.255.255") },
  // 169.254.0.0/16 link-local / cloud metadata
  { start: ip("169.254.0.0"), end: ip("169.254.255.255") },
  // 100.64.0.0/10 carrier-grade NAT
  { start: ip("100.64.0.0"), end: ip("100.127.255.255") },
  // 0.0.0.0/8
  { start: ip("0.0.0.0"), end: ip("0.255.255.255") },
];

function ip(addr: string): number {
  const parts = addr.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d+$/.test(p))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const addr = ip(hostname);
  return PRIVATE_RANGES.some((r) => addr >= r.start && addr <= r.end);
}

function isIPv6Loopback(hostname: string): boolean {
  const norm = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return norm === "::1" || norm === "0:0:0:0:0:0:0:1";
}

function isBlockedTld(hostname: string): boolean {
  const parts = hostname.split(".");
  const tld = parts[parts.length - 1].toLowerCase();
  return BLOCKED_TLDS.has(tld);
}

function normalizeUrl(rawUrl: string): URL | null {
  try {
    let u = rawUrl.trim();
    // Auto-prefix https:// if no scheme
    if (!u.match(/^https?:\/\//i)) {
      u = "https://" + u;
    }
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * Validates a URL for use as a scan target.
 * Blocks SSRF vectors: private IPs, loopback, link-local, metadata endpoints,
 * internal TLDs, and dangerous schemes.
 *
 * NOTE: Client-side validation only. The backend MUST perform equivalent
 * validation including DNS resolution to prevent SSRF via DNS rebinding.
 */
export function validateScanUrl(rawUrl: string): URLValidationResult {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return { valid: false, normalizedUrl: null, error: "Please enter a URL.", blocked: false, blockReason: null };
  }

  const trimmed = rawUrl.trim();

  // Reject non-http/https schemes before auto-prefixing (prevents scheme smuggling via normalize)
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (schemeMatch && !["http", "https"].includes(schemeMatch[1].toLowerCase())) {
    return { valid: false, normalizedUrl: null, error: "Only HTTP and HTTPS URLs are supported.", blocked: true, blockReason: "dangerous_scheme" };
  }

  const parsed = normalizeUrl(trimmed);
  if (!parsed) {
    return { valid: false, normalizedUrl: null, error: "Could not parse URL. Include https://.", blocked: false, blockReason: null };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, normalizedUrl: null, error: "Only HTTP and HTTPS URLs are supported.", blocked: true, blockReason: "dangerous_scheme" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!hostname || hostname.length === 0) {
    return { valid: false, normalizedUrl: null, error: "URL is missing a hostname.", blocked: false, blockReason: null };
  }

  // Block exact blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, normalizedUrl: null, error: "Scanning this host is not permitted.", blocked: true, blockReason: "blocked_hostname" };
  }

  // Block private IPv4 ranges
  if (isPrivateIPv4(hostname)) {
    return { valid: false, normalizedUrl: null, error: "Scanning private or internal IP addresses is not permitted.", blocked: true, blockReason: "private_ip" };
  }

  // Block IPv6 loopback
  if (isIPv6Loopback(hostname)) {
    return { valid: false, normalizedUrl: null, error: "Scanning loopback addresses is not permitted.", blocked: true, blockReason: "loopback_ipv6" };
  }

  // Block internal TLDs
  if (isBlockedTld(hostname)) {
    return { valid: false, normalizedUrl: null, error: "Scanning internal network hostnames is not permitted.", blocked: true, blockReason: "internal_tld" };
  }

  // Require at least one dot in hostname (prevents bare hostnames like "server")
  if (!hostname.includes(".")) {
    return { valid: false, normalizedUrl: null, error: "Enter a fully qualified domain name (e.g. example.com).", blocked: false, blockReason: null };
  }

  // Normalize to canonical form
  const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;

  return { valid: true, normalizedUrl: normalized, error: null, blocked: false, blockReason: null };
}

/**
 * Strips query params, fragments, and normalizes the URL for deduplication.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Extracts the display domain from a URL string.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
