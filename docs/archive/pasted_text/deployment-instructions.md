PRODUCTION DEPLOYMENT + SUPABASE INTEGRATION

IMPORTANT:
This is an EXISTING fully generated application.

Repository:
GitHub: gudlavarunkumar5195-bot/ZigmaNeuralIntelligence
Branch: main

The application was completely generated in Figma Make and contains the frontend plus server/backend code.

DO NOT rebuild the application from scratch.

DO NOT change the existing UI/UX, design, pages, content, text, branding, navigation, functionality, or visual appearance unless required strictly to fix a technical deployment issue.

Your job is to make the EXISTING application production-ready and deployable on DigitalOcean App Platform using the existing Supabase project.

--------------------------------------------------
1. FIRST: AUDIT THE EXISTING APPLICATION
--------------------------------------------------

Inspect the entire repository before making changes.

Inspect:

- package.json
- pnpm-lock.yaml
- tsconfig.json
- vite.config.ts
- src/
- server/
- all existing API/backend code
- existing authentication
- existing database access
- existing environment variable usage
- existing routes
- existing API endpoints
- existing Supabase-related code
- existing tests
- existing build configuration

Understand the current architecture.

DO NOT delete working functionality.

DO NOT replace existing functionality with mock/demo implementations.

--------------------------------------------------
2. DIGITALOCEAN APP PLATFORM COMPATIBILITY
--------------------------------------------------

The application must run correctly as a DigitalOcean App Platform Web Service.

Fix the current deployment error:

"failed to launch: determine start command:
when there is no default process a command is required"

Add a proper production build and production start process.

The application must:

1. Install dependencies successfully.
2. Build successfully.
3. Start successfully.
4. Listen on the PORT supplied by DigitalOcean.
5. Bind to 0.0.0.0.
6. Return HTTP responses on the configured port.
7. Pass DigitalOcean readiness/health checks.

Do NOT hardcode port 8080.

Use the environment PORT provided by DigitalOcean.

The application must work with:

HOST=0.0.0.0
PORT=<DigitalOcean supplied PORT>

--------------------------------------------------
3. PACKAGE.JSON
--------------------------------------------------

Inspect the existing package.json.

Ensure there is a valid production workflow.

Required logical scripts:

- dev
- build
- start
- test

The "start" command MUST actually launch the production application.

Do not leave:

"start": missing

Do not use:

"start": ""

Do not depend on a developer-only process.

If the application has a backend server, use the existing backend/server entry point as the production process.

If the application is frontend-only, configure a proper production static server.

Prefer existing dependencies where possible.

Do not introduce unnecessary dependencies.

--------------------------------------------------
4. FRONTEND + BACKEND ARCHITECTURE
--------------------------------------------------

Determine whether the current application is:

A. frontend only
B. frontend + Node server
C. frontend + API server
D. another existing architecture

Preserve the existing architecture.

If server/ already contains backend code, use that existing server instead of creating a second unnecessary backend.

The production server must:

- serve the built frontend
- expose existing API routes
- connect to Supabase
- handle errors safely
- listen on 0.0.0.0
- use process.env.PORT

Do not create duplicate servers.

--------------------------------------------------
5. SUPABASE INTEGRATION
--------------------------------------------------

Use the existing Supabase project:

Project:
ZigmaNeural Intelligence

Supabase must be the application's database/backend platform.

DO NOT create a separate DigitalOcean database.

DO NOT use SQLite.

DO NOT use an in-memory database.

DO NOT create mock database storage.

Use PostgreSQL through Supabase.

--------------------------------------------------
6. ENVIRONMENT VARIABLES
--------------------------------------------------

The application must use environment variables.

Required variables:

SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

Use the correct variable for the correct purpose.

SECURITY:

SUPABASE_SERVICE_ROLE_KEY is SERVER-ONLY.

NEVER expose SUPABASE_SERVICE_ROLE_KEY to:

- browser code
- frontend JavaScript
- public HTML
- Vite client environment
- client-side bundles
- GitHub
- logs
- API responses

The browser may use the publishable/anon key only where appropriate and where RLS policies protect the data.

Never hardcode secrets.

Never commit .env files containing secrets.

Update .gitignore appropriately.

Provide/update .env.example with variable names only.

--------------------------------------------------
7. SUPABASE DATABASE SCHEMA
--------------------------------------------------

The Supabase database currently has no application tables.

That is acceptable.

Do NOT manually invent unnecessary tables.

Inspect the existing application code and determine exactly which persistent data the application requires.

Create a proper PostgreSQL/Supabase migration system.

Create:

supabase/
  migrations/

or use the project's existing migration structure if one already exists.

Create normalized production database tables based on the application's ACTUAL existing functionality.

For every table:

- primary key
- appropriate PostgreSQL data types
- created_at
- updated_at where appropriate
- foreign keys
- unique constraints
- indexes
- NOT NULL constraints where appropriate
- CHECK constraints where appropriate

Do not create duplicate tables for the same entity.

Do not create unused tables.

