# Observability: Sentry + DigitalOcean App Platform

This covers error monitoring, tracing and log forwarding with Sentry (SDK
`@sentry/node` / `@sentry/react` 10.x), plus the DigitalOcean production
checklist. All Sentry code does nothing until a DSN is set, so you can merge
and deploy this before the Sentry projects exist.

## 1. What is wired up

| Layer | What is reported | Where |
| --- | --- | --- |
| API errors | Unhandled exceptions and 5xx responses only (4xx, validation, auth and rate-limit errors are skipped) | `server/src/observability/fastify.ts` |
| API tags | `request_id` (same as the `x-request-id` response header), `route`, `http.method`, `org_id` (UUID only), `user.id` (opaque id, never email) | same |
| API traces | 10% of requests in production (`SENTRY_TRACES_SAMPLE_RATE`) | `server/src/observability/sentry.ts` |
| API logs | pino `warn`/`error`/`fatal` plus `console.warn`/`console.error` become Sentry Logs (`SENTRY_ENABLE_LOGS`) | same |
| Browser errors | Uncaught errors and React render crashes (app-level `Sentry.ErrorBoundary` in `src/main.tsx`) | `src/observability/sentry.ts` |
| Browser traces | 5% of page loads and navigations (`VITE_SENTRY_TRACES_SAMPLE_RATE`) | same |
| Session Replay | Off. `VITE_SENTRY_REPLAY=on` turns it on with all text and inputs masked and all media blocked | same |

How data is kept private:
- `sendDefaultPii: false`. On the server, `dataCollection` also turns off user info, cookies, request and response bodies, URL query parameters and gen-AI inputs and outputs. Only a short allow-list of request headers is kept.
- Every event, transaction, breadcrumb and log goes through a scrubber before it is sent (`server/src/observability/scrub.ts` and `src/observability/scrub.ts`). The scrubber:
  - drops the Authorization, Cookie, Set-Cookie and X-Api-Key headers;
  - drops request bodies;
  - redacts query and fragment parameters named like `token`, `key`, `secret`, `password`, `code` or `state`;
  - masks OpenRouter (`sk-or-…`), `sk-…`, Bearer, JWT, AWS, GitHub and Slack tokens;
  - masks passwords inside connection strings such as `postgres://user:<pw>@…`.
- pino `redact` also covers `x-api-key` and the `password`, `token`, `apiKey` and `secret` fields in request bodies.

## 2. Create the Sentry projects

1. Sign in at sentry.io. Open your organization, or create one under **Settings → Organizations**.
2. **Projects → Create Project → Node.js** (choose the Fastify guide if you are offered one). Name it `zigma-api` and assign your team.
3. **Projects → Create Project → React**. Name it `zigma-web`.
4. For each project, copy its DSN from **Settings → Projects → <project> → Client Keys (DSN)**. It looks like `https://<key>@o<org-id>.ingest.<region>.sentry.io/<project-id>`.
   - The `zigma-web` DSN ships inside the browser bundle. It is public by design and can only submit events.
   - Keep the `zigma-api` DSN in an encrypted secret anyway.
5. Optional: under **Settings → Projects → zigma-api → Security & Privacy**, turn on **Data Scrubber**, **Use Default Scrubbers** and **Prevent Storing of IP Addresses**. This adds server-side scrubbing on top of ours.

## 3. Set the environment variables in DigitalOcean

Open **Apps → zigma-neural-intelligence → Settings → Components → web → Environment Variables → Edit**. The keys already exist in `app.yaml`; you only fill in the values.

