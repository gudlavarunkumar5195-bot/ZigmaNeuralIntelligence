// Phase 11: server-enforced tool registry.
//
// Models may PROPOSE a tool call; only this module executes one, and only
// after every check passes in application code:
//   1. the tool exists and is on the task's explicit allowlist,
//   2. arguments validate against the tool's strict schema,
//   3. the authenticated user's real role satisfies the tool's permission,
//   4. HIGH/CRITICAL risk tools have an approval record bound to this exact
//      tool and argument hash, decided by an authorized human, unused and
//      unexpired (a model's claim of approval is never approval),
//   5. the call runs with a timeout, inside the caller's organization.
// Every refusal is recorded as a security event; every execution is audited.

import { createHash } from "node:crypto";
import { z } from "zod";
import { query } from "../../db/client.js";
import { audit } from "../../services/audit.service.js";
import { createAlertRule, listAlerts } from "../../services/monitoring.service.js";
import { recordSecurityEvent } from "../security/events.js";

export type ToolRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type OrgRole = "viewer" | "member" | "admin" | "owner";
const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export interface ToolContext {
  orgId: string;
  userId: string;
  /** The user's role as resolved by the auth middleware for this organization — never from model output. */
  role: OrgRole;
  taskRunId: string | null;
}

export interface ToolDefinition<A = unknown> {
  id: string;
  description: string;
  scope: "read" | "write";
  risk: ToolRisk;
  minRole: OrgRole;
  timeoutMs: number;
  /** Maximum serialized result size returned to a model. */
  maxResultChars: number;
  args: z.ZodType<A>;
  run: (ctx: ToolContext, args: A, signal: AbortSignal) => Promise<unknown>;
}

const uuid = z.string().uuid();

