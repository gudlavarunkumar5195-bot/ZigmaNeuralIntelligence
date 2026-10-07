import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthUser, JwtPayload } from "../types.js";
import { query } from "../db/client.js";
import { config } from "../config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser;
    orgId: string;
  }
}

/**
 * Verifies the JWT access token (Bearer header).
 * Attaches authUser to the request.
 * Does NOT check org membership — use requireOrgMember for that.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    const payload = request.user as JwtPayload;
    request.authUser = {
      id: payload.sub,
      email: payload.email,
      orgIds: payload.orgIds ?? [],
    };
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Valid access token required" },
    });
  }
}

/**
 * Verifies org membership and attaches the resolved role.
 * Expects :orgId in route params or x-org-id header.
 */
export async function requireOrgMember(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const orgId =
    (request.params as Record<string, string>).orgId ??
    request.headers["x-org-id"];

  if (!orgId || typeof orgId !== "string") {
    return reply.status(400).send({
      error: { code: "ORG_REQUIRED", message: "Organization ID is required" },
    });
  }

  if (!UUID_RE.test(orgId)) {
    return reply.status(400).send({
      error: { code: "ORG_INVALID", message: "Organization ID must be a valid UUID" },
    });
  }

  const { rows } = await query(
    `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND u.active = TRUE`,
    [request.authUser.id, orgId]
  );

  if (rows.length === 0) {
    return reply.status(403).send({
      error: { code: "FORBIDDEN", message: "You are not a member of this organization" },
    });
  }

  request.authUser.role = rows[0].role;
  request.orgId = orgId;
}

/**
 * Requires the user to have one of the specified roles in the active org.
 */
export function requireRole(...roles: string[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.authUser?.role || !roles.includes(request.authUser.role)) {
      return reply.status(403).send({
        error: {
          code: "INSUFFICIENT_ROLE",
          message: `This action requires one of: ${roles.join(", ")}`,
        },
      });
    }
  };
}

/**
 * Builds a platform-admin guard. Platform admins are identified by user id
 * (PLATFORM_ADMIN_USER_IDS) and gate mutations of GLOBAL resources (model
 * catalog, agent enablement, global routing policy). It never replaces tenant
 * membership/role checks: use it after requireOrgMember/requireRole.
 * An empty list denies everyone (fail closed).
 */
export function createRequirePlatformAdmin(getAdminIds: () => readonly string[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const id = request.authUser?.id?.toLowerCase();
    if (!id || !getAdminIds().includes(id)) {
      return reply.status(403).send({
        error: {
          code: "PLATFORM_ADMIN_REQUIRED",
          message: "This action changes platform-wide settings and requires a platform administrator.",
        },
      });
    }
  };
}

export const requirePlatformAdmin = createRequirePlatformAdmin(() => config.PLATFORM_ADMIN_USER_IDS);
