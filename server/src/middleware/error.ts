import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { recordServerError } from "../platform/error-log.js";

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = request.id;
  const statusCode = error.statusCode ?? 500;
  const context = {
    err: error,
    requestId,
    method: request.method,
    url: request.url,
    statusCode,
    userId: request.authUser?.id,
    orgId: request.orgId,
  };

  // Zod validation errors from @fastify/type-provider-zod
  if (error.validation) {
    request.log.warn(context, "Request validation failed");
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.validation,
        requestId,
      },
    });
    return;
  }

  // JWT errors
  if (statusCode === 401) {
    request.log.warn(context, "Authentication rejected");
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Authentication required", requestId },
    });
    return;
  }

  // Log unexpected errors but never expose stack traces in the response.
  if (statusCode >= 500) {
    request.log.error(context, "Internal server error");
    recordServerError({ requestId, method: request.method, route: request.routeOptions?.url ?? "(unmatched)", statusCode, errorClass: error.name || "Error" });
    reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      },
    });
    return;
  }

  // @fastify/rate-limit errors carry no code; give clients a stable one (Retry-After is set by the plugin).
  if (statusCode === 429) {
    request.log.warn(context, "Rate limited");
    reply.status(429).send({ error: { code: "RATE_LIMITED", message: error.message || "Too many requests", requestId } });
    return;
  }

  request.log.warn(context, "Request failed");
  reply.status(statusCode).send({
    error: {
      code: error.code ?? "ERROR",
      message: error.message,
      requestId,
    },
  });
}

/** Error that is safe to expose to API callers (carries an HTTP status and stable code). */
export class AppError extends Error {
  constructor(message: string, public statusCode: number, public code: string) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * True only for deliberate application errors (statusCode 4xx + string code,
 * as thrown by services). Driver/network errors (pg, DNS) never match, so
 * callers should rethrow them to the central handler.
 */
export function isAppError(err: unknown): err is { statusCode: number; code: string; message: string } {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  return typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500
    && typeof e.code === "string" && typeof e.message === "string";
}
