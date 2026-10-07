import { query } from "@anthropic-ai/claude-agent-sdk";
import { routeTask } from "./router.mjs";

const task = process.argv.slice(2).join(" ");

if (!task) {
  console.error('Usage: node .zigma-agent/master.mjs "your task"');
  process.exit(1);
}

const IMPLEMENTATION_TASKS = {
  "F-001": {
    files: [
      "server/src/ai/evidence/store.ts",
      "server/src/tests/evidence-store.test.ts",
      "server/src/tests/evidence-store.integration.test.ts",
    ],
    allowedCommands: [
      "pnpm --dir server build",
      "pnpm --dir server test",
    ],
  },

  "F-002": {
    files: [
      "server/src/ai/registry.service.ts",
      "server/src/tests/registry.test.ts",
    ],
    allowedCommands: [
      "pnpm --dir server build",
      "pnpm --dir server test",
    ],
  },

  "F-003": {
    files: [
      "server/src/config.ts",
      "server/src/config-security.ts",
      "server/src/tests/production-security-config.test.ts",
      "app.yaml",
    ],
    allowedCommands: [
      "pnpm --dir server build",
      "pnpm --dir server test",
    ],
  },
};

const batchMatch = task.match(
  /\bAPPROVED\s+IMPLEMENTATION\s+BATCH\s+(P0|P1|P2|P3)\b/i,
);

const singleMatch = task.match(
  /\bAPPROVED\s+IMPLEMENTATION\s+(F-\d+)\b/i,
);

const approvedIds = batchMatch
  ? [...new Set(
      [...task.matchAll(/\bF-\d+\b/gi)]
        .map((m) => m[0].toUpperCase()),
    )]
  : singleMatch
    ? [singleMatch[1].toUpperCase()]
    : [];

const implementationMode = approvedIds.length > 0;

if (implementationMode) {
  const unknownIds = approvedIds.filter(
    (id) => !IMPLEMENTATION_TASKS[id],
  );

  if (unknownIds.length > 0) {
    console.error(
      "IMPLEMENTATION BLOCKED: One or more requested findings do not have an approved implementation scope.",
    );
    console.error(`Unknown findings: ${unknownIds.join(", ")}`);
    process.exit(2);
  }

  const emptyScopes = approvedIds.filter(
    (id) => IMPLEMENTATION_TASKS[id].files.length === 0,
  );

  if (emptyScopes.length > 0) {
    console.error(
      "IMPLEMENTATION BLOCKED: One or more findings have no approved file scope.",
    );
    console.error(`Findings: ${emptyScopes.join(", ")}`);
    process.exit(2);
  }
}

const routing = routeTask(task);

console.log("\n=== ZIGMANEURAL MASTER AGENT ===");
console.log(`Task: ${task}`);
console.log(`Complexity: ${routing.complexity}`);
console.log(`Selected model: ${routing.model}`);
console.log(`Internal budget estimate: $${routing.estimatedCostUSD.toFixed(2)}`);

if (implementationMode) {
  console.log(`Mode: CONTROLLED IMPLEMENTATION (${approvedIds.join(", ")})`);
  console.log(
    `Allowed files: ${approvedIds
      .flatMap((id) => IMPLEMENTATION_TASKS[id].files)
      .join(", ")}`,
  );
  console.log(
    `Allowed commands: ${[
      ...new Set(
        approvedIds.flatMap(
          (id) => IMPLEMENTATION_TASKS[id].allowedCommands,
        ),
      ),
    ].join(", ")}`,
  );
} else {
  console.log("Mode: PLAN ONLY");
}

console.log("================================\n");

