import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { audit } from "../services/audit.service.js";
import { resolveSecret } from "../platform/credential-store.js";
import { classifyPricing, type PricingClass } from "./pricing.js";
import { getRouterSettings } from "./router/settings.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_LENGTH = 2000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CatalogRefreshResult {
  refreshId: string;
  status: "completed" | "failed";
  modelsFound: number;
  modelsNew: number;
  modelsUpdated: number;
  modelsStale: number;
  durationMs: number;
  error?: string;
}

export interface CatalogStatus {
  lastRefreshId: string | null;
  lastRefreshAt: string | null;
  lastRefreshStatus: string | null;
  modelsInRegistry: number;
  isAvailable: boolean;
}

// OpenRouter API response shape — treat as untrusted external data
interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: {
    modality?: unknown;
    input_modalities?: unknown[];
    output_modalities?: unknown[];
    tokenizer?: unknown;
  };
  pricing?: unknown;
  supported_parameters?: unknown[];
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  expiration_date?: unknown;
  reasoning?: { mandatory?: unknown };
  benchmarks?: { artificial_analysis?: { intelligence_index?: unknown; coding_index?: unknown; agentic_index?: unknown } };
}

interface OpenRouterCatalogResponse {
  data?: unknown[];
  error?: { message?: unknown };
}

// Our normalized shape before DB write
interface NormalizedModel {
  openrouterId: string;
  displayName: string;
  provider: string;
  description: string | null;
  contextLength: number | null;
  freeStatus: "FREE" | "PAID" | "UNKNOWN";
  supportsToolCalling: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  inputModalities: string[];
  outputModalities: string[];
  // Phase 11
  pricingClass: PricingClass;
  pricingReason: string;
  pricing: Record<string, unknown> | null;
  expiresAt: Date | null;
  isRouter: boolean;
  maxCompletionTokens: number | null;
  reasoningMandatory: boolean;
  supportsJsonSchema: boolean;
  tokenizer: string | null;
  benchmarks: { intelligence: number | null; coding: number | null; agentic: number | null };
}

// ─── Normalization ────────────────────────────────────────────────────────────
//
// Treats OpenRouter response as untrusted.  Only safe, typed fields are extracted.
// Capabilities inferred from metadata are structural, NOT quality indicators.

export function normalizeOpenRouterModel(raw: unknown): NormalizedModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as OpenRouterModel;

  const openrouterId = typeof m.id === "string" && m.id.trim() ? m.id.trim() : null;
  if (!openrouterId) return null;

  // Sanitize text fields — no HTML, max lengths enforced
  const displayName = sanitizeText(m.name, 500) ?? openrouterId;
  const description = sanitizeText(m.description, MAX_DESCRIPTION_LENGTH);
  const positiveInt = (v: unknown, max: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : null;
  // The usable window is the smaller of the model's and its top provider's.
  const ctxModel = positiveInt(m.context_length, 10_000_000);
  const ctxProvider = positiveInt(m.top_provider?.context_length, 10_000_000);
  const contextLength = ctxModel && ctxProvider ? Math.min(ctxModel, ctxProvider) : ctxModel ?? ctxProvider;

  // Full pricing classification (every price field and override; expiry → TRIAL).
  const pricing = classifyPricing({ id: openrouterId, pricing: m.pricing, expirationDate: m.expiration_date });
  // Legacy free_status: FREE only for zero-priced models; UNKNOWN when unreadable.
  const freeStatus: NormalizedModel["freeStatus"] =
    pricing.pricingClass === "FREE" || pricing.pricingClass === "TRIAL" ? "FREE"
    : pricing.pricingClass === "PAID" ? "PAID"
    : "UNKNOWN";

  // Provider from the first segment of the model ID
  const provider = openrouterId.split("/")[0] ?? "unknown";

  // Structural capabilities from metadata
  const supportsVision = typeof m.architecture?.modality === "string"
    ? m.architecture.modality.includes("image")
    : false;

  const supportsToolCalling = Array.isArray(m.supported_parameters)
    && m.supported_parameters.includes("tools");

  const supportsStructuredOutput = Array.isArray(m.supported_parameters)
    && m.supported_parameters.includes("response_format");
  const supportsJsonSchema = Array.isArray(m.supported_parameters)
    && m.supported_parameters.includes("structured_outputs");
  const aa = m.benchmarks?.artificial_analysis;
  const bench = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000 ? Math.round(v * 100) / 100 : null);

  // Modalities
  const inputMods = Array.isArray(m.architecture?.input_modalities)
    ? m.architecture!.input_modalities
        .filter((x): x is string => typeof x === "string")
        .slice(0, 10)
    : ["text"];

  const outputMods = Array.isArray(m.architecture?.output_modalities)
    ? m.architecture!.output_modalities
        .filter((x): x is string => typeof x === "string")
        .slice(0, 10)
    : ["text"];

  return {
    openrouterId,
    displayName,
    provider,
    description,
    contextLength,
    freeStatus,
    supportsToolCalling,
    supportsStructuredOutput,
    supportsVision,
    inputModalities: inputMods,
    outputModalities: outputMods,
    pricingClass: pricing.pricingClass,
    pricingReason: pricing.reason,
    pricing: m.pricing && typeof m.pricing === "object" && !Array.isArray(m.pricing) ? (m.pricing as Record<string, unknown>) : null,
    expiresAt: pricing.expiresAt,
    isRouter: pricing.isRouter,
    maxCompletionTokens: positiveInt(m.top_provider?.max_completion_tokens, 10_000_000),
    reasoningMandatory: m.reasoning?.mandatory === true,
    supportsJsonSchema,
    tokenizer: sanitizeText(m.architecture?.tokenizer, 60),
    benchmarks: { intelligence: bench(aa?.intelligence_index), coding: bench(aa?.coding_index), agentic: bench(aa?.agentic_index) },
  };
}

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().substring(0, maxLength) || null;
}

