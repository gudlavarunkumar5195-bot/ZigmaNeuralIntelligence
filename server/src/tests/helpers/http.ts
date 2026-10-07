/**
 * Reusable Fastify inject() harness.
 *
 *   const h = await createHarness();            // builds the real app (no listen)
 *   const res = await h.request("POST", "/api/v1/websites", { token, orgId, payload });
 *   await h.close();
 *
 * Token minting uses the app's own JWT signer and needs no database. Seeding
 * (seedOrg/seedUser) writes to the database and must only be used inside
 * suites gated with INTEGRATION.
 */
import type { FastifyInstance } from "fastify";
import type { Role } from "../../types.js";

export const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

export interface RequestOptions {
  token?: string;
  orgId?: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

export interface Harness {
  app: FastifyInstance;
  request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts?: RequestOptions): ReturnType<FastifyInstance["inject"]>;
  mintToken(user: { id: string; email: string; orgIds?: string[] }, opts?: { expiresIn?: string }): string;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const { buildApp } = await import("../../app.js");
  const app = await buildApp();
  await app.ready();
  return {
    app,
    request(method, url, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.orgId) headers["x-org-id"] = opts.orgId;
      return app.inject({ method, url, headers, payload: opts.payload as never });
    },
    mintToken(user, o) {
      return app.jwt.sign(
        { sub: user.id, email: user.email, orgIds: user.orgIds ?? [] },
        { expiresIn: o?.expiresIn ?? "15m" },
      );
    },
    async close() {
      await app.close();
    },
  };
}

export interface SeededUser {
  id: string;
  email: string;
  role: Role;
  orgId: string;
  token: string;
}

export interface SeededOrg {
  id: string;
  users: Record<Role, SeededUser>;
  websiteId: string;
  scanId: string;
  monitoringId: string;
}

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

/** Creates an org with one user per role, a verified website, a scan and a monitoring config. */
export async function seedOrg(h: Harness, label: string): Promise<SeededOrg> {
  const { query } = await import("../../db/client.js");
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orgId = (await query<{ id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id",
    [`Http ${suffix}`, `http-${suffix}`],
  )).rows[0].id;
  const users = {} as Record<Role, SeededUser>;
  for (const role of ROLES) {
    const email = `${role}-${suffix}@http-test.example`;
    const id = (await query<{ id: string }>(
      "INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id",
      [email, "!not-a-real-hash", `${role} ${label}`],
    )).rows[0].id;
    await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3)", [id, orgId, role]);
    users[role] = { id, email, role, orgId, token: h.mintToken({ id, email, orgIds: [orgId] }) };
  }
  const domain = `${suffix}.example`;
  const websiteId = (await query<{ id: string }>(
    "INSERT INTO websites (org_id, url, domain, verified, created_by) VALUES ($1,$2,$3,TRUE,$4) RETURNING id",
    [orgId, `https://${domain}`, domain, users.owner.id],
  )).rows[0].id;
  const scanId = (await query<{ id: string }>(
    "INSERT INTO scans (website_id, org_id, triggered_by, status, modules) VALUES ($1,$2,$3,'completed','{seo}') RETURNING id",
    [websiteId, orgId, users.owner.id],
  )).rows[0].id;
  const monitoringId = (await query<{ id: string }>(
    "INSERT INTO monitoring_configs (org_id, website_id, frequency, next_run_at) VALUES ($1,$2,'daily',NOW() + interval '1 day') RETURNING id",
    [orgId, websiteId],
  )).rows[0].id;
  return { id: orgId, users, websiteId, scanId, monitoringId };
}

export async function cleanupOrgs(orgIds: string[]): Promise<void> {
  const { query } = await import("../../db/client.js");
  const users = await query<{ user_id: string }>("SELECT user_id FROM memberships WHERE org_id = ANY($1::uuid[])", [orgIds]);
  const tables = (await query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='org_id' AND table_name <> 'organizations'",
  )).rows.map((r) => r.table_name);
  // Delete org-scoped rows; retry passes resolve FK ordering between children.
  let pending = tables;
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const failed: string[] = [];
    for (const t of pending) {
      try { await query(`DELETE FROM "${t}" WHERE org_id = ANY($1::uuid[])`, [orgIds]); } catch { failed.push(t); }
    }
    pending = failed;
  }
  await query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
  if (users.rows.length) await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users.rows.map((r) => r.user_id)]).catch(() => undefined);
}
