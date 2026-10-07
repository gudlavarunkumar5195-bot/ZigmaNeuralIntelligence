# ZigmaNeural Website Intelligence

## Phase 2 — Backend, Authentication, Real Scanning & Production Foundation

The previous audit and hardening pass is complete.

Current verified state:

* 29 frontend files implemented
* Build: PASS
* Lint: PASS
* 64/64 tests passing
* 32 SSRF validation tests
* 32 scoring/quality tests
* `.env.example` created
* `ARCHITECTURE.md` updated
* Unused imports cleaned
* SSRF scheme validation hardened

The project is intentionally marked:

**NOT READY FOR PRODUCTION**

because the following blocking issues remain:

1. No authentication
2. No real scan engine
3. No backend
4. SSRF protection is client-side only
5. No multi-tenancy
6. Demo mode is the default

Your task is to implement the production foundation and eliminate these six blockers.

---

# CRITICAL PRINCIPLE

DO NOT redesign the existing frontend.

DO NOT replace the current UI.

DO NOT remove existing screens.

DO NOT create fake backend responses simply to make the UI appear functional.

The existing UI is the reference implementation.

Your job is to connect it to a real, secure, production-capable backend.

---

# PHASE 1 — ARCHITECTURE DISCOVERY

Before coding:

1. Inspect the complete repository.
2. Identify the current frontend framework.
3. Identify the package manager.
4. Inspect all package scripts.
5. Inspect existing types/interfaces.
6. Inspect all current mock/demo data.
7. Inspect routing.
8. Inspect state management.
9. Inspect API abstractions.
10. Inspect current scoring engine.
11. Inspect existing validation.
12. Inspect environment configuration.
13. Inspect existing test infrastructure.

Do not assume the stack.

Use the technologies already present unless there is a strong architectural reason to introduce something else.

Document the resulting architecture.

---

# PHASE 2 — BACKEND FOUNDATION

Create a proper backend architecture appropriate for the existing application.

Minimum layers:

```text
API
 ↓
Authentication / Authorization
 ↓
Request Validation
 ↓
Service Layer
 ↓
Domain Logic
 ↓
Repositories
 ↓
Database
```

Do not put business logic directly into route handlers.

Implement:

* API versioning
* request validation
* response schemas
* centralized exception handling
* structured logging
* request IDs
* health endpoint
* readiness endpoint
* configuration management

Example:

```text
/api/v1/auth
/api/v1/websites
/api/v1/scans
/api/v1/findings
/api/v1/reports
/api/v1/monitoring
/api/v1/agents
```

Use the actual framework appropriate to the repository.

---

# PHASE 3 — DATABASE

Use PostgreSQL for production.

Do not use browser localStorage as the source of truth.

Do not use SQLite as the production database.

Implement migrations.

Minimum entities:

```text
User
Organization
Membership
Website
WebsiteVerification
Scan
ScanModule
Finding
Evidence
Report
MonitoringSnapshot
AgentExecution
Instruction
ModelExecution
QualityAttempt
AuditLog
```

Use UUIDs or another secure stable identifier strategy.

Add:

* foreign keys
* indexes
* unique constraints
* timestamps
* transaction handling
* appropriate cascading behavior

Do not store secrets in plaintext.

---

# PHASE 4 — MULTI-TENANCY

Implement organization/workspace isolation.

Relationship:

```text
User
 ↓
Organization
 ↓
Website
 ↓
Scan
 ↓
Findings
 ↓
Reports
```

Users can only access resources belonging to organizations where they have permission.

Test explicitly:

```text
Organization A
    ↓
Website A

Organization B
    ↓
Website B
```

Organization A MUST NOT be able to:

* read Website B
* read Scan B
* read Findings B
* read Report B
* modify B
* delete B

Do not rely solely on frontend restrictions.

Enforce authorization server-side.

---

# PHASE 5 — AUTHENTICATION

Implement secure authentication.

Required capabilities:

* registration if applicable
* login
* logout
* session/token management
* protected routes
* password hashing if password authentication is used
* session expiration
* secure cookies where applicable
* account state handling

Never:

* store plaintext passwords
* expose password hashes
* store authentication secrets in frontend source
* place private secrets in `VITE_*` variables

If using cookies:

```text
HttpOnly
Secure
SameSite
```

must be configured appropriately.

If using tokens, design expiration and refresh/revocation properly.

---

# PHASE 6 — RBAC

Implement roles.

At minimum:

```text
Owner
Admin
Member
Viewer
```

Define permissions.

Example:

