import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope for integration secrets (OAuth refresh tokens, PKCE verifiers):
 * AES-256-GCM with a versioned key ring from INTEGRATION_ENCRYPTION_KEYS.
 *
 *   ciphertext = "<keyId>.<iv b64url>.<tag b64url>.<data b64url>"
 *
 * The associated data binds a ciphertext to its row (e.g. the organization
 * and integration id), so a value copied to another row or tenant does not
 * decrypt. Key rotation: add a new key, make it active, re-encrypt, then
 * remove the old key. Without keys the feature is unavailable; it never
 * stores secrets in plaintext.
 */

export class EncryptionUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "INTEGRATION_ENCRYPTION_UNAVAILABLE";
  constructor(message = "Integration credential encryption is not configured on the server") {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

export interface KeyRing {
  keys: Map<string, Buffer>;
  activeKeyId: string;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Parses "k1:<base64>,k2:<base64>". Throws on any malformed or non-32-byte key. */
export function parseKeyRing(spec: string | undefined, activeKeyId?: string): KeyRing | null {
  if (!spec?.trim()) return null;
  const keys = new Map<string, Buffer>();
  let last = "";
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    const id = part.slice(0, idx);
    if (idx <= 0 || !KEY_ID.test(id)) throw new Error("INTEGRATION_ENCRYPTION_KEYS: each entry must be <id>:<base64 key>");
    if (keys.has(id)) throw new Error(`INTEGRATION_ENCRYPTION_KEYS: duplicate key id ${id}`);
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`INTEGRATION_ENCRYPTION_KEYS: key ${id} must decode to exactly 32 bytes`);
    keys.set(id, key);
    last = id;
  }
  if (keys.size === 0) return null;
  const active = activeKeyId?.trim() || last;
  if (!keys.has(active)) throw new Error(`INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID ${active} is not in INTEGRATION_ENCRYPTION_KEYS`);
  return { keys, activeKeyId: active };
}

const b64 = (b: Buffer) => b.toString("base64url");

export function encryptSecret(ring: KeyRing | null, plaintext: string, aad: string): { ciphertext: string; keyId: string } {
  if (!ring) throw new EncryptionUnavailableError();
  const key = ring.keys.get(ring.activeKeyId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: `${ring.activeKeyId}.${b64(iv)}.${b64(tag)}.${b64(data)}`, keyId: ring.activeKeyId };
}

export function decryptSecret(ring: KeyRing | null, ciphertext: string, aad: string): string {
  if (!ring) throw new EncryptionUnavailableError();
  const [keyId, iv, tag, data, extra] = ciphertext.split(".");
  if (!keyId || !iv || !tag || !data || extra !== undefined) throw new Error("Malformed encrypted credential");
  const key = ring.keys.get(keyId);
  if (!key) throw new EncryptionUnavailableError(`Credential was encrypted with key ${keyId}, which is no longer configured`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

let cached: { spec?: string; active?: string; ring: KeyRing | null } | null = null;

/** The configured key ring, or null when no keys are configured. Throws on a malformed configuration. */
export function configuredKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing | null {
  const spec = env.INTEGRATION_ENCRYPTION_KEYS;
  const active = env.INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID;
  if (!cached || cached.spec !== spec || cached.active !== active) cached = { spec, active, ring: parseKeyRing(spec, active) };
  return cached.ring;
}
