// Phase 11: deterministic task classification.
//
// Every AI call is classified from where it comes from (the feature or agent
// type), never from the content it carries, so a document cannot change its
// own routing, budget or verification requirements.

import type { RouterTaskType } from "./settings.js";
import type { RiskLevel, TaskType } from "./types.js";

export type ResourceTier = "LIGHT" | "STANDARD" | "HEAVY";
export type BenchmarkFocus = "intelligence" | "coding" | "agentic";

export interface TaskProfile {
  category: RouterTaskType;
  tier: ResourceTier;
  benchmark: BenchmarkFocus;
  /** Output tokens a typical answer needs, and the least it can be completed with. */
  desiredOutputTokens: number;
  minOutputTokens: number;
  /** Consequential output gets an independent verification pass when budget allows. */
  verificationRequired: boolean;
  /** The task may be split into bounded subtasks when it does not fit any model. */
  splittable: boolean;
}

const PROFILES: Readonly<Record<RouterTaskType, TaskProfile>> = Object.freeze({
  CLASSIFICATION:        { category: "CLASSIFICATION", tier: "LIGHT", benchmark: "intelligence", desiredOutputTokens: 256, minOutputTokens: 64, verificationRequired: false, splittable: false },
  STRUCTURED_EXTRACTION: { category: "STRUCTURED_EXTRACTION", tier: "LIGHT", benchmark: "intelligence", desiredOutputTokens: 1_500, minOutputTokens: 400, verificationRequired: false, splittable: true },
  SUMMARIZATION:         { category: "SUMMARIZATION", tier: "LIGHT", benchmark: "intelligence", desiredOutputTokens: 1_200, minOutputTokens: 300, verificationRequired: false, splittable: true },
  CONTENT_GENERATION:    { category: "CONTENT_GENERATION", tier: "STANDARD", benchmark: "intelligence", desiredOutputTokens: 2_500, minOutputTokens: 800, verificationRequired: false, splittable: false },
  SEO_ANALYSIS:          { category: "SEO_ANALYSIS", tier: "STANDARD", benchmark: "intelligence", desiredOutputTokens: 2_500, minOutputTokens: 800, verificationRequired: false, splittable: true },
  TECHNICAL_REASONING:   { category: "TECHNICAL_REASONING", tier: "HEAVY", benchmark: "intelligence", desiredOutputTokens: 3_000, minOutputTokens: 1_000, verificationRequired: true, splittable: true },
  CODE_GENERATION:       { category: "CODE_GENERATION", tier: "HEAVY", benchmark: "coding", desiredOutputTokens: 4_000, minOutputTokens: 1_500, verificationRequired: true, splittable: false },
  RESEARCH_SYNTHESIS:    { category: "RESEARCH_SYNTHESIS", tier: "HEAVY", benchmark: "intelligence", desiredOutputTokens: 3_000, minOutputTokens: 1_000, verificationRequired: true, splittable: true },
  PLANNING:              { category: "PLANNING", tier: "HEAVY", benchmark: "agentic", desiredOutputTokens: 2_000, minOutputTokens: 600, verificationRequired: false, splittable: false },
  AGENT_COORDINATION:    { category: "AGENT_COORDINATION", tier: "HEAVY", benchmark: "agentic", desiredOutputTokens: 2_000, minOutputTokens: 600, verificationRequired: false, splittable: false },
  TOOL_USE:              { category: "TOOL_USE", tier: "STANDARD", benchmark: "agentic", desiredOutputTokens: 800, minOutputTokens: 200, verificationRequired: false, splittable: false },
  VERIFICATION:          { category: "VERIFICATION", tier: "STANDARD", benchmark: "intelligence", desiredOutputTokens: 800, minOutputTokens: 200, verificationRequired: false, splittable: false },
});

/** Agent and legacy task types mapped to router categories. */
const LEGACY_TO_CATEGORY: Readonly<Record<string, RouterTaskType>> = Object.freeze({
  DISCOVERY: "STRUCTURED_EXTRACTION",
  SEO_ANALYSIS: "SEO_ANALYSIS",
  AEO_ANALYSIS: "SEO_ANALYSIS",
  GEO_ANALYSIS: "SEO_ANALYSIS",
  SECURITY_ANALYSIS: "TECHNICAL_REASONING",
  PERFORMANCE_ANALYSIS: "TECHNICAL_REASONING",
  ACCESSIBILITY_ANALYSIS: "TECHNICAL_REASONING",
  TECHNICAL_HEALTH_ANALYSIS: "TECHNICAL_REASONING",
  SSL_ANALYSIS: "TECHNICAL_REASONING",
  QA_ANALYSIS: "TECHNICAL_REASONING",
  CROSS_DOMAIN_ANALYSIS: "RESEARCH_SYNTHESIS",
  REMEDIATION: "PLANNING",
  CODE_GENERATION: "CODE_GENERATION",
  REPORT_SYNTHESIS: "SUMMARIZATION",
  EVIDENCE_SUMMARIZATION: "SUMMARIZATION",
  STRUCTURED_EXTRACTION: "STRUCTURED_EXTRACTION",
  ROUTER: "CLASSIFICATION",
});

/** Product features that call the model directly (not through an agent). */
export const FEATURE_CATEGORY: Readonly<Record<string, RouterTaskType>> = Object.freeze({
  content_brief: "CONTENT_GENERATION",
  research_insights: "RESEARCH_SYNTHESIS",
  seo_workspace_summary: "SUMMARIZATION",
  aiv_summary: "SUMMARIZATION",
  aiv_answer: "CONTENT_GENERATION",
  agent: "SEO_ANALYSIS",
});

export function profileFor(category: RouterTaskType): TaskProfile {
  return PROFILES[category];
}

/** Resolves a task's category from a router category, an agent/legacy task type, or a feature name. */
export function classifyTask(input: { taskType?: string | null; feature?: string | null }): TaskProfile {
  const t = (input.taskType ?? "").toUpperCase();
  if (Object.hasOwn(PROFILES, t)) return PROFILES[t as RouterTaskType];
  if (Object.hasOwn(LEGACY_TO_CATEGORY, t)) return PROFILES[LEGACY_TO_CATEGORY[t]];
  const f = (input.feature ?? "").toLowerCase();
  if (Object.hasOwn(FEATURE_CATEGORY, f)) return PROFILES[FEATURE_CATEGORY[f]];
  return PROFILES.SEO_ANALYSIS;
}

/** Risk drives verification and exploration: consequential work is never used to explore. */
export function riskForCategory(category: RouterTaskType, declared?: RiskLevel): RiskLevel {
  if (declared) return declared;
  return category === "CODE_GENERATION" || category === "TOOL_USE" ? "HIGH" : category === "CLASSIFICATION" || category === "SUMMARIZATION" ? "LOW" : "MEDIUM";
}

export function isRouterCategory(t: string): t is RouterTaskType {
  return Object.hasOwn(PROFILES, t);
}

export type { TaskType };
