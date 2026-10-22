# Unused code, dependency and database audit

**Method**
- **Code:** static and dynamic import graph of `src/`, `server/src` and `e2e/`, including the lazy imports in `src/router.tsx` and dynamic `import()` in services. Also checked: route registration in `server/src/app.ts`, npm scripts, CI steps, the Vite and Vitest configs, and test usage.
- **Database:** every table name was searched in non-test server code, tests and the frontend.
- **Classification:** `SAFE_TO_REMOVE`, `POSSIBLY_UNUSED`, `REQUIRES_DEPRECATION`, `ACTIVE` or `INSUFFICIENT_EVIDENCE`.
- **Limits:** low test coverage was not treated as evidence of non-use. No runtime query statistics were available; no production database was queried.

## Removed in this phase (evidence verified)

| Item | Evidence | Class |
| --- | --- | --- |
| `server/src/ai/evidence/adapters.ts` | None of its 5 exports (`normalizeToolObservation`, `httpEvidence`, `securityEvidence`, `performanceEvidence`, `accessibilityEvidence`) is referenced anywhere in `server/src` or `src` | SAFE_TO_REMOVE → removed |
| `src/imports/image.png`, `image-1.png`, `image-2.png` (~320 KB) | Not referenced from `src`, `index.html`, `vite.config.ts` or `.figma` | SAFE_TO_REMOVE → removed |
| `uuid`, `@types/uuid` (server dependencies) | No `uuid` import or require anywhere; the code uses `crypto.randomUUID`. Removed with `pnpm --dir server remove`; both lockfiles updated (the root lock carries the server importer) | SAFE_TO_REMOVE → removed |

The full gate still passes after these removals (see the final report).

## Kept, with evidence (no removal)

| Item | Evidence | Class | Recommendation |
| --- | --- | --- | --- |
| `server/src/ai/adaptation/planner.ts`, `types.ts` | Only imported by `tests/adaptation-intelligence.test.ts`; matches the unused `adaptation_decisions` table | POSSIBLY_UNUSED | Remove together with its test once the owner confirms adaptive planning is abandoned |
| `server/src/ai/agents/lifecycle.ts` | Only imported by lifecycle tests | POSSIBLY_UNUSED | Same |
| `registry.service.recordReliabilityEvent`, `analytics/events.flushEvents` (alias), `router/candidate-scorer.getDataStatus` | No references besides their declarations | POSSIBLY_UNUSED | Remove the exports in a later cleanup |
| `auth.service.revokeAllUserTokens` | Was unused; session revocation now runs inside transactions in `platform/users.ts` | POSSIBLY_UNUSED | Keep as a public helper |
| Unused exports in `src/services/api.ts` (`apiCreateMonitoringRule`, `apiUpdateMonitoringRule`, `apiGetAlert`, `apiUnlinkSearchConsole`, `apiListSearchConsoleJobs`, `apiGetCatalogStatus`, `apiEnableModel`, `apiDisableModel`, `apiGetRoutingDecision`, `setActiveOrgId`) | Server endpoints exist; these are client API surface not yet wired to UI | POSSIBLY_UNUSED | Keep: wiring them is cheaper than re-writing them |
| Unused UI helpers (`Card.SectionHeader`, `MetricCard`, `FindingRow`, `DataState.DemoBanner`, `NotMeasured`, `PartialResult`, `ScoreRing.SmallScore`, `StatusBadge.SeverityBadge`) and about 25 types in `src/types/index.ts` | Dead exports in files that are otherwise used | POSSIBLY_UNUSED | Low value; remove opportunistically |
| `.zigma-agent/` (owner tooling; `master.p1-complete.mjs` is byte-identical to `master.mjs`) | Not imported by the app. `docs/RELEASE_RUNBOOK.md` leaves the decision to the owner | INSUFFICIENT_EVIDENCE (owner decision) | Move out of the repository, then drop the root devDependency `@anthropic-ai/claude-agent-sdk` and its 9 `minimumReleaseAgeExclude` entries |
| `Procfile` | `app.yaml` (DigitalOcean) does not use it | POSSIBLY_UNUSED | Keep while Heroku-style hosting is a possible target |
| Root `pnpm-workspace.yaml` (server as a workspace package) **and** `server/pnpm-lock.yaml` | CI and App Platform install the server standalone; the root lock duplicates the server importer and can drift | INSUFFICIENT_EVIDENCE | Choose one model: workspace or standalone |
| `docs/archive/pasted_text/*` | Historical prompts and logs, not referenced | POSSIBLY_UNUSED | Owner decision |
| `docs/STATUS_UPDATE.md` | Records that credentials were shared in chat; rotation was never confirmed (`RELEASE_RUNBOOK.md`) | ACTIVE (open security follow-up) | Rotate those credentials |
| `server/src/db/supabase_setup.sql` | Deprecated, raises an error when run, and guarded by `security-hardening.test.ts` | REQUIRES_DEPRECATION | Delete together with that test assertion in a dedicated change |
| Placeholder pages (rankings, backlinks, testing, client reports, certificates, domains, agent Control Center, model benchmarks) | They render explicit "unavailable / requires …" states and no figures (`technical-health-page.test.tsx`) | ACTIVE | Not misleading; keep until each feature exists |

