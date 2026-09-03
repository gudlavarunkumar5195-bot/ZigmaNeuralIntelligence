// Phase 3C: OX Alpha Intelligent Model Router.
//
// Architecture:
//   Task → Requirements → Registry → Eligibility filter (deterministic, hard)
//   → Candidate scoring (weighted) → OX Alpha selection (soft)
//   → Routing decision → Persistence
//
// OX Alpha selects among ELIGIBLE candidates only.
// OX Alpha CANNOT override hard eligibility or security constraints.
// Website/user content is NEVER included in the routing prompt (prompt injection defense).

import { query } from "../../db/client.js";
import { getEligibleModels } from "../registry.service.js";
import type { ModelRow, BenchmarkRow, ReliabilityRow } from "../registry.service.js";
import { getOxAlphaExecutor } from "../ox-alpha.js";
import { filterCandidates } from "./candidate-filter.js";
import { scoreCandidates, calculateRoutingConfidence } from "./candidate-scorer.js";
import { getActivePolicy } from "./routing-policy.js";
import type {
  TaskRequirements,
  RoutingDecision,
  ScoredCandidate,
  DecisionSource,
} from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ResolveRoutingOptions {
  requirements: TaskRequirements;
  correlationId?: string;
  taskId?: string;
  agentId?: string;
  orgId?: string;
  /** When true: run filter + score but do NOT call OX Alpha and do NOT persist. */
  simulate?: boolean;
}

export async function resolveRouting(
  opts: ResolveRoutingOptions
): Promise<RoutingDecision> {
  const startMs = Date.now();
  const { requirements, correlationId, taskId, agentId, orgId, simulate = false } = opts;

  // Merge org-level requirements (freeOnly etc.) from policy
  const policy = await getActivePolicy(orgId ?? requirements.orgId);

  // Apply policy defaults to requirements
  const effectiveReq: TaskRequirements = {
    ...requirements,
    freeOnly: requirements.freeOnly ?? policy.freeOnly,
    minimumReliability: requirements.minimumReliability ?? (policy.minReliability > 0 ? policy.minReliability : undefined),
    minimumQualityScore: requirements.minimumQualityScore ?? (policy.minQuality > 0 ? policy.minQuality : undefined),
    excludedModels: [
      ...(requirements.excludedModels ?? []),
      ...(policy.excludedModels ?? []),
    ],
    allowedProviders: requirements.allowedProviders ?? policy.allowedProviders ?? undefined,
  };

  // ── Load candidate pool ───────────────────────────────────────────────────
  // getEligibleModels applies basic eligibility; filterCandidates applies hard constraints.
  const allModels = await getEligibleModels({
    freeOnly: effectiveReq.freeOnly,
  });

  // Load reliability and benchmark data for scoring
  const [reliabilityMap, benchmarkMap] = await loadScoringData(allModels.map((m) => m.id));

  // ── Hard-constraint filter (deterministic) ────────────────────────────────
  const { eligible, excluded } = filterCandidates(allModels, effectiveReq, reliabilityMap);

  if (eligible.length === 0) {
    const decision = buildDecision({
      id: crypto.randomUUID(),
      correlationId,
      requirements: effectiveReq,
      status: "NO_CANDIDATES",
      selected: null,
      fallbacks: [],
      all: [],
      excluded,
      reason: "No eligible candidates after applying hard constraints",
      confidence: 0,
      source: "DETERMINISTIC",
      durationMs: Date.now() - startMs,
      policyId: policy.id,
      policyVersion: policy.version,
      error: "No candidates passed eligibility filters",
    });
    if (!simulate) await persistDecision(decision);
    return decision;
  }

  // ── Candidate scoring ─────────────────────────────────────────────────────
  const scored = scoreCandidates(eligible, effectiveReq, benchmarkMap, reliabilityMap, policy.weights);
  const { confidence: baseConfidence } = calculateRoutingConfidence(scored);

  // ── OX Alpha decision ─────────────────────────────────────────────────────
  let selected: ScoredCandidate = scored[0];
  let fallbacks: ScoredCandidate[] = scored.slice(1, 4);
  let reason = buildDeterministicReason(scored[0], scored);
  let confidence = baseConfidence;
  let source: DecisionSource = "DETERMINISTIC";

  if (!simulate) {
    const oxResult = await tryOxAlphaRouting(scored, effectiveReq, baseConfidence);
    if (oxResult) {
      selected = oxResult.selected;
      fallbacks = oxResult.fallbacks;
      reason = oxResult.reason;
      confidence = oxResult.confidence;
      source = "OX_ALPHA";
    }
  }

  const decision = buildDecision({
    id: crypto.randomUUID(),
    correlationId,
    requirements: effectiveReq,
    status: "RESOLVED",
    selected,
    fallbacks,
    all: scored,
    excluded,
    reason,
    confidence,
    source,
    durationMs: Date.now() - startMs,
    policyId: policy.id,
    policyVersion: policy.version,
  });

  if (!simulate) await persistDecision(decision);
  return decision;
}

