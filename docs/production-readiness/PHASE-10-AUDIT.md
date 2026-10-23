# Phase 10 production-readiness audit

**Branch:** `feat/p10-production-readiness`, from `main` at `31eeebc` (PR #14 merged).
**Recorded:** 23 Oct 2026. Every result below was executed in this phase.

**Companion documents:**
- `SECURITY-FINDINGS.md`: findings, fixes, open items.
- `PERFORMANCE-BASELINE.md`: measurements.
- `ROUTE-API-ACCEPTANCE-MATRIX.md`: journeys.
- `RELEASE-RUNBOOK.md`: release steps and environment inventory.

## Verdict: CONDITIONAL GO

**For:**
- No P0 issue was found.
- Every P1 found was fixed and has a regression test.
- Authentication, tenant isolation, SSRF protection, secrets handling and cost controls were verified in code and by tests.
- CI is green on GitHub for the merged baseline (PR #14), including the real-API browser job.

**Conditions (not verifiable from here; do them before production):**
1. Take a backup, then follow `RELEASE-RUNBOOK.md` §1: the migration 028 index check, building the 040 indexes `CONCURRENTLY` on large tables, and database timeouts on the role if a pooler is used.
2. Run the staging verification in `docs/RELEASE_RUNBOOK.md` §4 and the post-deploy checks in `RELEASE-RUNBOOK.md` §2. There is no staging or production access here.
3. Configure log shipping and alerting. The repository contains no monitoring or alerting pipeline.

**Known product gaps that are not release blockers but should be decided:**
- Registration reveals whether an email has an account (P2).
- No per-account login throttle (P2).
- Row-level security is not a database backstop (P2).
- Email delivery is not configured, so password-reset emails cannot be sent.

## 1. Repository baseline (before changes)

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` (root and server) | pass |
| Type check | `pnpm exec tsc --noEmit`; `pnpm --dir server exec tsc --noEmit -p .` | pass / pass |
| Frontend tests | `pnpm test` | **273 passed** (25 files) |
| Server tests (real PostgreSQL 16) | `RUN_INTEGRATION=1 pnpm --dir server test` | **1122 passed** (85 files), 0 skipped |
| Migration verification | `server/scripts/verify-migrations.mjs` | pass |
| Migrate twice | `pnpm --dir server migrate` ×2 | pass |
| Build | `pnpm build` | pass |
| Audit | `pnpm audit --prod --audit-level high` / server | pass, but **1 moderate** production advisory (`ip-address`) / none |
| Whitespace | `git diff --check` | pass |
| Format | `pnpm exec oxfmt --check` | **fail**: known since Phase 8; the repository has never been formatted with oxfmt (368 files) |
| CI on GitHub (PR #14) | Actions API | all three jobs success, including the real-API browser tests |

## 2. After this phase

| Check | Result |
| --- | --- |
| Type checks (frontend, server) | pass |
| Frontend tests | **274 passed** (25 files) |
| Server tests (real PostgreSQL) | **1136 passed** (89 files), 0 failed, 0 skipped. New: production hardening, session hardening, crypto tag, pooler detection |
| Migration verification | pass: fresh install, no-op re-run, and upgrade from `1ca145b` and from `origin/main` through `040`, with a schema identical to a fresh install |
| Build | pass (Vite 8.3.5) |
| `pnpm audit` / `--prod` (root) | **No known vulnerabilities found** (all dependencies, including dev) |
| `pnpm --dir server audit --prod` | No known vulnerabilities found. The secondary `server/pnpm-lock.yaml` still lists 6 dev-only Vite advisories (OPS-01) |
| Whitespace | pass |
| Format (`oxfmt --check`) | fail (unchanged, pre-existing) |
| E2E, signed-out smoke (`pnpm test:e2e`, installed Chrome) | **5 passed** |
| E2E, real API and database (`pnpm test:e2e:integration`) | **24 passed**, 0 skipped. Includes axe-core WCAG 2.2 A/AA scans on all 45 navigable routes |

Lint: the repository has no ESLint configuration; `oxfmt` is the only lint-style step.

**Secret scanning:** no dedicated scanner (gitleaks or trufflehog) is installed. A pattern search over all tracked files found **no matches**. It covered private-key blocks and OpenRouter, Anthropic, AWS, GitHub, Slack and Google API key formats. `.env*` files are git-ignored, and none is present in the working tree.

## 3. Security audit

Four independent read-only audits were run, each finding verified in code, and confirmed defects fixed with tests. Details are in `SECURITY-FINDINGS.md`.

- **P0:** none.
- **P1 fixed:**
  - **SEC-01:** a stalled gzip body hung the fetch forever. Reproduced, fixed and tested.
  - **DB-01:** no statement or idle-in-transaction timeouts.
  - **DB-02:** the workspace overview saturated the connection pool. Measured, fixed and measured again.
- **P2 fixed:**
  - unbounded dashboard history (3.4 MB, measured);
  - missing indexes;
  - mutable audit log;
  - a moderate production dependency advisory;
  - WCAG contrast and labelling failures.
- **P3 fixed:**
  - refresh rotation across tabs;
  - `/me` answering for deactivated users;
  - JWT algorithm pinning;
  - Secure cookie on HTTPS staging;
  - `authenticate` return;
  - input bounds;
  - GCM tag length;
  - OpenRouter redirects;
  - evidence update scoping.
- **Open:** 10 P2 and 14 P3 items, each with a recommended action.

## 4. Tenant isolation

What was checked, and how:

- **Route coverage (code audit).** All 27 route files require auth plus org membership, with three intended exceptions: auth, health and the OAuth callback (bound by single-use state).
- **Org scoping (code audit).** Every by-id query in services and workers is scoped by `org_id`, or follows a parent check that is. One defence-in-depth gap was fixed (TEN-01).
- **Server integration tests** (`http-rbac-tenancy`, 105 tests in this phase) cover:
  - organization resolution (wrong, unknown or malformed org header);
  - RBAC on every mutating route per role;
  - cross-organization reads and writes by id;
  - platform-admin-only global resources;
  - new: memberships in `/auth/me`, alert-id validation, and viewer refusal for alert transitions.
- **Browser (real API).** Another tenant's scan and website are invisible in the UI and refused by the API (403/404). A viewer's attempted change is refused and the record is unchanged after a reload.
- **Gap.** Database RLS policies do not apply to the application role (TEN-02, P2). Isolation is enforced only in the application.

## 5. End-to-end coverage

Verified against the real API and database (24 tests):
- sign-in, reload, logout, expiry and renewal, failed renewal with return path, wrong password;
- viewer and member restrictions, cross-tenant invisibility;
- alert resolve (single request, persisted), URL validation;
- technical-health issues with ignore and reopen;
- backlink CSV export with formula safety;
- rank project, keywords and pause;
- content topic; saved keyword lists;
- AI-visibility brand and re-matching;
- alert rules (admin allowed, member refused);
- Search Console unlink;
- model disable and enable; the audit log;
- every navigable route (crash, heading, overflow, page errors, axe WCAG).

Gaps:
- Starting real scans or crawls, live link checks and ownership verification all fetch external sites, so they are covered by unit and integration tests only.
- Provider-backed journeys are BLOCKED (see 7).
- Dashboard-to-source reconciliation is covered by service-level integration tests, not in the browser.

## 6. Performance

Measured before and after on about 657,000 Search Console rows, 90,000 findings, 20,000 snapshots and 300,000 audit rows (`PERFORMANCE-BASELINE.md`):

| Measure | Before | After |
| --- | --- | --- |
| Dashboard response size | 3,362,622 bytes | 63,942 bytes |
| Dashboard median | 133 ms | 7 ms |
| Median of a cheap request during 6 concurrent overviews | 66 ms | 8 ms |
| Overview latency | | essentially unchanged |

Not measured: production-like network latency, crawl memory over long jobs, and frontend runtime.

## 7. Integrations

| Integration | Status |
| --- | --- |
| PostgreSQL 16 | Tested (local, real) |
| Google Search Console | Code and OAuth flow verified; tests use a fake Google. **BLOCKED** live (no OAuth credentials). An unlink path with a seeded integration was tested end to end |
| OpenRouter (AI) | Mocked transport in tests; no paid or live call made. **BLOCKED** live (no key) |
| Anthropic API, Sarvam | **Not present** as application providers. The only Anthropic package is `@anthropic-ai/claude-agent-sdk`, used by the repository's `.zigma-agent/` tooling, not by the app |
| SERP / rank providers, keyword data providers | Provider-neutral adapters; none configured. **BLOCKED** |
| ClickHouse | Optional; outbox isolation verified in code. **Unverified** live (not configured) |
| Email delivery | **Not implemented** (no provider) |

## 8. Database

- **Migrations:** 000–040 in order, checksummed, applied under an advisory lock, and verified on a fresh install and on upgrades from both baselines. 040 is additive.
- **Production migration status:** unknown here; no production access. See the runbook §1 check for migration 028.
- **Integrity:**
  - composite `(id, org_id)` foreign keys on most tenant tables (gaps: TEN-03);
  - audit log now append-only;
  - job claiming uses `FOR UPDATE SKIP LOCKED` with leases and retry caps.
- **Risks:**
  - long-range Search Console aggregation (DB-03, now time-bounded);
  - worker coupling (DB-06);
  - in-memory exports (DB-07);
  - N+1 in transactions (DB-08);
  - outbox transaction across HTTP (DB-09);
  - no migrator `lock_timeout` (DB-11);
  - no retention for several growing tables.

## 9. Deployment readiness

Checked in `app.yaml`, `Procfile` and `server/src/config*.ts`:
- frozen installs and the build command;
- PRE_DEPLOY migrations over the direct connection;
- `/ready` health check (database only; no secrets or tenant data exposed);
- graceful shutdown (drains scans, closes SSE, forced exit after the grace period);
- strict config validation that refuses unsafe production settings;
- QA bypass off, database TLS verification on, `TRUST_PROXY=1`, auto-deploy off.

Remaining manual steps are in the runbook: backups, the 028 check, index builds, role timeouts, a log drain and alerts, and an email provider.

## 10. Files changed in this phase

**Server**
- `src/scanner/fetch.ts`
- `src/db/client.ts`, `src/config.ts`
- `src/routes/dashboard.ts`, `src/routes/auth.ts`, `src/routes/routing.ts`, `src/routes/agents.ts`
- `src/services/seo-workspace.service.ts`, `src/services/auth.service.ts`, `src/services/scan.service.ts`
- `src/middleware/auth.ts`, `src/app.ts`
- `src/integrations/crypto.ts`
- `src/ai/providers/openrouter.ts`, `src/ai/catalog.service.ts`
- `src/tests/setup.ts`, `src/tests/fetch-pinned.test.ts`
- new: `src/db/migrations/040_production_hardening.sql`, `scripts/perf-baseline.mts`
- new tests: `production-hardening.integration`, `session-hardening.integration`, `crypto-tag`, `db-pooler`

**Frontend**
- `src/services/api.ts` (refresh retry across tabs)
- `src/index.css` (`slate-400` contrast)
- `src/components/layout/Shell.tsx`, `src/components/ui/Toast.tsx`
- `src/pages/Overview.tsx`
- `src/pages/agents/AgentRegistry.tsx`, `ModelRegistry.tsx`, `ModelRouter.tsx`
- `src/tests/api-refresh.test.ts`

**E2E**
- new: `e2e/integration/accessibility.spec.ts`
- `e2e/integration/z-route-smoke.spec.ts` (axe scan per route)

**Dependencies**
- `package.json`, `pnpm-lock.yaml`: Vite 8.3.5, Vitest 4.1.12, `@axe-core/playwright` (dev)
- `pnpm-workspace.yaml`: security floors

**Docs**
- `docs/production-readiness/*`
- `docs/IMPLEMENTATION_LOG.md`, `AGENTS.md`

## 11. Git

No commit, push, deployment or production migration was performed. Work stayed on a new branch with no pre-existing uncommitted changes. The one lockfile change that went beyond its purpose (`server/pnpm-lock.yaml`) was restored from a backup and left as it was.
