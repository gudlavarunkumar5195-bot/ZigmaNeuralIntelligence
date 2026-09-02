# ZigmaNeural Website Intelligence

## Production Validation, Integration, Security & Reliability Pass

You have already implemented the ZigmaNeural Website Intelligence platform across 29 files and the project currently builds without errors.

DO NOT rebuild the UI from scratch.

DO NOT redesign the existing application unless a change is required to fix a functional, security, accessibility, usability, or production-readiness problem.

Your task now is to perform a complete **production validation, integration, security, reliability, and intelligence audit** of the entire application and fix everything you find.

The objective is to move the application from:

**"Build succeeds"**

to:

**"End-to-end production workflow is real, connected, testable, secure, observable, recoverable, and ready for deployment."**

---

# 1. FIRST: UNDERSTAND THE ENTIRE CODEBASE

Before modifying anything:

1. Inspect all 29 existing files.
2. Identify the frontend architecture.
3. Identify the backend architecture.
4. Identify API routes/endpoints.
5. Identify database/storage mechanisms.
6. Identify authentication and authorization.
7. Identify scan orchestration.
8. Identify OX Alpha implementation.
9. Identify model routing.
10. Identify model registry.
11. Identify quality-control logic.
12. Identify instruction intelligence.
13. Identify SEO/AEO processing.
14. Identify security scanning.
15. Identify SSL/HTTPS processing.
16. Identify reporting.
17. Identify monitoring.
18. Identify configuration/environment variables.
19. Identify logging and exception handling.
20. Identify every hardcoded/demo/mock value.

Create an internal architecture map before making changes.

Do not assume that something is implemented simply because a UI screen exists.

Trace every feature to its actual implementation.

---

# 2. CRITICAL RULE — NO FAKE INTELLIGENCE

Audit the entire application for:

* hardcoded scores
* hardcoded charts
* fake findings
* fake scan progress
* fake agent statuses
* fake benchmark values
* fake model results
* fake SSL status
* fake security findings
* fake SEO findings
* fake AI visibility scores
* fake performance metrics
* fake monitoring data
* placeholder reports
* static activity logs
* simulated API responses
* randomly generated production values

Examples that MUST NOT remain as production logic:

```text
87/100
A+
92%
12 findings
OX Alpha completed
Model selected: Claude
Scan completed successfully
```

unless those values are actually generated from the underlying system.

If demo data is required for development, isolate it behind an explicit development/demo mode.

Production mode MUST use real data.

---

# 3. END-TO-END USER JOURNEY

Test this complete workflow:

USER
↓
Add Website
↓
Validate URL
↓
Ownership Authorization
↓
Select Scan Modules
↓
Launch Scan
↓
Create Scan Job
↓
Queue/Worker
↓
Website Discovery
↓
SEO Analysis
↓
Security Analysis
↓
Performance Analysis
↓
SSL/HTTPS Analysis
↓
AI Visibility Analysis
↓
Evidence Collection
↓
Normalize Results
↓
OX Alpha Analysis
↓
Instruction Decision
↓
Model Routing
↓
Model Execution
↓
Quality Control
↓
Retry if required
↓
Final Score
↓
Persist Results
↓
Generate Report
↓
Monitoring Baseline

````

Every transition must be real.

Do not use UI-only simulation.

---

# 4. ADD WEBSITE FLOW

Validate:

- URL format
- HTTP/HTTPS
- DNS resolution
- reachable host
- redirect handling
- canonical URL
- hostname normalization
- duplicate website detection
- duplicate scan prevention
- SSRF protection
- private IP protection
- localhost protection
- internal network protection
- dangerous schemes
- malformed URLs
- excessive redirects
- timeout handling

Reject dangerous targets such as:

- localhost
- 127.0.0.1
- private RFC1918 addresses
- link-local addresses
- cloud metadata endpoints
- internal hostnames

Prevent SSRF.

Never allow a submitted URL to directly access internal infrastructure.

---

# 5. OWNERSHIP AUTHORIZATION

Verify that website ownership is actually meaningful.

Do not present "verified" merely because the user entered a URL.

Implement or validate a secure ownership mechanism such as:

- DNS verification
- HTML verification file
- meta verification
- authenticated deployment token

Store:

- verification status
- verification method
- timestamp
- website ID

Prevent users from scanning private/unauthorized websites if the product's business rules require ownership.

---

# 6. SCAN ENGINE