| Variable | Scope | Value | Encrypt |
| --- | --- | --- | --- |
| `SENTRY_DSN` | Run time | `zigma-api` DSN | Yes |
| `SENTRY_ENVIRONMENT` | Run time | `production` (already in spec) | No |
| `SENTRY_TRACES_SAMPLE_RATE` | Run time | `0.1` (already in spec) | No |
| `SENTRY_ENABLE_LOGS` | Run time | `true` (already in spec) | No |
| `SENTRY_RELEASE` | Run time | optional; defaults to `zigma-api@<COMMIT_SHA>` | No |
| `SENTRY_CSP_INGEST_HOST` | Run time | optional, e.g. `o123456.ingest.us.sentry.io` | No |
| `VITE_SENTRY_DSN` | **Build time** | `zigma-web` DSN | No (public) |
| `VITE_SENTRY_ENVIRONMENT` | Build time | `production` (already in spec) | No |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Build time | `0.05` (already in spec) | No |
| `VITE_SENTRY_RELEASE` | Build time | optional; defaults to `zigma-web@<package version>` | No |
| `VITE_SENTRY_REPLAY` | Build time | `on` to enable masked Session Replay (uses replay quota) | No |

`VITE_*` values are compiled into the bundle, so you must **redeploy** after changing them. Never put the server DSN, a Sentry auth token or any other secret in a `VITE_*` variable.

`COMMIT_SHA` is set in the spec to `${_self.COMMIT_HASH}`, a DigitalOcean bindable variable, so server events carry the deployed commit. If DigitalOcean does not substitute it, the value is ignored and events are sent without a release.

`SENTRY_CSP_INGEST_HOST` has no effect today. The CSP's `connect-src` already allows any `https:` origin. It only matters if `connect-src` is later narrowed to an allow-list. If you enable Replay with a strict CSP, also allow `worker-src 'self' blob:`. Without it, Replay falls back to compressing on the main thread.

## 4. Recommended Sentry alert rules

Create these under **Alerts → Create Alert**, for each project unless noted:

1. **New issue**: "A new issue is created" → email or Slack. For `zigma-api`, filter to `environment:production`.
2. **Regression**: "The issue changes state from resolved to unresolved".
3. **Error spike**: a metric alert on the number of errors. Critical when there are more than 20 in 5 minutes; tune this after a week of baseline data.
4. **Latency**: a metric alert on `p95(transaction.duration)` for `zigma-api`. Warning above 1500 ms, critical above 3000 ms, over 10 minutes. Because only 10% of traces are sampled, use a 10-minute window or longer.
5. **AI router health (Logs)**: the router logs structured JSON at `warn` with an `event` field, so these reach Sentry Logs. Save these searches under **Explore → Logs** and alert on them:
   - `ai_security_event`: prompt-injection signals, output-guard violations, blocked paid models and rejected tool calls. Alert on any with `severity:HIGH`.
   - `ai_catalog_refresh_failed`: the free-model catalog could not be refreshed. Routing then fails closed on stale pricing. Alert if it repeats for more than 2 hours.
   - `ai_quota_sync_failed`, `ai_model_health_write_failed`, `ai_token_settle_failed`, `router.*_failed`: bookkeeping failures. Alert on more than 10 in 10 minutes.
6. **Uptime**: optional. A Sentry Uptime monitor on `https://<domain>/ready` sends a 1-minute heartbeat.

## 5. Protecting the quota (5000 credits)

Sentry bills errors, spans (tracing), logs and replays separately. Each one has its own quota and on-demand budget. To keep spending predictable:

- **Spike protection**: turn it on under **Settings → Subscription → Spike Protection** for both projects. It is on by default for new organizations; check that it is on.
- **Rate limits per DSN**: under **Settings → Projects → <project> → Client Keys → Configure → Rate Limit**, start at about 300 events per hour for `zigma-web` and 600 per hour for `zigma-api`.
- **On-demand budget**: set it to $0, or to a small cap, so going over quota drops data instead of billing you.
- **Sample rates**: with `SENTRY_TRACES_SAMPLE_RATE=0.1`, 100k requests a day become about 10k transactions a day plus their child spans. Lower it to `0.02` if span usage grows. The browser default is `0.05`. Errors are never sampled; they are all sent, minus 4xx.
- **Logs**: only `warn` and higher are forwarded. Set `SENTRY_ENABLE_LOGS=false` to stop log ingestion with no code change.
- **Inbound filters**: under **Settings → Projects → zigma-web → Inbound Filters**, turn on "browser extensions", "legacy browsers" and "web crawlers".
- **Replay**: keep it off unless you are debugging a UX problem. When it is on, 1% of sessions and 100% of sessions with an error are recorded.

