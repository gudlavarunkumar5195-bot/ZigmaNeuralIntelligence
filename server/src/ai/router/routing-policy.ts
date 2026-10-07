// Phase 3C: Routing policy storage and retrieval.
// Policy changes are audited. OX Alpha cannot modify policy.

import { query, withTransaction } from "../../db/client.js";
import type { RoutingPolicy, ScoringWeights } from "./types.js";
import { DEFAULT_WEIGHTS } from "./types.js";

interface PolicyRow {
  id: string;
  org_id: string | null;
  version: number;
  free_only: boolean;
  min_reliability: string;
  min_quality: string;
  max_attempts: number;
  require_cross_model_verification: boolean;
  allowed_providers: string[] | null;
  excluded_models: string[] | null;
  weight_benchmark: string;
  weight_reliability: string;
  weight_capability: string;
  weight_historical: string;
  weight_structured_out: string;
  weight_latency: string;
  weight_context: string;
  weight_preference: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function rowToPolicy(row: PolicyRow): RoutingPolicy {
  return {
    id: row.id,
    orgId: row.org_id,
    version: row.version,
    freeOnly: row.free_only,
    minReliability: Number(row.min_reliability),
    minQuality: Number(row.min_quality),
    maxAttempts: row.max_attempts,
    requireCrossModelVerification: row.require_cross_model_verification,
    allowedProviders: row.allowed_providers,
    excludedModels: row.excluded_models,
    weights: {
      benchmark: Number(row.weight_benchmark),
      reliability: Number(row.weight_reliability),
      capability: Number(row.weight_capability),
      historical: Number(row.weight_historical),
      structuredOutput: Number(row.weight_structured_out),
      latency: Number(row.weight_latency),
      context: Number(row.weight_context),
      preference: Number(row.weight_preference),
    },
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Returns the active global policy, or a safe in-memory default if none found.
export async function getActivePolicy(orgId?: string): Promise<RoutingPolicy> {
  // Prefer org-specific policy, fall back to global
  if (orgId) {
    const { rows } = await query<PolicyRow>(
      "SELECT * FROM routing_policies WHERE org_id=$1 AND is_active=TRUE LIMIT 1",
      [orgId]
    );
    if (rows.length > 0) return rowToPolicy(rows[0]);
  }

  const { rows } = await query<PolicyRow>(
    "SELECT * FROM routing_policies WHERE org_id IS NULL AND is_active=TRUE LIMIT 1"
  );
  if (rows.length > 0) return rowToPolicy(rows[0]);

  // Fallback to in-memory default (handles missing DB / test environments)
  return defaultPolicy();
}

export function defaultPolicy(): RoutingPolicy {
  return {
    id: "default",
    orgId: null,
    version: 1,
    freeOnly: false,
    minReliability: 0,
    minQuality: 0,
    maxAttempts: 5,
    requireCrossModelVerification: false,
    allowedProviders: null,
    excludedModels: null,
    weights: DEFAULT_WEIGHTS,
    description: "Default in-memory policy",
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface PolicyUpdate {
  freeOnly?: boolean;
  minReliability?: number;
  minQuality?: number;
  maxAttempts?: number;
  requireCrossModelVerification?: boolean;
  allowedProviders?: string[] | null;
  excludedModels?: string[] | null;
  weights?: Partial<ScoringWeights>;
  description?: string;
}

// Replaces the active policy of ONE scope with a new version, atomically.
//
// Scope is explicit: an orgId updates only that org's own policy row; an
// undefined orgId targets the global default (org_id IS NULL) and must only be
// reached from a platform-admin code path (F-008). An org-scoped update never
// deactivates the global default. The org inherits the values of the policy it
// is currently effectively using (own active row, else the global default) for
// fields not present in the update. Versions are numbered per scope. Deactivate,
// insert and the audit record commit or roll back together; a per-scope
// advisory lock serialises concurrent updates, and the partial unique indexes
// from migration 023 are the final backstop.
export async function updateActivePolicy(
  update: PolicyUpdate,
  actorId: string,
  orgId?: string
): Promise<RoutingPolicy> {
  return withTransaction(async (client) => {
    const scopeKey = orgId ?? "global";
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`routing_policy:${scopeKey}`]);

    const own = await client.query<PolicyRow>(
      orgId
        ? "SELECT * FROM routing_policies WHERE org_id=$1 AND is_active=TRUE ORDER BY version DESC LIMIT 1 FOR UPDATE"
        : "SELECT * FROM routing_policies WHERE org_id IS NULL AND is_active=TRUE ORDER BY version DESC LIMIT 1 FOR UPDATE",
      orgId ? [orgId] : []
    );

    let current: RoutingPolicy;
    if (own.rows.length > 0) {
      current = rowToPolicy(own.rows[0]);
    } else if (orgId) {
      const global = await client.query<PolicyRow>(
        "SELECT * FROM routing_policies WHERE org_id IS NULL AND is_active=TRUE LIMIT 1"
      );
      current = global.rows.length > 0 ? rowToPolicy(global.rows[0]) : defaultPolicy();
    } else {
      current = defaultPolicy();
    }

    const maxVersion = await client.query<{ v: number | null }>(
      orgId
        ? "SELECT MAX(version) AS v FROM routing_policies WHERE org_id=$1"
        : "SELECT MAX(version) AS v FROM routing_policies WHERE org_id IS NULL",
      orgId ? [orgId] : []
    );
    const nextVersion = (maxVersion.rows[0]?.v ?? 0) + 1;

    if (own.rows.length > 0) {
      await client.query(
        "UPDATE routing_policies SET is_active=FALSE, updated_at=NOW() WHERE id=$1",
        [own.rows[0].id]
      );
    }

    const newWeights = { ...current.weights, ...(update.weights ?? {}) };

    const { rows } = await client.query<PolicyRow>(
      `INSERT INTO routing_policies (
         org_id, version, free_only, min_reliability, min_quality, max_attempts,
         require_cross_model_verification, allowed_providers, excluded_models,
         weight_benchmark, weight_reliability, weight_capability, weight_historical,
         weight_structured_out, weight_latency, weight_context, weight_preference,
         description, is_active, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,TRUE,$19
       ) RETURNING *`,
      [
        orgId ?? null,
        nextVersion,
        update.freeOnly ?? current.freeOnly,
        update.minReliability ?? current.minReliability,
        update.minQuality ?? current.minQuality,
        update.maxAttempts ?? current.maxAttempts,
        update.requireCrossModelVerification ?? current.requireCrossModelVerification,
        (update.allowedProviders !== undefined ? update.allowedProviders : current.allowedProviders),
        (update.excludedModels !== undefined ? update.excludedModels : current.excludedModels),
        newWeights.benchmark,
        newWeights.reliability,
        newWeights.capability,
        newWeights.historical,
        newWeights.structuredOutput,
        newWeights.latency,
        newWeights.context,
        newWeights.preference,
        update.description ?? current.description,
        actorId,
      ]
    );

    const newPolicy = rowToPolicy(rows[0]);

    // Audit inside the transaction (not the swallow-errors audit() helper) so a
    // failed audit write rolls the policy change back.
    await client.query(
      `INSERT INTO audit_log
         (user_id, org_id, action, resource_type, resource_id, result, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        actorId,
        orgId ?? null,
        "routing_policy_updated",
        "routing_policy",
        newPolicy.id,
        "success",
        JSON.stringify({
          version: newPolicy.version,
          scope: orgId ? "org" : "global",
          changes: Object.keys(update),
        }),
      ]
    );

    return newPolicy;
  });
}
