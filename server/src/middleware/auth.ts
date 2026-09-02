import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthUser, JwtPayload } from "../types.js";
import { query } from "../db/client.js";

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

  const { rows } = await query(
    "SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2",
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
