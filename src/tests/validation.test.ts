import { describe, it, expect } from "vitest";
import { validateScanUrl, canonicalizeUrl, extractDomain } from "../lib/validation";

describe("validateScanUrl", () => {
  // ─── Valid URLs ─────────────────────────────────────────────────────────────

  it("accepts a plain https domain", () => {
    const r = validateScanUrl("https://example.com");
    expect(r.valid).toBe(true);
    expect(r.normalizedUrl).toBe("https://example.com");
    expect(r.blocked).toBe(false);
  });

  it("accepts a domain with path", () => {
    const r = validateScanUrl("https://example.com/blog");
    expect(r.valid).toBe(true);
    expect(r.normalizedUrl).toBe("https://example.com/blog");
  });

  it("auto-prefixes https:// when scheme is missing", () => {
    const r = validateScanUrl("example.com");
    expect(r.valid).toBe(true);
    expect(r.normalizedUrl).toBe("https://example.com");
  });

  it("accepts http:// URLs", () => {
    const r = validateScanUrl("http://example.com");
    expect(r.valid).toBe(true);
  });

  it("strips trailing slash on root", () => {
    const r = validateScanUrl("https://example.com/");
    expect(r.valid).toBe(true);
    expect(r.normalizedUrl).toBe("https://example.com");
  });

  it("accepts subdomain", () => {
    const r = validateScanUrl("https://www.acmecorp.com");
    expect(r.valid).toBe(true);
  });

  // ─── Empty / Unparseable ────────────────────────────────────────────────────

  it("rejects empty string", () => {
    const r = validateScanUrl("");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    const r = validateScanUrl("   ");
    expect(r.valid).toBe(false);
  });

  it("rejects bare word without TLD", () => {
    const r = validateScanUrl("https://server");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(false);
  });

  // ─── Dangerous Schemes ──────────────────────────────────────────────────────

  it("blocks file:// scheme", () => {
    const r = validateScanUrl("file:///etc/passwd");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("dangerous_scheme");
  });

  it("blocks ftp:// scheme", () => {
    const r = validateScanUrl("ftp://example.com");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  // ─── SSRF: Loopback ─────────────────────────────────────────────────────────

  it("blocks localhost", () => {
    const r = validateScanUrl("https://localhost");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("blocked_hostname");
  });

  it("blocks 127.0.0.1", () => {
    const r = validateScanUrl("https://127.0.0.1");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("private_ip");
  });

  it("blocks 127.100.200.1 (loopback /8)", () => {
    const r = validateScanUrl("https://127.100.200.1");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks ::1 (IPv6 loopback)", () => {
    const r = validateScanUrl("https://[::1]");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("loopback_ipv6");
  });

  // ─── SSRF: Private RFC1918 Ranges ────────────────────────────────────────

  it("blocks 10.0.0.1", () => {
    const r = validateScanUrl("https://10.0.0.1");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("private_ip");
  });

  it("blocks 10.255.255.255", () => {
    const r = validateScanUrl("https://10.255.255.255");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks 172.16.0.1", () => {
    const r = validateScanUrl("https://172.16.0.1");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks 172.31.255.255", () => {
    const r = validateScanUrl("https://172.31.255.255");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("does NOT block 172.32.0.1 (outside /12 range)", () => {
    const r = validateScanUrl("https://172.32.0.1");
    expect(r.valid).toBe(true);
  });

  it("blocks 192.168.1.1", () => {
    const r = validateScanUrl("https://192.168.1.1");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  // ─── SSRF: Cloud Metadata ───────────────────────────────────────────────────

  it("blocks 169.254.169.254 (AWS metadata)", () => {
    const r = validateScanUrl("https://169.254.169.254");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks metadata.google.internal", () => {
    const r = validateScanUrl("https://metadata.google.internal");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  // ─── SSRF: Internal TLDs ─────────────────────────────────────────────────

  it("blocks .local TLD", () => {
    const r = validateScanUrl("https://server.local");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("internal_tld");
  });

  it("blocks .internal TLD", () => {
    const r = validateScanUrl("https://service.internal");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks .corp TLD", () => {
    const r = validateScanUrl("https://intranet.corp");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("blocks .lan TLD", () => {
    const r = validateScanUrl("https://nas.lan");
    expect(r.valid).toBe(false);
    expect(r.blocked).toBe(true);
  });
});

describe("canonicalizeUrl", () => {
  it("strips query params and fragments", () => {
    expect(canonicalizeUrl("https://example.com/page?q=1#section")).toBe("https://example.com/page");
  });

  it("strips trailing slash", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  it("returns original string on parse failure", () => {
    expect(canonicalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("extractDomain", () => {
  it("returns the hostname", () => {
    expect(extractDomain("https://www.example.com/path")).toBe("www.example.com");
  });

  it("returns the original string on parse failure", () => {
    expect(extractDomain("garbage")).toBe("garbage");
  });
});