--------------------------------------------------
8. ROW LEVEL SECURITY
--------------------------------------------------

Enable Row Level Security on every application table that is accessible through Supabase APIs.

Create explicit RLS policies.

Never rely on:

"Automatically expose new tables"

for production security.

Use least privilege.

Users must only access records they are authorized to access.

Server-side privileged operations may use:

SUPABASE_SERVICE_ROLE_KEY

but only from trusted server-side code.

--------------------------------------------------
9. DATABASE MIGRATIONS
--------------------------------------------------

Database schema changes must be reproducible.

Do NOT depend on manually creating tables in the Supabase dashboard.

Create SQL migrations that can be applied to a fresh Supabase project.

Document the migration process.

The result must allow:

fresh database
→ run migrations
→ database ready for application

--------------------------------------------------
10. EXISTING FUNCTIONALITY
--------------------------------------------------

Connect the existing application functionality to the real Supabase database.

Replace only fake/mock/local persistence if it exists.

Do NOT remove existing application features.

Do NOT change existing content.

Do NOT change the UI.

Do NOT redesign components.

Do NOT change routes unless technically required.

Every existing feature that requires persistence must use the real database.

--------------------------------------------------
11. ERROR HANDLING
--------------------------------------------------

Implement production-safe error handling.

Handle:

- database connection failures
- Supabase errors
- API errors
- invalid input
- authentication errors
- authorization failures
- missing environment variables
- startup failures
- unexpected exceptions

Never expose:

- database passwords
- service role keys
- stack traces
- internal filesystem paths
- sensitive configuration

to end users.

Return safe API errors.

Log useful server-side diagnostic information.

--------------------------------------------------
12. HEALTH CHECK
--------------------------------------------------

Add a lightweight health endpoint if one does not already exist.

Example:

GET /health

It should return HTTP 200 when the application process is healthy.

Do not make the health endpoint unnecessarily dependent on expensive database queries.

If appropriate, also provide a deeper readiness check separately.

The application must respond correctly to DigitalOcean health checks.

--------------------------------------------------
13. DIGITALOCEAN CONFIGURATION
--------------------------------------------------

Make the application compatible with:

DigitalOcean App Platform
Resource type: Web Service
GitHub repository:
gudlavarunkumar5195-bot/ZigmaNeuralIntelligence
Branch:
main

The service must automatically deploy when changes are pushed to main.

Ensure:

Build command is valid.
Run/start command is valid.
Port configuration is compatible with DigitalOcean.

Do not hardcode 8080.

--------------------------------------------------
14. BUILD VALIDATION
--------------------------------------------------

Before considering the work complete, verify:

npm/pnpm dependency installation
TypeScript compilation
frontend build
backend build if applicable
production start
API startup
health endpoint
Supabase initialization
database queries
authentication
existing tests

Fix actual errors found during validation.

Do not hide failures.

Do not claim success unless the application actually passes the checks.

--------------------------------------------------
15. OPEN SOURCE REQUIREMENT
--------------------------------------------------

Use open-source libraries/tools wherever an additional dependency is genuinely required.

Do not introduce:

- paid proprietary runtime dependencies
- free-trial-only services
- unnecessary SaaS dependencies

Prefer mature, actively maintained open-source packages.

Do not replace working dependencies merely for the sake of changing them.

--------------------------------------------------
16. PRODUCTION SECURITY
--------------------------------------------------

Review the existing application for:

- secret exposure
- insecure environment variables
- SQL injection
- XSS
- CSRF where applicable
- authentication bypass
- authorization bypass
- unsafe API endpoints
- excessive error disclosure
- insecure CORS
- unsafe file handling
- dependency vulnerabilities

Fix genuine issues without changing the UI or business functionality.

Use secure defaults.

--------------------------------------------------
17. DO NOT CREATE A SECOND COMPANY DATABASE
--------------------------------------------------

IMPORTANT ARCHITECTURE:

ZigmaNeuralIntelligence is a separate application/repository.

It may use the separate Supabase project:

ZigmaNeural Intelligence

The existing:

zigma-neural-nexus

application/repository and its existing database must NOT be modified or reused unless the existing ZigmaNeuralIntelligence code explicitly requires integration with it.

Keep the applications logically separated.

Use the ZigmaNeural Intelligence Supabase project for this application.

--------------------------------------------------
18. FINAL REQUIRED OUTPUT
--------------------------------------------------

After implementation, provide a concise technical summary containing:

1. Existing architecture discovered
2. Files changed
3. Production start command
4. Production build command
5. Required environment variables
6. Supabase tables created
7. Supabase migrations created
8. RLS policies created
9. Health endpoint
10. DigitalOcean configuration
11. Tests executed
12. Any remaining issues

MOST IMPORTANT:

Do not redesign or regenerate the application.

Preserve the complete Figma-generated application.

Only make the technical changes required to:

Figma-generated application
        ↓
GitHub
        ↓
DigitalOcean App Platform
        ↓
Production Web Service
        ↓
Supabase PostgreSQL

The final repository must be production-deployable.