import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = reply.getHeader("x-request-id") ?? request.id;

  // Zod validation errors from @fastify/type-provider-zod
  if (error.validation) {
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
  if (error.statusCode === 401) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Authentication required", requestId },
    });
    return;
  }

  // Log unexpected errors but never expose stack traces in production
  if (!error.statusCode || error.statusCode >= 500) {
    request.log.error({ err: error, requestId }, "Internal server error");
    reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      },
    });
    return;
  }

  reply.status(error.statusCode ?? 500).send({
    error: {
      code: error.code ?? "ERROR",
      message: error.message,
      requestId,
    },
  });
}