## Database

Migrations 000–033 create about 80 tables. About 70 are queried by application code. No database object was dropped or altered in this phase. Migration 034 is purely additive.

### Tables with no application references

| Table(s) | Created in | Inbound foreign keys | Class |
| --- | --- | --- | --- |
| `adaptation_decisions` | 010 | 0 | REQUIRES_DEPRECATION |
| `evidence_requests` | 007 | 0 | REQUIRES_DEPRECATION |
| `improvement_diagnoses` | 009 | 0 | REQUIRES_DEPRECATION |
| `regeneration_decisions`, `regeneration_reviews` | 009 | 0 | REQUIRES_DEPRECATION (`regeneration_runs` is used) |
| `instruction_profiles`, `instruction_profile_versions` | 006 | `instruction_profile_versions` → `instruction_profiles` | REQUIRES_DEPRECATION (profiles live in code, `ai/instructions/profiles.ts`) |
| `quality_policies` | 008 | 0 | REQUIRES_DEPRECATION (code uses `DEFAULT_QUALITY_POLICY`) |
| `routing_feedback` | 004 | 0 | REQUIRES_DEPRECATION |
| `specialist_agent_capabilities`, `specialist_agent_tools`, `specialist_agent_dependencies` | 005 | 0 | REQUIRES_DEPRECATION |

No code references these tables, but **they may hold historical rows in production**. Removing them needs separate, explicit approval and these steps:
1. Run `SELECT COUNT(*)` on each table in production (read-only) and record the counts.
2. If any table is non-empty, take a logical backup (`pg_dump -t <table>`) and keep it according to the retention policy.
3. Release a migration that only `REVOKE`s access and comments the tables as deprecated. Wait one release cycle and watch the logs for errors.
4. Release a numbered migration with `DROP TABLE` (never edit 004–010).
5. Rollback: restore from the backup. The DROP itself cannot be undone.

### Redundant indexes (write overhead only; nothing drops them automatically)

| Index | Redundant with | Class |
| --- | --- | --- |
| `idx_users_email` | `users.email UNIQUE` | SAFE_TO_REMOVE via a new migration (needs approval) |
| `idx_refresh_tokens_token` | `refresh_tokens.token_hash UNIQUE` | Same |
| `idx_scan_modules_scan(scan_id)` | `UNIQUE(scan_id, module_name)` | Same |
| `idx_scan_scores_scan(scan_id)` | `UNIQUE(scan_id, category)` | Same |
| `idx_monitoring_due` | Created in 020 and re-created identically in 021 | No action |
| `idx_gsc_search_daily_value` | Same columns as the primary key in a different order | ACTIVE (different access path) |

Dropping an index loses no data but changes query plans. Do it with `DROP INDEX CONCURRENTLY` in its own migration after checking `pg_stat_user_indexes.idx_scan` in production.

### Columns

No exhaustive per-column audit was done: **INSUFFICIENT_EVIDENCE**. One example: `users.email_verified` is never set or read. It is documented, not removed.

### RLS and tenant isolation

Every table, including the 034 tables, has row-level security enabled. The legacy permissive policies were dropped in 025, and 026 revoked membership writes from client roles. The 034 tables also have `REVOKE ALL` from `PUBLIC`, `authenticated` and `anon`. This audit found no tenant-isolation gap.

### Schema drift

`verify-migrations.mjs` checks this in CI. Upgrading from `1ca145b` or `origin/main` produces the same schema as a fresh install. No drift was found.
