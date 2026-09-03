import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import type { JwtPayload } from "../types.js";

const BCRYPT_ROUNDS = 12;

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

  if (rows.length === 0) {
    // Constant-time dummy compare to prevent user enumeration
    await bcrypt.compare("dummy", "$2b$12$invalidhashforthispath00000000000000000000000000000");
    throw Object.assign(new Error("Invalid email or password"), { statusCode: 401, code: "INVALID_CREDENTIALS" });
  }

  const user = rows[0];

  if (!user.active) {
    throw Object.assign(new Error("Account is disabled"), { statusCode: 403, code: "ACCOUNT_DISABLED" });
  }

  const passwordMatch = await bcrypt.compare(input.password, user.password_hash);
  if (!passwordMatch) {
    throw Object.assign(new Error("Invalid email or password"), { statusCode: 401, code: "INVALID_CREDENTIALS" });
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
}

export async function consumeRefreshToken(rawToken: string): Promise<RefreshResult> {
  const hash = createHash("sha256").update(rawToken).digest("hex");

  const { rows } = await query<{
    id: string; user_id: string; expires_at: string; revoked_at: string | null;
  }>(
    `UPDATE refresh_tokens
       SET revoked_at = NOW()
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     RETURNING id, user_id, expires_at, revoked_at`,
    [hash],
  );

  if (rows.length === 0) {
    throw Object.assign(new Error("Refresh token is invalid or revoked"), { statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  }

  const userId = rows[0].user_id;
  const { rows: userRows } = await query<{ email: string; active: boolean }>(
    "SELECT email, active FROM users WHERE id = $1",
    [userId]
  );
  if (userRows.length === 0 || !userRows[0].active) {
    throw Object.assign(new Error("Account is disabled"), { statusCode: 403, code: "ACCOUNT_DISABLED" });
  }
  const { rows: memberRows } = await query<{ org_id: string }>(
    "SELECT org_id FROM memberships WHERE user_id = $1",
    [userId]
  );

  return {
    userId,
    email: userRows[0].email,
    orgIds: memberRows.map((r) => r.org_id),
  };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  await query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hash]
  );
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
