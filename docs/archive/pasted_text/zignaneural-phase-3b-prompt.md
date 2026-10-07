# ZigmaNeural — Phase 3B Master Implementation Prompt

## CURRENT STATE

Phase 3A is COMPLETE.

Verified:

- 118 tests passed
- 0 failed
- 5 skipped
- 97 Phase 2 tests preserved
- 21 new Phase 3A tests
- Production build passes

Phase 3A implemented:

- ModelProvider interface
- ProviderError with retryable flag
- OpenRouter provider
- OX Alpha executor
- retries
- exponential backoff
- timeout handling
- fallback models
- JSON validation
- DB audit records
- execution/correlation/provider/token tracking
- graceful degradation when OPENROUTER_API_KEY is absent

Current configuration includes:

OPENROUTER_API_KEY
OX_ALPHA_MODEL
OX_ALPHA_TIMEOUT_MS
OX_ALPHA_MAX_RETRIES
OX_ALPHA_MAX_OUTPUT_TOKENS

IMPORTANT:

Do not destabilize Phase 3A.

The existing 118 passing tests are a protected baseline.

Do not rewrite the OX Alpha executor unless absolutely required.

==================================================
PHASE 3B OBJECTIVE
==================================================

Build the ZigmaNeural Model Registry and OpenRouter Model Intelligence layer.

The registry must become the source of truth for:

- available models
- model capabilities
- model eligibility
- model status
- free/paid classification
- task suitability
- benchmark results
- reliability
- latency
- structured-output capability
- fallback priority

The architecture must NOT permanently depend on a hard-coded model list.

==================================================
CRITICAL ARCHITECTURAL PRINCIPLE
==================================================

Separate these concepts:

OPENROUTER MODEL CATALOG

What OpenRouter currently exposes.

        ↓

ZIGMANEURAL MODEL REGISTRY

What ZigmaNeural has discovered, evaluated and allows.

        ↓

MODEL ELIGIBILITY

Which models are currently permitted for a task.

        ↓

MODEL ROUTER

Which eligible model OX Alpha selects.

Therefore:

OpenRouter availability does NOT automatically mean:

"ZigmaNeural trusts this model."

A model must pass ZigmaNeural eligibility rules before being used.

==================================================
3B.1 — OPENROUTER MODEL CATALOG
==================================================

Implement a server-side OpenRouter model catalog integration.

Use the provider abstraction created in Phase 3A.

Do NOT put API credentials in frontend code.

The catalog should retrieve currently available model metadata from OpenRouter where supported.

Do not assume the catalog is static.

Support:

- refresh
- cache
- failure handling
- stale catalog detection
- last successful refresh
- manual refresh
- scheduled refresh architecture

If OpenRouter is unavailable:

Do not destroy the existing registry.

Keep the last known good catalog.

Display:

"Catalog temporarily unavailable"

rather than failing the entire application.

==================================================
3B.2 — MODEL RECORD
==================================================

Create a normalized ZigmaNeural model record.

At minimum:

model_id
provider
display_name
openrouter_id
description
context_length
pricing_information
free_status
architecture_information
input_modalities
output_modalities
tool_calling_support
structured_output_support
reasoning_capability
coding_capability
vision_capability
status
first_seen_at
last_seen_at
last_catalog_refresh
enabled
eligibility_status

Do not store secrets.

Do not blindly persist every field returned by an external provider.

Normalize only fields required by ZigmaNeural.

==================================================
3B.3 — FREE MODEL HANDLING
==================================================

The platform must support multiple free models.

Do NOT hard-code specific model names as permanent dependencies.

Free status must be represented as current metadata.

Possible states:

FREE
PAID
UNKNOWN
CHANGED

If a previously free model becomes paid:

mark the state appropriately.

Do not silently continue using a model if ZigmaNeural policy says only free models are allowed.

The registry must support:

"Free models only"

as a configurable policy.

==================================================
3B.4 — MODEL CAPABILITIES
==================================================

Normalize capabilities.

Examples:

