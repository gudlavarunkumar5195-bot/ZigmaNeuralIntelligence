PHASE 3I — PRODUCTION INFRASTRUCTURE INTEGRATION & E2E ACCEPTANCE

The application code has completed production deployment verification.

DO NOT redesign the UI.
DO NOT change UX.
DO NOT change content.
DO NOT add new product features.
DO NOT replace real data with mock/demo data.

The remaining work is ONLY to complete and verify the real production infrastructure integration.

Current verified state:

- Root production build passes.
- Root start launches server/dist/index.js.
- Fastify serves the built frontend.
- Fastify listens using HOST and PORT.
- /health returns HTTP 200.
- /api/v1/auth/me correctly returns 401 without credentials.
- PostgreSQL persistence uses server-side DATABASE_URL.
- Migrations 001–011 exist and are included in the migration runner.
- Production fixture/demo data has been removed.
- SUPABASE_SERVICE_ROLE_KEY is server-only.
- .env files are gitignored.
- Frontend tests: 66 passed.
- Server tests: 247 passed.
- 5 database integration tests remain skipped.
- DigitalOcean deployment configuration exists.
- Live Supabase migration and authenticated production E2E flow remain unverified.

==================================================
1. SUPABASE PRODUCTION DATABASE
==================================================

Use the already connected:

ZigmaNeural Intelligence Supabase project.

DO NOT use the existing main company Supabase database.

DO NOT create a DigitalOcean database.

DO NOT use SQLite.

DO NOT use in-memory persistence.

Apply migrations 001–011 to the connected Supabase PostgreSQL database.

Use the existing migration runner:

pnpm --dir server migrate

Before applying migrations:

- inspect all migrations
- verify ordering
- verify dependencies
- verify idempotency behavior
- verify foreign keys
- verify indexes
- verify constraints
- verify tenant isolation requirements

Do not silently modify migrations just to make them pass.

If a migration fails:

1. identify the exact migration
2. identify the exact SQL failure
3. fix the underlying migration/schema problem
4. rerun from a clean database where appropriate
5. verify the complete migration chain

==================================================
2. DATABASE VERIFICATION
==================================================

After migrations complete, verify that the actual Supabase database contains the expected schema.

Verify all tables introduced by migrations 001–011.

Verify:

- primary keys
- foreign keys
- indexes
- constraints
- timestamps
- tenant relationships
- unique constraints
- RLS
- RLS policies

Do not create unused tables.

Do not create duplicate tables.

Do not invent schema that is not required by the application.

==================================================
3. RLS AND TENANT ISOLATION
==================================================

Perform an actual database-level tenant isolation verification.

Create/use test tenant A and tenant B.

Verify:

Tenant A cannot read Tenant B data.

Tenant A cannot modify Tenant B data.

Tenant A cannot delete Tenant B data.

Tenant A cannot access Tenant B agent executions.

Tenant A cannot access Tenant B evidence.

Tenant A cannot access Tenant B quality assessments.

Tenant A cannot access Tenant B regeneration history.

Tenant A cannot access Tenant B routing decisions.

Verify authorization at the API layer AND database layer.

Do not rely only on frontend restrictions.

==================================================
4. AUTHENTICATION
==================================================

Verify the complete authentication flow against the real deployed infrastructure.

Test:

- signup
- login
- authenticated session
- /api/v1/auth/me
- logout
- invalid credentials
- expired/invalid authentication
- unauthorized API requests
- tenant association

Do not create fake authenticated users in frontend code.

Use actual database-backed authentication behavior.

==================================================
5. DIGITALOCEAN ENVIRONMENT
==================================================

Verify that the DigitalOcean production Web Service has the required runtime configuration.

Required backend variables:

NODE_ENV=production
HOST=0.0.0.0
DATABASE_URL=<Supabase PostgreSQL connection>
JWT_SECRET=<strong secret>
COOKIE_SECRET=<strong secret>
CORS_ORIGIN=<production frontend origin>
SUPABASE_URL=<project URL>
SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<server-only secret>

