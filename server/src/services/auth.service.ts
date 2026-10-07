import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import type { JwtPayload } from "../types.js";

const BCRYPT_ROUNDS = 12;

// Valid-format bcrypt hash (same cost as real hashes) of random bytes, computed
// lazily once. Comparing against it makes unknown-email logins cost the same as
// wrong-password logins, preventing timing-based email enumeration.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash(randomBytes(32).toString("hex"), BCRYPT_ROUNDS);
  return dummyHashPromise;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
  fullName?: string;
  orgName: string;
}

export interface RegisterResult {
  userId: string;
  orgId: string;
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const email = input.email.toLowerCase().trim();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const slug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) +
               "-" + randomBytes(4).toString("hex");

  return withTransaction(async (client) => {
    // Check email uniqueness
    const existing = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(new Error("Email is already registered"), { statusCode: 409, code: "EMAIL_EXISTS" });
    }

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [email, passwordHash, input.fullName ?? null]
    );
    const userId = userResult.rows[0].id;

    const orgResult = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [input.orgName, slug]
    );
    const orgId = orgResult.rows[0].id;

    await client.query(
      `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
      [userId, orgId]
    );

    return { userId, orgId };
  });
}

// ─── Login ────────────────────────────────────────────────────────────────────

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  userId: string;
  email: string;
  fullName: string | null;
  orgIds: string[];
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const email = input.email.toLowerCase().trim();

  const { rows } = await query<{
    id: string; password_hash: string; full_name: string | null; active: boolean;
  }>(
    "SELECT id, password_hash, full_name, active FROM users WHERE email = $1",
    [email]
  );

  const invalid = () =>
    Object.assign(new Error("Invalid email or password"), { statusCode: 401, code: "INVALID_CREDENTIALS" });

  if (rows.length === 0) {
    await bcrypt.compare(input.password, await getDummyHash());
    throw invalid();
  }

  const user = rows[0];

  // Verify the password first so a disabled account is only revealed to
  // someone who knows the credentials.
  const passwordMatch = await bcrypt.compare(input.password, user.password_hash);
  if (!passwordMatch) throw invalid();

  if (!user.active) {
    throw Object.assign(new Error("Account is disabled"), { statusCode: 403, code: "ACCOUNT_DISABLED" });
  }

  const { rows: memberRows } = await query<{ org_id: string }>(
    "SELECT org_id FROM memberships WHERE user_id = $1",
    [user.id]
  );
  const orgIds = memberRows.map((r) => r.org_id);

  return { userId: user.id, email, fullName: user.full_name, orgIds };
}

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export async function createRefreshToken(userId: string): Promise<string> {
  const raw = randomBytes(48).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt.toISOString()]
  );

  return raw;
}

export interface RefreshResult {
  userId: string;
  orgIds: string[];
  email: string;
  /** Newly issued raw refresh token (rotated atomically with the revocation of the old one). */
  newRefreshToken: string;
}

const invalidRefresh = () =>
  Object.assign(new Error("Refresh token is invalid or revoked"), { statusCode: 401, code: "INVALID_REFRESH_TOKEN" });

/**
 * Rotates a refresh token: revokes the presented token and issues its
 * replacement in ONE transaction. Replaying an already-revoked token is treated
 * as theft: every refresh token of that user is revoked (reuse detection).
 */
export async function consumeRefreshToken(rawToken: string): Promise<RefreshResult> {
  const hash = createHash("sha256").update(rawToken).digest("hex");

  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE refresh_tokens
         SET revoked_at = NOW()
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING user_id`,
      [hash],
    );

    if (rows.length === 0) {
      const { rows: seen } = await client.query<{ user_id: string; revoked_at: string | null }>(
        "SELECT user_id, revoked_at FROM refresh_tokens WHERE token_hash = $1",
        [hash],
      );
      if (seen[0]?.revoked_at) {
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
          [seen[0].user_id],
        );
      }
      return { kind: "invalid" as const };
    }

    const userId = rows[0].user_id;
    const { rows: userRows } = await client.query<{ email: string; active: boolean }>(
      "SELECT email, active FROM users WHERE id = $1",
      [userId],
    );
    if (userRows.length === 0 || !userRows[0].active) return { kind: "disabled" as const };

    const { rows: memberRows } = await client.query<{ org_id: string }>(
      "SELECT org_id FROM memberships WHERE user_id = $1",
      [userId],
    );

    const newRaw = randomBytes(48).toString("hex");
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, createHash("sha256").update(newRaw).digest("hex"), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()],
    );

    return {
      kind: "ok" as const,
      result: { userId, email: userRows[0].email, orgIds: memberRows.map((r) => r.org_id), newRefreshToken: newRaw },
    };
  });

  if (outcome.kind === "invalid") throw invalidRefresh();
  if (outcome.kind === "disabled") {
    throw Object.assign(new Error("Account is disabled"), { statusCode: 403, code: "ACCOUNT_DISABLED" });
  }
  return outcome.result;
}

/** Revokes the token; returns the owning user id when a live token was revoked. */
export async function revokeRefreshToken(rawToken: string): Promise<string | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const { rows } = await query<{ user_id: string }>(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id",
    [hash]
  );
  return rows[0]?.user_id ?? null;
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

export function buildJwtPayload(userId: string, email: string, orgIds: string[]): JwtPayload {
  return { sub: userId, email, orgIds };
}
