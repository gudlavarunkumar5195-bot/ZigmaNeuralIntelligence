import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, parseKeyRing } from "../integrations/crypto.js";

describe("credential encryption", () => {
  const ring = parseKeyRing(`k1:${randomBytes(32).toString("base64")}`)!;

  it("round-trips a secret bound to its associated data", () => {
    const { ciphertext } = encryptSecret(ring, "s3cret", "org-a:openrouter");
    expect(decryptSecret(ring, ciphertext, "org-a:openrouter")).toBe("s3cret");
    expect(() => decryptSecret(ring, ciphertext, "org-b:openrouter")).toThrow();
  });

  it("rejects a truncated authentication tag (only full 128-bit tags are accepted)", () => {
    const { ciphertext } = encryptSecret(ring, "s3cret", "aad");
    const [keyId, iv, tag, data] = ciphertext.split(".");
    const short = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptSecret(ring, [keyId, iv, short, data].join("."), "aad")).toThrow(/Malformed/);
  });
});