Frontend build configuration:

VITE_API_BASE_URL=/api/v1

IMPORTANT:

Do not hardcode production secrets.

Do not commit secrets.

Do not expose SUPABASE_SERVICE_ROLE_KEY to the browser.

Do not place SUPABASE_SERVICE_ROLE_KEY in VITE_* variables.

==================================================
6. CORS
==================================================

Verify CORS against the actual production frontend origin.

Allow only the required production origin(s).

Do not use:

*

in production.

Verify:

- valid origin succeeds
- invalid origin is rejected
- credentials behavior is correct
- preflight works where required

==================================================
7. PRODUCTION API
==================================================

Against the deployed DigitalOcean application, verify:

GET /health

GET /api/v1/auth/me

and all major existing API route groups.

Verify:

- authentication
- authorization
- validation
- tenant isolation
- error handling
- HTTP status codes
- safe error responses

Do not alter API contracts unnecessarily.

==================================================
8. REAL DATABASE INTEGRATION TESTS
==================================================

Enable the currently skipped database integration tests.

Run:

RUN_INTEGRATION=1

against the real Supabase PostgreSQL database.

All previously skipped integration tests must be exercised.

If they fail:

- diagnose the actual cause
- fix the application/schema/configuration
- rerun
- do not skip or weaken the tests

==================================================
9. REAL END-TO-END TENANT FLOW
==================================================

Exercise a complete authenticated tenant flow using the real infrastructure.

Test:

signup/login
→ authenticated tenant
→ create project/website
→ create requirements where applicable
→ execute relevant workflow
→ model routing
→ specialist agent execution
→ instruction planning
→ evidence collection
→ quality assessment
→ controlled regeneration where applicable
→ persist results
→ retrieve results
→ verify tenant isolation

Use real PostgreSQL persistence.

Do not use mock data.

Do not use fixture data as a substitute for the live flow.

==================================================
10. AI / OX ALPHA
==================================================

Verify OX Alpha execution through the configured production provider.

Verify:

- provider credentials
- model configuration
- timeout
- retry behavior
- fallback behavior
- JSON validation
- audit records
- execution correlation
- failure handling

If OX Alpha/OpenRouter credentials are not available in the environment, report:

"Integration Required"

Do not fabricate successful AI execution.

Do not fabricate model output.

==================================================
11. MODEL ROUTING
==================================================

Verify the real model registry and routing system against production data.

Verify:

- candidate discovery
- hard constraints
- exclusions
- scoring
- confidence
- policy
- OX Alpha routing decision
- deterministic fallback
- routing persistence

Do not use illustrative candidate data.

==================================================
12. SPECIALIST AGENTS
==================================================

Verify all registered specialist agents using the real backend.

Verify:

- agent registry
- capability validation
- tool permissions
- dependency checks
- instruction profile selection
- execution
- output validation
- persistence
- tenant isolation

Do not grant agents tools outside their allowlists.

==================================================
13. EVIDENCE INTELLIGENCE
==================================================

Verify real evidence flow.

Verify:

- collector
- normalization
- validation
- provenance
- raw/derived classification
- lineage
- freshness
- hashing
- redaction
- claims
- finding references

Evidence displayed by the frontend must come from the tenant-scoped API.

No dummy evidence.

No fabricated evidence.

==================================================
14. QUALITY CONTROL
==================================================

Verify real post-execution quality assessment.

Verify:

- deterministic quality assessment
- weighted policy
- blockers
- reason codes
- improvement targets
- immutable assessment
- tenant-scoped history

Verify that security, invalid output, instruction failures, and missing evidence correctly act as blockers according to the existing implementation.

==================================================
15. CONTROLLED REGENERATION
==================================================

Verify:

