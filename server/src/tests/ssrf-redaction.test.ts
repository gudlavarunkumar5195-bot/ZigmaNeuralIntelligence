import { describe, expect, it } from "vitest";
import { checkUrlSafety } from "../scanner/ssrf.js";

describe("SSRF rejection reasons do not leak resolved IPs", () => {
  it("returns a generic reason and keeps detail separate", async () => {
    const resolver = { resolve4: async () => ["10.9.8.7"], resolve6: async () => { throw new Error("none"); } };
    const r = await checkUrlSafety("https://internal-name.example.org", resolver as never);
    expect(r.safe).toBe(false);
    expect(r.reason).not.toContain("10.9.8.7");
    expect(r.reason).toContain("non-public address");
    expect(r.detail).toContain("10.9.8.7");
  });
});
