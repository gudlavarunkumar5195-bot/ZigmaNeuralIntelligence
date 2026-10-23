/**
 * Fastify <-> Sentry wiring. Call `registerSentry(app)` right after the
 * Fastify instance is created (before routes). No-op unless Sentry is enabled.
 */
import * as Sentry from "@sentry/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isSentryEnabled, shouldReportError } from "./sentry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque identifiers only (never email). Resolved lazily: auth runs after onRequest. */
export function requestIdentity(request: FastifyRequest): { userId?: string; orgId?: string } {
  const r = request as FastifyRequest & { authUser?: { id?: unknown }; user?: unknown; orgId?: unknown };
  const sub = r.user && typeof r.user === "object" ? (r.user as { sub?: unknown }).sub : undefined;
  const userId = typeof r.authUser?.id === "string" ? r.authUser.id : typeof sub === "string" ? sub : undefined;
  const header = request.headers["x-org-id"];
  const candidate = typeof r.orgId === "string" ? r.orgId : typeof header === "string" ? header : undefined;
  const orgId = candidate && UUID_RE.test(candidate) ? candidate : undefined;
  return { userId: userId && userId.length <= 128 ? userId : undefined, orgId };
}

export function registerSentry(app: FastifyInstance): void {
  if (!isSentryEnabled()) return;

  // Reports thrown handler errors and hook errors; 4xx are filtered out.
  Sentry.setupFastifyErrorHandler(app, { shouldHandleError: (error) => shouldReportError(error) });

  app.addHook("onRequest", async (request) => {
    const scope = Sentry.getIsolationScope();
    scope.setTag("request_id", request.id);
    scope.setTag("http.method", request.method);
    scope.setTag("route", request.routeOptions?.url ?? "(unmatched)");
    // Identity is attached when an event is actually built, because
    // authenticate/requireOrgMember run later in the request lifecycle.
    scope.addEventProcessor((event) => {
      const { userId, orgId } = requestIdentity(request);
      if (userId) event.user = { id: userId };
      if (orgId) event.tags = { ...event.tags, org_id: orgId };
      return event;
    });
  });
}