Every selected module must produce real results.

Build/validate a scan orchestration layer.

Each scan should have:

```text
scan_id
website_id
status
started_at
completed_at
requested_modules
completed_modules
failed_modules
progress
error
````

Statuses should include at minimum:

```text
queued
running
completed
partial
failed
cancelled
```

The frontend must obtain progress from actual scan state.

Do not fake progress using timers.

---

# 7. SCAN RESILIENCE

A failed module must not automatically destroy the entire scan.

Example:

```text
SEO          PASS
Security     PASS
Performance  FAILED
SSL          PASS
AI Visibility PARTIAL
```

The system should produce a:

**PARTIAL**

result and clearly explain what failed.

Implement:

* module-level timeout
* retry policy
* retry count
* exponential backoff where appropriate
* failure reason
* recovery
* cancellation
* idempotency
* duplicate-job protection

Never retry infinitely.

---

# 8. SEO INTELLIGENCE

SEO findings must be evidence-backed.

Check actual website data for:

* title
* meta description
* canonical
* robots.txt
* sitemap.xml
* headings
* H1 count
* heading hierarchy
* indexability
* internal links
* broken links
* images
* alt attributes
* structured data
* Open Graph
* Twitter/X metadata
* duplicate metadata
* missing metadata
* page status codes
* redirect chains

Every finding should contain:

```text
finding_id
severity
category
description
evidence
affected_url
recommendation
confidence
```

Do not produce generic recommendations without evidence.

---

# 9. AEO / AI VISIBILITY

Validate actual structured data and AI discoverability.

Check:

* JSON-LD
* FAQ schema
* Organization schema
* WebSite schema
* WebPage schema where appropriate
* author information
* entity consistency
* answer-oriented content
* question coverage
* content accessibility
* crawlability
* citation/source signals where applicable

Clearly distinguish:

```text
MEASURED
INFERRED
OPPORTUNITY
```

Never present inferred information as measured information.

---

# 10. SECURITY ENGINE

Perform actual security validation.

Check:

* HTTPS
* HSTS
* CSP
* X-Frame-Options
* X-Content-Type-Options
* Referrer-Policy
* Permissions-Policy
* cookie security
* mixed content
* insecure resources
* exposed server information
* dangerous headers
* common security misconfigurations

Security findings must include evidence.

Severity:

```text
INFO
LOW
MEDIUM
HIGH
CRITICAL
```

Do not claim a vulnerability exists without evidence.

---

# 11. PERFORMANCE ENGINE

Measure actual performance where technically possible.

Collect:

* LCP
* CLS
* INP
* TTFB
* page size
* JavaScript size
* CSS size
* image weight
* request count
* render-blocking resources
* compression
* caching
* third-party resources

Do not use FID as a substitute for INP in new assessments.

If a metric cannot be measured, explicitly mark it:

```text
NOT_MEASURED
```

rather than inventing a value.

---

# 12. SSL / HTTPS ENGINE

Do not hardcode A+.

Actually inspect:

* certificate validity
* issuer
* subject
* SAN
* expiration
* protocol support
* certificate chain
* hostname match
* TLS configuration where measurable

Statuses:

```text
VALID
EXPIRING
EXPIRED
INVALID
UNAVAILABLE
NOT_MEASURED
```

Expiry warnings should be calculated from the actual certificate.

---

# 13. OX ALPHA — REAL DECISION LOOP

OX Alpha must be treated as the orchestration/intelligence layer.

The loop should be:

```text
Collect Results
      ↓
Analyze Results
      ↓
Identify Missing / Weak Areas
      ↓
Determine Whether Additional Instruction Is Required
      ↓
Generate Dynamic Instruction
      ↓
Select Appropriate Model
      ↓
Execute
      ↓
Validate Output
      ↓
Compare Against Previous Attempt
      ↓
Accept / Retry / Escalate
```

OX Alpha must NOT blindly retry.

It should determine:

* what failed
* why it failed
* whether another attempt can improve it
* what instruction should change
* which model is appropriate
* whether the quality threshold has been reached

Store every attempt.

---

# 14. INSTRUCTION INTELLIGENCE

Maintain three distinct instruction layers:

### Permanent Instructions

Stable system-wide rules.

### Agent Instructions

Instructions specific to the agent/task.

### Dynamic Instructions

Generated by OX Alpha based on current analysis.

Never allow dynamic instructions to overwrite permanent safety rules.

Priority must be:

```text
Safety / System Rules
        ↓
