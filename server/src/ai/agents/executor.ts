import { assertAgentPolicy } from "./policy-gate.js";
import { executeAgent } from "./orchestrator.js";
import type { AgentInput, AgentResult } from "./types.js";

export interface AgentExecutorContext extends AgentInput {
  policy?: { timeoutMs?: number; maxRetries?: number };
}

export class AgentExecutor {
  async execute(context: AgentExecutorContext): Promise<AgentResult> {
    await assertAgentPolicy({
      ...context,
      timeoutMs: context.policy?.timeoutMs ?? context.timeoutMs,
      maxRetries: context.policy?.maxRetries ?? context.maxRetries,
      context: {
        ...context.context,
        ...(context.policy?.timeoutMs !== undefined ? { timeoutMs: context.policy.timeoutMs } : {}),
      },
    });
    return executeAgent({
      ...context,
      timeoutMs: context.policy?.timeoutMs ?? context.timeoutMs,
      maxRetries: context.policy?.maxRetries ?? context.maxRetries,
    });
  }
}

export const agentExecutor = new AgentExecutor();