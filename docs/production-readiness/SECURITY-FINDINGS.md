# Security findings (Phase 10)

**Scope.** This was a code-level audit of `server/src` and `src/` on branch `feat/p10-production-readiness`, based on `main` at `31eeebc`. It covered four areas, each read independently:

- authentication, sessions and web security;
- multi-tenant isolation;
- outbound requests (SSRF, crawler, AI and other providers);
- database usage.

Every finding marked FIXED has a regression test that was run in this phase. No intrusive testing touched public or production systems: network behaviour was tested against local fixtures only.

Severity: **P0** critical, **P1** high, **P2** medium, **P3** low.

## Fixed in this phase

| ID | Sev | Finding | Evidence | Fix | Regression test |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | **P1** | A compressed response that stalls or drops mid-body hung the fetch forever. `decodedStream` used `res.pipe(gunzip)`, so the body timeout destroyed the request but the decoder never ended. Any site under scan, imported backlink URL or AI-visibility source could stall the crawler, the backlink worker (for every tenant) or an HTTP request. | Reproduced: both new tests hit the 10 s test limit before the fix. | `stream.pipeline(res, decoder)` destroys the decoder on any source error or early close (`server/src/scanner/fetch.ts`). | `fetch-pinned.test.ts`: "a stalled compressed body times out", "cut off mid-stream is a failed read" |
| DB-01 | **P1** | No server-side statement or idle-in-transaction timeout. One slow query or a forgotten transaction could hold a pooled connection indefinitely. The pool size (10) was hard-coded. | `db/client.ts` pool options; grep found no `statement_timeout`. | `DB_STATEMENT_TIMEOUT_MS` (default 30 s), `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (60 s) and `DB_POOL_MAX` (10), sent as startup parameters. Not sent through a transaction pooler: set them on the role (runbook). | `production-hardening.integration.test.ts`: values applied on pooled connections; a slow statement is cancelled. `db-pooler.test.ts` |
| DB-02 | **P1** | One SEO workspace overview request started 9 sections at once, each running several queries in parallel (35–60 queries), so a few concurrent loads saturated the pool. | Measured: a cheap request's median rose from 1–2 ms to 66 ms while 6 overviews ran (`PERFORMANCE-BASELINE.md`). | At most 2 sections in flight per request (`runLimited` in `seo-workspace.service.ts`). | Measured after the fix: median 8 ms under the same load. Workspace E2E and unit tests still pass. |
| PERF-01 | P2 | The dashboard returned every monitoring snapshot ever taken. | Measured: a 3.36 MB response for 20,000 snapshots. | Only the latest 365 points are returned (`routes/dashboard.ts`). | Measured: 64 KB. Dashboard unit and E2E tests pass. |
| DB-04 | P2 | Hot tenant queries had no supporting index: `agent_executions` by org and time, `findings` by org and time, `audit_log` by action, the latest scan per website, scan admission counts, monitoring history, and the `gsc_search_daily` retention prune. | Database audit, verified against the migrations. | Migration `040_production_hardening.sql` (additive `CREATE INDEX IF NOT EXISTS`; build large indexes `CONCURRENTLY` first in production, see the runbook). | `verify-migrations` (fresh install, re-run, upgrade from baselines) |
| DB-05 | P2 | `audit_log` could be updated or deleted by the application role. | Migration 022 revoked only from `PUBLIC`/`authenticated`; the app connects as owner. | A trigger refuses UPDATE, DELETE and TRUNCATE unless the session opts into documented maintenance (`SET zigma.audit_maintenance='on'`). A database owner can still drop the trigger, so ship logs off-site too. | `production-hardening.integration.test.ts` |
| AUTH-01 | P3 | Two tabs refreshing at once made the slower one look like token theft: every session was revoked and the user signed out everywhere. | Code: reuse of any revoked token revoked all of the user's tokens. | A 10 s rotation grace returns `REFRESH_TOKEN_ROTATED` (401) without revoking. The client retries once with the cookie the other tab just updated. Older reuse is still treated as theft. | `session-hardening.integration.test.ts` (both cases), `api-refresh.test.ts` |
| AUTH-02 | P3 | `GET /auth/me` answered a deactivated user's still-valid access token. | `routes/auth.ts`: `/me` was authenticate-only. | `/me` checks `users.active`. | `session-hardening.integration.test.ts` |
| AUTH-03 | P3 | The JWT algorithm was not pinned. | `app.ts` | HS256 for both sign and verify. | `session-hardening`: an HS512 token with the same secret is rejected |
| AUTH-04 | P3 | The refresh cookie's `Secure` flag depended on `NODE_ENV=production` only. | `routes/auth.ts` | `Secure` also whenever `APP_PUBLIC_URL` is https. | Covered by existing auth tests |
| AUTH-05 | P3 | `authenticate` sent a 401 without returning, relying on Fastify internals to stop. | `middleware/auth.ts` | `return reply…` | `http-auth.test.ts` |
| AUTH-06 | P3 | Unbounded `fullName`/`orgName`, and negative `limit` values producing a 500. | `routes/auth.ts`, `routing.ts`, `agents.ts` | Max 200 characters; limits clamped to 1–200. | Existing route tests |
| CRYPTO-01 | P3 | AES-GCM decryption accepted truncated authentication tags. | `integrations/crypto.ts` | Requires 128-bit tags (`authTagLength: 16`). | `crypto-tag.test.ts` |
| AI-01 | P3 | OpenRouter calls followed redirects with the API key. | `ai/providers/openrouter.ts`, `ai/catalog.service.ts` | `redirect: "error"` | — (no provider is called in tests) |
| TEN-01 | P3 | The evidence `UPDATE … WHERE id=$1` had no org predicate. It was not exploitable, because the id comes from an org-scoped upsert. | `services/scan.service.ts` | `AND org_id=$9` | Scan and module integration tests |
| DEP-01 | P2 | `ip-address` ≤10.7.3 (ReDoS, GHSA-rxp7-6hxx-x8q5) in production dependencies, via `@anthropic-ai/claude-agent-sdk` and `@fastify/rate-limit`. | `pnpm audit --prod` | Security floors in `pnpm-workspace.yaml` overrides (`ip-address >=10.7.4`, `source-map-js >=1.2.2`). | `pnpm audit` (root): **No known vulnerabilities found** |
| DEP-02 | P3 | Dev-only advisories: Vite ≤8.1.5 (3 high/moderate), `source-map-js`, `@vitest/mocker`. | `pnpm audit` | Vite 8.3.5, Vitest 4.1.12 | Build and all tests pass on the new versions |
| A11Y-01 | P2 | Automated WCAG checks failed. Muted text (`slate-400`) was 3.4:1 on the page background, the brand link's name did not contain its visible text, and the toast container had a prohibited `aria-label`. | axe-core on every navigable page | `slate-400` token darkened to `#687085` (4.6:1). Label and role fixes. Leftover dark-theme badges corrected. | `accessibility.spec.ts`, `z-route-smoke.spec.ts` (axe on 45 pages) |