Permanent Instructions
        ↓
Agent Instructions
        ↓
Dynamic Instructions
        ↓
Task Input
```

Dynamic instructions cannot bypass:

* security policies
* authorization
* validation
* data protection
* tool restrictions
* system constraints

---

# 15. MODEL ROUTER

Model selection must be real.

For every execution record:

```text
task
candidate_models
selected_model
reason
quality_requirement
latency_requirement
cost_requirement
fallback_model
execution_status
```

The router should consider:

* task type
* quality requirement
* reasoning requirement
* structured-output requirement
* latency
* cost
* model availability
* previous model performance
* failure rate

If the selected model fails:

```text
Primary Model
     ↓
Failure
     ↓
Fallback
     ↓
Validate
```

Never claim a model was used unless the execution actually occurred.

---

# 16. MODEL REGISTRY

Model registry data must be configuration-driven.

Store:

* provider
* model ID
* capabilities
* supported tasks
* context limits where known
* structured output support
* vision support where applicable
* availability
* enabled/disabled status

Do not invent benchmark numbers.

If benchmark data is unavailable, display:

```text
NOT_AVAILABLE
```

---

# 17. MODEL BENCHMARKS

Separate:

### External benchmark data

Published benchmark information.

### Internal platform benchmark

Performance measured by ZigmaNeural.

Never mix these.

Internal benchmark records should include:

```text
model
task
dataset/test
attempts
score
latency
token_usage
cost
timestamp
```

---

# 18. QUALITY CONTROL ENGINE

Quality control must be deterministic wherever possible.

Define measurable gates.

Examples:

```text
Evidence completeness
Result consistency
Schema validity
Required fields
Confidence threshold
Regression detection
Security constraints
Output validity
```

Example:

```text
Attempt 1 → 72
Attempt 2 → 84
Attempt 3 → 91
```

But these scores must be calculated.

Do not artificially increase scores.

Implement:

* minimum quality threshold
* maximum retry count
* regression detection
* best-attempt retention
* final acceptance criteria

If quality decreases:

```text
DO NOT accept the worse result automatically.
```

---

# 19. SECURITY OF THE AI AGENT

The model must NEVER be the final security authority.

Implement policy enforcement outside the model.

For every tool/action:

```text
User
 ↓
Authorization
 ↓
Policy Check
 ↓
Input Validation
 ↓
Tool Execution
 ↓
Output Validation
 ↓
Audit Log
```

Never:

```text
User
 ↓
LLM
 ↓
