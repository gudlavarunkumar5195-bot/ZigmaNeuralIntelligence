import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";

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
    reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      },
    });
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
