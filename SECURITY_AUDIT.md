# ZigmaNeuralIntelligence Security and Reliability Audit

Date: 2026-09-03 (historical baseline; see the 2026-10-07 hardening section at the end for current status)
Decision: Conditional Pass

## Scope

Reviewed frontend routes and pages, backend routes and middleware, database migrations, authentication, RBAC, tenant-scoped queries, scanner SSRF controls, AI integration boundaries, logging, rate limiting, headers, cookies, dependencies, worker execution, health/readiness routes, and existing unit/server/E2E tests.

## Fixes Implemented

- Protected frontend application routes and added logout behavior.
- Corrected website scan creation and result polling.
- Added website ownership verification token and verification action.
- Scoped routing decisions and routing policies to the authenticated organization.
- Persisted organization context with routing decisions.
- Made refresh-token rotation atomic.
- Pinned scanner connections to IP addresses validated by the SSRF check.
- Added manual redirect validation, response limits, and scanner timeouts.
- Added CSP, frame, MIME, referrer, permissions, and production HSTS headers.
- Added login and registration rate limits.
- Removed spoofable forwarded-IP rate-limit keys.
- Enabled verified database TLS by default.
- Added explicit PostgreSQL pool shutdown.
- Prevented duplicate scan worker claims.
- Upgraded frontend build dependencies; dependency audits report no known vulnerabilities.

## Acceptance Matrix

| Area | Current Level | Target | Result |
|---|---|---|---|
| Navigation and pages | Good | Production | All registered routes inventoried; E2E coverage remains limited |
| Authentication | Production | Production | JWT, bcrypt, refresh rotation, logout, route guards validated |
| Authorization and RBAC | Production | Production | Backend role and membership checks; routing IDOR fixed |
| Tenant isolation | Production | Production | Tenant filters audited; integration tests require database |
| Forms and validation | Good | Production | Zod/server validation and client regression tests pass |
| API and errors | Good | Production | Central error boundary and controlled responses present |
| SSRF | Production | Production | DNS result pinned for outbound scanner connection |
| Rate limiting | Production | Production | Auth-specific limits and non-spoofable request IP |
| CORS, headers, cookies | Production | Production | Configured origins, secure cookies, security headers |
| Secrets | Good | Production | No confirmed secret exposure found; runtime secret scan still required |
| Dependencies | Production | Production | Frontend and backend audits report no known vulnerabilities |
| Database | Good | Production | Parameterized queries and tenant filters; live migration/RLS test pending |
| Audit logging | Basic | Production | Audit records exist; durable delivery/outbox not implemented |
| AI security | Good | Production | Simulators and provider boundaries reviewed; no confirmed critical issue |
| Reliability | Good | Production | Worker claim race fixed; live concurrency test pending |
| Health/readiness | Good | Production | Routes exist; live dependency checks not run without database |
| Observability | Good | Production | Request IDs and structured Fastify logs exist |

## Tests Executed

- Frontend unit tests: 71 passed
- Backend tests: 249 passed, 5 skipped
- Frontend production build: passed
- Backend TypeScript build: passed
- Frontend dependency audit: no known vulnerabilities
- Backend dependency audit: no known vulnerabilities
- Existing browser E2E tests: 2 passed

## Global resource protection (F-007, F-008)

Global model, agent and routing-policy mutations now require a platform
administrator (`PLATFORM_ADMIN_USER_IDS`, user UUIDs, fail closed when unset) in
addition to the tenant role. Org-scoped routing policy updates can no longer
deactivate the global default and are transactional (migration 023 adds partial
unique indexes). The real platform admin user IDs must be configured in the
deployment environment; they are not stored in source.

## Remaining Risks and Required Environment Checks

1. Run database migrations and `/ready` against a real isolated PostgreSQL/Supabase environment.
2. Add and execute Supabase RLS policies/tests if direct Data API access is required. The current architecture intentionally denies direct table access and uses the Fastify API as the database boundary.
3. Add an audit outbox or transactional audit requirement if every security event must be guaranteed during database failure.
4. Run authenticated cross-tenant API tests with two isolated test organizations.
5. Run live scanner tests against controlled test hosts to verify pinned IPv4/IPv6 connections and redirect behavior.
6. Add worker lease/heartbeat recovery if scans must survive a worker crash while marked `running`.

No confirmed critical vulnerability was found in the reviewed source. Production readiness remains conditional until the live database, migration, readiness, RLS, and cross-tenant checks are executed.


## 2026-10-07 re-audit and hardening

A fresh audit of HEAD 7e8a5e2 found and fixed (with regression tests): the
pinned-DNS lookup incompatibility that failed every hostname scan (P0), SSE
streams that never terminated for failed/cancelled scans, unbounded SSE
connections, refresh-token race/reuse, logout failing after access-token
expiry, internal error text leaking from auth/website routes, email-enumeration
timing, over-broad `memberships` RLS (migration 026), SSL chain-trust and
wildcard-matching gaps, missing per-org AI budget, and non-cancellable AI work.

Verified locally against an isolated PostgreSQL 16 container: all migrations
(001-026) and the backend integration suites. NOT verified (pending external
verification): behaviour on real Supabase (roles `authenticated`/`anon`,
Data API), DigitalOcean App Platform, a real LLM provider, browser E2E, and
real-network TLS/DNS scanning.

Operational follow-up: a Supabase anon key was committed in the removed
`utils/supabase/info.tsx`; it remains in git history. Rotate it if it was ever
a live project key.