Tool
```

Protect against:

* prompt injection
* indirect prompt injection
* malicious website content
* malicious metadata
* malicious HTML
* hostile JSON
* data exfiltration
* unauthorized tool execution

Treat website content as untrusted data.

---

# 20. DATABASE INTEGRITY

Every important operation must be persisted.

At minimum maintain relationships between:

```text
User
Website
Scan
ScanModule
Finding
Evidence
AgentExecution
Instruction
ModelExecution
QualityAttempt
Report
MonitoringSnapshot
AuditLog
```

Use stable IDs.

Do not rely on frontend state as the source of truth.

Handle:

* transactions
* foreign keys
* unique constraints
* indexes
* timestamps
* soft deletion where appropriate
* concurrency

---

# 21. MULTI-TENANCY / AUTHORIZATION

If the application supports multiple organizations/workspaces:

Users must only access resources belonging to their authorized tenant/workspace.

Test:

```text
Tenant A → Website A
Tenant A → MUST NOT access Website B
Tenant B → Website B
Tenant B → MUST NOT access Website A
```

Check authorization on the backend.

Never rely only on frontend route protection.

---

# 22. API SECURITY

Audit every API endpoint.

For each endpoint validate:

* authentication
* authorization
* input schema
* output schema
* rate limiting
* error handling
* logging
* sensitive-data exposure

Do not expose:

* API keys
* provider secrets
* internal stack traces
* database credentials
* private infrastructure information

Use environment variables/secrets management.

---

# 23. ERROR HANDLING

Every external dependency must have controlled failure handling.

Test:

* DNS failure
* HTTP timeout
* TLS failure
* website unavailable
* malformed HTML
* oversized response
* API timeout
* model unavailable
* model rate limit
* database failure
* queue failure
* invalid JSON
* unexpected response
* worker crash

The application must return useful errors rather than crashing.

Never expose raw stack traces in production.

---

# 24. LOGGING

Implement structured logs.

Every important event should include where appropriate:

```text
timestamp
request_id
user_id
tenant_id
website_id
scan_id
agent_execution_id
model_execution_id
event
status
duration
error_code
```

Never log secrets.

Never log sensitive information unnecessarily.

---

# 25. AUDIT LOGGING

Record security-sensitive actions:

* login
* logout
* website added
* ownership verified
* scan started
* scan cancelled
* scan completed
* report generated
* configuration changed
* model configuration changed
* agent instruction changed
* permission changed
* user created
* user removed

Audit records should be tamper-resistant as far as the architecture permits.

---

# 26. FRONTEND DATA INTEGRITY

Every dashboard component must have:

### Loading state

Show actual loading state.

### Empty state

Explain that no data exists.

### Error state

Explain what failed and provide recovery.

### Partial state

Clearly show incomplete scan data.

### Success state

Show persisted results.

Do not show fake placeholder metrics when the backend has no data.

---

# 27. REAL-TIME / PROGRESS

If real-time progress is supported:

Use actual backend state through:

* WebSocket
* Server-Sent Events
* polling
* job-status API

Do not use:

```text
setInterval(() => progress += 10)
```

to simulate scan completion.

If the connection drops, the frontend must recover the current scan state from the backend.

---

# 28. REPORT GENERATION

Reports must be generated from persisted scan results.

Report structure should include:

```text
Executive Summary
Overall Score
Category Scores
Critical Findings
Evidence
Recommendations
Implementation Roadmap
Scan Metadata
Limitations
```

Include:

* scan timestamp
* website
* modules executed
* failed modules
* measured vs inferred information
* evidence references

Never generate a report containing findings that are not present in the database.

---

# 29. MONITORING

Monitoring must compare real historical snapshots.

Track:

```text
score
uptime
security
SEO
performance
AI visibility
SSL
```

When a change is detected:

```text
Previous
Current
Difference
Timestamp
Affected area
Evidence
```

Do not generate fake change logs.

---

# 30. ACCESSIBILITY

Audit the existing UI without redesigning it.

Check:

* keyboard navigation
* focus states
* semantic HTML
* ARIA labels
* form labels
* color contrast
* screen-reader usability
* chart accessibility
* modal accessibility
* responsive behavior

Fix genuine issues while preserving the current visual language.

---

# 31. RESPONSIVE TESTING

Validate:

* desktop
* laptop
* tablet
* mobile

Check every major screen:

* sidebar
* dashboard
* tables
* charts
* modals
* forms
* reports
* agent panels

No horizontal overflow.

No broken layouts.

No inaccessible controls.

---

# 32. PERFORMANCE OF THE APPLICATION ITSELF

Audit the ZigmaNeural application.

Check:

* unnecessary rerenders
* oversized bundles
* unnecessary API requests
* duplicate requests
* memory leaks
* abandoned subscriptions
* chart rendering
* image optimization
* lazy loading
* route loading
* caching

Do not optimize blindly.

Measure first where possible.

---

# 33. DATABASE / QUERY PERFORMANCE

Look for:

* N+1 queries
* missing indexes
* repeated queries
* unnecessary full-table scans
* unbounded queries
* missing pagination

Large datasets must not cause the dashboard to become unusable.

---

# 34. RATE LIMITING

Protect:

* authentication
* URL scanning
* scan creation
* report generation
* expensive AI calls
* public APIs
* ownership verification
* password/reset endpoints

Use appropriate per-user/IP/tenant limits.

Do not create limits that make legitimate use impossible.

---

# 35. COST CONTROL

AI/model execution must not become an uncontrolled cost source.

Track:

* model
* tokens
* execution count
* latency
* estimated cost where supported
* retries
* fallback usage

Implement safeguards:

* maximum retries
* maximum tokens where appropriate
* request timeouts
* concurrency limits
* per-scan execution limits

---

# 36. CONFIGURATION

Move production configuration into environment variables.

Audit for hardcoded:

* API keys
* secrets
* passwords
* database URLs
* provider credentials
* production URLs

Provide a safe `.env.example`.

Never commit secrets.

---

# 37. SECURITY HEADERS

Verify implementation of:

```text
Content-Security-Policy
Strict-Transport-Security
X-Frame-Options
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

Do not blindly copy an insecure CSP.

Ensure the CSP matches the actual application's required resources.

