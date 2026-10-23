// Phase 11: token estimation and context feasibility.
//
// No provider tokenizer is available for most OpenRouter models (the catalog
// reports tokenizers such as "Other"), so estimates are APPROXIMATE and
// deliberately conservative: one token per 3 UTF-8 bytes. English BPE
// tokenizers average about 4 bytes per token, so this over-reserves ordinary
// text by roughly a third; CJK text (3 bytes per character) lands near one
// token per character. Each model's observed ratio of provider-reported to
// estimated prompt tokens (calibration) raises the estimate further when the
// model tokenizes more densely; it never lowers it.

export const TOKEN_ESTIMATE_METHOD = "utf8-bytes/3 (approximate)";
const BYTES_PER_TOKEN = 3;
const PER_MESSAGE_OVERHEAD = 8;
/** Context assumed for a model whose catalog entry reports none (conservative). */
export const UNKNOWN_CONTEXT_ASSUMPTION = 4_096;
const REQUEST_OVERHEAD = 16;
/** Calibration factors are clamped: a broken measurement can neither shrink nor explode a reservation. */
export const MIN_CALIBRATION = 1;
export const MAX_CALIBRATION = 2.5;

export function estimateTextTokens(text: string, calibration = 1): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil((bytes / BYTES_PER_TOKEN) * clampCalibration(calibration));
}

export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>, calibration = 1): number {
  let total = REQUEST_OVERHEAD;
  for (const m of messages) total += PER_MESSAGE_OVERHEAD + estimateTextTokens(m.content, calibration);
  return total;
}

export function clampCalibration(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, value)) : MIN_CALIBRATION;
}

// ─── Context planning ─────────────────────────────────────────────────────────

export type SectionKind =
  | "policy"          // application policy and security rules (never removed)
  | "instructions"    // trusted task instructions (never removed)
  | "user_request"    // the authenticated user's request (never removed)
  | "evidence"        // source material; removable only when not marked required
  | "retrieved"       // retrieved documents (untrusted)
  | "history"         // earlier conversation turns
  | "tool_spec"       // tool descriptions
  | "tool_output"     // tool results (untrusted)
  | "agent_message";  // output of another agent (untrusted)

export interface PromptSection {
  id: string;
  role: "system" | "user" | "assistant";
  kind: SectionKind;
  content: string;
  /** Required sections are never dropped or shortened. Policy, instructions and the user request are always required. */
  required?: boolean;
  /** Higher priority is kept longer when reducing (default 0). */
  priority?: number;
}

export interface ModelLimits {
  contextLength: number | null;
  maxCompletionTokens: number | null;
  reasoningMandatory?: boolean;
}

export interface PlanLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxReductionIterations: number;
}

export type ContextFeasibility = "FEASIBLE" | "FEASIBLE_WITH_REDUCTION" | "DOES_NOT_FIT";

export interface ContextPlan {
  status: ContextFeasibility;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  usableContext: number;
  safetyMargin: number;
  reductions: string[];
  droppedSectionIds: string[];
  /** Input tokens of the required sections alone: a model needs at least this much room. */
  requiredInputTokens: number;
  approximate: true;
  reason?: string;
}

const ALWAYS_REQUIRED: ReadonlySet<SectionKind> = new Set(["policy", "instructions", "user_request"]);
/** Order in which optional material is removed: least essential first. */
const DROP_ORDER: SectionKind[] = ["history", "agent_message", "tool_output", "retrieved", "evidence", "tool_spec"];

export function isRequired(s: PromptSection): boolean {
  return ALWAYS_REQUIRED.has(s.kind) || s.required === true;
}

/** Context left for input once the output reservation and a safety margin are set aside. */
export function safetyMarginFor(contextLength: number): number {
  return Math.max(256, Math.ceil(contextLength * 0.05));
}

/** Tokens to reserve for the answer; models that always reason spend completion tokens on reasoning first. */
export function outputReservation(desired: number, model: ModelLimits, limits: Pick<PlanLimits, "maxOutputTokens">): number {
  const wanted = model.reasoningMandatory ? desired * 3 : desired;
  const caps = [wanted, limits.maxOutputTokens];
  if (model.maxCompletionTokens && model.maxCompletionTokens > 0) caps.push(model.maxCompletionTokens);
  return Math.max(1, Math.min(...caps));
}

