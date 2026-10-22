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
- ~~The crawl does not poll for cancellation mid-crawl~~ (resolved in Phase 2: polled every 2 s).
- The AI discovery agent still runs its own 25-page crawl when AI is enabled.
- CI's PostgreSQL user is a superuser; the non-superuser (Neon-like) path was verified locally only.
- RLS still does not bind the API's own connection (owner role, no `FORCE`); isolation rests on `org_id` filters (audit item P1-3).

---

# Phase 2: complete technical SEO audit

Branch `feat/p2-technical-seo-audit`, stacked on `feat/p0-phase1-verification` (PR #3). Not deployed; no production migration run.

## Crawler rules (documented behaviour)

| Rule | Behaviour |
| --- | --- |
| Scope | Start URL's host or its www/apex twin, **same port**, http(s). A site on default ports may switch http/https. Off-scope redirects are recorded (`redirect_out_of_scope`, target kept) and never requested |
| SSRF | Every request and redirect hop goes through `safeFetch` (DNS pinning, private/metadata ranges refused) |
| robots.txt | RFC 9309 for token `zigmaneural-scanner` (UA `ZigmaNeural-Scanner/1.0`); 4xx = allow all, 5xx/unreachable = disallow all; disallowed URLs are recorded as `blocked_by_robots`, never fetched; `Crawl-delay` honoured (max 5 s, concurrency 1) |
| Sitemaps | robots.txt `Sitemap:` lines, else `/sitemap.xml`; indexes followed; max 10 files, 5 000 URLs; gzip reported as unsupported; a declared sitemap that fails is "unavailable", a missing default one is "missing" |
| Normalization | No fragments, lowercase host, default ports dropped, tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, ...) removed |
| Budgets | Pages (`SCANNER_CRAWL_MAX_PAGES` 100), depth (`SCANNER_CRAWL_MAX_DEPTH` 5), 10 query-string variants per path, discovered URLs (20x pages), concurrency (`SCANNER_CRAWL_CONCURRENCY` 2), per-request body timeout (`SCANNER_CRAWL_REQUEST_TIMEOUT_MS` 15 s), page size (`SCANNER_CRAWL_MAX_PAGE_BYTES` 2 MiB), total time (`SCANNER_CRAWL_MAX_DURATION_MS`, capped by the scan deadline). Per-scan `crawl.maxPages` / `crawl.maxDepth` can only lower them |
| Outcomes | `ok`, `redirect`, `redirect_out_of_scope`, `redirect_loop`, `http_error`, `fetch_error`, `too_large`, `non_html` (body not downloaded), `blocked_by_robots`. Content rules run only on `ok` 200 pages |
| Indexability | "Eligible by measured signals" (200, no noindex meta/header, self or no canonical). Never a claim that a page is indexed |
| Cancellation | Polled every 2 s (DB) plus lost lease; a cancelled crawl is discarded and changes no issue |

## Rules (`SEO_RULES`, all MEASURED by `site_crawler`)

crawlability: `robots_txt_unreachable`, `robots_txt_missing`, `start_url_blocked_by_robots` · status codes: `page_4xx`, `page_5xx`, `page_fetch_error`, `page_too_large` · links: `broken_internal_link`, `internal_link_to_redirect` · redirects: `redirect_chain`, `redirect_loop`, `redirect_off_site` · content: `title_missing`, `title_duplicate`, `meta_description_missing`, `meta_description_duplicate`, `h1_missing`, `h1_multiple` · canonicals: `canonical_missing`, `canonical_multiple`, `canonical_invalid`, `canonical_cross_domain`, `canonical_target_not_ok` · indexability: `page_noindex`, `page_nofollow` · sitemaps: `sitemap_missing`, `sitemap_invalid`, `sitemap_unavailable`, `sitemap_url_not_indexable`, `sitemap_url_blocked_by_robots` · images: `img_alt_missing`.

Fingerprint: `sha256(rule | normalized URL | group key)`, unique per website (`UNIQUE (website_id, fingerprint)`); no timestamps or evidence in it.

## Issue lifecycle

OPEN → FIXED only when a completed, reconcilable crawl re-checked the scope: content rules need the page re-fetched and parsed (200 HTML), or a complete crawl that no longer reaches it; robots-blocked, failed, too-large, cancelled or truncated-before-the-page re-checks fix nothing. IGNORED is kept across scans until a user reopens. Every observing scan is in `site_issue_scans`; events (`DETECTED`, `FIXED`, `REOPENED`, `IGNORED`, `UNIGNORED`) carry scan or actor and reason.