// ─── Catalog fetch ────────────────────────────────────────────────────────────

export async function fetchOpenRouterCatalog(): Promise<NormalizedModel[]> {
  // The model list is public; the key is sent when configured (never logged).
  const apiKey = resolveSecret("openrouter")?.secret ?? null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);

  let body: OpenRouterCatalogResponse;
  try {
    let res: Response;
    try {
      res = await fetch(OPENROUTER_MODELS_URL, {
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          "HTTP-Referer": "https://zigmaneural.com",
          "X-Title": "ZigmaNeural",
        },
      });
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Catalog fetch timed out after ${CATALOG_TIMEOUT_MS}ms`);
      }
      throw new Error(`Catalog fetch failed: ${(err as Error).message}`);
    }

    if (res.status === 429) {
      await res.body?.cancel().catch((): void => undefined);
      throw new Error("OpenRouter rate limit — catalog refresh deferred");
    }
    if (!res.ok) {
      await res.body?.cancel().catch((): void => undefined);
      throw new Error(`OpenRouter catalog returned HTTP ${res.status}`);
    }

    // The abort timer stays armed until the body has been fully read.
    try {
      body = (await res.json()) as OpenRouterCatalogResponse;
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        throw new Error(`Catalog fetch timed out after ${CATALOG_TIMEOUT_MS}ms`);
      }
      throw new Error("OpenRouter catalog response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }

  if (body.error) {
    throw new Error(`OpenRouter catalog error: ${String(body.error.message ?? "unknown")}`);
  }

  if (!Array.isArray(body.data)) {
    throw new Error("OpenRouter catalog response has unexpected shape");
  }

  if (body.data.length > 20_000) {
    throw new Error("OpenRouter catalog response is unexpectedly large");
  }
  const normalized: NormalizedModel[] = [];
  for (const raw of body.data) {
    const model = normalizeOpenRouterModel(raw);
    if (model) normalized.push(model);
  }

  return normalized;
}

// ─── Refresh flow ─────────────────────────────────────────────────────────────

let inFlight: Promise<CatalogRefreshResult> | null = null;

/** Single-flight: concurrent callers (scheduler, admin, stale-check) share one refresh. */
export function refreshCatalog(): Promise<CatalogRefreshResult> {
  if (!inFlight) inFlight = runRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function runRefresh(): Promise<CatalogRefreshResult> {
  const refreshId = randomUUID();
  const start = Date.now();

  // Create refresh record
  await query(
    `INSERT INTO catalog_refreshes (id, status, started_at) VALUES ($1, 'running', NOW())`,
    [refreshId]
  );

  let modelsFound = 0;
  let modelsNew = 0;
  let modelsUpdated = 0;
  let modelsStale = 0;
  let error: string | undefined;
  let status: "completed" | "failed" = "failed";

  try {
    const catalog = await fetchOpenRouterCatalog();
    modelsFound = catalog.length;

    const seenIds = new Set<string>();
    const { settings } = await getRouterSettings();
    const autoApprove = { free: settings.autoApproveFreeModels, trial: settings.autoApproveFreeModels && settings.trials.enabled };

    for (const model of catalog) {
      seenIds.add(model.openrouterId);
      const result = await upsertModel(model, refreshId, autoApprove);
      if (result === "new") modelsNew++;
      else if (result === "updated") modelsUpdated++;
    }

    // Mark models not in this refresh as STALE
    modelsStale = await markStaleModels(seenIds, refreshId);

    status = "completed";
  } catch (err: unknown) {
    error = (err as Error).message;
  }

  const durationMs = Date.now() - start;

  await query(
    `UPDATE catalog_refreshes
     SET status=$2, models_found=$3, models_new=$4, models_updated=$5,
         models_stale=$6, error=$7, completed_at=NOW(), duration_ms=$8
     WHERE id=$1`,
    [refreshId, status, modelsFound, modelsNew, modelsUpdated, modelsStale, error ?? null, durationMs]
  );

  await audit({
    action: "catalog_refresh",
    resourceType: "catalog",
    resourceId: refreshId as unknown as string,
    result: status === "completed" ? "success" : "failure",
    metadata: { modelsFound, modelsNew, modelsUpdated, modelsStale, durationMs },
  });

  return { refreshId, status, modelsFound, modelsNew, modelsUpdated, modelsStale, durationMs, error };
}

/**
 * A verified free (or, when trials are enabled, time-limited free) text
 * model that is not a routing alias may be approved automatically, so the
 * router can use newly released free models without manual review. Paid and
 * unknown-price models are never auto-approved; an administrator's disable
 * always wins.
 */
export function qualifiesForAutoApproval(model: Pick<NormalizedModel, "pricingClass" | "isRouter" | "outputModalities">, policy: { free: boolean; trial: boolean }): boolean {
  if (model.isRouter) return false;
  if (model.outputModalities.length !== 1 || model.outputModalities[0] !== "text") return false;
  return (model.pricingClass === "FREE" && policy.free) || (model.pricingClass === "TRIAL" && policy.trial);
}

/**
 * Status after a refresh for a model already in the registry. A STALE model
 * that reappears returns to AVAILABLE only if it had been approved before
 * (eligibility ELIGIBLE); otherwise it goes back to review. A model awaiting
 * review is promoted only when it qualifies for automatic approval and any
 * price change has been reviewed.
 */
export function nextModelStatus(input: { prevStatus: string; prevEligibility: string; approve: boolean; freeStatus: string }): { status: string; autoPromoted: boolean } {
  const fromStale = input.prevStatus === "STALE";
  const wasApproved = input.prevEligibility === "ELIGIBLE";
  const autoPromoted = (input.prevStatus === "DISCOVERED" || (fromStale && !wasApproved)) && input.approve && input.freeStatus !== "CHANGED";
  if (autoPromoted) return { status: "AVAILABLE", autoPromoted };
  if (fromStale) return { status: wasApproved ? "AVAILABLE" : "DISCOVERED", autoPromoted };
  return { status: input.prevStatus, autoPromoted };
}

async function upsertModel(
  model: NormalizedModel,
  refreshId: string,
  autoApprove: { free: boolean; trial: boolean } = { free: false, trial: false }
): Promise<"new" | "updated" | "unchanged"> {
  const { rows: existing } = await query<{ id: string; free_status: string; status: string; pricing_class: string | null; eligibility_status: string }>(
    "SELECT id, free_status, status, pricing_class, eligibility_status FROM models WHERE openrouter_id = $1",
    [model.openrouterId]
  );
  const approve = qualifiesForAutoApproval(model, autoApprove);
  const v2 = [
    model.pricingClass, model.pricing ? JSON.stringify(model.pricing) : null, model.expiresAt?.toISOString() ?? null,
    model.maxCompletionTokens, model.reasoningMandatory, model.supportsJsonSchema, model.isRouter, model.tokenizer,
    model.benchmarks.intelligence, model.benchmarks.coding, model.benchmarks.agentic,
  ];

  if (existing.length === 0) {
    // New model — DISCOVERED (awaiting review) unless it qualifies for automatic approval.
    const { rows: newRow } = await query<{ id: string }>(
      `INSERT INTO models
         (openrouter_id, display_name, provider, description, context_length, free_status,
          supports_tool_calling, supports_structured_output, supports_vision,
          input_modalities, output_modalities, status, eligibility_status,
          last_seen_at, last_catalog_refresh,
          pricing_class, pricing, expires_at, max_completion_tokens, reasoning_mandatory, supports_json_schema,
          is_router, tokenizer, benchmark_intelligence, benchmark_coding, benchmark_agentic, pricing_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$14,NOW(),$12,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())
       RETURNING id`,
      [
        model.openrouterId, model.displayName, model.provider, model.description,
        model.contextLength, model.freeStatus,
        model.supportsToolCalling, model.supportsStructuredOutput, model.supportsVision,
        model.inputModalities, model.outputModalities, refreshId,
        approve ? "AVAILABLE" : "DISCOVERED", approve ? "ELIGIBLE" : "NOT_ELIGIBLE",
        ...v2,
      ]
    );
    if (newRow[0]) {
      await recordModelHistory(newRow[0].id, "DISCOVERED", null, { openrouterId: model.openrouterId, pricingClass: model.pricingClass }, null, null);
      if (approve) await recordModelHistory(newRow[0].id, "AUTO_APPROVED", { status: "DISCOVERED" }, { status: "AVAILABLE" }, `Verified ${model.pricingClass.toLowerCase()} text model (${model.pricingReason})`, null);
    }
    return "new";
  }

  const existingModel = existing[0];
  const prev = {
    freeStatus: existingModel.free_status,
    status: existingModel.status,
  };

  // Detect free→paid change
  let newFreeStatus: "FREE" | "PAID" | "UNKNOWN" | "CHANGED" = model.freeStatus;
  if (prev.freeStatus === "FREE" && model.freeStatus === "PAID") {
    newFreeStatus = "CHANGED";
  } else if (prev.freeStatus === "PAID" && model.freeStatus === "FREE") {
    newFreeStatus = "CHANGED";
  } else if (prev.freeStatus === "CHANGED") {
    // A price change stays flagged until an administrator reviews it (enableModel clears it).
    newFreeStatus = "CHANGED";
  }

  // A STALE model that reappears returns to AVAILABLE only if it had been
  // approved before (eligibility ELIGIBLE); otherwise it goes back to review.
  // A model still awaiting review is promoted only when it qualifies for automatic approval.
  const { status: newStatus, autoPromoted } = nextModelStatus({ prevStatus: prev.status, prevEligibility: existingModel.eligibility_status, approve, freeStatus: newFreeStatus });

  await query(
    `UPDATE models
     SET display_name=$2, description=$3, context_length=$4, free_status=$5,
         supports_tool_calling=$6, supports_structured_output=$7, supports_vision=$8,
         input_modalities=$9, output_modalities=$10, status=$11,
         last_seen_at=NOW(), last_catalog_refresh=$12, updated_at=NOW(),
         pricing_class=$13, pricing=$14, expires_at=$15, max_completion_tokens=$16, reasoning_mandatory=$17,
         supports_json_schema=$18, is_router=$19, tokenizer=$20, benchmark_intelligence=$21, benchmark_coding=$22,
         benchmark_agentic=$23, pricing_checked_at=NOW(),
         eligibility_status = CASE WHEN $24::boolean THEN 'ELIGIBLE' ELSE eligibility_status END
     WHERE id=$1`,
    [
      existingModel.id, model.displayName, model.description, model.contextLength,
      newFreeStatus, model.supportsToolCalling, model.supportsStructuredOutput, model.supportsVision,
      model.inputModalities, model.outputModalities, newStatus, refreshId,
      ...v2, autoPromoted,
    ]
  );
  if (autoPromoted) {
    await recordModelHistory(existingModel.id, "AUTO_APPROVED", { status: prev.status }, { status: "AVAILABLE" }, `Verified ${model.pricingClass.toLowerCase()} text model (${model.pricingReason})`, null);
  }
  if ((existingModel.pricing_class ?? "UNKNOWN") !== model.pricingClass && existingModel.pricing_class !== null) {
    await recordModelHistory(existingModel.id, "PRICING_CLASS_CHANGED", { pricingClass: existingModel.pricing_class }, { pricingClass: model.pricingClass, reason: model.pricingReason }, null, null);
  }

  if (newFreeStatus !== prev.freeStatus) {
    await recordModelHistory(
      existingModel.id, "PRICING_CHANGED",
      { freeStatus: prev.freeStatus }, { freeStatus: newFreeStatus },
      null, null
    );
  }

  return "updated";
}

async function markStaleModels(seenIds: Set<string>, _refreshId: string): Promise<number> {
  // Any model not in the current catalog and not already STALE/DEPRECATED/DISABLED → STALE
  const { rows: toStale } = await query<{ id: string; openrouter_id: string }>(
    `SELECT id, openrouter_id FROM models
     WHERE status NOT IN ('STALE','DEPRECATED','DISABLED')
       AND last_seen_at < NOW() - INTERVAL '1 hour'`
  );

  let count = 0;
  for (const row of toStale) {
    if (!seenIds.has(row.openrouter_id)) {
      await query(
        "UPDATE models SET status='STALE', updated_at=NOW() WHERE id=$1",
        [row.id]
      );
      await recordModelHistory(row.id, "BECAME_STALE", { status: "AVAILABLE" }, { status: "STALE" }, null, null);
      count++;
    }
  }
  return count;
}

async function recordModelHistory(
  modelId: string,
  eventType: string,
  oldValue: unknown,
  newValue: unknown,
  reason: string | null,
  actorId: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO model_history (model_id, event_type, old_value, new_value, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [modelId, eventType, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, reason, actorId]
    );
  } catch { /* history failures never crash the main flow */ }
}

// ─── Status query ─────────────────────────────────────────────────────────────

// ─── Scheduled refresh ────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** True when the newest completed refresh is older than `maxAgeMs` (or none exists). */
export async function catalogIsStale(maxAgeMs: number): Promise<boolean> {
  const { rows } = await query<{ completed_at: Date | null }>(
    "SELECT completed_at FROM catalog_refreshes WHERE status='completed' ORDER BY completed_at DESC NULLS LAST LIMIT 1",
  );
  const at = rows[0]?.completed_at ? new Date(rows[0].completed_at).getTime() : 0;
  return Date.now() - at > maxAgeMs;
}

/**
 * Refreshes at start (when stale) and then on the configured interval. The
 * check runs every 10 minutes and reads the interval from settings, so an
 * administrator's change applies without a restart. Failures are logged and
 * retried on the next tick; routing fails closed on stale pricing meanwhile.
 */
export function startCatalogScheduler(): void {
  if (schedulerTimer) return;
  const tick = async () => {
    try {
      const { settings } = await getRouterSettings();
      if (await catalogIsStale(settings.catalog.refreshIntervalMinutes * 60_000)) {
        const r = await refreshCatalog();
        console.log(JSON.stringify({ event: "ai_catalog_refreshed", status: r.status, found: r.modelsFound, new: r.modelsNew, stale: r.modelsStale, durationMs: r.durationMs, error: r.error ? r.error.slice(0, 200) : undefined }));
      }
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", event: "ai_catalog_refresh_failed", error: (err as Error).message.slice(0, 200) }));
    }
  };
  void tick();
  schedulerTimer = setInterval(() => void tick(), 10 * 60_000);
  schedulerTimer.unref();
}

export function stopCatalogScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export async function getCatalogStatus(): Promise<CatalogStatus> {
  const [refreshRow, countRow] = await Promise.all([
    query<{ id: string; status: string; completed_at: string | null }>(
      "SELECT id, status, completed_at FROM catalog_refreshes ORDER BY created_at DESC LIMIT 1"
    ),
    query<{ count: string }>("SELECT COUNT(*) AS count FROM models"),
  ]);

  const last = refreshRow.rows[0];
  return {
    lastRefreshId: last?.id ?? null,
    lastRefreshAt: last?.completed_at ?? null,
    lastRefreshStatus: last?.status ?? null,
    modelsInRegistry: parseInt(countRow.rows[0]?.count ?? "0", 10),
    isAvailable: !!resolveSecret("openrouter"),
  };
}
