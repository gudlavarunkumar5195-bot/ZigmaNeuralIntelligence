// Phase 11: model intelligence API (autonomous router, budgets, quality, security).
//
// GET  /status                 router health: catalog freshness, quotas, settings version   (member)
// GET  /models                 catalog with pricing class, eligibility, freshness, health   (admin)
// GET  /settings               router settings                                               (admin)
// PUT  /settings               replace router settings                                       (platform admin)
// POST /quota/sync             read the provider's free allowance (no inference)             (platform admin)
// POST /feasibility            preview whether a task can run, without calling a model       (member)
// GET  /usage                  this organization's estimated vs actual usage                 (admin)
// GET  /tasks, /tasks/:id      task runs with attempts, fallbacks, agents and evaluations    (admin)
// POST /tasks/:id/cancel       request cancellation                                          (admin)
// POST /tasks/:id/feedback     rate a completed result (one vote per user)                   (member)
// GET  /quality                evaluation summaries by model and task category               (admin)
// GET  /security-events        injection signals, blocked tools and policy refusals          (admin)
// GET  /tools                  registered tools and their risk                               (member)
// GET  /approvals              tool approvals                                                (admin)
// POST /approvals/:id/decision approve or deny a pending tool call                           (admin)
//
// Every query is scoped to the caller's organization except global catalog,
// settings and quota data, which contain no tenant information. No secret is
// ever returned.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, requireOrgMember, requireRole, requirePlatformAdmin } from "../middleware/auth.js";
import { uuidParams } from "../middleware/validate.js";
import { query } from "../db/client.js";
import { getRouterSettings, updateRouterSettings, RouterSettingsError, ROUTER_TASK_TYPES } from "../ai/router/settings.js";
import { getPoolStatus, syncProviderQuota, getModelHealth, isCoolingDown } from "../ai/quota.js";
import { getCatalogStatus } from "../ai/catalog.service.js";
import { resolveRouting } from "../ai/router/index.js";
import { classifyTask, FEATURE_CATEGORY } from "../ai/router/task-profiles.js";
import { orgTokensUsed, requestTaskCancel } from "../ai/task-runs.js";
import { recordUserFeedback, FeedbackError } from "../ai/evaluation.js";
import { listTools, listApprovals, decideApproval, ToolError, type OrgRole } from "../ai/tools/registry.js";
import { paidModelsAllowed } from "../ai/governance.js";
import { TOKEN_ESTIMATE_METHOD } from "../ai/tokens.js";
import { config } from "../config.js";
import type { TaskType } from "../ai/router/types.js";
import { resolveSecret } from "../platform/credential-store.js";

const limitParam = (raw: unknown, def = 50, max = 200) => Math.min(Math.max(parseInt(String(raw ?? def), 10) || def, 1), max);
const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: "VALIDATION_ERROR", message } });

const FEASIBILITY_MESSAGES: Record<string, string> = {
  FEASIBLE: "This task can run now within the free-model limits.",
  FEASIBLE_WITH_REDUCTION: "This task can run, but some optional context will be left out to fit the model.",
  SPLIT_REQUIRED: "This task is too large for any available free model. Split it into smaller parts (for example, fewer pages or a shorter date range).",
  INSUFFICIENT_BUDGET: "The AI allowance is used up for now. Try again after the daily reset, or ask an administrator to adjust the limits.",
  NO_ELIGIBLE_MODEL: "No free model currently meets this task's requirements. Try again later; models recover from rate limits automatically.",
  BLOCKED_BY_POLICY: "This request is not permitted by the AI policy.",
};