## 6. Release tracking and source maps (optional next step)

Not wired up yet, on purpose. To get readable browser stack traces:

1. Create an **Organization Auth Token** (Settings → Auth Tokens) with `project:releases` and `org:read` scopes.
2. Store it in DigitalOcean as a **BUILD_TIME SECRET** named `SENTRY_AUTH_TOKEN`. It must never have a `VITE_` prefix.
3. Either add `@sentry/vite-plugin` with `sourcemap: 'hidden'` (and delete the `.map` files after upload), or run `sentry-cli sourcemaps inject` and then `sentry-cli sourcemaps upload` after `vite build`. Set `VITE_SENTRY_RELEASE` and `SENTRY_RELEASE` to the same commit-based value.

The server already reports `zigma-api@<sha>`. Node stack traces are readable without uploads because `tsc` emits source maps next to `dist/`.

## 7. Verify after deploy

1. Check the logs (**Runtime Logs**) for startup errors. When `SENTRY_DSN` is invalid, the server prints `[sentry] SENTRY_DSN is set but is not a valid Sentry DSN` and runs without Sentry.
2. Server test error:
   - Signed in as a platform admin (`PLATFORM_ADMIN_USER_IDS`), call `GET /api/v1/admin/diagnostics/sentry-test` with your Bearer token.
   - Expect HTTP 500. Within about a minute, a `SentryTestError` issue appears in `zigma-api` tagged `sentry_test:true`, `route:/api/v1/admin/diagnostics/sentry-test` and `request_id` (match it against the `x-request-id` response header).
   - The endpoint is rate-limited to 2 per minute and audit-logged (`admin_sentry_test_triggered`). It returns `409 SENTRY_DISABLED` when no DSN is configured.
3. Browser test: in the browser devtools console on the live site, run `setTimeout(() => { throw new Error("zigma-web sentry test") })`. The error should appear in `zigma-web`. Alternatively, use **Settings → Projects → zigma-web → Client Keys → "Send test event"** if your plan offers it.
4. Open one event and confirm there is no `Authorization` or `Cookie` header, no request body, no email and no token query values.
5. Logs: trigger a 404 or a failed login (logged at `warn`) and check **Explore → Logs** for the entry.

### Graceful shutdown

The SIGTERM/SIGINT handler in `server/src/index.ts` calls `flushSentry(2000)` after the app and database pool close, so buffered events are sent when App Platform redeploys or scales down.

## 8. DigitalOcean production checklist

### Environment variables (web component)

