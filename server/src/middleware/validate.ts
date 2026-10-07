import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const uuid = z.string().uuid();

/**
 * Builds a preValidation hook rejecting non-UUID values for the named path
 * params with 400 VALIDATION_ERROR before any handler/DB access (a non-UUID
 * reaching Postgres would raise 22P02 and surface as a 500).
 * Unauthenticated requests (no Authorization header) are skipped so they keep
 * receiving 401 from the authenticate guard.
 */
export function uuidParams(...names: string[]) {
  return async function validateUuidParams(request: FastifyRequest, reply: FastifyReply) {
    if (!request.headers.authorization) return;
    const params = (request.params ?? {}) as Record<string, unknown>;
    for (const name of names) {
      if (name in params && !uuid.safeParse(params[name]).success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: `Path parameter '${name}' must be a valid UUID`, requestId: request.id },
        });
      }
    }
  };
}