const scope = implementationMode
  ? `
APPROVED IMPLEMENTATION SCOPE:

Approved findings:
${approvedIds.map((id) => `- ${id}`).join("\n")}

You are authorized to implement ONLY these approved findings.

Files you may create or modify:
${approvedIds.flatMap((id) => IMPLEMENTATION_TASKS[id].files).map((f) => `- ${f}`).join("\n")}

Commands you may run:
${[...new Set(approvedIds.flatMap((id) => IMPLEMENTATION_TASKS[id].allowedCommands))].map((c) => `- ${c}`).join("\n")}

You MUST NOT modify any other file.

You MUST NOT:
- modify migrations
- modify production configuration outside the explicitly approved files
- modify frontend code
- modify deployment configuration
- install dependencies
- modify package.json
- modify .env files
- modify secrets
- modify unrelated AI code
- modify authentication or tenancy code
- modify git history
- commit
- push
- deploy
- reset or revert unrelated changes
- run destructive commands

If you discover another problem while implementing this finding:
DO NOT fix it.
Record it in the final report as an out-of-scope finding.

Implementation requirements for F-001:
1. Verify the current evidence schema and store implementation.
2. Add the legacy required \`type\` column to both evidence INSERT paths.
3. Use \`record.evidenceType\` as the value.
4. Preserve the existing \`evidence_type\` field.
5. Preserve existing tenant/org/task scoping.
6. Preserve the existing logical-key upsert behavior.
7. Add a focused unit test covering both insert paths.
8. Add an integration test for the real database path if the repository's existing integration-test pattern supports it.
9. Do not weaken the database schema to hide the failure.
10. Run the allowed build/tests after implementation.
11. Report every file changed.
12. Report every test executed and its result.
13. If a test cannot run because no disposable PostgreSQL database exists, do not fake success. Report it clearly.
`
  : `
PLAN-ONLY MODE.

You have READ-ONLY access.

You MUST NOT:
- create files
- edit files
- delete files
- rename or move files
- install dependencies
- modify databases
- run migrations
- deploy
- commit
- push
- reset git
- run destructive commands
- expose secrets
- read .env contents
`;

const prompt = `
You are the ZigmaNeural Master Development Agent.

Repository:
 /workspaces/ZigmaNeuralIntelligence

USER REQUEST:
${task}

${scope}

Before working:

1. Read AGENTS.md.
2. Read CLAUDE.md.
3. Read ARCHITECTURE.md.
4. Read SECURITY_AUDIT.md.
5. Inspect relevant source code.
6. Inspect relevant tests.
7. Inspect relevant migrations when database behavior is involved.
8. Never read or expose secret values.
9. Do not inspect .env files.

For controlled implementation:

- Make the smallest production-safe change.
- Do not rewrite unrelated code.
- Do not weaken validation or security to make tests pass.
- Do not create fake/mock production behavior.
- Do not silently skip a required test.
- Preserve existing architecture unless the approved finding requires otherwise.
- After implementation, inspect git diff.
- Confirm every changed file is inside the approved scope.
- Run the allowed validation commands.
- If validation fails, diagnose and fix only problems caused by this approved change.
- Stop if fixing the issue would require an out-of-scope file.

Final response structure:

# MASTER AGENT IMPLEMENTATION REPORT

## 1. Finding
State the approved finding and original problem.

## 2. Changes Made
List every file changed and exactly what changed.

## 3. Verification
List every command run and its result.

## 4. Tests
List passed, failed, and skipped tests.

## 5. Database Impact
State whether schema/migrations changed.

## 6. Security & Tenancy
State whether security or tenant behavior changed.

## 7. Out-of-Scope Findings
List anything discovered but intentionally not changed.

## 8. Remaining Risk
State anything that still requires real database/staging verification.

## 9. Final Status
Use exactly one:
IMPLEMENTED_AND_VERIFIED
IMPLEMENTED_REQUIRES_INTEGRATION_TEST
IMPLEMENTATION_BLOCKED

Do not claim verification that was not actually performed.
`;

const allowedTools = implementationMode
  ? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
  : ["Read", "Grep", "Glob"];

const result = query({
  prompt,
  options: {
    cwd: "/workspaces/ZigmaNeuralIntelligence",
    model: routing.model,
    allowedTools,
    maxTurns: implementationMode ? 60 : 30,
  },
});

for await (const message of result) {
  if (message.type === "assistant") {
    for (const block of message.message.content ?? []) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  }

  if (message.type === "result") {
    console.log("\n--- MASTER AGENT RESULT ---");
    console.log(message.result ?? "");
  }
}
