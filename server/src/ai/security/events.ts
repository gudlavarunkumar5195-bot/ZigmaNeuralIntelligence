// Phase 11: persisted security decisions (injection signals, blocked tools,
// policy refusals). Details are structured and bounded; raw prompts, model
// output and secrets are never stored.

import { query } from "../../db/client.js";

export type SecurityEventKind =
  | "PROMPT_INJECTION_SUSPECTED"
  | "OUTPUT_GUARD_VIOLATION"
  | "TOOL_CALL_REJECTED"
  | "TOOL_APPROVAL_REQUIRED"
  | "PAID_MODEL_BLOCKED"
  | "POLICY_BLOCKED"
  | "AGENT_LIMIT_REACHED"
  | "CROSS_TENANT_BLOCKED";

export type SecuritySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export async function recordSecurityEvent(e: {
  orgId: string | null;
  taskRunId?: string | null;
  kind: SecurityEventKind;
  severity: SecuritySeverity;
  source?: string | null;
  categories?: string[];
  model?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const detail = JSON.stringify(e.detail ?? {});
    await query(
      "INSERT INTO ai_security_events (org_id, task_run_id, kind, severity, source, categories, model, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [e.orgId, e.taskRunId ?? null, e.kind, e.severity, e.source ?? null, (e.categories ?? []).slice(0, 20), e.model ?? null, detail.length > 4_000 ? JSON.stringify({ truncated: true }) : detail],
    );
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", event: "ai_security_event_write_failed", error: (err as Error).message }));
  }
  // Mirrored to structured logs so log search and alerting see it without a database query.
  console.warn(JSON.stringify({ level: "warn", event: "ai_security_event", kind: e.kind, severity: e.severity, orgId: e.orgId, taskRunId: e.taskRunId ?? null, categories: e.categories ?? [] }));
}