Reasoning
Coding
SEO
Security
AEO/GEO
Accessibility
Performance
Structured JSON
Summarization
Long Context
Vision
Tool Calling

Do not assume OpenRouter metadata alone determines task quality.

Capability metadata is NOT benchmark quality.

For example:

A model may technically support coding but still perform poorly at coding.

Therefore distinguish:

CAPABILITY

from

PERFORMANCE.

==================================================
3B.5 — ZIGMANEURAL TASK SCORES
==================================================

Create a benchmark-score structure.

Each model can have scores for:

SEO
Security
AEO/GEO
Performance
Accessibility
Coding
Reasoning
Structured JSON
Evidence interpretation
Instruction following

Each score should include:

score
sample_size
benchmark_version
evaluated_at
evaluation_status

Do not fabricate benchmark scores.

Until actual benchmarking exists:

display:

"Not benchmarked"

rather than inventing values.

==================================================
3B.6 — MODEL RELIABILITY
==================================================

Track operational reliability separately from intelligence quality.

Metrics may include:

success rate
failure rate
timeout rate
rate-limit rate
average latency
p95 latency
malformed-output rate
successful structured-output rate

Do not confuse:

MODEL QUALITY

with

MODEL RELIABILITY.

A model can be intelligent but unreliable.

==================================================
3B.7 — MODEL STATUS
==================================================

Support statuses such as:

DISCOVERED
AVAILABLE
ELIGIBLE
DISABLED
UNAVAILABLE
STALE
DEPRECATED
REQUIRES_REVIEW

The system must never automatically treat:

DISCOVERED

as:

ELIGIBLE.

==================================================
3B.8 — MODEL ELIGIBILITY
==================================================

Create explicit eligibility rules.

A model can only become eligible if it satisfies required conditions.

Example:

Free-only policy
+
currently available
+
supported output format
+
minimum reliability
+
security policy
+
not manually disabled

→ ELIGIBLE

Do not allow the LLM itself to override eligibility.

Eligibility is deterministic application policy.

==================================================
3B.9 — MODEL PREFERENCES
==================================================

Allow administrators to configure:

- preferred models
- fallback models
- disabled models
- free-only mode
- minimum reliability
- minimum benchmark score
- maximum context requirement
- task-specific eligibility

Example:

SEO:

Preferred:
Model A

Fallback:
Model B
Model C

Security:

Preferred:
Model B

Fallback:
Model D

These are preferences.

OX Alpha still makes the final task-routing decision later.

==================================================
3B.10 — MODEL FALLBACK CHAIN
==================================================

Create a normalized fallback structure.

Example:

Primary:
Model A

Fallback 1:
Model B

Fallback 2:
Model C

Fallback 3:
Model D

Fallback decisions must respect eligibility.

If Model B becomes unavailable:

skip Model B.

Do NOT attempt to execute disabled/ineligible models.

==================================================
3B.11 — MODEL CATALOG REFRESH
==================================================

Implement safe refresh behavior.

Flow:

REQUEST REFRESH
      ↓
FETCH OPENROUTER CATALOG
      ↓
VALIDATE RESPONSE
      ↓
NORMALIZE MODELS
      ↓
UPSERT REGISTRY
      ↓
MARK MISSING/STALE MODELS
      ↓
UPDATE LAST REFRESH
      ↓
AUDIT EVENT

Never delete historical model information simply because it disappears from the current catalog.

Use status:

STALE

or:

UNAVAILABLE.

Preserve historical executions.

==================================================
3B.12 — MODEL HISTORY
==================================================

Track changes such as:

Model discovered
Model became unavailable
Model changed pricing
Model changed capabilities
Model enabled
Model disabled
Model benchmarked
Model score changed

This will become important for auditability.

==================================================
3B.13 — ADMIN API
==================================================

Create secure server-side APIs for:

GET model registry
GET model details
GET model capabilities
GET model benchmark scores
GET model reliability
GET model history
POST catalog refresh
POST enable model
POST disable model
POST update model policy
POST update fallback priority