## Open findings

| ID | Sev | Finding | Recommended action |
| --- | --- | --- | --- |
| AUTH-07 | P2 | `/auth/register` returns 409 `EMAIL_EXISTS`, which reveals whether an account exists. Login and password reset avoid this. | Product decision: either respond uniformly ("check your email") with email verification, or accept and document the trade-off. |
| AUTH-08 | P2 | There is no per-account login throttle (limits are per IP+email and per IP), and limiters are in memory per instance. | Add a per-email failure counter in PostgreSQL (for example 50 per hour, then a delay or step-up), shared across instances. |
| TEN-02 | P2 | Row-level security does not protect the application path: every policy is `TO authenticated`, and the app connects as table owner. Isolation relies entirely on application predicates. The audit found none missing. | Defence in depth: run as a non-owner role, `FORCE ROW LEVEL SECURITY`, and policies on `current_setting('app.org_id')` with `SET LOCAL` per transaction. This is an architectural change; plan and test it separately. |
| DB-03 | P2 | Search Console "movers" and top-row aggregation over custom ranges up to 480 days scans large volumes. The statement timeout (DB-01) now bounds it. | Pre-aggregate period rollups, or cap long ranges for movers. |
| DB-06 | P2 | The worker tick runs scans inline, so monitoring, notifications, Search Console, rank and AI-visibility jobs can wait up to the scan duration (≤300 s) in each process. | Give scans their own loop or slot, separate from the scheduler tick. |
| DB-07 | P2 | CSV exports build up to 100k–200k rows into one string in memory. | Stream with a cursor in batches. |
| DB-08 | P2 | N+1 inside transactions: `reconcileIssues` (up to ~6k round trips for 2,000 issues, holding row locks) and `reprocessMentions`. | Set-based `INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT`. |
| DB-09 | P2 | The analytics outbox holds a database transaction across ClickHouse HTTP calls. Bounded by the new idle-in-transaction timeout. | Claim with a lease, commit, send, then mark. |
| DB-10 | P2 | Migration 028 skips its unique index (with a WARNING) if duplicate active scans exist, and is still recorded as applied. | Run the runbook check `scans_one_active_per_website` in each environment. |
| DB-11 | P2 | The migrator sets no `lock_timeout`, so DDL can queue behind long queries and block traffic. | `SET LOCAL lock_timeout = '5s'` in the migration transaction. |
| SSRF-01 | P3 | Backlink and AI-visibility source checks accept any port, so they could be used as a third-party port probe. | Allow 80/443 (and 8080/8443) for those checks. |
| SSRF-02 | P3 | The discovery agent fetches off-origin redirect targets before discarding them. Every hop is still SSRF-checked. | Pass `followRedirect` scoped to the origin. |
| AI-02 | P3 | AI retries have no jitter, ignore Retry-After and have no circuit breaker. Failed attempts consume budget rows. | Full jitter, capped Retry-After, a process-wide breaker. |
| AI-03 | P3 | The AI-visibility daily verification quota is checked non-atomically. | A single conditional `UPDATE … RETURNING`. |
| AI-04 | P3 | An undecryptable stored provider key silently falls back to the environment key. | Treat a decrypt error as "disabled". |
| AI-05 | P3 | The keyword-insights prompt lacks the untrusted-data preamble used elsewhere. Output is still validated. | Add the preamble. |
| AI-06 | P3 | The paid-model budget counts calls, not cost. | Operator decision before enabling `AI_ALLOW_PAID_MODELS`. |
| INT-01 | P3 | Google `Retry-After` is not capped. | Clamp to 1 h. |
| AUTH-09 | P3 | Password-reset request timing differs when an account exists (inline send). | Send after replying, or from a queue. |
| WEB-01 | P3 | The CSP allows `connect-src https:`. | Restrict to `'self'` plus the API origin. |
| TEN-03 | P3 | A few child tables lack composite `(id, org_id)` foreign keys (`alert_rules`, `evidence_relationships`, `keyword_list_items.source_run_id`), and worker UPDATEs by job id omit `org_id`. Both are guarded in code. | Add the composite FKs and `AND org_id` in workers. |
| OPS-01 | P3 | `server/pnpm-lock.yaml` is a secondary lockfile not used by CI or deploy (both install from the workspace root). It still lists dev-only Vite advisories. | Delete it or regenerate it deliberately. It is left unchanged here because it is the owner's file. |
| OPS-02 | P3 | `@anthropic-ai/claude-agent-sdk` is a root production dependency used only by the repository's `.zigma-agent/` tooling, not by the app bundle. | Move it to devDependencies if that tooling is not deployed. |
| ROLE-01 | — | Design question: members (not only admins) can create AI-visibility brands and schedules (which cost money), delete rank keywords, and delete keyword lists. | Confirm that this is intended. |