// ─── OX Alpha routing call ────────────────────────────────────────────────────

interface OxRoutingResult {
  selected: ScoredCandidate;
  fallbacks: ScoredCandidate[];
  reason: string;
  confidence: number;
}

async function tryOxAlphaRouting(
  candidates: ScoredCandidate[],
  requirements: TaskRequirements,
  baseConfidence: number
): Promise<OxRoutingResult | null> {
  const executor = getOxAlphaExecutor();
  if (!executor) return null;

  const eligibleIds = new Set(candidates.map((c) => c.openrouterId));

  // Build routing prompt — ONLY system-trusted data, NEVER website content
  const candidateData = candidates.map((c) => ({
    openrouter_id: c.openrouterId,
    name: c.displayName,
    composite_score: c.compositeScore,
    benchmark: { value: c.components.benchmark.value, status: c.components.benchmark.status },
    reliability: { value: c.components.reliability.value, status: c.components.reliability.status },
    capability: c.components.capability.value,
    context: c.components.context.value,
  }));

  const systemPrompt = [
    "You are OX Alpha, the ZigmaNeural master routing orchestrator.",
    "Select the optimal AI model from the pre-filtered ELIGIBLE CANDIDATES list.",
    "RULES:",
    "- You MUST only select models from the candidates list below.",
    "- You CANNOT select any model not in the list.",
    "- You CANNOT modify eligibility rules or hard constraints.",
    "- Your response MUST be valid JSON matching the schema exactly.",
    "- Keep the reason to 2-3 sentences maximum.",
  ].join("\n");

  const userPrompt = [
    `Task type: ${requirements.taskType}`,
    `Complexity: ${requirements.complexity}`,
    `Risk level: ${requirements.riskLevel}`,
    `Structured output required: ${requirements.structuredOutputRequired}`,
    "",
    "Eligible candidates (pre-scored, sorted by composite score descending):",
    JSON.stringify(candidateData, null, 2),
    "",
    "Select primary + up to 3 fallbacks. Provide brief reason and confidence (0-100).",
    "",
    'Respond ONLY with JSON: {"primary":"<openrouter_id>","fallbacks":["<id>"],"reason":"<text>","confidence":<number>}',
  ].join("\n");

  try {
    const result = await executor.execute({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      requireJson: true,
      temperature: 0.1,
      agentType: "ROUTER",
      taskDescription: `Routing decision for ${requirements.taskType}`,
    });

    if (!result.success || !result.response) return null;

    const parsed = JSON.parse(result.response.content) as {
      primary?: string;
      fallbacks?: string[];
      reason?: string;
      confidence?: number;
    };

    // Validate: primary MUST be in eligible set
    const primaryId = parsed.primary;
    if (!primaryId || !eligibleIds.has(primaryId)) {
      // OX Alpha selected ineligible model — fall back to deterministic
      return null;
    }

    const primaryCandidate = candidates.find((c) => c.openrouterId === primaryId);
    if (!primaryCandidate) return null;

    // Validate fallbacks: only include eligible models
    const validFallbacks = (parsed.fallbacks ?? [])
      .filter((id): id is string => typeof id === "string" && eligibleIds.has(id) && id !== primaryId)
      .slice(0, 3)
      .map((id) => candidates.find((c) => c.openrouterId === id)!)
      .filter(Boolean);

    const reason = typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason.slice(0, 500)
      : buildDeterministicReason(primaryCandidate, candidates);

    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : baseConfidence;

    return {
      selected: primaryCandidate,
      fallbacks: validFallbacks,
      reason,
      confidence,
    };
  } catch {
    return null;
  }
}

// ─── Decision builder ─────────────────────────────────────────────────────────

interface BuildDecisionInput {
  id: string;
  correlationId?: string;
  requirements: TaskRequirements;
  status: RoutingDecision["status"];
  selected: ScoredCandidate | null;
  fallbacks: ScoredCandidate[];
  all: ScoredCandidate[];
  excluded: RoutingDecision["excludedCandidates"];
  reason: string;
  confidence: number;
  source: DecisionSource;
  durationMs: number;
  policyId?: string;
  policyVersion?: number;
  error?: string;
}