```text
Owner
- manage organization
- manage members
- manage websites
- run scans
- view reports
- configure settings

Admin
- manage websites
- run scans
- view reports
- manage operational settings

Member
- run permitted scans
- view permitted resources

Viewer
- read-only access
```

Authorization must be enforced in backend services.

---

# PHASE 7 — REAL WEBSITE INGESTION

Replace fake website scanning.

Create a secure website ingestion service.

Input:

```text
URL
```

Process:

```text
Normalize
 ↓
Validate Scheme
 ↓
Resolve DNS
 ↓
Validate Resolved IPs
 ↓
Block Private/Internal Addresses
 ↓
Make Request
 ↓
Validate Redirect
 ↓
Repeat Safety Checks
 ↓
Collect Response
```

Never trust the initial URL alone.

---

# PHASE 8 — SERVER-SIDE SSRF PROTECTION

The existing client-side SSRF protection is NOT sufficient.

Implement server-side protection.

Block:

### Schemes

Only allow:

```text
http
https
```

Reject:

```text
file
ftp
gopher
data
javascript
blob
etc.
```

### IP ranges

Block:

* localhost
* loopback
* private networks
* link-local
* multicast
* unspecified addresses
* reserved ranges
* IPv4-mapped internal IPv6
* IPv6 loopback
* IPv6 link-local

### Cloud metadata

Block known metadata endpoints, including:

```text
169.254.169.254
```

and equivalent IPv6/internal representations.

### DNS rebinding

Resolve the hostname and validate the resulting addresses.

Do not assume DNS resolution is safe.

Validate again before connecting where the HTTP client architecture allows it.

### Redirects

Every redirect must be validated.

Do not blindly follow:

```text
public website
 ↓
private IP
```

Limit redirect count.

---

# PHASE 9 — REQUEST LIMITS

Protect the scanner from hostile websites.

Implement:

* connection timeout
* total request timeout
* maximum response size
* maximum redirects
* maximum pages per scan
* maximum crawl depth
* content-type validation
* decompression limits where applicable
* concurrency limits

Never allow an untrusted website to consume unlimited resources.

---

# PHASE 10 — REAL SCAN JOB

Create a persistent scan job.

Example:

```text
POST /api/v1/websites/{website_id}/scans
```

Return:

```text
scan_id
status
created_at
```

Lifecycle:

```text
QUEUED
 ↓
RUNNING
 ↓
MODULES EXECUTE
 ↓
RESULTS STORED
 ↓
OX ALPHA ANALYSIS
 ↓
QUALITY CONTROL
 ↓
COMPLETED
```

Failure:

```text
RUNNING
 ↓
MODULE FAILURE
 ↓
PARTIAL / FAILED
```

Never simulate this with frontend timers.

---

# PHASE 11 — SCAN MODULE ARCHITECTURE

Create a modular scanner interface.

Conceptually:

```text
Scanner
 ├── SEOScanner
 ├── SecurityScanner
 ├── PerformanceScanner
 ├── SSLScanner
 └── AIVisibilityScanner
```

Each module should return normalized results.

Example:

```text
module
status
started_at
completed_at
duration
findings
evidence
errors
```

A module failure should not automatically destroy unrelated results.

---

# PHASE 12 — SEO SCANNER

Implement real measurements for:

* HTTP status
* title
* meta description
* canonical
* robots
* sitemap
* headings
* H1
* heading hierarchy
* internal links
* broken links where crawling is enabled
* image alt attributes
* structured data
* Open Graph
* Twitter/X metadata
* indexability signals
* redirect chains

Every finding must contain evidence.

Never generate generic findings without measurements.

---

# PHASE 13 — SECURITY SCANNER

Implement deterministic checks for:

* HTTPS
* HSTS
* CSP
* X-Frame-Options
* X-Content-Type-Options
* Referrer-Policy
* Permissions-Policy
* secure cookies
* mixed content
* insecure resources
* server disclosure where observable

Do not claim vulnerabilities that cannot be supported by evidence.

---

# PHASE 14 — SSL SCANNER

Inspect the actual TLS certificate.

Collect:

```text
issuer
subject
SAN
valid_from
valid_until
hostname_match
chain_status
protocol information where measurable
```

Calculate expiry from actual certificate data.

Do not hardcode:

```text
A+
VALID
30 days
```

---

# PHASE 15 — PERFORMANCE

Implement real measurements where technically possible.

Use appropriate tooling for the existing environment.

Collect:

* LCP
* CLS
* INP
* TTFB
* document size
* transfer size
* request count
* JavaScript weight
* CSS weight
* image weight
* compression
* caching signals

If a metric cannot be measured:

```text
status = NOT_MEASURED
```

Do not invent values.

---

# PHASE 16 — AI VISIBILITY