- regeneration run creation
- diagnosis
- decision
- evidence-first strategy
- acceptance stop
- block stop
- iteration limit
- plateau protection
- review records
- immutable history

Never allow infinite regeneration.

Never allow regeneration to bypass quality/security blockers.

==================================================
16. FRONTEND PRODUCTION DATA
==================================================

The frontend MUST use real production API responses.

Remove/disable any remaining:

- dummy data
- mock data
- hardcoded records
- fake dashboards
- illustrative agent records
- fake evidence
- fake quality scores
- fake routing results

Empty state is acceptable when the tenant genuinely has no records.

The frontend must clearly distinguish:

Loading
Empty
Error
Integration Required
Real Data

Do not display fake records to make the interface look populated.

==================================================
17. API BASE URL
==================================================

The current frontend behavior intentionally shows an integration-required state if VITE_API_BASE_URL is absent.

For the current DigitalOcean deployment:

Set build-time:

VITE_API_BASE_URL=/api/v1

Verify that the production frontend correctly calls:

/api/v1/...

through the same production host.

Do not hardcode localhost.

Do not hardcode development URLs.

Do not require users to manually configure an API URL in production.

==================================================
18. PRODUCTION ERROR HANDLING
==================================================

Verify:

- database unavailable
- Supabase unavailable
- AI provider unavailable
- timeout
- malformed AI response
- unauthorized request
- forbidden request
- validation failure
- missing configuration
- unexpected server exception

The application must fail safely.

Never expose secrets or internal stack traces.

==================================================
19. SECURITY AUDIT
==================================================

Perform a final production security review covering:

- authentication
- authorization
- tenant isolation
- RLS
- CORS
- CSRF where applicable
- XSS
- SQL injection
- SSRF
- prompt injection
- secret exposure
- unsafe logging
- API validation
- rate limiting where already supported
- dependency vulnerabilities
- service-role key exposure

Fix genuine vulnerabilities.

Do not weaken existing security controls to make tests pass.

==================================================
20. PRODUCTION HEALTH
==================================================

Verify:

GET /health → 200

Verify DigitalOcean readiness probe succeeds.

Verify:

- application starts
- application remains running
- frontend loads
- API responds
- database connection works
- shutdown is graceful
- startup failures are clearly reported

==================================================
21. FINAL VERIFICATION
==================================================

Run the complete verification suite:

Frontend:
- build
- all frontend tests

Server:
- TypeScript build
- all server tests
- RUN_INTEGRATION=1 database tests

Production:
- build
- startup
- /health
- authentication
- real tenant flow
- database persistence
- tenant isolation
- API
- frontend real data
- AI integration where credentials are configured

Do not claim production-ready merely because unit tests pass.

Production readiness requires the live Supabase + DigitalOcean path to work.

==================================================
22. FINAL ACCEPTANCE REPORT
==================================================

Update ARCHITECTURE.md with:

PHASE 3I — PRODUCTION INFRASTRUCTURE INTEGRATION & E2E ACCEPTANCE

Include:

1. Infrastructure
2. Supabase project
3. Migration status
4. Database schema
5. RLS
6. Tenant isolation
7. Authentication
8. DigitalOcean configuration
9. CORS
10. API verification
11. AI provider verification
12. Model routing
13. Specialist agents
14. Instruction Intelligence
15. Evidence Intelligence
16. Quality Control
17. Controlled Regeneration
18. Frontend real-data verification
19. Security verification
20. Tests
21. Live E2E results
22. Remaining blockers

IMPORTANT:

Give an honest final verdict:

PRODUCTION READY

only if the complete live infrastructure path has been verified.

Otherwise:

NOT READY FOR PRODUCTION

and list the exact blockers.

Do not hide skipped tests.

Do not fabricate external service results.

Do not fabricate AI results.

Do not fabricate database records.

Do not modify UI/UX/content during this phase.

This phase is about making the EXISTING application actually work end-to-end in production.