## API (all under `/api/v1/websites/:id`, org-scoped, 404 across tenants)

`GET /crawl` (latest, previous, changes, latest crawl scan) · `GET /crawl/pages?status=&outcome=&indexable=&url=&limit=&cursor=` · `GET /issues?status=&severity=&category=&rule=&url=&limit=&cursor=` · `GET /issues/rules` · `GET /issues/:issueId` · `GET /issues/:issueId/history` · `POST /issues/:issueId/ignore {reason}` · `POST /issues/:issueId/reopen`. `POST /api/v1/scans` accepts `crawl: { maxPages, maxDepth }`; `GET /api/v1/scans/:id` adds `module_statuses` and `crawl_progress`.

## Migration 031 (additive)

crawl page outcome / redirect target / X-Robots-Tag / image alt / indexability reasons; summary depth, robots-blocked count, reconcilable; wider `truncated_reason`; `site_issues.category` (backfilled, indexed); `site_issue_scans`; `scans.crawl_options`. Fresh and upgrade paths are checked by `server/scripts/verify-migrations.mjs` in CI.

## Known limitations (Phase 2)

- No JavaScript rendering: pages are audited as served HTML. A headless browser needs separate approval (CPU, cost).
- Core Web Vitals are not measured (no lab or field data source); nothing reports them.
- The crawl runs in the shared worker loop: a long crawl (up to `SCANNER_CRAWL_MAX_DURATION_MS`) delays the monitoring scheduler tick. Separate scheduler/worker processes are audit item P1-5.
- `hreflang` reciprocity and orphan-page detection are not implemented.
- Crawl pages are kept for the latest 2 crawls per website; older page-level history is not retained (ClickHouse later).
- The frontend tests use mocked responses shaped like the backend's (the same contract is asserted against PostgreSQL in `site-audit-api.integration.test.ts`); there is no browser E2E of the workflow against a live backend yet.

---

# Phase 3: Google Search Console integration

Branch `feat/p3-search-console`, from `main` after PRs #3 and #4. Not deployed; no production migration run; no live Google call made (no OAuth client is configured).

- OAuth: authorization code + PKCE, read-only scope, single-use browser-bound state, encrypted refresh tokens (AES-256-GCM, versioned keys), reauthorization on `invalid_grant`, disconnect revokes and deletes.
- Properties: live list, domain / URL-prefix matching against the website, ZigmaNeural verification and Google permission both required.
- Sync: checkpointed (set x day) units, 20 s worker slices, leases, one active job per property, quota pauses, never wiping data with an empty or failed fetch, coverage that separates missing days from zeros.
- API and UI: Integrations settings (connect, reconnect, link, disconnect) and Search performance (freshness, sync, KPIs with comparison, daily chart + table, query/page/country/device/appearance breakdowns).
- Migration 032 (additive). Details, configuration, limits and the staging procedure: `docs/SEARCH_CONSOLE.md`.

Known limitations: web search type only; one performance filter at a time; no ClickHouse copy yet; per-process pacing (fine for one worker instance, needs a shared limiter if web/worker scale out); a Google OAuth app in Testing mode expires refresh tokens after 7 days.

---

# Phase 4: Keyword research and competitor intelligence

Branch `feat/p4-keyword-research`, from `main` after PR #5. Not deployed; no production migration run; no paid provider call made.

- Provider-neutral interface (`server/src/research/providers`) with declared capabilities, metrics, targeting, caching, attribution and cost; registry with explicit `CAPABILITY_UNSUPPORTED` / `PROVIDER_NOT_CONFIGURED` errors.
- Search Console provider (first-party): organic keywords, ideas, related, overview, and gap between an organization's own websites, from the Phase 3 data. Search volume, difficulty, CPC, competition, SERPs and competitor discovery are unsupported (no licensed provider approved).
- Runs with provenance (source, data date, sample flag, notes), params-hash caching, concurrent de-duplication, per-org daily quota, timeouts, safe errors, retention pruning.
- Deterministic normalization, rule-based intent, gap classification (shared / missing / unique, with sample-absence flags), run comparison, CSV export, saved keyword lists, optional AI prioritization grounded in the run's rows and labelled as AI.
- Keywords and Competitors pages replace the placeholders; Rankings and Backlinks stay placeholders.
- Migration 033 (additive). Details: `docs/KEYWORD_RESEARCH.md`.

Known limitations: first-party data only; gap limited to own websites; runs execute in the request (no queue); ideas only from queries the site already has.