Keep the distinction:

```text
MEASURED
INFERRED
OPPORTUNITY
```

Only measured values may be represented as measurements.

AI-derived analysis must retain provenance.

Store:

```text
input
processing method
model/rule
timestamp
confidence
result
```

---

# PHASE 17 — EVIDENCE MODEL

Every important finding must be traceable.

Example:

```text
Finding
 ↓
Evidence
 ↓
URL
 ↓
Observed value
 ↓
Timestamp
 ↓
Rule / Model
```

A user should be able to answer:

**"Why did ZigmaNeural give me this finding?"**

---

# PHASE 18 — OX ALPHA INTEGRATION

OX Alpha must operate on actual persisted scan results.

Pipeline:

```text
Scan Results
 ↓
Analysis
 ↓
Weak / Missing Areas
 ↓
Instruction Decision
 ↓
Model Router
 ↓
Model Execution
 ↓
Quality Control
```

OX Alpha must NOT fabricate missing scanner data.

If required information is unavailable:

```text
NOT_MEASURED
```

must remain the state.

---

# PHASE 19 — MODEL EXECUTION

Do not create fake model execution records.

If no model provider is configured:

```text
status = UNAVAILABLE
```

not:

```text
COMPLETED
```

Store:

```text
model
task
status
started_at
completed_at
latency
input metadata
output metadata
error
```

Never store provider API keys in the database.

---

# PHASE 20 — QUALITY CONTROL

Use the existing scoring/quality logic where valid.

Do not replace deterministic rules with arbitrary LLM judgments.

Persist:

```text
attempt_number
input
result
quality_score
quality_gates
accepted
reason
timestamp
```

Implement:

* maximum retry count
* regression detection
* best attempt
* final acceptance

Never retry indefinitely.

---

# PHASE 21 — API ↔ FRONTEND INTEGRATION

Replace demo data progressively.

Every existing screen should consume the real API.

Priority:

1. Add Website
2. Scan Progress
3. Overview
4. SEO Intelligence
5. Security
6. Performance
7. SSL
8. AI Visibility
9. Reports
10. Monitoring
11. Control Center
12. Model Router
13. Quality Control
14. Instructions

Do not break the current UI.

---

# PHASE 22 — FRONTEND STATES

Every API-backed screen must support:

```text
Loading
Empty
Success
Partial
Error
Unauthorized
Forbidden
```

Never display fake values when the backend has no data.

---

# PHASE 23 — DEMO MODE

Keep demo mode if useful for development.

But production must require explicit configuration.

Change:

```text
VITE_APP_MODE=demo
```

from an implicit production behavior into an explicit development/demo setting.

Production must fail safely if required backend configuration is missing.

Never silently fall back to demo data in production.

---

# PHASE 24 — SECRETS

Audit every environment variable.

Public frontend variables:

```text
VITE_*
```

must NEVER contain:

* database credentials
* private API keys
* model provider secrets
* JWT signing secrets
* encryption keys
* internal service credentials

Create appropriate server-only environment variables.

Update `.env.example`.

---

# PHASE 25 — RATE LIMITING

Implement server-side rate limits for:

* login
* registration
* URL validation
* scan creation
* report generation
* expensive AI execution
* ownership verification

Return appropriate status codes.

Do not expose internal implementation details.

---

# PHASE 26 — AUDIT LOGGING

Record:

```text
login
logout
website_created
website_deleted
ownership_verified
scan_created
scan_started
scan_completed
scan_failed
report_generated
model_executed
instruction_changed
permission_changed
```

Include:

```text
timestamp
user
organization
resource
action
result
request_id
```

Do not log secrets.

---

# PHASE 27 — ERROR HANDLING

Implement centralized error handling.

External failures must become controlled application states.

Test:

```text
DNS failure
TLS failure
HTTP timeout
HTTP 500
HTTP 429
invalid HTML
oversized response
model timeout
model unavailable
database unavailable
queue unavailable
worker crash
```

No production stack traces to users.

---

# PHASE 28 — TESTING

Expand the existing 64 tests.

Do not delete them.

Add:

### Authentication tests

* registration
* login
* logout
* invalid credentials
* session expiration

### Authorization tests

* role restrictions
* unauthorized resource access
* cross-tenant access

### SSRF tests

* IPv4
* IPv6
* DNS rebinding scenarios
* redirects
* metadata endpoints
* alternate IP formats
* dangerous schemes

### Scan tests

* successful scan
* partial scan
* failed scan
* duplicate scan
* cancellation
* timeout
* retry

### API tests

Critical endpoints.

### Database tests

* constraints
* tenant isolation
* transactions