/**
 * Fits sections into one model's limits:
 *   estimated_input + reserved_output + safety_margin <= context_length
 * reducing optional material in a fixed order. Required sections are never
 * dropped or truncated; when they alone cannot fit the plan is DOES_NOT_FIT
 * (the caller tries a larger model or splits the task).
 */
export function planContext(input: {
  sections: PromptSection[];
  model: ModelLimits;
  desiredOutputTokens: number;
  minOutputTokens: number;
  limits: PlanLimits;
  calibration?: number;
}): ContextPlan {
  const calibration = clampCalibration(input.calibration ?? 1);
  // An unreported window is assumed to be small rather than refused or trusted blindly.
  const ctx = input.model.contextLength && input.model.contextLength > 0 ? input.model.contextLength : UNKNOWN_CONTEXT_ASSUMPTION;
  const margin = ctx ? safetyMarginFor(ctx) : 0;
  let output = outputReservation(input.desiredOutputTokens, input.model, input.limits);
  const minOutput = Math.min(output, Math.max(1, input.model.reasoningMandatory ? input.minOutputTokens * 2 : input.minOutputTokens));
  const reductions: string[] = [];
  const dropped: string[] = [];
  let sections = input.sections.map((s) => ({ ...s }));

  const sectionTokens = (s: PromptSection) => PER_MESSAGE_OVERHEAD + estimateTextTokens(s.content, calibration);
  const inputTokens = () => REQUEST_OVERHEAD + sections.reduce((n, s) => n + sectionTokens(s), 0);
  const requiredTokens = REQUEST_OVERHEAD + input.sections.filter(isRequired).reduce((n, s) => n + sectionTokens(s), 0);
  const inputCap = () => Math.min(input.limits.maxInputTokens, ctx ? ctx - margin - output : 0);
  const fits = () => ctx > 0 && inputTokens() <= inputCap();

  const finish = (status: ContextFeasibility, reason?: string): ContextPlan => ({
    status,
    messages: toMessages(sections),
    estimatedInputTokens: inputTokens(),
    reservedOutputTokens: output,
    usableContext: Math.max(0, ctx - margin),
    safetyMargin: margin,
    reductions,
    droppedSectionIds: dropped,
    requiredInputTokens: requiredTokens,
    approximate: true,
    reason,
  });

  if (fits()) return finish("FEASIBLE");

  let iterations = 0;
  // 1. Drop optional material, least essential kind and lowest priority first.
  for (const kind of DROP_ORDER) {
    if (fits() || iterations >= input.limits.maxReductionIterations) break;
    const candidates = sections.filter((s) => s.kind === kind && !isRequired(s)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    if (candidates.length === 0) continue;
    iterations++;
    for (const s of candidates) {
      if (fits()) break;
      sections = sections.filter((x) => x.id !== s.id);
      dropped.push(s.id);
    }
    reductions.push(`removed optional ${kind}`);
  }
  // 2. Lower the output reservation, never below what the task needs.
  if (!fits() && output > minOutput && iterations < input.limits.maxReductionIterations) {
    iterations++;
    const room = ctx - margin - inputTokens();
    output = Math.max(minOutput, Math.min(output, room));
    reductions.push(`reduced output reservation to ${output}`);
  }
  if (fits()) return finish("FEASIBLE_WITH_REDUCTION");
  return finish("DOES_NOT_FIT", requiredTokens + minOutput + margin > ctx ? "required context exceeds this model's window" : "input exceeds the per-request token limit");
}

function toMessages(sections: PromptSection[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  // Adjacent sections with the same role are joined so providers see a normal conversation.
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (last && last.role === s.role) last.content += "\n\n" + s.content;
    else out.push({ role: s.role, content: s.content });
  }
  return out;
}

/** Wraps plain messages as required sections (callers that pass messages cannot be reduced, only routed). */
export function messagesToSections(messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>): PromptSection[] {
  return messages.map((m, i) => ({ id: `m${i}`, role: m.role, kind: m.role === "system" ? "policy" : "user_request", content: m.content, required: true }));
}
