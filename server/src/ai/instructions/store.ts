import { query } from "../../db/client.js";
import type { ComposedInstructionSet, InstructionPlan, ValidationResult } from "./types.js";

export async function recordInstructionPlan(orgId: string, plan: InstructionPlan, validation: ValidationResult, composition: ComposedInstructionSet, correlationId?: string): Promise<void> {
  await query(
    `INSERT INTO instruction_plans (id, org_id, task_id, agent_type, agent_version, profile_version, status, base_instruction_ids, additional_instructions, reason_codes, explanation, constraints, output_contract, evidence_requirements, validation_requirements, decision_source, composition_hash, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [plan.instructionPlanId, orgId, plan.taskId, plan.agentId, plan.agentVersion, plan.profileVersion, plan.status, JSON.stringify(plan.baseInstructionIds), JSON.stringify(plan.additionalInstructions), JSON.stringify(plan.reasonCodes), plan.explanation, JSON.stringify(plan.constraints), JSON.stringify(plan.outputContract), JSON.stringify(plan.evidenceRequirements), JSON.stringify(plan.validationRequirements), plan.decisionSource, composition.hash, correlationId ?? null]
  );
  await query(`INSERT INTO instruction_validations (instruction_plan_id, status, violations) VALUES ($1,$2,$3)`, [plan.instructionPlanId, validation.status, JSON.stringify(validation.violations)]);
  await query(`INSERT INTO instruction_compositions (instruction_plan_id, composition_hash, ordered_sections) VALUES ($1,$2,$3)`, [plan.instructionPlanId, composition.hash, JSON.stringify(composition.orderedSections)]);
}
