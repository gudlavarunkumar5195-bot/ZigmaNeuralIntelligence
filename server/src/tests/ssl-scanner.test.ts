import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runSSLScanner, type TlsConnectFn } from "../scanner/ssl.js";
import type { DnsResolver } from "../scanner/ssrf.js";

const resolver = (a: string[], aaaa: string[] = []): DnsResolver & { calls: number } => {
  const r = {
    calls: 0,
    resolve4: async () => { r.calls++; if (!a.length) throw new Error("ENODATA"); return a; },
    resolve6: async () => { if (!aaaa.length) throw new Error("ENODATA"); return aaaa; },
  };
  return r;
};

function fakeConnect(cert: Record<string, unknown> | null, opts: { hang?: boolean } = {}) {
  const sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const connect = ((options: Record<string, unknown>, cb: () => void) => {
    calls.push(options);
    const s = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn>; getPeerCertificate: () => unknown };
    s.destroy = vi.fn();
    s.getPeerCertificate = () => cert;
    sockets.push(s);
    if (!opts.hang) setImmediate(cb);
    return s;
  }) as unknown as TlsConnectFn;
  return { connect, sockets, calls };
}

const day = 86_400_000;
const certExpiring = (days: number, extra: Record<string, unknown> = {}) => ({
  subject: { CN: "site.example.com" },
  issuer: { O: "Test CA" },
  valid_from: new Date(Date.now() - 100 * day).toUTCString(),
  valid_to: new Date(Date.now() + days * day + 3600_000).toUTCString(),
  subjectaltname: "DNS:site.example.com",
  ...extra,
});

describe("runSSLScanner", () => {
  it("refuses private-IP DNS results without connecting", async () => {
    const f = fakeConnect(certExpiring(90));
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["10.0.0.5"]), connect: f.connect });
    expect(r.status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses mixed public/private records", async () => {
    const f = fakeConnect(certExpiring(90));
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["93.184.216.34"], ["::ffff:7f00:1"]), connect: f.connect });
    expect(r.status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });

  it("connects to the pinned IP with SNI and default port, resolving once", async () => {
    const f = fakeConnect(certExpiring(90));
    const res = resolver(["93.184.216.34"]);
    const r = await runSSLScanner("https://site.example.com", { resolver: res, connect: f.connect });
    expect(r.status).toBe("completed");
    expect(r.findings).toHaveLength(0);
    expect(f.calls[0]).toMatchObject({ host: "93.184.216.34", port: 443, servername: "site.example.com", rejectUnauthorized: false });
    expect(res.calls).toBe(1);
    expect(f.sockets[0].destroy).toHaveBeenCalled();
  });

  it("uses the URL's explicit port", async () => {
    const f = fakeConnect(certExpiring(90));
    await runSSLScanner("https://site.example.com:8443/x", { resolver: resolver(["93.184.216.34"]), connect: f.connect });
    expect(f.calls[0].port).toBe(8443);
  });

  it("detects expired certificates", async () => {
    const f = fakeConnect(certExpiring(-5));
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["93.184.216.34"]), connect: f.connect });
    expect(r.findings.some((x) => x.title === "TLS certificate has expired")).toBe(true);
  });

  it("detects hostname mismatch", async () => {
    const f = fakeConnect(certExpiring(90, { subject: { CN: "other.com" }, subjectaltname: "DNS:other.com" }));
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["93.184.216.34"]), connect: f.connect });
    expect(r.findings.some((x) => x.title === "Certificate hostname mismatch")).toBe(true);
  });

  it("enforces the overall timeout and destroys the socket", async () => {
    const f = fakeConnect(null, { hang: true });
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["93.184.216.34"]), connect: f.connect, timeoutMs: 50 });
    expect(r.status).toBe("failed");
    expect(r.findings).toHaveLength(0);
    expect(f.sockets[0].destroy).toHaveBeenCalled();
  });

  it("times out when DNS hangs", async () => {
    const hung: DnsResolver = { resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}) };
    const f = fakeConnect(certExpiring(90));
    const r = await runSSLScanner("https://site.example.com", { resolver: hung, connect: f.connect, timeoutMs: 50 });
    expect(r.status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });

  it("keeps a critical finding on connection errors", async () => {
    const connect = ((_o: unknown, _cb: () => void) => {
      const s = new EventEmitter() as EventEmitter & { destroy: () => void };
      s.destroy = () => {};
      setImmediate(() => s.emit("error", new Error("ECONNREFUSED")));
      return s;
    }) as unknown as TlsConnectFn;
    const r = await runSSLScanner("https://site.example.com", { resolver: resolver(["93.184.216.34"]), connect });
    expect(r.findings[0]?.title).toBe("TLS certificate could not be retrieved");
  });
});
