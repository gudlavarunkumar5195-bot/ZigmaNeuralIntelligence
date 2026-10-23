# Frontend–backend integration matrix (Phase 9.6)

How each screen reaches the API, where the data lives, and how far the chain was verified. All requests go through the one client in `src/services/api.ts` (`authorizedFetch` → `apiFetch` / `downloadResponse`), with the bearer token, the `x-org-id` header, a 30-second timeout (120 s for downloads) and one shared token refresh on 401.

## Status definitions

| Status | Meaning |
| --- | --- |
| **Verified E2E** | Real UI → real API → real PostgreSQL, checked by `e2e/integration/*` (`pnpm test:e2e:integration`) |
| **Connected (unit)** | The integration exists; the page is tested with the API mocked at the client boundary, and the backend route has its own integration tests against PostgreSQL. It has not been run end to end. |
| **Partially connected** | Some operations work; others are missing (listed) |
| **Blocked** | Needs a provider, credential or configuration that is not available |
| **Intentionally unavailable** | Not supported by the product; labelled N/A or "Not available yet" |
| **UI-only** | A control without a working backend operation (none found) |

## Matrix

| Frontend page / workflow | UI action | API endpoint(s) | Backend service / data | Persistence | Status |
| --- | --- | --- | --- | --- | --- |
| Login, register (`/login`) | Sign in, create account | `POST /auth/login`, `/auth/register` | `auth.service` (bcrypt), refresh token in the `zn_refresh` httpOnly cookie | users, memberships, refresh_tokens | **Verified E2E** (sign in, wrong password) |
| Session (all pages) | Reload, expired token, sign out | `POST /auth/refresh`, `/auth/logout`, `GET /auth/me` | Single-use refresh rotation; `/me` returns memberships | refresh_tokens | **Verified E2E** (reload, renewal, failed renewal → sign-in and return, logout clears the tab) |
| Password reset (`/reset-password`) | Request link, set password | `POST /auth/password-reset/request`, `/confirm` | `auth.service`, mailer | password_reset_tokens | **Blocked** for delivery (email not configured); token flow covered by server tests |
| Dashboard (`/`) | Load KPIs, start scan, open scan | `GET /dashboard?websiteId=`, `POST /scans` | `routes/dashboard.ts`, scan queue | scans, scan_scores, monitoring_snapshots | **Verified E2E** (load); starting a scan: **Connected (unit)**, since a real scan fetches external sites |
| Websites (`/websites`, `/websites/add`) | List, add, verify ownership, start scan | `GET/POST /websites`, `POST /websites/:id/verify`, `POST /scans` | `website.service` (SSRF-guarded fetch for verification) | websites | List: **Verified E2E**. Add-form validation: **Verified E2E**. Verify and scan: **Connected (unit)** (external fetch) |
| Scan progress (`/websites/scan/:id`) | Poll, cancel | `GET /scans/:id`, `POST /scans/:id/cancel` | `scan.service` | scans, module status | Tenant isolation: **Verified E2E**. Polling backoff and cancel: **Connected (unit)** |
| Scan history, Reports (`/websites/history`, `/reports`) | View latest scan, print | `GET /dashboard`, `GET /reports/:scanId` | dashboard, report | scans, findings | **Connected (unit)**; the routes render against the real API in the route smoke test |
| Findings pages (`/intelligence/seo` and others, `/infrastructure/ssl`) | View findings | `GET /dashboard`, `GET /scans/:id/findings` | scan findings | findings | **Connected (unit)** |
| Technical health (`/intelligence/technical-health`) | Run crawl, poll, filter, ignore/reopen issue | `/websites/:id/crawl*`, `/websites/:id/issues*`, `POST /scans` (crawl) | `site-audit.service` | site_issues, crawl_pages, crawl_summaries | Issue list, ignore with a reason, reopen: **Verified E2E**. Starting a crawl and polling: **Connected (unit)** (a crawl fetches external sites) |
| SEO workspace (`/intelligence/workspace/*`) | Range, insights, actions, report and CSV downloads, AI summary | `/websites/:id/seo-workspace/*` | `seo-workspace.service` | seo_insights, seo_action_states (+ events) | **Connected (unit)**. AI summary: **Blocked** (needs an OpenRouter key; paid models off) |
| Search performance (`/search/performance`) | Connect Google, link property, sync, view | `/integrations*`, `/websites/:id/search-console*` | Search Console integration (fake Google in tests) | gsc_properties, gsc_search_daily, gsc_sync_jobs | **Blocked** without Google OAuth credentials; **Connected (unit)** |
| Keywords and keyword gap (`/search/keywords`, `/search/competitors`) | Run research, save to list, export CSV; open, edit and delete saved lists | `/keyword-research/*` (lists: `GET /lists/:id`, `DELETE /lists/:id/items?keyword=`, `DELETE /lists/:id`) | Provider-neutral research (Search Console provider only) | research_runs, research_results, keyword_lists | Saved lists (open, remove a keyword, delete with confirmation): **Verified E2E**. Running research: **Blocked** without Search Console data; **Connected (unit)** |
| Rank tracking (`/search/rankings/*`) | Projects (create, pause/resume, archive), keywords, import, history, competitors, alerts, export | `/rank-tracking/projects/*` (`PATCH /projects/:id` for status) | `rank-tracking.service` | rank_* | Create project, add keywords, pause (persists): **Verified E2E**. Other tabs: **Connected (unit)**. Scheduled collection: **Blocked** (no SERP provider configured); imports work |
| Backlinks (`/search/backlinks/*`) | Import CSV, live checks, gap, export | `/websites/:id/backlinks/*` | `backlinks.service` (SSRF-guarded live checks) | backlink_datasets, backlink_links, backlink_link_checks | Export: **Verified E2E** (CSV with formula cells neutralized). Other tabs: **Connected (unit)** |
| Content (`/intelligence/content/*`) | Run analysis, findings lifecycle, create and edit topics, opportunities, briefs | `/websites/:id/content/*` (`POST /content/topics`) | `content.service` | content_* | Create topic (persists): **Verified E2E**. Other tabs: **Connected (unit)**. AI brief suggestions: **Blocked** (OpenRouter) |
| AI visibility (`/intelligence/ai-visibility/*`) | Brands, re-run matching, queries, runs, imports, observations, export | `/ai-visibility/brands/*` (`POST /brands/:id/reprocess`) | `ai-visibility.service` | aiv_* | Create brand (domain validation enforced), re-run matching: **Verified E2E**. Imports and analysis: **Connected (unit)**. Provider runs: **Blocked** (OpenRouter key; web search off) |
| Monitoring (`/monitoring`, `/monitoring/changes`) | Create, pause/resume/re-enable, disable, run, frequency, alert rules | `/monitoring*` (`GET/POST /monitoring/:id/rules`, `PATCH /monitoring/rules/:id`) | `monitoring.service` | monitoring_configs, runs, changes, alert_rules | Alert rules (an admin adds a rule and it persists; a member is refused visibly): **Verified E2E**. Other actions: **Connected (unit)**. "Run now" starts a real scan |
| Alerts (`/monitoring/alerts`, bell) | Acknowledge, resolve, dismiss | `GET /monitoring/alerts`, `POST /monitoring/alerts/:id/{acknowledge,resolve,dismiss}` | `monitoring.service.updateAlert` | alerts | **Verified E2E** (member resolves once, persists after reload; viewer refused and unchanged) |
| Settings, integrations (`/settings/integrations`) | Connect Google, link, unlink (confirmed), disconnect | `/integrations*`, `/websites/:id/search-console` (`DELETE` unlinks and deletes the stored data) | Integration store (encrypted tokens) | integrations, gsc_properties (cascades to Search Console data) | Unlinking a property: **Verified E2E** (seeded integration; no Google call). Connecting: **Blocked** without Google OAuth credentials |
| Settings, workspace and API (`/settings/workspace`, `/settings/api`) | View account and connection | `GET /auth/me` | — | — | **Partially connected** (read-only); editing is not implemented |
| Settings, team and security | — | — | — | — | **Intentionally unavailable** ("Not available yet") |
| Analytics (`/analytics/*`) | View usage | `/analytics/*` | Analytics read model; ClickHouse optional | analytics_outbox, ClickHouse | **Connected (unit)**. Panels without data are shown as "Not available yet" |
| AI agents (`/agents/*`) | Registry, simulate, router, models (enable/disable for platform admins), instructions, evidence, quality | `/agents*`, `/routing*`, `/models*` (`POST /models/:id/enable` and `/disable`), `/ai/*` | AI registry and router | models, agent tables | Model disable (with a reason) and enable by a platform admin: **Verified E2E**. Other pages: **Connected (unit)** |
| Administration (`/admin/*`) | Diagnostics, full audit log, credentials, users, infrastructure | `/admin/*` (`GET /admin/audit`), `/infrastructure/*` | Platform admin services | audit_log and others | Full audit log: **Verified E2E**. Other pages: **Connected (unit)**; the backend enforces platform admin |
| Accessibility, certificates, domains, client reports, AI control center, model benchmarks, testing (3) | — | — | — | — | **Intentionally unavailable** (N/A in navigation) |