function buildDecision(input: BuildDecisionInput): RoutingDecision {
  return {
    id: input.id,
    correlationId: input.correlationId,
    taskType: input.requirements.taskType,
    complexity: input.requirements.complexity,
    riskLevel: input.requirements.riskLevel,
    status: input.status,
    orgId: input.requirements.orgId,
    selectedModel: input.selected,
    fallbackModels: input.fallbacks,
    allCandidates: input.all,
    excludedCandidates: input.excluded,
    decisionReason: input.reason,
    decisionConfidence: input.confidence,
    decisionSource: input.source,
    decisionDurationMs: input.durationMs,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    createdAt: new Date().toISOString(),
    errorMessage: input.error,
  };
}

function buildDeterministicReason(top: ScoredCandidate, all: ScoredCandidate[]): string {
  const parts: string[] = [`${top.displayName} scored highest (${top.compositeScore.toFixed(1)}/100)`];

  if (top.components.benchmark.status === "KNOWN") {
    parts.push(`benchmark score ${top.components.benchmark.value}`);
  }
  if (top.components.reliability.status === "KNOWN") {
    parts.push(`${top.components.reliability.value}% reliability`);
  }

  const unknownCount = all.filter((c) => c.components.benchmark.status === "UNKNOWN").length;
  if (unknownCount > 0) {
    parts.push(`${unknownCount} candidate(s) lack benchmark data (scored as neutral 50)`);
  }

  return parts.join(". ") + ".";
}

// ─── Persistence ──────────────────────────────────────────────────────────────

