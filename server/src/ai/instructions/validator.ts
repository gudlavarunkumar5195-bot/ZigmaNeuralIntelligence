import type { AgentDefinition } from "../agents/types.js";
import type { InstructionItem, InstructionPlan, ValidationResult } from "./types.js";

const forbidden = /\b(ignore|override|disable|bypass|skip|reveal|expose)\b.{0,80}\b(system|security|policy|validation|tenant|rbac|permission|secret|credential|environment)/i;
const toolRequest = /\b(use|enable|access)\s+(?:the\s+)?([A-Z_]+)\b/g;

export function validateInstructionPlan(plan: InstructionPlan, agent: AgentDefinition): ValidationResult {
  const violations: string[] = [];
  for (const item of plan.additionalInstructions) {
    if (item.source === "UNTRUSTED") violations.push("Untrusted content cannot become an executable instruction.");
    if (item.type === "SYSTEM" || item.type === "PLATFORM_POLICY" || item.type === "SAFETY") violations.push("Dynamic instructions cannot declare a protected instruction type.");
    if (forbidden.test(item.text)) violations.push("Instruction attempts to weaken a protected policy or expose sensitive data.");
    for (const match of item.text.matchAll(toolRequest)) {
      if (!agent.allowedTools.some((tool) => tool.name === match[2])) violations.push(`Instruction requests unauthorized tool: ${match[2]}.`);
    }
  }
  if (plan.constraints.some((constraint) => /disable|bypass|skip.*validation|tenant/i.test(constraint))) violations.push("Plan constraints conflict with deterministic platform policy.");
  return { status: violations.length ? "REJECTED" : "APPROVED", violations, validatedAt: new Date().toISOString() };
}