---

# 38. TEST SUITE

Create/repair automated tests.

At minimum:

### Unit tests

* URL validation
* scoring
* severity
* model routing
* instruction prioritization
* quality evaluation
* SSL calculations

### Integration tests

* add website
* ownership verification
* scan creation
* scan execution
* result persistence
* report generation

### API tests

Every critical endpoint.

### Security tests

* SSRF
* authorization bypass
* tenant isolation
* XSS
* injection
* rate limiting
* secret exposure

### Failure tests

* timeout
* API failure
* model failure
* database failure
* partial scan

### Frontend tests

Critical user workflows.

---

# 39. BUILD / LINT / TYPE CHECK

Run all available:

```text
npm run build
npm run lint
npm run typecheck
npm test
```

or the equivalent commands for the actual stack.

Do not assume the commands above exist.

First inspect `package.json`, project configuration, and available scripts.

Fix all:

* compile errors
* type errors
* lint errors
* failing tests
* runtime errors

---

# 40. PRODUCTION MODE VS DEVELOPMENT MODE

Clearly separate:

### Development

Can contain:

* mock data
* test websites
* development logging

### Production

Must contain:

* real scan results
* real persistence
* real authentication
* real authorization
* real model execution
* real monitoring
* real security controls

Never accidentally deploy development mocks to production.

---

# 41. NO UNNECESSARY TECHNOLOGY CHANGES

Do not replace the existing stack merely for preference.

Use the project's existing:

* framework
* database
* API architecture
* component system
* charting system
* authentication
* job system

Only introduce a dependency when it solves a real production requirement.

Prefer mature open-source components where appropriate.

Do not introduce paid SaaS dependencies when an existing open-source implementation can reliably satisfy the requirement.

However:

**Do not assume open source automatically means production-ready.**

Evaluate security, maintenance, compatibility, and reliability before using a dependency.

---

# 42. DATA PROVENANCE

Every important intelligence result should be traceable.

For each finding:

```text
Source
Evidence
Measurement
Processing
Model/Rule
Timestamp
Confidence
```

The user should be able to understand:

**"Why did the platform give me this result?"**

---

# 43. SCORING ENGINE

Audit all scoring logic.

Scores must be:

* deterministic where appropriate
* explainable
* reproducible
* evidence-backed

Do not let an LLM arbitrarily decide:

```text
SEO = 87
Security = 91
Overall = 89
```

without a defined scoring methodology.

Implement explicit scoring rules.

For AI-derived scoring:

* store the inputs
* store the model result
* validate the result
* apply deterministic boundaries

---

# 44. SECURITY BOUNDARY FOR SCANNED WEBSITES

This is extremely important.

The target website is untrusted.

The scanner must assume the target can contain:

* malicious HTML
* malicious JavaScript
* prompt injection
* huge responses
* infinite redirects
* malicious headers
* malformed content
* embedded payloads

Do not allow scanned website content to directly control:

* system prompts
* shell commands
* database queries
* filesystem operations
* privileged APIs
* model tool calls

Sanitize and isolate accordingly.

---

# 45. OX ALPHA SAFETY

OX Alpha can decide:

* whether more analysis is needed
* which instruction is useful
* which model is appropriate
* whether quality improved
* whether to retry

OX Alpha CANNOT override:

* authentication
* authorization
* security policies
* SSRF protections
* rate limits
* tool allowlists
* data access restrictions
* system-level safety rules

Architecture must enforce this independently of the model.

---

# 46. OBSERVABILITY

Provide enough information to answer:

```text
What happened?
When did it happen?
Who initiated it?
Which website?
Which scan?
Which agent?
Which model?
Which instruction?
How long did it take?
Did it fail?
Why did it fail?
What was retried?
What was the final result?
```

This should be traceable through IDs.

---

# 47. FINAL ACCEPTANCE TEST

Do not consider the work complete until this scenario succeeds:

### Scenario

1. Create a new user.
2. Authenticate.
3. Add a real publicly accessible website.
4. Validate the URL.
5. Complete ownership flow if required.
6. Select scan modules.
7. Launch scan.
8. Observe actual scan progress.
9. Execute each selected scanner.
10. Persist results.
11. Generate evidence.
12. Calculate category scores.
13. Send appropriate analysis to OX Alpha.
14. OX Alpha determines whether further instruction is needed.
15. Model Router selects a model.
16. Model executes.
17. Quality Control evaluates the result.
18. Retry only if necessary.
19. Persist all attempts.
20. Produce final results.
21. Generate report.
22. Display report in frontend.
23. Create monitoring baseline.
24. Run a second scan.
25. Detect actual changes.
26. Display change history.
27. Verify audit logs.
28. Verify authorization.
29. Verify tenant isolation.
30. Verify no secrets are exposed.
31. Verify failure recovery.
32. Verify refresh/re-login does not lose state.