async function persistDecision(decision: RoutingDecision): Promise<void> {
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO routing_decisions (
         id, correlation_id, task_type, complexity, risk_level, org_id,
         selected_model_id, selected_openrouter_id,
         fallback_model_ids, fallback_openrouter_ids,
         decision_reason, decision_confidence, decision_source,
         candidate_count, excluded_count,
         policy_id, policy_version,
         decision_duration_ms, status, error_message
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
       ) RETURNING id`,
      [
        decision.id,
        decision.correlationId ?? null,
        decision.taskType,
        decision.complexity,
        decision.riskLevel,
        decision.orgId ?? null,
        decision.selectedModel?.modelId ?? null,
        decision.selectedModel?.openrouterId ?? null,
        decision.fallbackModels.map((f) => f.modelId),
        decision.fallbackModels.map((f) => f.openrouterId),
        decision.decisionReason,
        decision.decisionConfidence,
        decision.decisionSource,
        decision.allCandidates.length,
        decision.excludedCandidates.length,
        decision.policyId ?? null,
        decision.policyVersion ?? null,
        decision.decisionDurationMs,
        decision.status,
        decision.errorMessage ?? null,
      ]
    );

    if (rows.length === 0) return;

    // Persist per-candidate scores
    if (decision.allCandidates.length > 0) {
      await persistCandidates(decision.id, decision);
    }
  } catch {
    // DB errors must not crash routing
  }
}

async function persistCandidates(
  decisionId: string,
  decision: RoutingDecision
): Promise<void> {
  const selected = decision.selectedModel;
  const fallbackIds = new Set(decision.fallbackModels.map((f) => f.openrouterId));
  const fallbackOrder = new Map(
    decision.fallbackModels.map((f, i) => [f.openrouterId, i + 1])
  );

  for (const c of decision.allCandidates) {
    try {
      await query(
        `INSERT INTO routing_candidates (
           decision_id, model_id, openrouter_id, display_name, included,
           composite_score,
           score_benchmark, score_reliability, score_capability, score_historical,
           score_structured_out, score_latency, score_context, score_preference,
           benchmark_data_status, reliability_data_status,
           is_selected, fallback_order
         ) VALUES (
           $1,$2,$3,$4,TRUE,
           $5,$6,$7,$8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17
         )`,
        [
          decisionId,
          c.modelId,
          c.openrouterId,
          c.displayName,
          c.compositeScore,
          c.components.benchmark.value,
          c.components.reliability.value,
          c.components.capability.value,
          c.components.historical.value,
          c.components.structuredOutput.value,
          c.components.latency.value,
          c.components.context.value,
          c.components.preference.value,
          c.components.benchmark.status,
          c.components.reliability.status,
          c.openrouterId === selected?.openrouterId,
          fallbackOrder.get(c.openrouterId) ?? null,
        ]
      );
    } catch { /* skip individual candidate persistence errors */ }
  }

  // Persist excluded candidates
  for (const ex of decision.excludedCandidates) {
    try {
      await query(
        `INSERT INTO routing_candidates
           (decision_id, openrouter_id, display_name, included, exclusion_reason)
         VALUES ($1,$2,$3,FALSE,$4)`,
        [decisionId, ex.openrouterId, ex.displayName, ex.reason]
      );
    } catch { /* skip */ }
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadScoringData(
  modelIds: string[]
): Promise<[Map<string, ReliabilityRow>, Map<string, BenchmarkRow[]>]> {
  if (modelIds.length === 0) {
    return [new Map(), new Map()];
  }

  try {
    const placeholders = modelIds.map((_, i) => `$${i + 1}`).join(",");

    const [reliabilityResult, benchmarkResult] = await Promise.all([
      query<ReliabilityRow>(
        `SELECT * FROM model_reliability WHERE model_id IN (${placeholders})`,
        modelIds
      ),
      query<BenchmarkRow>(
        `SELECT * FROM model_benchmarks WHERE model_id IN (${placeholders})`,
        modelIds
      ),
    ]);

    const reliabilityMap = new Map<string, ReliabilityRow>(
      reliabilityResult.rows.map((r) => [r.model_id, r])
    );

    const benchmarkMap = new Map<string, BenchmarkRow[]>();
    for (const row of benchmarkResult.rows) {
      const existing = benchmarkMap.get(row.model_id) ?? [];
      existing.push(row);
      benchmarkMap.set(row.model_id, existing);
    }

    return [reliabilityMap, benchmarkMap];
  } catch {
    return [new Map(), new Map()];
  }
}

// ─── Decision retrieval ───────────────────────────────────────────────────────

export interface StoredDecisionSummary {
  id: string;
  taskType: string;
  complexity: string;
  riskLevel: string;
  selectedOpenrouterId: string | null;
  decisionConfidence: number | null;
  decisionSource: string;
  candidateCount: number;
  excludedCount: number;
  status: string;
  createdAt: string;
}

export async function listRoutingDecisions(
  limit = 50,
  orgId: string
): Promise<StoredDecisionSummary[]> {
  const values: unknown[] = [orgId, limit];

  const { rows } = await query<{
    id: string;
    task_type: string;
    complexity: string;
    risk_level: string;
    selected_openrouter_id: string | null;
    decision_confidence: number | null;
    decision_source: string;
    candidate_count: number;
    excluded_count: number;
    status: string;
    created_at: string;
  }>(
    `SELECT id, task_type, complexity, risk_level, selected_openrouter_id,
            decision_confidence, decision_source, candidate_count, excluded_count,
            status, created_at
    FROM routing_decisions WHERE org_id = $1
     ORDER BY created_at DESC
    LIMIT $2`,
    values
  );

  return rows.map((r) => ({
    id: r.id,
    taskType: r.task_type,
    complexity: r.complexity,
    riskLevel: r.risk_level,
    selectedOpenrouterId: r.selected_openrouter_id,
    decisionConfidence: r.decision_confidence,
    decisionSource: r.decision_source,
    candidateCount: r.candidate_count,
    excludedCount: r.excluded_count,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function getRoutingDecision(
  id: string,
  orgId: string
): Promise<(StoredDecisionSummary & { candidates: unknown[] }) | null> {
  const { rows } = await query<{
    id: string;
    task_type: string;
    complexity: string;
    risk_level: string;
    selected_openrouter_id: string | null;
    decision_confidence: number | null;
    decision_source: string;
    decision_reason: string | null;
    candidate_count: number;
    excluded_count: number;
    status: string;
    created_at: string;
  }>(
    "SELECT * FROM routing_decisions WHERE id=$1 AND org_id=$2",
    [id, orgId]
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  const { rows: candidateRows } = await query(
    "SELECT * FROM routing_candidates WHERE decision_id=$1 ORDER BY composite_score DESC NULLS LAST",
    [id]
  );

  return {
    id: row.id,
    taskType: row.task_type,
    complexity: row.complexity,
    riskLevel: row.risk_level,
    selectedOpenrouterId: row.selected_openrouter_id,
    decisionConfidence: row.decision_confidence,
    decisionSource: row.decision_source,
    candidateCount: row.candidate_count,
    excludedCount: row.excluded_count,
    status: row.status,
    createdAt: row.created_at,
    candidates: candidateRows,
  };
}