## Backend operations that had no screen (added in this phase)

- **Monitoring alert rules:** on the monitoring page, per monitor, for owners and admins.
- **Unlink a Search Console property:** Settings, Integrations, with a confirmation that names the data deletion.
- **Pause, resume or archive a rank-tracking project:** archive is confirmed and says it cannot be reopened from the app.
- **Enable or disable a model:** platform admins only, with a reason that is written to the audit log.
- **Full administrative audit log:** in the Control Center.
- **Saved keyword lists:** view, remove a keyword, delete with confirmation.
- **Re-run AI-visibility matching.**
- **Create a content topic.**

## Requests and cancellation

`useApiQuery` aborts the network request when a page's inputs change or the page closes, using `withSignal` in `src/services/api.ts`. Responses from superseded requests are also ignored.

## Access token storage (decision)

The 15-minute access token stays in `sessionStorage`, as in the existing design. The long-lived secret is the refresh token, which is an httpOnly, SameSite=Strict cookie limited to `/api/v1/auth`. It is single-use, and reusing a spent one revokes all of the user's sessions.

Keeping the access token only in memory would mean renewing it on every page load. Two tabs reloading at the same moment would then present the same refresh token, trip that reuse detection and sign the user out everywhere. Changing this needs a server-side grace window for concurrent refreshes first.

## Verified chains (E2E)

For each E2E-verified workflow, the test drives the real UI and checks the result through the UI after a reload, against the real API and a migrated, seeded PostgreSQL database:

> user action → frontend validation → API request (token, `x-org-id`) → authentication and role check → validation → service → PostgreSQL → response → UI update

The suite runs as the CI job `e2e-integration`.