Protect administrative operations with existing authentication/RBAC/tenant rules.

Do not allow normal users to modify global model policy unless explicitly authorized.

==================================================
3B.14 — MODEL REGISTRY UI
==================================================

Create:

AI Agents
→ Model Registry

The UI should show:

MODEL

PROVIDER

STATUS

FREE

REASONING

CODING

STRUCTURED OUTPUT

RELIABILITY

BENCHMARK

LAST SEEN

Example:

--------------------------------------------------

Model
Status
Free
Reasoning
Coding
JSON
Reliability
Benchmark

--------------------------------------------------

Do not show fake numerical scores.

Use:

Not benchmarked

when appropriate.

==================================================
3B.15 — MODEL DETAIL VIEW
==================================================

Clicking a model should show:

Overview

Capabilities

Availability

Free/Paid Status

ZigmaNeural Benchmark Results

Operational Reliability

Task Suitability

Fallback Position

Execution History

Model History

Eligibility

Administrative Controls

Example:

MODEL:

Example Model

Eligibility:

ELIGIBLE

Current status:

AVAILABLE

Free:

YES

Benchmark:

Not benchmarked

Reliability:

Insufficient data

Supported tasks:

Structured output
Reasoning
Coding

==================================================
3B.16 — MODEL CATALOG VS REGISTRY UI
==================================================

Clearly separate:

"OpenRouter Catalog"

from:

"ZigmaNeural Registry"

Catalog:

External availability.

Registry:

ZigmaNeural-approved models.

This distinction should be visible to administrators.

==================================================
3B.17 — API KEY ABSENCE
==================================================

Phase 3A intentionally degrades gracefully when:

OPENROUTER_API_KEY

is absent.

Preserve this behavior.

The application should still allow:

- registry viewing
- cached model data
- configuration
- UI exploration
- tests

But live catalog refresh should show:

Integration Required

when credentials are absent.

Never crash the application.

==================================================
3B.18 — RATE LIMITS
==================================================

OpenRouter/catalog requests must handle:

429
5xx
timeouts
connection failures
malformed responses

Use existing ProviderError semantics.

Do not duplicate retry logic unnecessarily if Phase 3A already provides it.

==================================================
3B.19 — DATABASE
==================================================

Add migrations for model registry data.

Design normalized tables conceptually:

models
model_capabilities
model_benchmarks
model_reliability
model_preferences
model_fallbacks
model_history
catalog_refreshes

Do not create unnecessary denormalized duplication.

Preserve historical model executions.

Existing:

agent_executions

must remain compatible.

==================================================
3B.20 — MULTI-TENANCY
==================================================

Determine carefully which model data is:

GLOBAL

versus:

TENANT-SPECIFIC.

Global:

OpenRouter catalog
global model metadata
global benchmark data

Tenant-specific:

tenant model enable/disable policy
tenant preferred models
tenant-specific routing preferences

Do not leak tenant configuration.

Apply existing tenancy protections.

==================================================
3B.21 — SECURITY
==================================================

Security requirements:

- API keys server-side only
- validate external model metadata
- protect admin APIs
- tenant isolation
- RBAC
- input validation
- output validation
- rate limiting
- audit logging
- safe error messages
- no secret leakage
- no provider credentials in logs
- no raw authorization headers in logs

Treat OpenRouter responses as external untrusted data.

==================================================
3B.22 — TESTING
==================================================

Add comprehensive tests.

At minimum:

Catalog:

- successful refresh
- empty catalog
- malformed response
- OpenRouter unavailable
- timeout
- rate limit
- stale catalog
- duplicate model
- changed model metadata

Registry:

- create model
- update model
- preserve history
- enable model
- disable model
- eligibility calculation
- free-only filtering
- unavailable model
- stale model

Capabilities:

- supported capability
- unsupported capability
- unknown capability

Benchmarks:

- no benchmark
- valid benchmark
- multiple benchmark versions
- benchmark history

Reliability:

- success rate
- failure rate
- timeout rate
- malformed-output rate