export async function aiRouterRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preValidation", uuidParams("id"));
  const member = [authenticate, requireOrgMember];
  const admin = [authenticate, requireOrgMember, requireRole("owner", "admin")];
  const platformAdmin = [authenticate, requireOrgMember, requireRole("owner", "admin"), requirePlatformAdmin];

  fastify.get("/status", { preHandler: member }, async (_request, reply) => {
    const { settings, version, updatedAt } = await getRouterSettings();
    const [catalog, pools, counts] = await Promise.all([
      getCatalogStatus(),
      getPoolStatus(settings),
      query<{ pricing_class: string; n: string }>("SELECT pricing_class, COUNT(*) AS n FROM models WHERE enabled GROUP BY pricing_class"),
    ]);
    const lastRefresh = catalog.lastRefreshAt ? new Date(catalog.lastRefreshAt).getTime() : 0;
    return reply.send({
      data: {
        providerConfigured: !!resolveSecret("openrouter"),
        paidModelsAllowed: paidModelsAllowed(),
        catalog: {
          lastRefreshAt: catalog.lastRefreshAt,
          lastRefreshStatus: catalog.lastRefreshStatus,
          stale: !lastRefresh || Date.now() - lastRefresh > settings.catalog.maxStaleHours * 3_600_000,
          modelsByPricingClass: Object.fromEntries(counts.rows.map((r) => [r.pricing_class, Number(r.n)])),
        },
        quotas: pools,
        settings: { version, updatedAt, trialsEnabled: settings.trials.enabled },
        tokenEstimate: TOKEN_ESTIMATE_METHOD,
      },
    });
  });

  fastify.get("/models", { preHandler: admin }, async (request, reply) => {
    const q = request.query as { pricingClass?: string; limit?: string; offset?: string };
    const cls = q.pricingClass && ["FREE", "TRIAL", "PAID", "UNKNOWN"].includes(q.pricingClass) ? q.pricingClass : null;
    const { settings } = await getRouterSettings();
    const { rows } = await query<Record<string, unknown> & { openrouter_id: string }>(
      `SELECT m.id, m.openrouter_id, m.display_name, m.provider, m.pricing_class, m.free_status, m.status, m.eligibility_status, m.enabled,
              m.context_length, m.max_completion_tokens, m.reasoning_mandatory, m.supports_tool_calling, m.supports_structured_output,
              m.supports_json_schema, m.is_router, m.expires_at, m.pricing_checked_at, m.output_modalities,
              m.benchmark_intelligence, m.benchmark_coding, m.benchmark_agentic,
              (SELECT COUNT(*) FROM ai_model_evaluations e WHERE e.model = m.openrouter_id AND e.created_at > NOW() - INTERVAL '90 days') AS evaluations
         FROM models m
        WHERE ($1::text IS NULL OR m.pricing_class = $1)
        ORDER BY (m.pricing_class = 'FREE') DESC, (m.pricing_class = 'TRIAL') DESC, m.display_name
        LIMIT $2 OFFSET $3`,
      [cls, limitParam(q.limit, 100, 500), Math.max(0, parseInt(q.offset ?? "0", 10) || 0)],
    );
    const health = await getModelHealth(rows.map((r) => r.openrouter_id));
    const staleMs = settings.catalog.maxStaleHours * 3_600_000;
    return reply.send({
      data: rows.map((r) => {
        const h = health.get(r.openrouter_id);
        const checked = r.pricing_checked_at ? new Date(r.pricing_checked_at as string).getTime() : 0;
        return {
          ...r,
          evaluations: Number(r.evaluations),
          pricingFresh: !!checked && Date.now() - checked <= staleMs,
          excludedByAdmin: settings.models.excluded.includes(r.openrouter_id),
          health: h ? { coolingDown: isCoolingDown(h), cooldownUntil: h.cooldownUntil, consecutiveFailures: h.consecutiveFailures, lastFailureCategory: h.lastFailureCategory } : null,
          qualityConfidence: Number(r.evaluations) >= settings.quality.minSamples ? "measured" : "insufficient_data",
        };
      }),
    });
  });

  fastify.get("/settings", { preHandler: admin }, async (_request, reply) => {
    const s = await getRouterSettings();
    return reply.send({ data: { ...s, paidModelsAllowed: paidModelsAllowed(), taskTypes: ROUTER_TASK_TYPES } });
  });

  fastify.put("/settings", { preHandler: platformAdmin }, async (request, reply) => {
    const body = z.object({ settings: z.unknown(), expectedVersion: z.number().int().min(0).optional() }).safeParse(request.body);
    if (!body.success) return bad(reply, "Body must be { settings, expectedVersion? }");
    try {
      const updated = await updateRouterSettings(body.data.settings, request.authUser.id, body.data.expectedVersion);
      return reply.send({ data: updated });
    } catch (err) {
      if (err instanceof RouterSettingsError) {
        return reply.status(err.message.includes("changed by someone else") ? 409 : 400).send({ error: { code: "INVALID_SETTINGS", message: err.message, issues: err.issues } });
      }
      throw err;
    }
  });

  fastify.post("/quota/sync", { preHandler: platformAdmin }, async (_request, reply) => {
    const r = await syncProviderQuota();
    return reply.send({ data: r });
  });

  fastify.post("/feasibility", { preHandler: member }, async (request, reply) => {
    const parsed = z.object({
      taskType: z.enum(ROUTER_TASK_TYPES).optional(),
      feature: z.enum(Object.keys(FEATURE_CATEGORY) as [string, ...string[]]).optional(),
      inputChars: z.number().int().min(0).max(5_000_000).optional(),
      requireJson: z.boolean().default(false),
    }).safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, parsed.error.issues.map((i) => i.message).join("; "));
    const profile = classifyTask({ taskType: parsed.data.taskType, feature: parsed.data.feature });
    const { settings } = await getRouterSettings();
    // Characters → tokens with the same conservative estimator the executor uses.
    // Same conservative ratio as the executor's estimator (one token per 3 bytes), without allocating the text.
    const estimatedInput = Math.ceil((parsed.data.inputChars ?? 2_000) / 3) + 32;
    const [decision, pools, used] = await Promise.all([
      resolveRouting({
        requirements: {
          taskType: profile.category as TaskType, complexity: profile.tier === "HEAVY" ? "HIGH" : "MEDIUM", riskLevel: "MEDIUM",
          requiredCapabilities: [], preferredCapabilities: [], structuredOutputRequired: parsed.data.requireJson,
          toolCallingRequired: false, visionRequired: false, estimatedInputTokens: estimatedInput, orgId: request.orgId,
        },
        orgId: request.orgId, simulate: true, correlationId: crypto.randomUUID(), feature: parsed.data.feature,
      }),
      getPoolStatus(settings),
      orgTokensUsed({ query }, request.orgId),
    ]);
    const free = pools.find((p) => p.pool === "FREE");
    const need = estimatedInput + profile.desiredOutputTokens;
    let feasibility: string;
    if (estimatedInput > settings.perTask.maxInputTokens) feasibility = profile.splittable ? "SPLIT_REQUIRED" : "BLOCKED_BY_POLICY";
    else if ((free?.remaining ?? 0) <= 0 || used + need > settings.perOrg.dailyTokens) feasibility = "INSUFFICIENT_BUDGET";
    else if (decision.status !== "RESOLVED") feasibility = decision.excludedCandidates.some((e) => e.reason === "CONTEXT_TOO_SHORT") && profile.splittable ? "SPLIT_REQUIRED" : "NO_ELIGIBLE_MODEL";
    else feasibility = "FEASIBLE";
    return reply.send({
      data: {
        feasibility,
        message: FEASIBILITY_MESSAGES[feasibility],
        taskCategory: profile.category,
        estimatedInputTokens: estimatedInput,
        reservedOutputTokens: profile.desiredOutputTokens,
        estimate: TOKEN_ESTIMATE_METHOD,
        selectedModel: decision.selectedModel?.openrouterId ?? null,
        fallbacks: decision.fallbackModels.map((f) => f.openrouterId),
        reason: decision.decisionReason,
        exclusions: summarizeExclusions(decision.excludedCandidates),
        budget: { orgTokensUsed24h: used, orgTokenLimit24h: settings.perOrg.dailyTokens, freeRequestsRemaining: free?.remaining ?? 0 },
      },
    });
  });

  fastify.get("/usage", { preHandler: admin }, async (request, reply) => {
    const days = Math.min(Math.max(parseInt((request.query as { days?: string }).days ?? "7", 10) || 7, 1), 90);
    const [byModel, reservations] = await Promise.all([
      query(
        `SELECT model_id AS model, COUNT(*) AS attempts,
                COUNT(*) FILTER (WHERE status='completed') AS completed,
                COUNT(*) FILTER (WHERE failure_category IS NOT NULL) AS failed,
                COALESCE(SUM(estimated_input_tokens),0) AS estimated_input,
                COALESCE(SUM(estimated_output_tokens),0) AS reserved_output,
                COALESCE(SUM(prompt_tokens) FILTER (WHERE usage_estimated = FALSE),0) AS provider_input,
                COALESCE(SUM(completion_tokens) FILTER (WHERE usage_estimated = FALSE),0) AS provider_output,
                COUNT(*) FILTER (WHERE usage_estimated = TRUE) AS estimated_only,
                COALESCE(SUM(cost_usd),0)::text AS reported_cost_usd,
                MAX(pricing_class) AS pricing_class
           FROM agent_executions
          WHERE org_id=$1 AND execution_kind='MODEL_ATTEMPT' AND started_at > NOW() - ($2 || ' days')::interval
          GROUP BY model_id ORDER BY attempts DESC LIMIT 100`,
        [request.orgId, String(days)],
      ),
      query(
        `SELECT status, usage_source, COUNT(*) AS n, COALESCE(SUM(reserved_tokens),0) AS reserved,
                COALESCE(SUM(COALESCE(actual_input,0)+COALESCE(actual_output,0)),0) AS settled
           FROM ai_token_reservations WHERE org_id=$1 AND created_at > NOW() - ($2 || ' days')::interval
          GROUP BY status, usage_source`,
        [request.orgId, String(days)],
      ),
    ]);
    const { settings } = await getRouterSettings();
    return reply.send({
      data: {
        days,
        byModel: byModel.rows,
        reservations: reservations.rows,
        orgTokensUsed24h: await orgTokensUsed({ query }, request.orgId),
        orgTokenLimit24h: settings.perOrg.dailyTokens,
        note: "Provider figures are reported by OpenRouter; estimated figures use a conservative approximation and are labelled as such.",
      },
    });
  });

  fastify.get("/tasks", { preHandler: admin }, async (request, reply) => {
    const q = request.query as { limit?: string; status?: string };
    const { rows } = await query(
      `SELECT id, task_type, feature, status, feasibility, selected_model, error_code, tokens_used, tokens_reserved, calls_used, agents_used, started_at, completed_at
         FROM ai_task_runs WHERE org_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY started_at DESC LIMIT $3`,
      [request.orgId, q.status && /^[A-Z]{1,20}$/.test(q.status) ? q.status : null, limitParam(q.limit)],
    );
    return reply.send({ data: rows });
  });

  fastify.get("/tasks/:id", { preHandler: admin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const { rows } = await query("SELECT * FROM ai_task_runs WHERE id=$1 AND org_id=$2", [id, request.orgId]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Task not found" } });
    const [attempts, agents, evaluations, decisions, feedback] = await Promise.all([
      query(
        `SELECT model_id AS model, attempt_number, status, failure_category, fallback_reason, pricing_class, latency_ms,
                estimated_input_tokens, estimated_output_tokens, prompt_tokens, completion_tokens, usage_estimated, cost_usd, started_at
           FROM agent_executions WHERE task_run_id=$1 AND org_id=$2 AND execution_kind='MODEL_ATTEMPT' ORDER BY started_at`,
        [id, request.orgId],
      ),
      query("SELECT id, parent_id, role, depth, status, model, error_code, started_at, completed_at FROM ai_agent_runs WHERE task_run_id=$1 AND org_id=$2 ORDER BY started_at", [id, request.orgId]),
      query("SELECT model, task_type, outcome, quality_score, method, confidence, validators, security_violation, created_at FROM ai_model_evaluations WHERE task_run_id=$1 AND org_id=$2 ORDER BY created_at", [id, request.orgId]),
      query("SELECT id, selected_openrouter_id, fallback_openrouter_ids, decision_reason, decision_source, decision_confidence, candidate_count, excluded_count FROM routing_decisions WHERE task_run_id=$1 AND org_id=$2", [id, request.orgId]),
      query("SELECT rating, reason, created_at FROM ai_feedback WHERE task_run_id=$1 AND org_id=$2", [id, request.orgId]),
    ]);
    return reply.send({ data: { ...rows[0], attempts: attempts.rows, agents: agents.rows, evaluations: evaluations.rows, routing: decisions.rows, feedback: feedback.rows } });
  });

  fastify.post("/tasks/:id/cancel", { preHandler: admin }, async (request, reply) => {
    const ok = await requestTaskCancel((request.params as { id: string }).id, request.orgId);
    return ok ? reply.send({ data: { cancelRequested: true } }) : reply.status(404).send({ error: { code: "NOT_FOUND", message: "No running task with that id" } });
  });

  fastify.post("/tasks/:id/feedback", { preHandler: member }, async (request, reply) => {
    const parsed = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), reason: z.enum(["incorrect", "incomplete", "off_topic", "unsafe", "format", "helpful", "accurate", "other"]).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return bad(reply, "rating must be 1 or -1");
    if (request.authUser.role === "viewer") return reply.status(403).send({ error: { code: "INSUFFICIENT_ROLE", message: "Viewers cannot rate results" } });
    try {
      await recordUserFeedback({ orgId: request.orgId, taskRunId: (request.params as { id: string }).id, userId: request.authUser.id, rating: parsed.data.rating, reason: parsed.data.reason ?? null });
      return reply.status(201).send({ data: { recorded: true } });
    } catch (err) {
      if (err instanceof FeedbackError) return reply.status(err.status).send({ error: { code: err.status === 409 ? "ALREADY_RATED" : "NOT_FOUND", message: err.message } });
      throw err;
    }
  });

  fastify.get("/quality", { preHandler: admin }, async (request, reply) => {
    const { settings } = await getRouterSettings();
    // Organization admins see their own organization's evaluations; platform administrators
    // see the cross-organization aggregate the router learns from (scores only, no content).
    const global = config.PLATFORM_ADMIN_USER_IDS.includes(request.authUser.id);
    const { rows } = await query<{ model: string; task_type: string; n: string; org_n: string; avg_score: string | null; pass_rate: string | null; security_violations: string; user_ratings: string; last_at: Date }>(
      `SELECT model, task_type, COUNT(*) AS n, COUNT(*) FILTER (WHERE org_id=$1) AS org_n,
              ROUND(AVG(quality_score)::numeric, 1)::text AS avg_score,
              ROUND((COUNT(*) FILTER (WHERE outcome='PASS'))::numeric / NULLIF(COUNT(*),0) * 100, 1)::text AS pass_rate,
              COUNT(*) FILTER (WHERE security_violation) AS security_violations,
              COUNT(*) FILTER (WHERE method='USER_FEEDBACK') AS user_ratings,
              MAX(created_at) AS last_at
         FROM ai_model_evaluations WHERE created_at > NOW() - INTERVAL '90 days' AND ($2::boolean OR org_id = $1)
        GROUP BY model, task_type ORDER BY n DESC LIMIT 300`,
      [request.orgId, global],
    );
    return reply.send({
      data: rows.map((r) => ({
        model: r.model, taskType: r.task_type, evaluations: Number(r.n), orgEvaluations: Number(r.org_n),
        averageScore: r.avg_score === null ? null : Number(r.avg_score), passRate: r.pass_rate === null ? null : Number(r.pass_rate),
        securityViolations: Number(r.security_violations), userRatings: Number(r.user_ratings), lastEvaluatedAt: r.last_at,
        confidence: Number(r.n) >= settings.quality.minSamples ? "measured" : "insufficient_data",
      })),
      minSamples: settings.quality.minSamples,
      scope: global ? "all_organizations" : "this_organization",
    });
  });

  fastify.get("/security-events", { preHandler: admin }, async (request, reply) => {
    const q = request.query as { limit?: string; kind?: string };
    const { rows } = await query(
      `SELECT id, kind, severity, source, categories, model, detail, task_run_id, created_at
         FROM ai_security_events WHERE org_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at DESC LIMIT $3`,
      [request.orgId, q.kind && /^[A-Z_]{1,40}$/.test(q.kind) ? q.kind : null, limitParam(q.limit)],
    );
    return reply.send({ data: rows });
  });

  fastify.get("/tools", { preHandler: member }, async (_request, reply) => reply.send({ data: listTools() }));

  fastify.get("/approvals", { preHandler: admin }, async (request, reply) => {
    const q = request.query as { status?: string; limit?: string };
    const status = q.status && ["PENDING", "APPROVED", "DENIED", "EXPIRED", "USED"].includes(q.status) ? q.status : undefined;
    return reply.send({ data: await listApprovals(request.orgId, status, limitParam(q.limit)) });
  });

  fastify.post("/approvals/:id/decision", { preHandler: admin }, async (request, reply) => {
    const parsed = z.object({ approve: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return bad(reply, "Body must be { approve: boolean }");
    try {
      const status = await decideApproval({ orgId: request.orgId, approvalId: (request.params as { id: string }).id, deciderId: request.authUser.id, deciderRole: request.authUser.role as OrgRole, approve: parsed.data.approve });
      return reply.send({ data: { status } });
    } catch (err) {
      if (err instanceof ToolError) {
        const code = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
        return reply.status(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}

function summarizeExclusions(excluded: Array<{ reason: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of excluded) out[e.reason] = (out[e.reason] ?? 0) + 1;
  return out;
}