---

# 48. NEGATIVE TESTING

Intentionally test:

```text
Invalid URL
Private IP
localhost
Metadata endpoint
Unreachable website
Expired SSL
Broken SSL
Slow website
Huge website
Website with malformed HTML
Website with malicious content
Model unavailable
Model timeout
Model rate limit
Database unavailable
Worker failure
Duplicate scan
Concurrent scan
Unauthorized API call
Cross-tenant access
Expired session
Invalid token
Malformed API payload
Missing required field
```

The application must fail safely.

---

# 49. DO NOT HIDE FAILURES

Never convert an error into:

```text
87%
A+
Completed
Healthy
Excellent
```

If something failed, show:

```text
FAILED
PARTIAL
NOT_MEASURED
UNAVAILABLE
```

with a useful explanation.

Accuracy is more important than attractive numbers.

---

# 50. FINAL CODEBASE CLEANUP

After implementation:

Remove:

* dead code
* unused imports
* unused components
* duplicate utilities
* obsolete mock data
* debug statements
* console logs that should not exist in production
* commented-out abandoned implementations
* hardcoded secrets
* temporary test endpoints

Keep the code modular.

---

# 51. DOCUMENTATION

Create/update concise technical documentation covering:

```text
Architecture
Environment Variables
Database
API
Scan Pipeline
OX Alpha
Model Router
Quality Control
Security
Authentication
Authorization
Monitoring
Testing
Deployment
Failure Recovery
```

Document actual implementation, not planned features.

---

# 52. FINAL OUTPUT

After completing the audit and fixes, provide a concise implementation report:

## A. Files inspected

List all relevant files.

## B. Problems found

Group by:

* Functional
* Backend
* Frontend
* Security
* Data
* AI/Agent
* Performance
* Reliability
* Testing

## C. Problems fixed

Give exact fixes.

## D. Remaining issues

Do not hide anything.

Clearly mark:

```text
BLOCKING
HIGH
MEDIUM
LOW
```

## E. Test results

Report:

```text
Build: PASS/FAIL
Lint: PASS/FAIL
Type Check: PASS/FAIL
Unit Tests: PASS/FAIL
Integration Tests: PASS/FAIL
Security Tests: PASS/FAIL
E2E Tests: PASS/FAIL
```

## F. Production readiness

Give one of:

```text
READY
READY WITH WARNINGS
NOT READY
```

Do not claim READY if critical functionality is mocked, disconnected, insecure, or untested.

---

# ABSOLUTE RULES

1. Do not redesign the existing UI unnecessarily.
2. Do not remove working functionality.
3. Do not replace the architecture without justification.
4. Do not use fake production data.
5. Do not hardcode intelligence scores.
6. Do not invent benchmark results.
7. Do not claim a scan ran when it did not.
8. Do not claim a model executed when it did not.
9. Do not claim SSL/security status without evidence.
10. Do not hide failures.
11. Do not expose secrets.
12. Do not trust scanned website content.
13. Do not let the LLM become the security authority.
14. Do not allow OX Alpha to bypass security controls.
15. Do not allow infinite retries.
16. Do not introduce unnecessary paid services.
17. Prefer reliable open-source components where appropriate.
18. Preserve existing UI/UX unless fixing a real issue.
19. Fix root causes rather than hiding symptoms.
20. Run tests after changes.
21. Re-run the complete validation after fixes.
22. Production correctness is more important than demo appearance.

---

# DEFINITION OF DONE

The project is DONE only when:

**A real user can submit a real website and receive a real, evidence-backed, reproducible Website Intelligence assessment through a secure end-to-end pipeline, with OX Alpha making controlled intelligence decisions, real model routing, deterministic quality control, persistent results, reliable reporting, monitoring, auditability, and safe failure handling.**

The current 29-file implementation is the starting point.

Do not assume it is production-ready merely because it builds.

Audit it.
Trace it.
Test it.
Break it.
Fix it.
Test it again.
Then report the actual state.
