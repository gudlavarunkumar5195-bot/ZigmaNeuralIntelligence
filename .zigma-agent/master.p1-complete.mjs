import { query } from "@anthropic-ai/claude-agent-sdk";

const task = process.argv.slice(2).join(" ");

if (!task) {
  console.error('Usage: node .zigma-agent/master.mjs "task"');
  process.exit(1);
}

const repo = "/workspaces/ZigmaNeuralIntelligence";

console.log(`
=== ZIGMANEURAL FULL IMPLEMENTATION MASTER AGENT ===

Repository:
${repo}

Mission:
Complete the entire application audit and implementation backlog.

This is NOT plan-only mode.
The agent is authorized to implement the approved repository fixes.
`);

const prompt = `
You are the ZigmaNeural Master Agent.

Your mission is to COMPLETE the ZigmaNeuralIntelligence application based on
the existing full functional audit.

Repository:
${repo}

USER REQUEST:
${task}

==================================================
PRIMARY OBJECTIVE
==================================================

Take the entire application from the current audited state toward
production-ready functionality.

Do NOT merely report findings.

You must:

1. inspect the repository
2. inspect the full audit
3. inspect current working-tree changes
4. understand dependencies between findings
5. implement fixes
6. add/update tests
7. run tests
8. fix failures caused by your changes
9. rebuild
10. re-run verification
11. re-audit affected areas
12. continue until all feasible P0/P1 findings are implemented
13. clearly identify anything that genuinely requires external infrastructure,
    human approval, production credentials, or real staging verification

==================================================
EXECUTION ORDER
==================================================

Follow this dependency-aware order.

BATCH 0
-------
Verify the already implemented work:

F-001
F-002
F-003
F-045

Do not reimplement working fixes unnecessarily.

Verify:
- typecheck
- frontend tests
- backend tests
- build
- diff
- focused tests

F-001 real database verification should be attempted only if a safe isolated
integration database is actually available.

Never use production credentials as a test database.

BATCH 1
-------
F-020 HTTP test harness.

Build reusable Fastify inject() testing infrastructure.

Cover:
- unauthenticated request
- invalid organization
- RBAC
- viewer/member restrictions
- cross-organization access where safely testable

BATCH 2
-------
F-008 then F-007.

F-008:
Introduce the approved platform-admin protection for global resources.

Use the recommended:
PLATFORM_ADMIN_USER_IDS

Requirements:
- user IDs, not emails
- fail closed
- 403 PLATFORM_ADMIN_REQUIRED
- protect global model catalog refresh
- protect model enable
- protect model disable
- protect global agent enable/disable
- protect global routing-policy mutation
- preserve per-org model preferences
- do not weaken tenant membership checks
- update frontend handling
- update tests
- update architecture documentation

Do NOT automatically create a platform admin.
Do NOT expose secrets.
Do NOT put credentials in source control.

F-007:
Fix global routing policy mutation so an organization cannot deactivate
the global default.

Requirements:
- never deactivate the global policy from an org-scoped update
- calculate versions per organization
- transactionally deactivate/insert/audit
- add the required unique active-policy constraint
- add migration if required
- add tests

BATCH 3
-------
F-014 then F-013.

F-014:
Harden IPv6 SSRF validation.

Cover:
- loopback
- unspecified
- fc00::/7
- fe80::/10
- fec0::/10
- multicast
- mapped IPv4
- NAT64
- 6to4
- embedded private IPv4
- legitimate domains such as fcc.gov and fda.gov

F-013:
Harden SSL scanning.

Requirements:
- URL safety check
- DNS resolution/pinning
- connect to validated IP
- preserve TLS servername
- correct URL port
- hard overall timeout
- prevent DNS rebinding/internal probing
- preserve expired-certificate detection behavior

Add focused tests.

BATCH 4
-------
F-012
F-016
F-015

F-012:
Fix proxy-aware rate limiting without creating a spoofable trust configuration.

F-016:
A cancelled/failed monitoring scan must not permanently disable scheduled
monitoring.

F-015:
Fix crashed scan recovery.

Requirements:
- transactional scan creation
- recover expired execution leases
- avoid duplicate live execution
- safe shutdown handling
- preserve tenant isolation
- add tests
- inspect whether retry_count already exists before adding anything

Do not invent database columns without checking the schema first.

BATCH 5
-------
F-019
F-017
F-018

F-019:
Improve migration runner.

Requirements:
- discover migration files dynamically
- deterministic ordering
- migration checksum tracking
- detect modified applied migrations
- safe checksum backfill
- transaction-safe migration locking
- test runner behavior

F-017:
Remove obsolete 021 RLS isolation policies through a new migration.
Never edit an already-applied historical migration to change history.

F-018:
Make production migration/build behavior consistent.

Check:
- SQL files included in production build
- production migration command
- app.yaml
- Procfile
- package scripts
- reproducible dependency installation

Do not deploy.

Do not execute production migrations.

BATCH 6
-------
F-011
F-010
F-009

F-011:
Harden prompt construction against crawled-content prompt injection.

Requirements:
- explicitly label crawled data as UNTRUSTED
- delimit it
- cap individual values
- cap total context
- strip secrets from headers
- preserve legitimate security headers
- test injection strings
- test oversized content

F-010:
Bound AI cost and runtime.

Requirements:
- cap retries
- cap total attempts
- add deadlines
- enforce scan deadline
- prevent stage lease expiration during legitimate bounded work
- prevent duplicate expensive executions
- preserve fallback behavior
- add tests

Do NOT add an arbitrary large token budget.
Prefer deterministic hard limits.

F-009:
Make quality evaluation actually validate evidence.

Requirements:
- validate evidence IDs per finding
- validate tenant/task ownership
- validate freshness where applicable
- calculate actual coverage
- do not automatically ACCEPT empty/unsupported results
- preserve legitimate successful scans
- version the quality policy if behavior changes
- add negative tests

BATCH 7
-------
F-005
F-006
F-004

F-005:
Remove fabricated settings data.

Never replace fake data with another fake value.

Where backend support does not exist:
- use honest unavailable/empty states
- clearly distinguish unavailable functionality
- remove fabricated claims such as MFA/rate-limit status

Extend production-data tests.

F-006:
Remove misleading placeholder navigation or convert it to honest
unavailable states.

Do not pretend an unimplemented feature is functional.

Implement useful existing backend-backed functionality where the audit
shows the backend already exists and the change is small and safe.

F-004:
Fix MonitoringPage unreachable management UI.

Ensure:
- create monitoring
- run now
- pause
- resume
- disable
- frequency changes

actually render and connect to the existing APIs.

Server-side authorization remains authoritative.

Add tests.

==================================================
GENERAL IMPLEMENTATION RULES
==================================================

You have permission to modify application source, tests, migrations,
configuration and documentation necessary for the findings above.

You may create new files.

You may modify existing files.

You may add migrations.

You may NOT:

- expose secrets
- print API keys
- modify production secrets
- commit secrets
- deploy
- push
- reset the repository
- git reset --hard
- git clean -fd
- delete unrelated user work
- overwrite unrelated uncommitted changes
- use production database credentials for testing
- disable authentication
- weaken authorization
- weaken tenant isolation
- bypass RLS merely to make tests pass
- remove tests because they fail
- convert real functionality into mocks just to pass tests

==================================================
WORKING TREE SAFETY
==================================================

Before modifying anything:

- inspect git status
- inspect git diff
- preserve unrelated user changes
- understand existing uncommitted changes

The following existing work is expected and must not be casually reverted:

- F-001 evidence-store fix
- F-003 configuration-security fix
- F-045 TypeScript fixes
- test setup required for backend tests
- intended Master Agent tooling

If an existing change is incorrect, verify it before changing it.

==================================================
TESTING
==================================================

After every batch:

1. run focused tests
2. run TypeScript checks
3. run relevant backend tests
4. run relevant frontend tests

At the end run:

pnpm exec tsc --noEmit
pnpm test
pnpm --dir server build
pnpm --dir server test
git diff --check
pnpm build

If a test fails:

- diagnose the real cause
- fix the implementation
- rerun the test

Never hide failures.

==================================================
DATABASE RULES
==================================================

Before adding a migration:

- inspect existing migrations
- inspect current schema
- inspect migration runner
- check whether equivalent columns/indexes/policies already exist

Never modify historical migrations merely to make the current state appear
correct.

New migrations must be ordered correctly.

If a migration requires a real database to verify:
- add the test
- run it only against a safe isolated database
- otherwise mark it explicitly as pending external verification

==================================================
AI MODEL RULES
==================================================

Use model selection intelligently.

For repository exploration and simple edits:
use a cheaper model.

For architecture/security/database reasoning:
use the stronger model.

Do not repeatedly reread the entire repository.

Use the existing audit as the baseline and inspect only relevant source
when implementing each finding.

Avoid unnecessary model calls.

==================================================
ERROR HANDLING
==================================================

Do not fix errors with generic silent catch blocks.

Preserve or introduce structured error handling.

Every user-facing failure should have:
- meaningful error classification
- safe user-facing message
- useful server-side diagnostics
- no secret leakage

==================================================
DEFINITION OF DONE
==================================================

A finding is DONE only when:

- implementation is complete
- relevant tests exist
- tests pass
- TypeScript passes
- build passes where applicable
- no obvious security regression exists
- no unrelated files were changed
- behavior matches the audit requirement

A finding requiring external infrastructure is:

IMPLEMENTED_PENDING_EXTERNAL_VERIFICATION

not DONE.

==================================================
FINAL RE-AUDIT
==================================================

After implementation:

Search again for:

TODO
FIXME
Coming Soon
placeholder
mock
mocked
demo
sample
fake
temporary
not implemented
console.log
empty catch
throw new Error

But distinguish legitimate test fixtures from production dummy data.

Check frontend -> API -> backend -> service -> database paths.

Check:
- authentication
- authorization
- tenancy
- RLS
- validation
- loading states
- empty states
- error states
- persistence
- integrations
- AI provider paths
- cost controls
- migrations
- deployment configuration

==================================================
FINAL REPORT
==================================================

Produce:

# FULL IMPLEMENTATION REPORT

## Executive Summary

## Findings Completed
| Finding | Status | Files | Tests |

## Findings Pending External Verification

## Findings Blocked

## Tests
- frontend
- backend
- TypeScript
- build
- integration

## Database/Migrations

## Security/Tenancy

## AI/Cost Controls

## Remaining Dummy/Placeholder Functionality

## Remaining P0

## Remaining P1

## Remaining P2/P3

## Working Tree Changes

## Production Readiness

Do not claim production-ready if external verification remains.

==================================================

IMPORTANT:

Do not stop after the first successful batch.

Continue through every feasible P0/P1 batch automatically.

If one finding is blocked by a genuine external dependency,
record it and continue with independent findings.

Do not ask for approval between batches.

Only stop when:
- all feasible P0/P1 findings are implemented and tested,
OR
- a genuine safety/infrastructure boundary prevents further progress.

FINAL STATUS MUST BE HONEST.
`;

const result = query({
  prompt,
  options: {
    cwd: repo,

    // Strong model for the full architectural/security implementation.
    model: "claude-sonnet-5-5",

    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "Bash",
    ],

    maxTurns: 300,
  },
});

for await (const message of result) {
  if (message?.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === "text") {
        process.stdout.write(block.text + "\n");
      }
    }
  }
}

console.log("\n=== FULL IMPLEMENTATION RUN FINISHED ===");