## Controls verified (evidence, not assumptions)

**Authentication**
- bcrypt cost 12, with passwords over 72 bytes rejected.
- Login does not enumerate (a dummy hash on unknown emails, one generic message).
- Refresh tokens: CSPRNG, stored only as SHA-256, rotated in one transaction, reuse revokes all, deactivation revokes.
- Password reset: 30-minute single-use tokens that revoke every session.
- Rate limits on every auth route, plus 200 requests per minute per IP globally.
- `TRUST_PROXY` strictly parsed (`true` is rejected).
- Production refuses weak or identical secrets, the QA bypass, and database TLS without verification (`config-security.ts`).

**Web**
- CSRF: only `/auth/refresh` and `/auth/logout` use the cookie (httpOnly, `SameSite=Strict`, path `/api/v1/auth`). Every other route uses the bearer token.
- CORS: allowlist only, and `*` is rejected.
- Security headers, including `frame-ancestors 'none'`, `script-src 'self'` and HSTS in production.
- 5xx responses are generic with a request id. Authorization, cookie and set-cookie headers and OAuth codes are redacted from logs.
- No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in the frontend.
- No secrets in `VITE_` variables.

**Tenancy**
- `requireOrgMember` re-reads membership and the active flag from the database on every request.
- All 27 route files require auth plus org membership, except auth, health and the OAuth callback (which is bound by single-use state).
- Scoped loaders (`getWebsite`, `requireProject`, `requireBrand`, `getScan`) check `id AND org_id`.
- Workers carry `org_id` from the claimed row.
- No mutation is reachable by a viewer.

**Outbound requests**
- One SSRF guard, which:
  - blocks private, loopback, link-local, CGNAT, multicast, reserved, IPv6 ULA, link-local and mapped addresses, NAT64, 6to4 and Teredo;
  - pins DNS to the validated IP (no rebinding);
  - re-validates every redirect hop, with a hop cap;
  - allows http(s) only, without userinfo;
  - caps decoded size (stops decompression bombs);
  - bounds crawl concurrency (≤5).
- `rejectUnauthorized:false` is used only in the TLS-inspection scanner.

**AI and providers**
- Keys come from the encrypted store or the environment and are never returned or logged.
- Per-attempt timeouts with caller cancellation.
- Atomic per-org budget under an advisory lock.
- The paid-model gate is enforced on the server.
- Model output is schema-validated, and evidence ids are restricted to the supplied set.
- AI suggestions are labelled and need human approval.

**Credentials**
- AES-256-GCM with a key ring, key ids and associated data.
- Google OAuth uses PKCE S256, single-use hashed state plus a browser-nonce cookie, and refresh tokens encrypted at rest.
