import { query } from "../db/client.js";
import { getOxAlphaExecutor } from "../ai/ox-alpha.js";
import { normalizeKeyword } from "../research/keywords.js";
import { ResearchError } from "../research/providers/types.js";
import { allResults, getRunRow } from "./keyword-research.service.js";

/**
 * Optional AI prioritization of a research run. The model only sees the
 * run's retrieved rows (keyword, the metrics the provider returned, the
 * rule-based intent). Output is validated: every item must reference a
 * keyword of the run, priorities come from a fixed set, and the result is
 * stored and labelled as AI-generated. If AI is not configured or fails, the
 * research itself is unaffected. Calls go through the existing executor:
 * free models only unless paid models are explicitly approved, and every
 * attempt counts against the organization's AI budget.
 */

const MAX_ROWS_FOR_AI = 40;
const PRIORITIES = new Set(["high", "medium", "low"]);

export interface InsightItem {
  keyword: string;
  keywordKey: string;
  priority: "high" | "medium" | "low";
  rationale: string;
  intentNote: string | null;
  evidence: string[];
  missingData: string[];
}

function prompt(run: { kind: string; provider: string; observed_through: string | null; notes: unknown }, rows: Awaited<ReturnType<typeof allResults>>) {
  const data = rows.slice(0, MAX_ROWS_FOR_AI).map((r) => ({ keyword: r.keyword, metrics: r.metrics, rule_based_intent: r.intent, gap_category: r.gap_category ?? undefined }));
  return [
    {
      role: "system" as const,
      content:
        "You prioritize SEO keyword opportunities using ONLY the data provided. Never invent search volume, keyword difficulty, CPC, rankings or any number not in the data. " +
        "If a decision needs data that is missing (for example market search volume), say so in missingData. Answer with JSON only: " +
        '{"summary": string (max 600 chars), "items": [{"keyword": string (exactly as given), "priority": "high"|"medium"|"low", "rationale": string (max 300 chars, cite the metrics you used), ' +
        '"intentNote": string|null, "evidence": string[] (names of metrics or fields you used), "missingData": string[]}]}. At most 15 items.',
    },
    {
      role: "user" as const,
      content: JSON.stringify({ researchKind: run.kind, source: run.provider, observedThrough: run.observed_through, sourceNotes: run.notes, rows: data }),
    },
  ];
}

/** Keep only well-formed items that point at keywords of this run. */
export function validateInsights(raw: unknown, rowKeys: Map<string, string>): { summary: string; items: InsightItem[] } {
  const obj = (raw ?? {}) as { summary?: unknown; items?: unknown };
  const items: InsightItem[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(obj.items) ? obj.items.slice(0, 15) : []) {
    const i = it as Record<string, unknown>;
    if (typeof i.keyword !== "string") continue;
    const key = normalizeKeyword(i.keyword);
    const display = rowKeys.get(key);
    if (!display || seen.has(key) || typeof i.priority !== "string" || !PRIORITIES.has(i.priority) || typeof i.rationale !== "string") continue;
    seen.add(key);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 100)).slice(0, 8) : []);
    items.push({
      keyword: display,
      keywordKey: key,
      priority: i.priority as InsightItem["priority"],
      rationale: i.rationale.slice(0, 300),
      intentNote: typeof i.intentNote === "string" ? i.intentNote.slice(0, 200) : null,
      evidence: strings(i.evidence),
      missingData: strings(i.missingData),
    });
  }
  return { summary: typeof obj.summary === "string" ? obj.summary.slice(0, 600) : "", items };
}

export async function getInsights(orgId: string, runId: string) {
  const { rows } = await query("SELECT status, model, summary, items, error, created_at FROM research_insights WHERE run_id = $1 AND org_id = $2", [runId, orgId]);
  return rows[0] ?? null;
}

export async function generateInsights(orgId: string, runId: string, userId: string) {
  const run = await getRunRow(orgId, runId);
  if (!run) return null;
  if (run.status !== "completed" && run.status !== "partial") throw new ResearchError(409, "RUN_NOT_READY", "Only completed research runs can be analysed.");
  const rows = await allResults(orgId, runId);
  if (rows.length === 0) throw new ResearchError(409, "RUN_NOT_READY", "This run has no keywords to analyse.");
  const executor = getOxAlphaExecutor();
  if (!executor) throw new ResearchError(503, "AI_UNAVAILABLE", "AI analysis is not configured on this server. Keyword research works without it.");

  const result = await executor.execute({
    messages: prompt(run, rows),
    requireJson: true,
    maxTokens: 2_000,
    temperature: 0.2,
    orgId,
    researchRunId: runId,
    userId,
    agentType: "KEYWORD_PRIORITIZATION",
    taskDescription: "Prioritize keyword research results",
  });
  const keyMap = new Map(rows.map((r) => [r.keyword_key, r.keyword]));
  const ok = result.success && result.parsedJson !== null;
  const validated = ok ? validateInsights(result.parsedJson, keyMap) : { summary: "", items: [] };
  const status = ok && validated.items.length > 0 ? "completed" : "failed";
  const error = status === "failed" ? (ok ? "The AI answer did not reference any keyword of this run." : "AI analysis failed or is over budget; try again later.") : null;
  await query(
    `INSERT INTO research_insights (run_id, org_id, status, model, summary, items, error, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, model = EXCLUDED.model, summary = EXCLUDED.summary, items = EXCLUDED.items,
       error = EXCLUDED.error, created_by = EXCLUDED.created_by, created_at = NOW()`,
    [runId, orgId, status, result.response?.model ?? null, validated.summary, JSON.stringify(validated.items), error, userId],
  );
  return getInsights(orgId, runId);
}
