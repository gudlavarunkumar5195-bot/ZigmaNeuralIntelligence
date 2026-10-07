import { query } from "../../db/client.js";
import { getAgentDefinition, getAgentFromDb } from "./registry.js";
import type { AgentInput } from "./types.js";

export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

export async function assertAgentPolicy(input: AgentInput): Promise<void> {
  if (input.userId) {
    const { rows } = await query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2",
      [input.userId, input.tenantId]
    );
    if (!rows[0]) throw new PolicyDeniedError("User is not a member of the active organization");
  }
  const definition = getAgentDefinition(input.agentType);
  if (!definition || !definition.enabled || definition.status !== "ACTIVE") {
    throw new PolicyDeniedError(`Agent ${input.agentType} is not enabled`);
  }

  const dbAgent = await getAgentFromDb(input.agentType);
  if (dbAgent && (!dbAgent.enabled || dbAgent.status !== "ACTIVE")) {
    throw new PolicyDeniedError(`Agent ${input.agentType} is disabled by policy`);
  }

  for (const tool of input.allowedTools ?? []) {
    if (!definition.allowedTools.some((allowed) => allowed.name === tool)) {
      throw new PolicyDeniedError(`Tool ${tool} is not allowed for ${input.agentType}`);
    }
  }

  if (input.websiteId) {
    const { rows } = await query<{ url: string; verified: boolean }>(
      "SELECT url, verified FROM websites WHERE id = $1 AND org_id = $2 AND active = TRUE",
      [input.websiteId, input.tenantId]
    );
    const website = rows[0];
    if (!website) throw new PolicyDeniedError("Website is outside the active organization");
    if (!website.verified) throw new PolicyDeniedError("Website ownership is not verified");
    if (input.target && new URL(input.target).origin !== new URL(website.url).origin) {
      throw new PolicyDeniedError("Agent target is outside the verified website origin");
    }
    if (input.evidenceReferences.length > 0) {
      const { rows } = await query(
        "SELECT COUNT(*)::int AS count FROM evidence WHERE id = ANY($1::uuid[]) AND org_id = $2 AND task_id = $3 AND metadata->>'websiteId' = $4",
        [input.evidenceReferences, input.tenantId, input.taskId, input.websiteId]
      );
      if (Number(rows[0]?.count ?? 0) !== input.evidenceReferences.length) {
        throw new PolicyDeniedError("Evidence references are outside the authorized website or task");
      }
    }
  } else if (input.target) {
    throw new PolicyDeniedError("Agent target requires a verified website context");
  }

  const timeoutMs = input.timeoutMs ?? (typeof input.context.timeoutMs === "number" ? input.context.timeoutMs : 60_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new PolicyDeniedError("Agent timeout is outside policy limits");
  }
}