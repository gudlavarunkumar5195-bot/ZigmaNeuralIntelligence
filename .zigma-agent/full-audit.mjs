import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = `
You are the ZigmaNeuralIntelligence FULL FUNCTIONAL AUDIT AGENT.

Repository:
 /workspaces/ZigmaNeuralIntelligence

MISSION:

Perform a comprehensive read-only audit of the ENTIRE application.

The goal is NOT merely to understand the architecture.

The goal is to determine what is:
- fully implemented
- partially implemented
- broken
- unfinished
- dummy/mock
- placeholder
- disconnected
- missing
- incorrectly implemented
- missing error handling
- missing validation
- missing loading/empty/error states
- inconsistent between frontend/backend/database
- insecure
- untested
- documented incorrectly

IMPORTANT:
READ ONLY.

DO NOT:
- modify files
- create files
- delete files
- rename files
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
- print API keys/tokens/passwords/cookies

You MAY inspect source code, configuration structure, documentation, tests, migrations, routes, components and package manifests.

Do not treat documentation as proof that a feature works.
Verify claims against actual implementation.

==================================================
PHASE 1 — GOVERNANCE
==================================================

Read:
- AGENTS.md
- CLAUDE.md
- ARCHITECTURE.md
- SECURITY_AUDIT.md
- package.json
- server/package.json

Determine:
- authoritative rules
- architecture
- scripts
- dependencies
- documented phases
- documented functionality
- known limitations

==================================================
PHASE 2 — COMPLETE FRONTEND INVENTORY
==================================================

Inventory EVERY:

- route
- page
- layout
- component
- modal
- form
- table
- dashboard
- settings page
- navigation item
- button/action
- hook
- API client
- state/store
- loading state
- empty state
- error state

For every major page/functionality determine:

1. Does the route exist?
2. Does the UI load?
3. Does it use real data?
4. Is data fetched from a real API?
5. Are mutations connected?
6. Are buttons/actions actually functional?
7. Are forms validated?
8. Is success handled?
9. Is failure handled?
10. Is loading handled?
11. Is empty data handled?
12. Are permissions respected?
13. Is tenant context respected?
14. Are there hardcoded/demo values?
15. Are there placeholders?
16. Are there dead/unreachable controls?
17. Are there "Coming Soon" features?
18. Are errors swallowed?

Search for indicators such as:
- TODO
- FIXME
- Coming Soon
- placeholder
- mock
- mocked
- demo
- sample
- fake
- hardcoded
- static
- temporary
- not implemented
- console.log
- empty catch blocks
- throw new Error
- integration required
- unsupported

Do not assume these are automatically defects. Inspect their context.

==================================================
PHASE 3 — COMPLETE BACKEND INVENTORY
==================================================

Inventory EVERY:

- Fastify route
- endpoint
- middleware
- service
- repository/database access
- validation schema
- background worker
- queue/job
- AI agent
- provider
- router
- integration
- error handler

For every endpoint determine:

- authentication
- authorization
- tenant enforcement
- input validation
- database operation
- real implementation vs mock
- response schema
- success handling
- error handling
- transaction behavior
- retry behavior
- timeout behavior
- logging/audit
- tests

Identify:
- endpoints with no frontend consumer
- frontend API calls with no backend endpoint
- mismatched request/response contracts
- body orgId vs authenticated orgId inconsistencies
- unscoped tenant queries
- unsafe updates/deletes
- swallowed errors
- generic errors hiding useful information
- missing validation
- missing authorization

==================================================
PHASE 4 — DATABASE AUDIT
==================================================

Inspect ALL migrations in order.

Inventory:

- tables
- columns
- primary keys
- foreign keys
- unique constraints
- indexes
- enums
- triggers
- RLS
- policies
- audit tables

Determine:

- which application features depend on each table
- whether CRUD actually exists
- orphaned tables
- tables without consumers
- consumers without schema
- migration/documentation mismatches
- missing indexes where obvious
- tenant isolation gaps
- dangerous cascade behavior
- incomplete migrations

Do NOT connect to or modify a live database.

==================================================
PHASE 5 — AI / AGENT AUDIT
==================================================

Inspect the complete AI implementation.

Inventory:

- all agents
- all providers
- model registry
- model routing
- OX Alpha
- fallback logic
- retries
- evidence layer
- instruction layer
- quality layer
- regeneration
- adaptation
- AI endpoints
- prompts
- output validation
- usage tracking
- error handling

For each determine:

- implemented?
- actually invoked?
- reachable?
- tested?
- provider configured?
- fallback exists?
- malformed output handled?
- timeout handled?
- provider failure handled?
- mock response anywhere?
- hardcoded model?
- hardcoded result?
- audit trail?

==================================================
PHASE 6 — INTEGRATIONS
==================================================

Inventory external integrations.

For each determine:

- configuration
- credentials requirement
- API client
- actual invocation
- response validation
- timeout
- retry
- failure handling
- unavailable integration behavior
- IntegrationRequired behavior
- mock/demo fallback

Never expose credentials.

==================================================
PHASE 7 — AUTH / SECURITY / TENANCY
==================================================

Audit:

- registration
- login
- logout
- refresh
- password handling
- JWT
- refresh tokens
- RBAC
- organization context
- x-org-id
- route params
- body orgId
- RLS
- SQL queries
- IDOR
- SSRF
- rate limits
- CORS
- security headers
- CSRF assumptions
- secret handling
- audit logging

Look specifically for defense-in-depth gaps.

==================================================
PHASE 8 — ERROR HANDLING
==================================================

Systematically identify:

- empty catch blocks
- swallowed exceptions
- unhandled promises
- generic error responses
- missing frontend error states
- backend exceptions that can reach users
- database errors without translation
- external API errors without translation
- AI provider failures without fallback
- retry loops without limits
- timeouts missing
- partial failure handling

For each important failure path, determine what the user actually sees.

==================================================
PHASE 9 — TEST COVERAGE
==================================================

Inventory:

- frontend unit tests
- backend unit tests
- integration tests
- tenancy tests
- security tests
- AI tests
- E2E tests

Compare tests against actual functionality.

Identify:

- important functionality with no tests
- tests that only inspect strings instead of behavior
- skipped tests
- stale tests
- tests that don't exercise production code
- missing negative/error cases

==================================================
PHASE 10 — DOCUMENTATION CONSISTENCY
==================================================

Compare:

- ARCHITECTURE.md
- SECURITY_AUDIT.md
- AGENTS.md
- CLAUDE.md

against actual source code.

Identify:

- stale documentation
- features documented but missing
- implemented features not documented
- contradictory claims
- outdated security statements
- outdated architecture statements

==================================================
PHASE 11 — CROSS-LAYER CONSISTENCY
==================================================

This is critical.

Trace important functionality end-to-end:

UI
→ API client
→ backend route
→ middleware
→ service
→ database
→ response
→ frontend state
→ UI

Find breaks anywhere in this chain.

Also identify:

Frontend functionality
WITHOUT backend implementation

Backend functionality
WITHOUT frontend consumer

Database functionality
WITHOUT application consumer

Documentation
WITHOUT implementation

Implementation
WITHOUT tests

==================================================
FINAL REPORT
==================================================

Produce a comprehensive report.

Use this classification:

IMPLEMENTED_VERIFIED
IMPLEMENTED_UNVERIFIED
PARTIALLY_IMPLEMENTED
BROKEN
DUMMY_OR_MOCK
PLACEHOLDER
MISSING
DEAD_OR_UNUSED
ERROR_HANDLING_GAP
SECURITY_GAP
TENANCY_GAP
INTEGRATION_REQUIRED
TEST_GAP
DOCUMENTATION_GAP

Assign priority:

P0 = blocks core functionality/security/production
P1 = major functionality incomplete or broken
P2 = important but non-blocking
P3 = polish/cleanup

For every finding provide:

ID
Area
Feature
Status
Priority
Evidence (exact file/path and relevant function/component)
What is actually implemented
What is missing/broken
Expected behavior
Recommended implementation
Tests required
Dependencies
Risk

==================================================
REQUIRED SUMMARY TABLES
==================================================

1. Complete feature inventory
2. Frontend functionality status
3. Backend endpoint status
4. Database feature mapping
5. AI/agent status
6. Integration status
7. Security findings
8. Error-handling findings
9. Test gaps
10. Documentation gaps
11. Dummy/mock/placeholder findings
12. Cross-layer mismatches
13. P0/P1/P2/P3 backlog

==================================================
FINAL PRIORITIZATION
==================================================

Create a recommended execution order:

Phase 1 — P0 blockers
Phase 2 — P1 broken/incomplete core functionality
Phase 3 — P1/P2 cross-layer integration
Phase 4 — error handling and resilience
Phase 5 — security/tenancy hardening
Phase 6 — test coverage
Phase 7 — documentation
Phase 8 — P3 polish

Do NOT implement any fixes.

The purpose of this run is to create the authoritative application completion backlog.

At the end clearly state:

AUDIT COMPLETE: YES
FILES MODIFIED: NONE
DATABASE MODIFIED: NO
DEPLOYMENT PERFORMED: NO
SECRETS EXPOSED: NO
`;

const result = query({
  prompt,
  options: {
    cwd: "/workspaces/ZigmaNeuralIntelligence",
    model: "claude-sonnet-5-5",
    allowedTools: ["Read", "Grep", "Glob"],
    maxTurns: 100
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
    console.log("\n--- FULL FUNCTIONAL AUDIT RESULT ---");
    console.log(message.result ?? "");
  }
}
