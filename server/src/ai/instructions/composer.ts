import { createHash, randomUUID } from "node:crypto";
import { PLATFORM_POLICY_INSTRUCTIONS, SYSTEM_SAFETY_INSTRUCTIONS } from "./profiles.js";
import type { ComposedInstructionSet, InstructionItem, InstructionPlan, InstructionProfile } from "./types.js";

const rank: Record<InstructionItem["type"], number> = { SYSTEM: 0, SAFETY: 0, PLATFORM_POLICY: 1, AGENT: 2, OUTPUT_FORMAT: 3, TASK: 5, SPECIALIZATION: 6, VALIDATION: 4, EVIDENCE: 7 };

export function composeInstructions(profile: InstructionProfile, plan: InstructionPlan): ComposedInstructionSet {
  const orderedSections = [...SYSTEM_SAFETY_INSTRUCTIONS, ...PLATFORM_POLICY_INSTRUCTIONS, ...profile.instructions, ...plan.additionalInstructions]
    .sort((a, b) => rank[a.type] - rank[b.type] || a.id.localeCompare(b.id));
  const canonical = JSON.stringify(orderedSections.map(({ id, type, text, mandatory, version }) => ({ id, type, text, mandatory, version })));
  return { instructionSetId: randomUUID(), versions: { profileVersion: profile.version, planVersion: "1", agentVersion: plan.agentVersion }, orderedSections, hash: createHash("sha256").update(canonical).digest("hex"), createdAt: new Date().toISOString() };
}
