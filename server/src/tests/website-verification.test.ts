import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, fetchMock } = vi.hoisted(() => ({ queryMock: vi.fn(), fetchMock: vi.fn() }));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn() }));
vi.mock("../scanner/fetch.js", () => ({ safeFetch: fetchMock }));

import { isClaimedHost, verifyOwnership } from "../services/website.service.js";

const TOKEN = "a".repeat(32);
function site(method: "html" | "file", url = "https://victim.example/blog") {
  return { id: "w1", org_id: "o1", url, domain: new URL(url).hostname, verified: false, verification_method: method, verification_token: TOKEN };
}
function served(finalUrl: string, body: string) {
  return { ok: true, status: 200, headers: {}, body, finalUrl, redirectCount: finalUrl.includes("victim") ? 0 : 1, durationMs: 1 };
}
const META = `<html><head><meta name="zignaneural-site-verification" content="${TOKEN}"></head></html>`;

describe("ownership verification stays on the claimed domain (P0-4)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    fetchMock.mockReset();
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
});
