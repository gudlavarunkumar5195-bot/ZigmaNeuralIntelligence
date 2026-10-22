# Repository inventory

Snapshot taken on branch `feat/admin-control-center`, created from `main` at `4386850` (PR #6 merged). The working tree was clean at the start: no staged, unstaged or untracked files. This describes the repository as it is, not a target architecture.

## Shape

| Part | Location | Notes |
| --- | --- | --- |
| Frontend | `src/` | Vite + React 19. Uses `createBrowserRouter` (`src/router.tsx`), with every page lazy-loaded. Tailwind v4. No mock or demo data reaches production paths: in `VITE_APP_MODE=demo`, `src/services/api.ts` throws `IntegrationRequired` |
| API server | `server/` | Fastify 5, `pg`, zod. Has its own `package.json` and lockfile. One process serves `/api/v1/*` and the built SPA (`app.yaml`, `Procfile`) |
| Database | `server/src/db/migrations/000–034` | Ordered SQL files, checksummed and immutable once applied. CI enforces this and `server/scripts/verify-migrations.mjs` checks fresh and upgrade paths |
| Background work | `server/src/services/scan.service.ts` worker loop, started in `server/src/index.ts` | One loop in the web process. Each tick runs monitoring, notifications, the Search Console sync, keyword-research pruning and the scan queue. A separate timer drives the analytics outbox (`server/src/analytics/events.ts`) |
| CI | `.github/workflows/ci.yml` | Typecheck, frontend tests, server build, migration safety, fresh migrate, server unit and integration tests on PostgreSQL, production build, audit, whitespace check, Playwright smoke |
| Owner tooling | `.zigma-agent/` | Not part of the app. See the cleanup audit |

## Authentication and authorization (as implemented)

- **Login and registration.** `server/src/routes/auth.ts` and `server/src/services/auth.service.ts`.
  - Passwords are hashed with bcryptjs, cost 12.
  - Unknown emails cost the same time as wrong passwords.
  - Self-registration creates a user, a new organization and an owner membership.
- **Tokens.**
  - The access token is an HS256 JWT (`@fastify/jwt`) that lives 15 minutes. It carries `sub`, `email` and `orgIds`.
  - The refresh token is 48 random bytes. Only its SHA-256 is stored (`refresh_tokens`). It lives 7 days and rotates on every use; reusing a revoked token revokes all of that user's tokens.
  - It travels in the `zn_refresh` cookie, which is httpOnly, SameSite=Strict, scoped to `/api/v1/auth`, and Secure in production.
- **Tenancy.** `requireOrgMember` reads `x-org-id` and checks membership, role and `users.active` in the database on every request. `requireRole(...)` gates by role.
- **Platform administration.** `PLATFORM_ADMIN_USER_IDS` is a list of user UUIDs. An empty list means nobody is an admin (fails closed). `requirePlatformAdmin` is enforced on the global model, agent, routing and infrastructure routes, and on all `/api/v1/admin/*` routes.
- **CSRF.** Every state-changing API route authenticates with a bearer header, not a cookie. The only cookie-authenticated routes are `/auth/refresh` and `/auth/logout`, protected by SameSite=Strict and the narrow cookie path. CORS is an explicit allowlist (`CORS_ORIGIN`).
- **Rate limits.**
  - Global: 200 requests per minute per IP. `request.ip` honours `TRUST_PROXY`.
  - Register and login have per-(IP, email) and per-IP limits.
  - Sensitive routes have their own limits.
- **Audit log.** `audit_log` is append-only: UPDATE and DELETE are revoked from client roles. It is written by `services/audit.service.ts` and never throws.
- **Before this phase:**
  - no password reset or change flow;
  - no email delivery;
  - no user-management API or UI (`SettingsTeam` was a placeholder);
  - `revokeAllUserTokens` existed but was never called.

## External connections (as implemented)

| Connection | How | Credentials |
| --- | --- | --- |
| PostgreSQL (Neon or any) | `pg` pool (`server/src/db/client.ts`). TLS verification is required in production | `DATABASE_URL`, `DIRECT_DATABASE_URL` (migrations), `DB_SSL_*` |
| ClickHouse | Hand-written HTTPS client (`services/infrastructure.ts` `chRequest`) used by the analytics outbox dispatcher. Analytics pages read PostgreSQL | `CLICKHOUSE_*` (optional) |
| Supabase | No client code. Only role-compatibility and RLS SQL (`000`, `011`, `022`, `025`, `026`). `server/src/db/supabase_setup.sql` is deprecated and raises an error when run | none |
| Google OAuth + Search Console | `server/src/integrations/google/*`. All network access goes through `http.ts`. Per-organization refresh tokens are encrypted in the `integrations` table | Deployment: `GOOGLE_OAUTH_*`, `INTEGRATION_ENCRYPTION_KEYS` |
| OpenRouter (AI) | `server/src/ai/providers/openrouter.ts`, executor `ai/ox-alpha.ts`, catalog `ai/catalog.service.ts` | Before this phase: `OPENROUTER_API_KEY` only. Now an encrypted admin-managed key, with the environment variable as fallback |
| Email | None | none |
| Licensed SEO data (volume, SERP, backlinks) | None. Explicitly unsupported (`docs/KEYWORD_RESEARCH.md`) | none |

Secrets load in `server/src/config.ts`: dotenv, then a zod schema, with production checks in `config-security.ts`. Frontend `VITE_*` variables are limited to the mode, the API URL and retries, and hold no secrets. Session tokens are kept in `sessionStorage` (`zn_token`).

## Feature status

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Website add/verify, scans, scan progress (SSE) | Implemented | `routes/websites.ts`, `routes/scans.ts` |
| Technical SEO crawl and issue lifecycle (Phase 2) | Implemented | No JavaScript rendering; no hreflang or orphan-page checks |
| Monitoring, changes, alerts | Implemented | Notification delivery has no provider: deliveries are marked FAILED with an explicit reason |
| AI intelligence (scan agents, insights) | Implemented; needs an OpenRouter key | Free models only unless `AI_ALLOW_PAID_MODELS` |
| Google Search Console (Phase 3) | Implemented; waiting for an OAuth client | No production OAuth client is configured |
| Keyword research and competitor gap (Phase 4) | Partial by design | First-party Search Console data only. Volume, difficulty, CPC, SERP and competitor discovery are unsupported |
| Rankings, backlinks | Missing (placeholder pages that say so) | Needs licensed providers |
| Testing (browser, regression, results) | Missing (placeholders) | |
| Client reports, certificates, domains, agent Control Center, model benchmarks | Missing (placeholders) | |
| Core Web Vitals | Missing | No lab or field data source |
| Admin Control Center | Implemented in this phase | `docs/ADMIN_CONTROL_CENTER.md` |

## Baseline (before any change in this phase)

Run on a fresh local PostgreSQL 17 cluster (port 55433) with frozen installs:

| Check | Result |
| --- | --- |
| Frontend typecheck (`tsc --noEmit`) | pass |
| Frontend tests | 16 files, 139/139 |
| Server build | pass |
| `verify-migrations.mjs` (baseline `1ca145b`) | pass |
| Fresh migrate | pass |
| Server tests, with `RUN_INTEGRATION=1` | 72 files, 914/914 |
| Production build | pass |
| `pnpm audit --prod` (root and server) | no known vulnerabilities |
| `oxfmt --check` | **fails: 279 files unformatted (pre-existing)**. The repository has never been formatted with oxfmt; this phase does not mass-format it |
| ESLint | **not configured** in the repository. Unused imports and locals were checked with the compiler and import graph instead |
