import { config } from "../config.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import { query, withTransaction, type Queryable } from "../db/client.js";
import { generatePassword, hashPassword, register } from "../services/auth.service.js";
import { AdminError } from "./integrations.js";
import type { Role } from "../types.js";

/**
 * Platform user administration (Admin → Users & Access). Platform admins are
 * the users listed in PLATFORM_ADMIN_USER_IDS; their admin status is
 * deployment configuration and cannot be granted or revoked here.
 */

export const isPlatformAdminId = (id: string) => config.PLATFORM_ADMIN_USER_IDS.includes(id.toLowerCase());

export interface AdminUserRow {
  id: string;
  email: string;
  full_name: string | null;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
  active_sessions: number;
  memberships: Array<{ orgId: string; orgName: string; role: Role }>;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.active, u.created_at, u.last_login_at,
         (SELECT COUNT(*)::int FROM refresh_tokens r WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.expires_at > NOW()) AS active_sessions,
         COALESCE((SELECT json_agg(json_build_object('orgId', m.org_id, 'orgName', o.name, 'role', m.role) ORDER BY o.name)
                     FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id), '[]'::json) AS memberships
    FROM users u`;

const present = (u: AdminUserRow) => ({ ...u, isPlatformAdmin: isPlatformAdminId(u.id) });

export async function listUsers(opts: { search?: string; status?: "active" | "inactive"; limit: number; cursor?: string }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.search) {
    params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }
  if (opts.status) where.push(opts.status === "active" ? "u.active = TRUE" : "u.active = FALSE");
  if (opts.cursor) {
    const c = decodeCursor<{ t: string; id: string }>(opts.cursor, (x) => typeof x.t === "string" && typeof x.id === "string");
    params.push(c.t, c.id);
    where.push(`(u.created_at, u.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(opts.limit + 1);
  const { rows } = await query<AdminUserRow>(
    `${USER_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY u.created_at DESC, u.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return { users: page.map(present), nextCursor: more && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

const ACCESS_EVENTS = ["login", "login_failed", "logout", "user_registered", "password_reset_requested", "password_reset_completed",
  "admin_user_deactivated", "admin_user_activated", "admin_sessions_revoked", "admin_role_changed", "admin_credentials_generated", "admin_password_reset_initiated"];

export async function getUser(userId: string) {
  const { rows } = await query<AdminUserRow>(`${USER_SELECT} WHERE u.id = $1`, [userId]);
  if (!rows[0]) throw new AdminError(404, "USER_NOT_FOUND", "User not found.");
  // Events about the user (as actor or as subject); metadata is not returned (it can hold emails or IPs).
  const events = await query<{ timestamp: Date; action: string; result: string; user_id: string | null; request_id: string | null }>(
    `SELECT timestamp, action, result, user_id, request_id FROM audit_log
      WHERE (user_id = $1 OR (resource_type = 'user' AND resource_id = $1)) AND action = ANY($2)
      ORDER BY timestamp DESC LIMIT 30`,
    [userId, ACCESS_EVENTS],
  );
  return { user: present(rows[0]), events: events.rows.map((e) => ({ ...e, byUser: e.user_id === userId ? "self" : e.user_id ? "admin" : null })) };
}

async function activePlatformAdminCount(excluding: string): Promise<number> {
  const ids = config.PLATFORM_ADMIN_USER_IDS.filter((id) => id !== excluding.toLowerCase());
  if (!ids.length) return 0;
  const { rows } = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND active = TRUE", [ids]);
  return rows[0].n;
}

export async function setUserActive(actorId: string, userId: string, active: boolean): Promise<{ revokedSessions: number }> {
  if (!active && actorId === userId) throw new AdminError(409, "CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account.");
  if (!active && isPlatformAdminId(userId) && (await activePlatformAdminCount(userId)) === 0) {
    throw new AdminError(409, "LAST_PLATFORM_ADMIN", "This is the last active platform administrator; deactivating it would lock everyone out of administration.");
  }
  return withTransaction(async (tx) => {
    const { rowCount } = await tx.query("UPDATE users SET active = $2, updated_at = NOW() WHERE id = $1", [userId, active]);
    if (!rowCount) throw new AdminError(404, "USER_NOT_FOUND", "User not found.");
    // Deactivation ends every session; access tokens stop working on org routes immediately (membership check reads users.active).
    const revoked = active ? { rowCount: 0 } : await tx.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    return { revokedSessions: revoked.rowCount ?? 0 };
  });
}

export async function revokeSessions(userId: string): Promise<{ revokedSessions: number }> {
  const exists = await query("SELECT 1 FROM users WHERE id = $1", [userId]);
  if (!exists.rows[0]) throw new AdminError(404, "USER_NOT_FOUND", "User not found.");
  const { rowCount } = await query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  return { revokedSessions: rowCount ?? 0 };
}

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

/** Changes a member's role in one organization; the organization always keeps an active owner. */
export async function changeRole(userId: string, orgId: string, role: Role): Promise<{ from: Role; to: Role }> {
  if (!ROLES.includes(role)) throw new AdminError(400, "VALIDATION_ERROR", "Unknown role.");
  return withTransaction(async (tx) => {
    // Lock the organization's memberships so two concurrent demotions cannot both pass the owner check.
    const { rows: members } = await tx.query<{ user_id: string; role: Role; active: boolean }>(
      "SELECT m.user_id, m.role, u.active FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.user_id FOR UPDATE OF m",
      [orgId],
    );
    const current = members.find((m) => m.user_id === userId);
    if (!current) throw new AdminError(404, "MEMBERSHIP_NOT_FOUND", "This user is not a member of that organization.");
    if (current.role === role) return { from: current.role, to: role };
    if (current.role === "owner" && !members.some((m) => m.user_id !== userId && m.role === "owner" && m.active)) {
      throw new AdminError(409, "LAST_OWNER", "This is the organization's last active owner. Make another member owner first.");
    }
    await tx.query("UPDATE memberships SET role = $3 WHERE user_id = $1 AND org_id = $2", [userId, orgId, role]);
    return { from: current.role, to: role };
  });
}

// ─── One-click login credentials for the designated account ──────────────────

const DUPLICATE_WINDOW_SECONDS = 15;

export type GenerateOutcome =
  | { kind: "confirmation_required"; userId: string; active: boolean }
  | { kind: "generated"; userId: string; email: string; password: string; created: boolean; active: boolean; revokedSessions: number };

/**
 * Creates the designated account (ADMIN_CREDENTIAL_ACCOUNT_EMAIL) through the
 * normal registration path, or, after explicit confirmation, replaces its
 * password. The password is generated here from the CSPRNG, stored only as a
 * bcrypt hash, and returned to the caller once. Requests are serialized, and
 * a second request within a few seconds is refused (double clicks).
 */
export async function generateAccountCredentials(confirmReset: boolean, ctx: { actorId: string; requestId: string }): Promise<GenerateOutcome> {
  const email = config.ADMIN_CREDENTIAL_ACCOUNT_EMAIL;
  // The success event is written inside the locked transaction: the next request
  // (waiting on the lock) then always sees it, so two concurrent confirmations
  // cannot both replace the password. It never contains the password.
  const recordGenerated = (tx: Queryable, userId: string, metadata: Record<string, unknown>) =>
    tx.query(
      "INSERT INTO audit_log (user_id, request_id, action, resource_type, resource_id, result, metadata) VALUES ($1,$2,'admin_credentials_generated','user',$3,'success',$4)",
      [ctx.actorId, ctx.requestId, userId, JSON.stringify(metadata)],
    );
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-credential-generation', 0))");
    const { rows } = await tx.query<{ id: string; active: boolean }>("SELECT id, active FROM users WHERE email = $1", [email]);
    const existing = rows[0];
    if (existing) {
      const recent = await tx.query(
        `SELECT 1 FROM audit_log WHERE action = 'admin_credentials_generated' AND resource_id = $1 AND result = 'success'
            AND timestamp > NOW() - make_interval(secs => $2) LIMIT 1`,
        [existing.id, DUPLICATE_WINDOW_SECONDS],
      );
      if (recent.rows[0]) throw new AdminError(409, "RECENTLY_GENERATED", "Credentials for this account were generated a few seconds ago. Use those, or wait and try again.");
      if (!confirmReset) return { kind: "confirmation_required", userId: existing.id, active: existing.active };
      const password = generatePassword();
      await tx.query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1", [existing.id, await hashPassword(password)]);
      await tx.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL", [existing.id]);
      const revoked = await tx.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [existing.id]);
      await recordGenerated(tx, existing.id, { created: false, revokedSessions: revoked.rowCount ?? 0 });
      return { kind: "generated", userId: existing.id, email, password, created: false, active: existing.active, revokedSessions: revoked.rowCount ?? 0 };
    }
    const password = generatePassword();
    // Same provisioning as self-registration (user + organization + owner membership).
    const { userId } = await register({ email, password, fullName: "ZigmaNeural", orgName: "ZigmaNeural" });
    await recordGenerated(tx, userId, { created: true, revokedSessions: 0 });
    return { kind: "generated", userId, email, password, created: true, active: true, revokedSessions: 0 };
  });
}
