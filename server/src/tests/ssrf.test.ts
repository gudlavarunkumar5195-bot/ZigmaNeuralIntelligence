import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { checkUrlSafety } from "../scanner/ssrf.js";

// Mock dns.promises so tests don't require network access
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn(async (hostname: string) => {
      // Simulate DNS responses for test hostnames
      const map: Record<string, string[]> = {
        "example.com": ["93.184.216.34"],
        "rebind.attacker.com": ["192.168.1.1"],  // DNS rebinding attempt
        "metadata-via-dns.com": ["169.254.169.254"],
      };
      if (map[hostname]) return map[hostname];
      throw new Error("DNS lookup failed");
    }),
    resolve6: vi.fn(async () => { throw new Error("no AAAA records"); }),
  },
}));

describe("checkUrlSafety — scheme validation", () => {
  it("allows https", async () => {
    const r = await checkUrlSafety("https://example.com");
    expect(r.safe).toBe(true);
  });

  it("allows http", async () => {
    const r = await checkUrlSafety("http://example.com");
    expect(r.safe).toBe(true);
  });

  it("blocks file://", async () => {
    const r = await checkUrlSafety("file:///etc/passwd");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("file:");
  });

  it("blocks ftp://", async () => {
    const r = await checkUrlSafety("ftp://example.com");
    expect(r.safe).toBe(false);
  });

  it("blocks gopher://", async () => {
    const r = await checkUrlSafety("gopher://example.com");
    expect(r.safe).toBe(false);
  });

  it("blocks data: URIs", async () => {
    const r = await checkUrlSafety("data:text/html,<script>alert(1)</script>");
    expect(r.safe).toBe(false);
  });

  it("rejects malformed URL", async () => {
    const r = await checkUrlSafety("not-a-url");
    expect(r.safe).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe("checkUrlSafety — blocked hostnames", () => {
  it("blocks localhost", async () => {
    const r = await checkUrlSafety("https://localhost");
    expect(r.safe).toBe(false);
  });

  it("blocks 0.0.0.0", async () => {
    const r = await checkUrlSafety("https://0.0.0.0");
    expect(r.safe).toBe(false);
  });

  it("blocks metadata.google.internal", async () => {
    const r = await checkUrlSafety("https://metadata.google.internal");
    expect(r.safe).toBe(false);
  });

  it("blocks 169.254.169.254 (AWS/GCP metadata)", async () => {
    const r = await checkUrlSafety("https://169.254.169.254");
    expect(r.safe).toBe(false);
  });
});

describe("checkUrlSafety — private IPv4 ranges", () => {
  it("blocks 10.0.0.1", async () => {
    const r = await checkUrlSafety("https://10.0.0.1");
    expect(r.safe).toBe(false);
  });

  it("blocks 10.255.255.255", async () => {
    const r = await checkUrlSafety("https://10.255.255.255");
    expect(r.safe).toBe(false);
  });

  it("blocks 172.16.0.1", async () => {
    const r = await checkUrlSafety("https://172.16.0.1");
    expect(r.safe).toBe(false);
  });

  it("blocks 172.31.255.255", async () => {
    const r = await checkUrlSafety("https://172.31.255.255");
    expect(r.safe).toBe(false);
  });

  it("does NOT block 172.32.0.1 (outside /12)", async () => {
    const r = await checkUrlSafety("https://172.32.0.1");
    // 172.32.0.1 resolves via mock to failure, but the IP itself is not private
    // (DNS failure will block it, which is correct — unknown host is blocked)
    // The important thing is it's not blocked as "private IP"
    if (!r.safe) {
      expect(r.reason).not.toContain("private");
    }
  });

  it("blocks 192.168.1.1", async () => {
    const r = await checkUrlSafety("https://192.168.1.1");
    expect(r.safe).toBe(false);
  });

  it("blocks 127.0.0.1 (loopback)", async () => {
    const r = await checkUrlSafety("https://127.0.0.1");
    expect(r.safe).toBe(false);
  });

  it("blocks 127.100.200.1 (loopback /8)", async () => {
    const r = await checkUrlSafety("https://127.100.200.1");
    expect(r.safe).toBe(false);
  });
});

describe("checkUrlSafety — IPv6", () => {
  it("blocks ::1 (IPv6 loopback)", async () => {
    const r = await checkUrlSafety("https://[::1]");
    expect(r.safe).toBe(false);
  });

  it("blocks fe80::1 (link-local)", async () => {
    const r = await checkUrlSafety("https://[fe80::1]");
    expect(r.safe).toBe(false);
  });

  it("blocks fc00::1 (unique local)", async () => {
    const r = await checkUrlSafety("https://[fc00::1]");
    expect(r.safe).toBe(false);
  });

  it("blocks ::ffff:192.168.1.1 (IPv4-mapped private)", async () => {
    const r = await checkUrlSafety("https://[::ffff:192.168.1.1]");
    expect(r.safe).toBe(false);
  });
});

describe("checkUrlSafety — internal TLDs", () => {
  it("blocks .local", async () => {
    const r = await checkUrlSafety("https://server.local");
    expect(r.safe).toBe(false);
  });

  it("blocks .internal", async () => {
    const r = await checkUrlSafety("https://api.internal");
    expect(r.safe).toBe(false);
  });

  it("blocks .corp", async () => {
    const r = await checkUrlSafety("https://intranet.corp");
    expect(r.safe).toBe(false);
  });

  it("blocks .lan", async () => {
    const r = await checkUrlSafety("https://nas.lan");
    expect(r.safe).toBe(false);
  });
});

describe("checkUrlSafety — DNS rebinding protection", () => {
  it("blocks hostname that resolves to private IP (rebind.attacker.com → 192.168.1.1)", async () => {
    const r = await checkUrlSafety("https://rebind.attacker.com");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("rebinding");
  });

  it("blocks hostname that resolves to metadata IP", async () => {
    const r = await checkUrlSafety("https://metadata-via-dns.com");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("rebinding");
  });

  it("blocks hostname with no DNS records", async () => {
    const r = await checkUrlSafety("https://nxdomain-test-hostname.example.invalid");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("DNS");
  });
});
