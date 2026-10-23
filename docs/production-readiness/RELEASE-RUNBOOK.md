# Release runbook: Phase 10 additions

This extends `docs/RELEASE_RUNBOOK.md`, which already covers the CI gate, deploy-after-CI, running migrations once per release over the direct connection, staging verification and credentials. Do those steps as written there; the steps below come in addition.

## 1. Before the first release that includes migration 040

1. **Back up.** Take a point-in-time backup or a Neon branch of production and record its id. Migration 040 is additive (indexes plus an audit-log trigger), but every schema change needs a recovery point.
2. **Check migration 028.** It may have been silently skipped. On production, run:
   ```sql
   SELECT indexname FROM pg_indexes WHERE indexname = 'scans_one_active_per_website';
   ```
   If no row comes back, duplicate active scans existed when 028 ran. Resolve them (keep the newest active scan per website and mark the rest `failed`), then create the index. Plan this change; it is a data fix, not part of this release.
3. **Build the large indexes without blocking writes.** The migration runner wraps each file in a transaction, so 040 cannot use `CONCURRENTLY`. On a large production database, create these first by hand over the direct connection. 040 then skips them (`IF NOT EXISTS`).
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_executions_org_created ON agent_executions (org_id, created_at DESC);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_findings_org_created ON findings (org_id, created_at);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_action_time ON audit_log (action, timestamp DESC);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scans_website_created ON scans (website_id, created_at DESC);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scans_org_created ON scans (org_id, created_at);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_monitoring_snapshots_website_time ON monitoring_snapshots (website_id, captured_at DESC);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsc_search_daily_day_brin ON gsc_search_daily USING brin (day);
   ```
   A failed `CONCURRENTLY` build leaves an `INVALID` index. Drop that index and retry before deploying.
4. **Database timeouts behind a pooler.** If `DATABASE_URL` uses a transaction pooler (a Neon host containing `-pooler.`, or `?pgbouncer=true`), the app does not send its timeouts and logs `db_timeouts_not_applied` at start. Set them on the application role instead:
   ```sql
   ALTER ROLE <app_role> SET statement_timeout = '30s';
   ALTER ROLE <app_role> SET idle_in_transaction_session_timeout = '60s';
   ```
   Then verify from the app's connection that `SHOW statement_timeout;` returns `30s`.
5. **Audit-log maintenance.** `audit_log` is now append-only. A future retention job must run inside a transaction with `SET LOCAL zigma.audit_maintenance = 'on'` and be reviewed like a migration. Ship the audit log off-site (log drain) as well: a database owner can drop the trigger.

## 2. Post-deploy verification (production)

- `GET /health` returns 200, and `GET /ready` returns 200 with `{"checks":{"database":"ok"}}`. The App Platform health check uses `/ready`.
- In the logs: no `db_timeouts_not_applied`, unless step 1.4 was done on the role instead.
- Sign in, load the dashboard, sign out. Open two tabs and refresh both after 15 minutes: neither tab should be signed out (refresh rotation grace).
- `request.ip` differs per client (the `TRUST_PROXY` note in `app.yaml`).

## 3. Rollback

- **Application:** redeploy the previous build. It must still contain every migration file the database has applied, because the runner aborts on a missing file. Roll back code, never migration files.
- **Migration 040:** additive, so the previous code runs unchanged with it applied. If the audit trigger itself must be removed, drop `audit_log_append_only` and `audit_log_no_truncate` in a reviewed change.
- **Data:** restore from the backup taken in step 1.1.

## 4. Environment configuration inventory

Names only, never values. Source of truth: `server/src/config.ts` (validated at start; production refuses unsafe values in `server/src/config-security.ts`) and `src/config/env.ts`.

| Variable | Required | Purpose | Consumer |
| --- | --- | --- | --- |
| `NODE_ENV` | yes (prod) | `production` turns on TLS checks, HSTS, Secure cookies and strict config | API |
| `PORT`, `HOST` | no (3001 / 0.0.0.0) | Listen address | API |
| `DATABASE_URL` | **yes** | PostgreSQL (pooled is fine for the app) | API, workers |
| `DIRECT_DATABASE_URL` | recommended | Direct (non-pooled) connection for migrations | Migrator (`migrate:prod`) |
| `DB_SSL_REJECT_UNAUTHORIZED`, `DB_SSL_CA` | prod: must be `true`; CA optional | Database TLS verification | API, migrator |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | no (10 / 30000 / 60000) | Pool size and server-side timeouts (new in Phase 10) | API |
| `NEON_BRANCH` | no | Informational | Diagnostics |
| `JWT_SECRET`, `COOKIE_SECRET` | **yes** (≥32 characters, distinct, high entropy) | Access-token signing; cookie plugin | API |
| `CORS_ORIGIN` | **yes** (prod) | Allowed browser origins; no `*`, no localhost in production | API |
| `TRUST_PROXY` | prod: `1` on App Platform | Proxy hops trusted for the client IP (rate limits) | API |
| `APP_PUBLIC_URL` | for password reset and OAuth | Public base URL (also forces Secure cookies when https) | API |
| `PLATFORM_ADMIN_USER_IDS` | no | Platform administrators (user UUIDs) | API |
| `QA_VERIFICATION_BYPASS_ENABLED`, `QA_AUTHORIZED_EMAILS`, `QA_ALLOW_PRODUCTION_BYPASS` | no; production refuses the bypass | QA ownership-verification bypass | API |
| `ADMIN_CREDENTIAL_ACCOUNT_EMAIL` | no | Account used for generated admin credentials | API |
| `OPENROUTER_API_KEY` | optional (AI features) | AI provider key (or stored encrypted by an admin) | API, workers |
| `OX_ALPHA_MODEL`, `OX_ALPHA_TIMEOUT_MS`, `OX_ALPHA_MAX_RETRIES`, `OX_ALPHA_MAX_OUTPUT_TOKENS` | no | AI defaults and limits | API, workers |
| `AI_MAX_EXECUTIONS_PER_ORG_PER_DAY`, `AI_ALLOW_PAID_MODELS`, `AI_ROUTER_LLM_ENABLED` | no (500 / false / false) | Cost controls; paid models need explicit approval | API, workers |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `INTEGRATION_ENCRYPTION_KEYS`, `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | optional; all or none for Search Console | Google OAuth and the encryption key ring for stored tokens and credentials | API, workers |
| `GSC_*` (6 variables) | no | Search Console sync cadence, lookback, quota, retention, timeout | Workers |
| `SCANNER_*` (12 variables), `MAX_CONCURRENT_SCANS_PER_TENANT`, `MAX_QUEUED_SCANS_PER_TENANT`, `MAX_SCAN_CREATIONS_PER_MINUTE`, `SCAN_MAX_EXECUTION_ATTEMPTS` | no | Crawler budgets, timeouts and per-tenant scan limits | API, workers |
| `SSE_*` (4 variables), `WORKER_POLL_INTERVAL_MS`, `SHUTDOWN_GRACE_MS` | no | Event-stream limits, worker cadence, graceful shutdown | API |
| `CONTENT_*` (3), `AIV_*` (15), `RANK_*` (6), `BACKLINK_*` (5), `KEYWORD_RESEARCH_*` (5) | no | Module limits, quotas and provider timeouts | API, workers |
| `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_CA_CERT` | optional | Analytics sink; the outbox stays in PostgreSQL when unset | Event pipeline |
| `VITE_API_BASE_URL`, `VITE_APP_MODE`, `VITE_MAX_RETRIES` | build time | Frontend API base and mode; no secrets | Vite build |

## 5. Deployment facts (checked in `app.yaml` and `Procfile`)

- **Build:** `pnpm install --frozen-lockfile && pnpm --dir server install --frozen-lockfile && pnpm build`.
- **Run:** `pnpm --dir server start` (a single process: API, scan worker and schedulers).
- **Migrations:** a PRE_DEPLOY job runs `pnpm --dir server migrate:prod`.
- **Auto-deploy:** `deploy_on_push: false`. Deploy manually after CI is green.
- **Instances:** 1 × `basic-xxs`. Workers run inside the web process and claim jobs with `FOR UPDATE SKIP LOCKED` and leases, so a second instance is safe, but every instance runs the full worker loop (open finding DB-06).
- **Monitoring:** none configured. There is no metrics or alerting pipeline: logs are JSON on stdout, with a request id per request. Configure a log drain and alerts on 5xx rate, `/ready` failures, `job dead`/`DEAD` outbox rows and `shutdown_forced_exit`.
- **Email delivery:** not configured. Password-reset links cannot be sent until a provider is added (`server/src/platform/mailer.ts`).
