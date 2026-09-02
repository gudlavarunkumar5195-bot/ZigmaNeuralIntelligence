import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorHandler } from "../middleware/error.js";

function makeBoundary() {
  const response = { statusCode: 0, body: undefined as unknown };
  const request = {
    id: "request-123",
    method: "POST",
    url: "/api/v1/example",
    authUser: { id: "user-123" },
    orgId: "org-123",
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
  const reply = {
    status: vi.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      response.body = body;
      return reply;
    }),
    getHeader: vi.fn(() => undefined),
  } as unknown as FastifyReply;
  return { request, reply, response };
}

describe("errorHandler", () => {
  it("logs request context and sanitizes unexpected errors", () => {
    const { request, reply, response } = makeBoundary();

    errorHandler(new Error("database password must not escape"), request, reply);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId: "request-123",
      },
    });
    expect(request.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-123",
        method: "POST",
        url: "/api/v1/example",
        userId: "user-123",
        orgId: "org-123",
        statusCode: 500,
      }),
      "Internal server error",
    );
  });

  it("logs expected client errors at warning level", () => {
    const { request, reply, response } = makeBoundary();
    const error = Object.assign(new Error("Invalid state"), { statusCode: 422, code: "INVALID_STATE" });

    errorHandler(error, request, reply);

    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({
      error: { code: "INVALID_STATE", message: "Invalid state", requestId: "request-123" },
    });
    expect(request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422 }),
      "Request failed",
    );
  });
});