Fallback:

- primary available
- primary unavailable
- fallback available
- fallback disabled
- all models unavailable

Security:

- tenant isolation
- RBAC
- unauthorized registry update
- secret leakage checks

Regression:

ALL existing 118 tests must remain passing.

==================================================
3B.23 — NO MODEL ROUTER YET
==================================================

IMPORTANT:

Do not implement the full intelligent Model Router in Phase 3B.

Phase 3B should provide the registry foundation that the router will consume.

The future architecture is:

OpenRouter Catalog
        ↓
ZigmaNeural Registry
        ↓
Eligibility
        ↓
OX Alpha Model Router
        ↓
Selected Specialist Model

Do not mix routing logic into the registry unnecessarily.

==================================================
3B.24 — NO FAKE BENCHMARKING
==================================================

Do not assign scores such as:

SEO = 94
Security = 91
Coding = 96

unless actual benchmark tests generated those results.

If no benchmark has been executed:

show:

NOT BENCHMARKED

This is extremely important.

==================================================
3B.25 — OBSERVABILITY
==================================================

Record:

catalog refresh ID
correlation ID
refresh start
refresh end
model count
new models
updated models
stale models
errors
duration
status

Do not log:

API keys
authorization headers
sensitive credentials

==================================================
3B.26 — DOCUMENTATION
==================================================

Update:

ARCHITECTURE.md

Add:

Phase 3B final report.

Document:

- model catalog
- model registry
- model normalization
- capability system
- benchmark system
- reliability system
- eligibility
- fallback architecture
- global vs tenant data
- security
- APIs
- migrations
- tests
- known limitations

Clearly state:

Phase 3B does NOT yet implement intelligent OX Alpha model routing.

==================================================
3B.27 — ACCEPTANCE CRITERIA
==================================================

Phase 3B is complete only when:

[ ] OpenRouter catalog integration exists
[ ] Catalog refresh works
[ ] Catalog failure is graceful
[ ] Model registry exists
[ ] Model metadata normalized
[ ] Free/paid state supported
[ ] Capability system exists
[ ] Eligibility system exists
[ ] Benchmark structure exists
[ ] Reliability structure exists
[ ] Model history exists
[ ] Fallback configuration exists
[ ] Admin APIs exist
[ ] Registry UI exists
[ ] Model detail UI exists
[ ] Global/tenant separation is correct
[ ] Existing Phase 3A execution remains intact
[ ] Existing 118 tests remain passing
[ ] New Phase 3B tests pass
[ ] Production build passes
[ ] No fake benchmark values
[ ] No fake availability values
[ ] No secrets exposed
[ ] ARCHITECTURE.md updated

==================================================
FINAL ENGINEERING RULE
==================================================

Do not build a "list of models."

Build a MODEL INTELLIGENCE FOUNDATION.

The purpose of Phase 3B is to allow future OX Alpha routing to answer:

"What is the best currently eligible model for THIS specific task?"

The registry must therefore distinguish:

AVAILABLE
from
ELIGIBLE

CAPABILITY
from
QUALITY

QUALITY
from
RELIABILITY

FREE
from
APPROVED

PREFERRED
from
REQUIRED

The registry must be objective infrastructure.

OX Alpha will make intelligent routing decisions in Phase 3C.

==================================================
IMPLEMENTATION DISCIPLINE
==================================================

Start by inspecting the existing Phase 3A code.

Do not assume table names, API structures, or abstractions.

Reuse existing provider interfaces.

Do not duplicate retry/error handling.

Implement database migrations safely.

Implement backend functionality first.

Then APIs.

Then UI.

Then tests.

After every major change:

1. Run existing tests.
2. Run new tests.
3. Run build.
4. Inspect failures.
5. Fix root causes.
6. Update documentation.

Do not declare Phase 3B complete until the acceptance criteria are actually verified.

START WITH 3B.1 — OPENROUTER MODEL CATALOG AND THE NORMALIZED MODEL REGISTRY FOUNDATION.

Do not implement Phase 3C yet.