import { pool } from "../db/client.js";
import type { AuditResult } from "../types.js";

export interface AuditEvent {
  userId?: string | null;
  orgId?: string | null;
  requestId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: AuditResult;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends an event to the append-only audit log.
 * Failures are logged to stderr but never throw — never let audit errors
 * disrupt the main request path.
 */
export async function audit(event: AuditEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log
         (user_id, org_id, request_id, action, resource_type, resource_id, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.userId ?? null,
        event.orgId ?? null,
        event.requestId ?? null,
        event.action,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.result,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]
    );
  } catch (err) {
    console.error("[audit] Failed to write audit event:", (err as Error).message, event.action);
  }
}
