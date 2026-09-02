import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { audit } from "../services/audit.service.js";
import { config } from "../config.js";

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
  };
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  supported_parameters?: unknown[];
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
  const contextLength =
    typeof m.context_length === "number" && m.context_length > 0
      ? Math.min(Math.round(m.context_length), 10_000_000)
      : null;

  // Free status: both prompt and completion prices must be exactly "0".
  // UNKNOWN when pricing is absent or non-parseable — never assume free or paid.
  let freeStatus: NormalizedModel["freeStatus"] = "UNKNOWN";
  if (m.pricing && typeof m.pricing === "object") {
    const promptPrice = parseFloat(String(m.pricing.prompt ?? ""));
    const completionPrice = parseFloat(String(m.pricing.completion ?? ""));
    if (!isNaN(promptPrice) && !isNaN(completionPrice)) {
      freeStatus = promptPrice === 0 && completionPrice === 0 ? "FREE" : "PAID";
    }
  }

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
  };
}

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().substring(0, maxLength) || null;
}

// ─── Catalog fetch ────────────────────────────────────────────────────────────

export async function fetchOpenRouterCatalog(): Promise<NormalizedModel[]> {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: {
        // Key is sent to get full pricing details — never logged
        "Authorization": `Bearer ${config.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://zignaneural.com",
        "X-Title": "ZigmaNeural",
      },
    });
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Catalog fetch timed out after ${CATALOG_TIMEOUT_MS}ms`);
    }
    throw new Error(`Catalog fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new Error("OpenRouter rate limit — catalog refresh deferred");
  }
  if (!res.ok) {
    throw new Error(`OpenRouter catalog returned HTTP ${res.status}`);
  }

  let body: OpenRouterCatalogResponse;
  try {
    body = (await res.json()) as OpenRouterCatalogResponse;
  } catch {
    throw new Error("OpenRouter catalog response is not valid JSON");
  }

  if (body.error) {
    throw new Error(`OpenRouter catalog error: ${String(body.error.message ?? "unknown")}`);
  }

  if (!Array.isArray(body.data)) {
    throw new Error("OpenRouter catalog response has unexpected shape");
  }

  const normalized: NormalizedModel[] = [];
  for (const raw of body.data) {
    const model = normalizeOpenRouterModel(raw);
    if (model) normalized.push(model);
  }

  return normalized;
}

// ─── Refresh flow ─────────────────────────────────────────────────────────────

export async function refreshCatalog(): Promise<CatalogRefreshResult> {
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

    for (const model of catalog) {
      seenIds.add(model.openrouterId);
      const result = await upsertModel(model, refreshId);
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

async function upsertModel(
  model: NormalizedModel,
  refreshId: string
): Promise<"new" | "updated" | "unchanged"> {
  const { rows: existing } = await query<{ id: string; free_status: string; status: string }>(
    "SELECT id, free_status, status FROM models WHERE openrouter_id = $1",
    [model.openrouterId]
  );

  if (existing.length === 0) {
    // New model — insert as DISCOVERED
    await query(
      `INSERT INTO models
         (openrouter_id, display_name, provider, description, context_length, free_status,
          supports_tool_calling, supports_structured_output, supports_vision,
          input_modalities, output_modalities, status, eligibility_status,
          last_seen_at, last_catalog_refresh)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DISCOVERED','NOT_ELIGIBLE',NOW(),$12)`,
      [
        model.openrouterId, model.displayName, model.provider, model.description,
        model.contextLength, model.freeStatus,
        model.supportsToolCalling, model.supportsStructuredOutput, model.supportsVision,
        model.inputModalities, model.outputModalities, refreshId,
      ]
    );

    const { rows: newRow } = await query<{ id: string }>(
      "SELECT id FROM models WHERE openrouter_id = $1",
      [model.openrouterId]
    );
    if (newRow[0]) {
      await recordModelHistory(newRow[0].id, "DISCOVERED", null, { openrouterId: model.openrouterId }, null, null);
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
  }

  // If previously STALE, mark as AVAILABLE again
  const newStatus = prev.status === "STALE" ? "AVAILABLE" : prev.status;

  await query(
    `UPDATE models
     SET display_name=$2, description=$3, context_length=$4, free_status=$5,
         supports_tool_calling=$6, supports_structured_output=$7, supports_vision=$8,
         input_modalities=$9, output_modalities=$10, status=$11,
         last_seen_at=NOW(), last_catalog_refresh=$12, updated_at=NOW()
     WHERE id=$1`,
    [
      existingModel.id, model.displayName, model.description, model.contextLength,
      newFreeStatus, model.supportsToolCalling, model.supportsStructuredOutput, model.supportsVision,
      model.inputModalities, model.outputModalities, newStatus, refreshId,
    ]
  );

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
    isAvailable: !!config.OPENROUTER_API_KEY,
  };
}