| Name | Type | Notes |
| --- | --- | --- |
| `DATABASE_URL` | secret | Neon **pooled** URL (`…-pooler.<region>.aws.neon.tech`, `sslmode=require`) |
| `DIRECT_DATABASE_URL` | secret | Neon **direct** URL (host without `-pooler`). The PRE_DEPLOY `migrate` job uses it for DDL |
| `JWT_SECRET`, `COOKIE_SECRET` | secret | ≥ 32 random characters each |
| `DB_SSL_REJECT_UNAUTHORIZED` | general | `true` |
| `TRUST_PROXY` | general | `1` |
| `CORS_ORIGIN`, `APP_PUBLIC_URL` | general | `${APP_URL}` |
| `PLATFORM_ADMIN_USER_IDS` | general | comma-separated user UUIDs |
| `OPENROUTER_API_KEY` | secret | optional AI |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `INTEGRATION_ENCRYPTION_KEYS` | secret / general | all or none |
| `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_CA_CERT` | secret (port general) | optional analytics |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_ENABLE_LOGS`, `SENTRY_RELEASE`, `SENTRY_CSP_INGEST_HOST`, `COMMIT_SHA` | see §3 | |
| `VITE_APP_MODE`, `VITE_API_BASE_URL`, `VITE_SENTRY_*` | build time | |

### Neon: pooled vs direct

- The **web** service uses the pooled endpoint (PgBouncer in transaction mode). Session settings such as `statement_timeout` are not applied through it, and the app logs `db_timeouts_not_applied`. To set them on the role, run `ALTER ROLE <app_role> SET statement_timeout = '30s'`.
- The **migrate** job uses `DIRECT_DATABASE_URL` because advisory locks and DDL need a real session. Both URLs should point at the same branch.

### ClickHouse Cloud

`CLICKHOUSE_HOST` is the **bare hostname**, with no `https://` and no port, e.g. `abc123xyz.us-east-1.aws.clickhouse.cloud`. The connection always uses HTTPS on `CLICKHOUSE_PORT` (default `8443`) with normal CA verification. `CLICKHOUSE_CA_CERT` only adds a trusted CA. Analytics count as "configured" only when `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD` **and** `CLICKHOUSE_DATABASE` are all set; otherwise events stay in the PostgreSQL outbox. `CLICKHOUSE_USER` defaults to `default`.

### Domain and HTTPS

Add the domain under **Settings → Domains** and use DigitalOcean-managed DNS or a CNAME. App Platform issues and renews the TLS certificate. HSTS is sent in production. The `DOMAIN_FAILED` alert fires when verification or certificate issuance fails. After a domain change, `${APP_URL}`-based values (CORS, OAuth redirect) update on the next deploy.

### Alerts in the spec

- App level: `DEPLOYMENT_FAILED`, `DOMAIN_FAILED`.
- Web component: CPU above 80% for 10 minutes, memory above 80% for 10 minutes, more than 3 restarts in 30 minutes.

Alert emails go to team members. Add Slack destinations in the dashboard.

### Scaling and instance size

The spec still uses `basic-xxs`: a legacy slug with 512 MiB and 1 shared vCPU, at about $5/month. Node, Sentry's OpenTelemetry instrumentation, the AI router and the static frontend in one process can use more than 512 MiB under load. Recommendation:

- **`apps-s-1vcpu-1gb`**: 1 GiB, 1 shared vCPU, about $12/month. Change it once memory alerts fire or before launch.
  - `apps-s-1vcpu-1gb-fixed` (about $10/month) has the same RAM but cannot autoscale.
  - `apps-s-1vcpu-2gb` costs about $25/month.
- Prices are from DigitalOcean's App Platform pricing page at the time of writing. Check them before changing.
- Running two instances (`instance_count: 2`) gives zero-downtime deploys and redundancy, at double the cost. Rate limits are per instance (in memory), so the effective limit doubles.

### Backups

- **Neon**: point-in-time restore is covered by the plan's history retention window. Check that the window is enough (7 days or more for production). Before risky migrations, create a branch with `neonctl branches create`.
- **ClickHouse Cloud**: automatic daily backups. Check the retention in the service settings.
- **App spec**: download it from **Settings → App Spec** after dashboard edits and commit it, so `app.yaml` stays in sync. Secrets are never exported in plain text.

### Log forwarding

App Platform keeps runtime logs only for a short time. To keep them longer, add a `log_destinations` entry at app level in `app.yaml` (Papertrail `endpoint`, Datadog `endpoint`+`api_key`, Logtail `token`, or OpenSearch `endpoint`/`cluster_name`). Put tokens in the dashboard, not in git. A commented example is at the top of `app.yaml`. The logs are pino JSON with secrets redacted, so they can be searched by `reqId`.
