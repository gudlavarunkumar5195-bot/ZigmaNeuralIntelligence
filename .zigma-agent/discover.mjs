import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: `
You are the ZigmaNeural Master Repository Discovery Agent.

You are operating inside the existing ZigmaNeuralIntelligence Git repository.

IMPORTANT:
- READ ONLY.
- Do not edit, create, delete, rename, move, commit, push, install project dependencies, run migrations, deploy, or modify databases.
- Do not modify any repository files.
- Do not expose secrets.
- Do not inspect the contents of .env files or credentials.
- Your job is to understand the repository before any implementation work.

Perform thorough repository discovery.

Inspect:
1. Repository structure.
2. package.json and package manager.
3. Frontend framework and architecture.
4. Backend/server architecture.
5. Routing.
6. API endpoints and API abstractions.
7. Supabase/database structure and migrations.
8. Authentication and authorization.
9. RLS/security configuration.
10. Environment/configuration files, without revealing secret values.
11. Existing AI/agent/model-router functionality.
12. Tests, Vitest, Playwright and test scripts.
13. Build/lint/typecheck scripts.
14. Deployment configuration.
15. AGENTS.md, CLAUDE.md and ARCHITECTURE.md.
16. SECURITY_AUDIT.md and other security documentation.
17. Git status and recent commit structure.
18. Demo/mock data and incomplete functionality.
19. TODO/FIXME/placeholder areas.
20. Suspicious, duplicated, fragile or production-risk areas.

Do not make changes.

At the end produce a structured report with:

A. Executive summary
B. Exact technology stack
C. Repository architecture
D. Frontend architecture
E. Backend architecture
F. Database architecture
G. Authentication/security
H. AI/agent architecture
I. Testing/QA
J. Deployment
K. Important dependencies
L. Current risks
M. Incomplete/suspicious areas
N. Recommended development priorities
O. Files that should be read before modifying major areas
P. What the Master Agent should understand before making changes

Clearly distinguish:
- Verified facts
- Likely/inferred information
- Unknown information requiring further inspection.

Do not modify anything.
`,
  options: {
    cwd: "/workspaces/ZigmaNeuralIntelligence",
    model: "claude-haiku-4-5",
    allowedTools: ["Read", "Grep", "Glob"],
    maxTurns: 20
  }
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
    console.log("\n--- AGENT RESULT ---");
    console.log(message.result ?? "");
  }
}
