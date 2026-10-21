# Implementation log: P0 foundation + SEO crawl slice

Branch `feat/p0-foundation-seo-crawl`, based on `main` at `1ca145b` (21 Oct 2026). Not deployed. No production migration has been run.

## What changed

| Area | Change | Where |
| --- | --- | --- |
| CI | Install (frozen), type check, frontend tests, server build, migrate a fresh PostgreSQL 16 twice, server unit + integration tests, production build, `audit --prod --audit-level high`, PR check that applied migrations are never modified, Playwright smoke job | `.github/workflows/ci.yml` |
| Neon migrations | `000_supabase_role_compat.sql` creates NOLOGIN `authenticated` / `anon` only when missing, so 021/022 apply on a fresh database. No applied migration was edited | `server/src/db/migrations/000_*` |
| Migrate once per release | `app.yaml` web `run_command` only starts the server; a `PRE_DEPLOY` job runs `migrate:prod`. The migrator prefers `DIRECT_DATABASE_URL` and validates only DB TLS settings | `app.yaml`, `server/src/db/migrate.ts`, `server/src/config-security.ts` |
| Auto-deploy | `deploy_on_push: false` until CI is a required check on `main` (App Platform cannot wait for GitHub checks) | `app.yaml` |
| Dependencies | fastify 5.12.7, @fastify/* patch releases and transitive updates; `audit --prod` clean | `server/package.json`, lockfile |
| Ownership verification | Token must be served by the claimed host or its www/apex twin; meta tag read from the origin root | `server/src/services/website.service.ts` |
| Atomic module commit | Findings, evidence, module status (guarded by execution ownership), crawl data and outbox rows commit in one transaction | `server/src/services/scan.service.ts` |
| Duplicate scans | Existing active scan returned (`200`, `meta.deduplicated`); monitoring gets `409 SCAN_ALREADY_ACTIVE`; partial unique index backstop | `scan.service.ts`, `routes/scans.ts`, migration 028 |
| Analytics outbox | `analytics_outbox` written in the business transaction, dispatched with `FOR UPDATE SKIP LOCKED`, backoff, DEAD after 20 attempts; ClickHouse DDL now ReplacingMergeTree keyed on `event_id` | `server/src/analytics/events.ts`, migration 027 |
| AI cost guards | Atomic per-org budget reservation; unattributed calls refused; free-only unless `AI_ALLOW_PAID_MODELS=true`; router LLM advisor off unless `AI_ROUTER_LLM_ENABLED=true` (and then budgeted) | `server/src/ai/budget.ts`, `ai/ox-alpha.ts`, `ai/router/*` |
| SEO crawl | robots.txt (RFC 9309, linear-time matching), sitemaps, same-site crawl with page/time/link budgets, status inventory, broken links, redirect chains/loops, canonical checks, duplicate titles/descriptions | `server/src/scanner/{robots,sitemap,crawl}.ts` |
| Persistent issues | `site_issues` with OPEN / FIXED / IGNORED, fingerprints per website, event history; API and Technical Health page | migration 029, `services/site-audit.service.ts`, `routes/site-audit.ts`, `src/pages/intelligence/TechnicalHealthPage.tsx` |
| Search data honesty | Keywords, Rankings, Backlinks, Competitors pages say the data needs an authorized source and show no figures | `src/pages/search/SearchDataPages.tsx` |

## New configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_ALLOW_PAID_MODELS` | `false` | Needs explicit approval. While false only registry-verified FREE models are called |
| `AI_ROUTER_LLM_ENABLED` | `false` | Optional extra (budgeted) routing-advisor call |
| `SCANNER_CRAWL_MAX_PAGES` | `100` | Pages per crawl, capped by `SCANNER_MAX_PAGES` |
| `SCANNER_CRAWL_MAX_DURATION_MS` | `120000` | Crawl time budget, also capped by the scan deadline |
| `DIRECT_DATABASE_URL` | unset | Non-pooled Neon endpoint used by the migration job |

## Before the first deploy of this branch (staging first)

1. Add `DATABASE_URL`, `DIRECT_DATABASE_URL` (secrets) to the new `migrate` PRE_DEPLOY job in App Platform. Confirm the job runs once per deployment and the web component no longer migrates.
2. The migration user needs `CREATEROLE` the first time (to create the two NOLOGIN roles) unless an admin creates them: `CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;`. Unverified on the real Neon project.
3. Check migration 028's output: if it logged `scans_one_active_per_website NOT created`, resolve duplicate active scans and add the index in a new migration.
4. If ClickHouse tables were already created as plain MergeTree, the new ReplacingMergeTree DDL does not change them (`CREATE TABLE IF NOT EXISTS`). Recreate them before relying on de-duplication.
5. Make CI a required status check on `main`, then decide whether to re-enable auto-deploy.

## Rollback

Releases from before this branch do not contain migrations 000 and 027-029, and the runner aborts when an applied migration has no file. A rollback build must therefore keep those four SQL files (they are additive; old code ignores the new tables and the partial index only rejects a second active scan per website). Never edit or delete applied migration files.

## Known limitations (not done in this batch)

- The outbox dispatcher holds row locks during the ClickHouse HTTP call (bounded by the 8 s socket timeout). Claim-then-send with a lease would release them sooner.
- `insert_deduplication_token` only applies on replicated tables or with `non_replicated_deduplication_window`; exact counts before merges need `FINAL`.
- robots.txt is read for the start host only and applied to its www/apex twin.
- The crawl does not poll for cancellation mid-crawl; cancel takes effect after the module.
- The AI discovery agent still runs its own 25-page crawl when AI is enabled.
- CI's PostgreSQL user is a superuser; the non-superuser (Neon-like) path was verified locally only.
- RLS still does not bind the API's own connection (owner role, no `FORCE`); isolation rests on `org_id` filters (audit item P1-3).
