import { describe, it, expect } from "vitest";
import { checkUrlSafety, isUnsafeIp, isUnsafeIPv6, isPrivateIPv4, parseIPv6, type DnsResolver } from "../scanner/ssrf.js";

const resolverFor = (map: Record<string, { a?: string[]; aaaa?: string[] }>): DnsResolver => ({
  resolve4: async (h) => { if (map[h]?.a) return map[h].a!; throw new Error("ENODATA"); },
  resolve6: async (h) => { if (map[h]?.aaaa) return map[h].aaaa!; throw new Error("ENODATA"); },
});

describe("IPv6 parsing", () => {
  it("expands compressed, zone, bracket and v4-suffix forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[fe80::1%eth0]")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toHaveLength(8);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("zz::1")).toBeNull();
  });
});

describe("unsafe IPv6", () => {
  it.each([
    "::", "::1", "0:0:0:0:0:0:0:1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0",
    "febf::1", "fec0::1", "ff02::1", "ff00::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe", "::ffff:192.168.1.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1", "2002:7f00:1::", "2002:0a00:0001::1", "2002:c0a8:0101::", "::127.0.0.1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1", "3fff::1", "100::1",
  ])("blocks %s", (a) => {
    expect(isUnsafeIPv6(a)).toBe(true);
    expect(isUnsafeIp(a)).toBe(true);
  });

  it.each([
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808",
    "64:ff9b::808:808", "2002:808:808::1",
  ])("allows %s", (a) => {
    expect(isUnsafeIPv6(a)).toBe(false);
  });

  it("fails closed on malformed IPv6", () => {
    expect(isUnsafeIPv6("gggg::1")).toBe(true);
  });
});

describe("IPv4 ranges", () => {
  it.each(["0.1.2.3", "10.1.1.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.9.9",
    "192.168.0.1", "192.0.0.5", "198.18.0.1", "198.19.1.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.2.1"])("blocks %s", (a) => {
    expect(isPrivateIPv4(a)).toBe(true);
  });
  it.each(["8.8.8.8", "100.63.255.255", "172.15.0.1", "172.32.0.1", "1.1.1.1"])("allows %s", (a) => {
    expect(isPrivateIPv4(a)).toBe(false);
  });
});

describe("checkUrlSafety with IP literals and hostnames", () => {
  const resolver = resolverFor({
    "fcc.gov": { a: ["23.1.2.3"] },
    "fda.gov": { a: ["23.1.2.4"] },
    "fd.example.com": { a: ["93.184.216.34"] },
    "fe80.example.org": { aaaa: ["2606:4700::1"] },
    "mixed.example.com": { a: ["93.184.216.34", "10.0.0.5"] },
    "v6private.example.com": { aaaa: ["::ffff:7f00:1"] },
  });

  it.each(["https://fcc.gov", "https://fda.gov", "https://fd.example.com", "https://fe80.example.org"])("allows legit domain %s", async (u) => {
    expect((await checkUrlSafety(u, resolver)).safe).toBe(true);
  });

  it.each([
    "http://[::1]/", "http://[fe80::1%25eth0]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[ff02::1]/",
    "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/",
  ])("blocks literal %s", async (u) => {
    expect((await checkUrlSafety(u, resolver)).safe).toBe(false);
  });

  it("refuses when any resolved record is private", async () => {
    expect((await checkUrlSafety("https://mixed.example.com", resolver)).safe).toBe(false);
    expect((await checkUrlSafety("https://v6private.example.com", resolver)).safe).toBe(false);
  });
});