---

# PHASE 29 — SECURITY TESTING

Explicitly test:

```text
SSRF
XSS
CSRF where applicable
SQL injection
authorization bypass
tenant isolation
session abuse
rate-limit bypass
secret exposure
prompt injection
malicious website content
oversized payloads
resource exhaustion
```

Remember:

**The website being scanned is untrusted input.**

---

# PHASE 30 — PRODUCTION OBSERVABILITY

Implement:

* structured logging
* request IDs
* scan IDs
* agent execution IDs
* model execution IDs
* duration metrics
* error codes
* health checks
* readiness checks

Make it possible to trace:

```text
User
 ↓
Request
 ↓
Scan
 ↓
Scanner
 ↓
Finding
 ↓
OX Alpha
 ↓
Model
 ↓
Quality Control
 ↓
Report
```

---

# PHASE 31 — NO FAKE SUCCESS

Never transform failures into successful UI states.

Bad:

```text
Scanner failed
↓
Overall score = 87
↓
Scan complete
```

Correct:

```text
Scanner failed
↓
Scan = PARTIAL
↓
Affected metric = NOT_MEASURED
↓
User sees explanation
```

Accuracy is more important than presentation.

---

# PHASE 32 — ACCEPTANCE TEST

The following must work end-to-end:

```text
Create user
 ↓
Login
 ↓
Create organization
 ↓
Add website
 ↓
Validate website
 ↓
Pass ownership verification
 ↓
Create scan
 ↓
Queue scan
 ↓
Run real modules
 ↓
Collect evidence
 ↓
Persist findings
 ↓
Calculate scores
 ↓
OX Alpha analyzes
 ↓
Model Router executes where configured
 ↓
Quality Control evaluates
 ↓
Persist final result
 ↓
Generate report
 ↓
Display report
 ↓
Create monitoring baseline
```

Then:

```text
Run second scan
 ↓
Compare snapshots
 ↓
Detect actual changes
 ↓
Display change history
```

---

# PHASE 33 — FAILURE ACCEPTANCE

The system must also correctly handle:

```text
Invalid URL
Private IP
Metadata endpoint
DNS failure
Website unavailable
Timeout
SSL failure
Oversized website
Malformed website
Scanner failure
Model failure
Database failure
Worker failure
Unauthorized request
Cross-tenant request
Expired session
Rate limit
```

No unsafe fallback.

No fake success.

---

# PHASE 34 — FINAL VALIDATION

Run:

```text
build
lint
typecheck
unit tests
integration tests
API tests
security tests
```

Use the actual repository commands.

Do not invent commands that do not exist.

Fix all blocking issues.

Re-run everything after fixes.

---

# FINAL REPORT

Update `ARCHITECTURE.md`.

Report:

## Build

PASS / FAIL

## Lint

PASS / FAIL

## Type Check

PASS / FAIL

## Tests

X / X PASS

## Authentication

IMPLEMENTED / NOT IMPLEMENTED

## Backend

IMPLEMENTED / NOT IMPLEMENTED

## Real Scanner

IMPLEMENTED / NOT IMPLEMENTED

## Server-Side SSRF

IMPLEMENTED / NOT IMPLEMENTED

## Multi-Tenancy

IMPLEMENTED / NOT IMPLEMENTED

## Production Mode

IMPLEMENTED / NOT IMPLEMENTED

## Remaining Blockers

List every remaining blocker honestly.

## Production Verdict

Choose exactly one:

```text
READY
READY WITH WARNINGS
NOT READY FOR PRODUCTION
```

Do not mark READY if any critical security, authentication, authorization, backend, or real-scanning requirement remains incomplete.

---

# ABSOLUTE RULES

1. Preserve the existing UI.
2. Do not rebuild the application unnecessarily.
3. Do not use fake production data.
4. Do not hardcode scan results.
5. Do not hardcode scores.
6. Do not simulate scan progress.
7. Do not claim a scanner executed when it did not.
8. Do not claim a model executed when it did not.
9. Do not trust scanned website content.
10. Do not rely on client-side SSRF protection.
11. Do not allow cross-tenant access.
12. Do not expose secrets.
13. Do not let OX Alpha bypass security controls.
14. Do not allow infinite retries.
15. Do not silently fall back to demo mode in production.
16. Do not hide failures.
17. Do not remove existing tests.
18. Do not reduce test coverage to make the build pass.
19. Fix root causes.
20. Run the complete test suite after implementation.

The goal is not merely:

**"The application builds."**

The goal is:

**"A real authenticated user can safely scan a real website and receive a real, evidence-backed, persistent Website Intelligence assessment through a secure production architecture."**
