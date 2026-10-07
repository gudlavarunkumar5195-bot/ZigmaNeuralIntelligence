import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinnedLookup } from "../scanner/fetch.js";
import { sanMatchesHostname } from "../scanner/ssl.js";

describe("pinnedLookup", () => {
  it("answers both the legacy and the {all:true} (autoSelectFamily) forms", () => {
    const cb = vi.fn();
    pinnedLookup("93.184.216.34")("x", { all: true }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    pinnedLookup("2606:2800::1")("x", {}, cb);
    expect(cb).toHaveBeenLastCalledWith(null, "2606:2800::1", 6);
    pinnedLookup("1.2.3.4")("x", undefined, cb);
    expect(cb).toHaveBeenLastCalledWith(null, "1.2.3.4", 4);
  });

  it("actually connects through Node's http client to the pinned address for a hostname", async () => {
    const srv = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: "pinned.invalid", port, lookup: pinnedLookup("127.0.0.1") as never }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    srv.close();
    expect(status).toBe(200);
  });
});

describe("wildcard certificate matching (RFC 6125)", () => {
  it("matches exactly one label", () => {
    expect(sanMatchesHostname("*.example.com", "www.example.com")).toBe(true);
    expect(sanMatchesHostname("*.example.com", "a.b.example.com")).toBe(false);
    expect(sanMatchesHostname("*.example.com", "example.com")).toBe(false);
    expect(sanMatchesHostname("*.com", "example.com")).toBe(false);
    expect(sanMatchesHostname("Example.com", "example.COM")).toBe(true);
  });
});

describe("safeFetch against a real local server", () => {
  let srv: http.Server; let port: number;
  beforeAll(async () => {
    vi.resetModules();
    srv = http.createServer((q, r) => {
      if (q.url === "/gz") { r.writeHead(200, { "content-encoding": "gzip", "content-type": "text/html" }); r.end(gzipSync("x".repeat(20_000))); return; }
      if (q.url === "/trunc") { r.writeHead(200, { "content-length": "1000" }); r.write("partial"); setTimeout(() => r.destroy(), 20); return; }
      r.end("hi");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => srv.close());

  // checkUrlSafety blocks loopback, so exercise the transport layer by mocking only the SSRF gate.
  async function load() {
    vi.resetModules();
    vi.doMock("../scanner/ssrf.js", () => ({ checkUrlSafety: async () => ({ safe: true, resolvedIPs: ["127.0.0.1"] }) }));
    return (await import("../scanner/fetch.js")).safeFetch;
  }

  it("fetches a hostname through the pinned address and decodes gzip", async () => {
    const safeFetch = await load();
    const res = await safeFetch(`http://site.invalid:${port}/gz`);
    expect(res.ok).toBe(true);
    expect(res.body.length).toBe(20_000);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("reports a truncated body as a failed read, not a successful page", async () => {
    const safeFetch = await load();
    const res = await safeFetch(`http://site.invalid:${port}/trunc`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/body/i);
  });
});