const TOOLS: ToolDefinition<never>[] = [
  {
    id: "alerts.list",
    description: "List recent monitoring alerts for the organization.",
    scope: "read",
    risk: "LOW",
    minRole: "viewer",
    timeoutMs: 5_000,
    maxResultChars: 8_000,
    args: z.object({ monitoringId: uuid.optional(), limit: z.number().int().min(1).max(25).default(10) }).strict(),
    run: async (ctx, args: { monitoringId?: string; limit: number }) => {
      const rows = (await listAlerts(ctx.orgId, args.monitoringId, args.limit, 0)) as Array<Record<string, unknown>>;
      // Only fields a model needs; never internal identifiers of other records.
      return rows.map((r) => ({ id: r.id, severity: r.severity, title: r.title, status: r.status, detectedAt: r.detected_at }));
    },
  } as ToolDefinition<{ monitoringId?: string; limit: number }> as unknown as ToolDefinition<never>,
  {
    id: "alerts.create_rule",
    description: "Create or update an alert rule on a monitoring configuration.",
    scope: "write",
    risk: "HIGH",
    minRole: "admin",
    timeoutMs: 5_000,
    maxResultChars: 2_000,
    args: z.object({ monitoringId: uuid, ruleType: z.string().regex(/^[a-z_]{1,60}$/), threshold: z.number().finite().min(0).max(1_000_000).nullable().default(null) }).strict(),
    run: async (ctx, args: { monitoringId: string; ruleType: string; threshold: number | null }) => {
      const rule = (await createAlertRule(args.monitoringId, ctx.orgId, { ruleType: args.ruleType, threshold: args.threshold })) as Record<string, unknown> | null;
      if (!rule) throw new ToolError("NOT_FOUND", "Monitoring configuration not found in this organization");
      return { id: rule.id, ruleType: rule.rule_type, threshold: rule.threshold, enabled: rule.enabled };
    },
  } as ToolDefinition<{ monitoringId: string; ruleType: string; threshold: number | null }> as unknown as ToolDefinition<never>,
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function listTools(): Array<Pick<ToolDefinition, "id" | "description" | "scope" | "risk" | "minRole">> {
  return TOOLS.map(({ id, description, scope, risk, minRole }) => ({ id, description, scope, risk, minRole }));
}

export class ToolError extends Error {
  constructor(public readonly code: "UNKNOWN_TOOL" | "NOT_ALLOWED" | "INVALID_ARGUMENTS" | "FORBIDDEN" | "APPROVAL_REQUIRED" | "TIMEOUT" | "NOT_FOUND" | "FAILED", message: string, public readonly approvalId?: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Canonical JSON (sorted keys) so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function argsHash(toolId: string, args: unknown): string {
  return createHash("sha256").update(`${toolId}\n${canonicalJson(args)}`).digest("hex");
}

export interface ToolProposal { tool: unknown; arguments: unknown }

export interface ToolCallResult { ok: true; tool: string; result: unknown }

const APPROVAL_TTL_MS = 30 * 60_000;

async function reject(ctx: ToolContext, toolId: string, code: ToolError["code"], message: string, severity: "MEDIUM" | "HIGH" = "MEDIUM"): Promise<never> {
  await recordSecurityEvent({ orgId: ctx.orgId, taskRunId: ctx.taskRunId, kind: "TOOL_CALL_REJECTED", severity, source: "tool_registry", categories: [code], detail: { tool: toolId.slice(0, 80), reason: message.slice(0, 200) } });
  throw new ToolError(code, message);
}

/**
 * Validates and, when every rule passes, executes a model-proposed tool call.
 * `allowedTools` is the task's allowlist chosen by application code.
 */
export async function executeToolCall(ctx: ToolContext, proposal: ToolProposal, allowedTools: readonly string[]): Promise<ToolCallResult> {
  const toolId = typeof proposal.tool === "string" ? proposal.tool.slice(0, 80) : "";
  const def = BY_ID.get(toolId);
  if (!def) return reject(ctx, toolId || "(none)", "UNKNOWN_TOOL", "No such tool");
  if (!allowedTools.includes(def.id)) return reject(ctx, def.id, "NOT_ALLOWED", "Tool is not allowed for this task", "HIGH");
  const parsed = def.args.safeParse(proposal.arguments ?? {});
  if (!parsed.success) return reject(ctx, def.id, "INVALID_ARGUMENTS", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (ROLE_RANK[ctx.role] === undefined || ROLE_RANK[ctx.role] < ROLE_RANK[def.minRole]) {
    return reject(ctx, def.id, "FORBIDDEN", `Requires the ${def.minRole} role`, "HIGH");
  }
  const args = parsed.data;
  let approvalId: string | null = null;
  if (def.risk === "HIGH" || def.risk === "CRITICAL") {
    approvalId = await consumeApproval(ctx, def, args);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      def.run(ctx, args as never, controller.signal),
      new Promise<never>((_, rej) => { timer = setTimeout(() => { controller.abort(); rej(new ToolError("TIMEOUT", `Tool timed out after ${def.timeoutMs}ms`)); }, def.timeoutMs); }),
    ]);
    const serialized = JSON.stringify(result ?? null);
    const bounded = serialized.length > def.maxResultChars ? { truncated: true, preview: serialized.slice(0, def.maxResultChars) } : result;
    await audit({ userId: ctx.userId, orgId: ctx.orgId, action: "ai_tool_executed", resourceType: "ai_tool", result: "success", metadata: { tool: def.id, risk: def.risk, approvalId, taskRunId: ctx.taskRunId } });
    return { ok: true, tool: def.id, result: bounded };
  } catch (err) {
    await audit({ userId: ctx.userId, orgId: ctx.orgId, action: "ai_tool_executed", resourceType: "ai_tool", result: "failure", metadata: { tool: def.id, error: (err as Error).message.slice(0, 200), taskRunId: ctx.taskRunId } });
    if (err instanceof ToolError) throw err;
    throw new ToolError("FAILED", "Tool execution failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Finds an APPROVED, unexpired, unused approval for exactly this tool and
 * arguments in this organization and marks it USED atomically. Without one,
 * a PENDING approval request is created (or reused) and the call is refused.
 */
async function consumeApproval(ctx: ToolContext, def: ToolDefinition<never>, args: unknown): Promise<string> {
  const hash = argsHash(def.id, args);
  const { rows } = await query<{ id: string }>(
    `UPDATE ai_tool_approvals SET status='USED', used_at=NOW()
      WHERE id = (SELECT id FROM ai_tool_approvals
                   WHERE org_id=$1 AND tool_id=$2 AND args_hash=$3 AND requested_by=$4 AND status='APPROVED' AND expires_at > NOW()
                   ORDER BY decided_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [ctx.orgId, def.id, hash, ctx.userId],
  );
  if (rows[0]) return rows[0].id;
  const existing = await query<{ id: string }>(
    "SELECT id FROM ai_tool_approvals WHERE org_id=$1 AND tool_id=$2 AND args_hash=$3 AND requested_by=$4 AND status='PENDING' AND expires_at > NOW() LIMIT 1",
    [ctx.orgId, def.id, hash, ctx.userId],
  );
  const pendingId = existing.rows[0]?.id ?? (await query<{ id: string }>(
    `INSERT INTO ai_tool_approvals (org_id, task_run_id, tool_id, args_hash, args_preview, risk, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.orgId, ctx.taskRunId, def.id, hash, canonicalJson(args).length <= 2_000 ? canonicalJson(args) : JSON.stringify({ truncated: true }), def.risk, ctx.userId, new Date(Date.now() + APPROVAL_TTL_MS).toISOString()],
  )).rows[0].id;
  await recordSecurityEvent({ orgId: ctx.orgId, taskRunId: ctx.taskRunId, kind: "TOOL_APPROVAL_REQUIRED", severity: "LOW", source: "tool_registry", detail: { tool: def.id, approvalId: pendingId } });
  throw new ToolError("APPROVAL_REQUIRED", "This action needs approval by an administrator before it can run", pendingId);
}

/**
 * Decides a pending approval. Only owners/admins of the same organization may
 * decide, and the requester may not approve their own HIGH/CRITICAL request
 * unless they are the organization owner.
 */
export async function decideApproval(input: { orgId: string; approvalId: string; deciderId: string; deciderRole: OrgRole; approve: boolean }): Promise<"APPROVED" | "DENIED"> {
  if (ROLE_RANK[input.deciderRole] < ROLE_RANK.admin) throw new ToolError("FORBIDDEN", "Only organization admins can decide approvals");
  const { rows } = await query<{ requested_by: string | null; status: string; expires_at: Date }>(
    "SELECT requested_by, status, expires_at FROM ai_tool_approvals WHERE id=$1 AND org_id=$2",
    [input.approvalId, input.orgId],
  );
  const a = rows[0];
  if (!a) throw new ToolError("NOT_FOUND", "Approval not found");
  if (a.status !== "PENDING" || new Date(a.expires_at).getTime() <= Date.now()) throw new ToolError("NOT_ALLOWED", "Approval is no longer pending");
  if (input.approve && a.requested_by === input.deciderId && input.deciderRole !== "owner") {
    throw new ToolError("FORBIDDEN", "A second administrator must approve your own request");
  }
  const status = input.approve ? "APPROVED" : "DENIED";
  const updated = await query(
    "UPDATE ai_tool_approvals SET status=$3, decided_by=$4, decided_at=NOW() WHERE id=$1 AND org_id=$2 AND status='PENDING' RETURNING id",
    [input.approvalId, input.orgId, status, input.deciderId],
  );
  if ((updated.rowCount ?? 0) === 0) throw new ToolError("NOT_ALLOWED", "Approval is no longer pending");
  await audit({ userId: input.deciderId, orgId: input.orgId, action: input.approve ? "ai_tool_approval_granted" : "ai_tool_approval_denied", resourceType: "ai_tool_approval", resourceId: input.approvalId, result: "success" });
  return status;
}

export async function listApprovals(orgId: string, status?: string, limit = 50): Promise<unknown[]> {
  const { rows } = await query(
    `SELECT id, tool_id, risk, status, args_preview, requested_by, decided_by, decided_at, expires_at, used_at, created_at
       FROM ai_tool_approvals WHERE org_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3`,
    [orgId, status ?? null, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}
