import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, fetchMock, resolveTxtMock } = vi.hoisted(() => ({ queryMock: vi.fn(), fetchMock: vi.fn(), resolveTxtMock: vi.fn() }));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn() }));
vi.mock("../scanner/fetch.js", () => ({ safeFetch: fetchMock }));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, promises: { ...actual.promises, resolveTxt: resolveTxtMock } };
});

import { isClaimedFinalUrl, isClaimedHost, verificationOrigin, verifyOwnership } from "../services/website.service.js";

const TOKEN = "a".repeat(32);
function site(method: "html" | "file" | "dns", url = "https://victim.example/blog", domain = new URL(url).hostname) {
  return { id: "w1", org_id: "o1", url, domain, verified: false, verification_method: method, verification_token: TOKEN as string | null };
}
function served(finalUrl: string, body: string) {
  return { ok: true, status: 200, headers: {}, body, finalUrl, redirectCount: finalUrl.includes("victim") ? 0 : 1, durationMs: 1 };
}
const META = `<html><head><meta name="zignaneural-site-verification" content="${TOKEN}"></head></html>`;

describe("ownership verification stays on the claimed domain (P0-4)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    fetchMock.mockReset();
    resolveTxtMock.mockReset();
  });

  function wire(row: ReturnType<typeof site>) {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM websites")) return { rows: [row] };
      return { rows: [] };
    });
  }
  const markedVerified = () => queryMock.mock.calls.some((c) => String(c[0]).includes("SET verified = TRUE"));

  it("rejects a meta token served by another host after a redirect", async () => {
    wire(site("html"));
    fetchMock.mockResolvedValue(served("https://attacker.example/", META));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("rejects a file token served by another host after a redirect", async () => {
    wire(site("file"));
    fetchMock.mockResolvedValue(served("https://attacker.example/zignaneural-verify.txt", TOKEN));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("accepts http -> https and apex -> www on the same site", async () => {
    wire(site("html", "http://victim.example"));
    fetchMock.mockResolvedValue(served("https://www.victim.example/", META));
    await expect(verifyOwnership("w1", "o1")).resolves.toBe(true);
    expect(markedVerified()).toBe(true);
  });

  it("reads the meta token from the origin root, not the stored path", async () => {
    wire(site("html", "https://victim.example/blog"));
    fetchMock.mockResolvedValue(served("https://victim.example/", META));
    await verifyOwnership("w1", "o1");
    expect(fetchMock).toHaveBeenCalledWith("https://victim.example/");
  });

  it("isClaimedHost fails closed for other subdomains and look-alikes", () => {
    expect(isClaimedHost("victim.example", "https://victim.example/x")).toBe(true);
    expect(isClaimedHost("victim.example", "https://WWW.victim.example./")).toBe(true);
    expect(isClaimedHost("www.victim.example", "https://victim.example/")).toBe(true);
    expect(isClaimedHost("victim.example", "https://blog.victim.example/")).toBe(false);
    expect(isClaimedHost("victim.example", "https://victim.example.attacker.test/")).toBe(false);
    expect(isClaimedHost("victim.example", "not a url")).toBe(false);
  });
  it("accepts a file token served by the claimed host, including after http -> https", async () => {
    wire(site("file", "http://victim.example/shop"));
    fetchMock.mockResolvedValue(served("https://victim.example/zignaneural-verify.txt", `${TOKEN}\n`));
    await expect(verifyOwnership("w1", "o1")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://victim.example/zignaneural-verify.txt");
    expect(markedVerified()).toBe(true);
  });

  it("rejects a token after an https -> http downgrade on the same host", async () => {
    wire(site("file", "https://victim.example"));
    fetchMock.mockResolvedValue(served("http://victim.example/zignaneural-verify.txt", TOKEN));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("rejects a token served from another port on the same host", async () => {
    wire(site("html", "https://victim.example"));
    fetchMock.mockResolvedValue(served("https://victim.example:8443/", META));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("rejects a wrong token for both HTTP methods", async () => {
    wire(site("file"));
    fetchMock.mockResolvedValue(served("https://victim.example/zignaneural-verify.txt", "b".repeat(32)));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    wire(site("html"));
    fetchMock.mockResolvedValue(served("https://victim.example/", META.replace(TOKEN, "b".repeat(32))));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("fails verification (not a 500) when the token page is not 2xx", async () => {
    wire(site("file"));
    fetchMock.mockResolvedValue({ ...served("https://victim.example/zignaneural-verify.txt", TOKEN), ok: false, status: 404 });
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
  });

  it("fails verification (not a 500) when the SSRF-safe fetch refuses or errors", async () => {
    wire(site("html"));
    fetchMock.mockRejectedValue(Object.assign(new Error("Blocked: private address"), { code: "SSRF_BLOCKED" }));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED", statusCode: 422 });
    expect(markedVerified()).toBe(false);
  });

  it("fails verification without fetching when the stored URL is malformed or off the claimed domain", async () => {
    for (const row of [
      site("html", "not a url", "victim.example"),
      site("html", "ftp://victim.example/", "victim.example"),
      site("file", "https://attacker.example/", "victim.example"),
      site("file", "https://user:pass@victim.example/", "victim.example"),
    ]) {
      wire(row);
      await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED", statusCode: 422 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markedVerified()).toBe(false);
  });

  it("refuses when no token exists and short-circuits an already verified site", async () => {
    wire({ ...site("html"), verification_token: null });
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    wire({ ...site("html"), verified: true });
    await expect(verifyOwnership("w1", "o1")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DNS method: exact TXT token passes; mismatch and resolver errors fail", async () => {
    wire(site("dns"));
    resolveTxtMock.mockResolvedValueOnce([["other"], [TOKEN.slice(0, 16), TOKEN.slice(16)]]);
    await expect(verifyOwnership("w1", "o1")).resolves.toBe(true);
    expect(resolveTxtMock).toHaveBeenCalledWith("_zignaneural-verify.victim.example");

    queryMock.mockClear();
    resolveTxtMock.mockResolvedValueOnce([[`${TOKEN}x`]]);
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    resolveTxtMock.mockRejectedValueOnce(Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(verifyOwnership("w1", "o1")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(markedVerified()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verificationOrigin and isClaimedFinalUrl encode the same-site rules", () => {
    expect(verificationOrigin("https://victim.example/a/b?c", "victim.example")).toBe("https://victim.example");
    expect(verificationOrigin("http://www.victim.example:8080/", "victim.example")).toBe("http://www.victim.example:8080");
    expect(verificationOrigin("javascript:alert(1)", "victim.example")).toBeNull();
    expect(verificationOrigin("https://victim.example.attacker.test/", "victim.example")).toBeNull();

    const req = "http://victim.example/zignaneural-verify.txt";
    expect(isClaimedFinalUrl("victim.example", req, "https://www.victim.example/zignaneural-verify.txt")).toBe(true);
    expect(isClaimedFinalUrl("victim.example", "http://victim.example:8080/", "https://victim.example/")).toBe(true);
    expect(isClaimedFinalUrl("victim.example", "http://victim.example:8080/", "http://victim.example:8080/")).toBe(true);
    expect(isClaimedFinalUrl("victim.example", req, "https://www.www.victim.example/")).toBe(false);
    expect(isClaimedFinalUrl("victim.example", req, "https://victim.example:444/")).toBe(false);
    expect(isClaimedFinalUrl("victim.example", req, "https://user@victim.example/")).toBe(false);
    expect(isClaimedFinalUrl("victim.example", req, "file:///etc/passwd")).toBe(false);
    expect(isClaimedFinalUrl("victim.example", req, "%%%")).toBe(false);
  });
});
