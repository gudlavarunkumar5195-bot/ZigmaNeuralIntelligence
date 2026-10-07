# ZigmaNeural Website Intelligence & AI Engineering Platform

## ROLE

You are building the production-oriented foundation and UI/UX for **ZigmaNeural Website Intelligence & AI Engineering Platform**.

This is NOT a collection of separate small tools.

Build **ONE unified enterprise-grade platform** that combines website intelligence, SEO, AI visibility, security, performance, accessibility, automated QA, SSL/HTTPS management, monitoring, AI-assisted remediation, reporting, and multi-agent intelligence.

The customer should experience one unified ZigmaNeural product.

The underlying open-source engines and models must remain replaceable components behind the ZigmaNeural architecture.

---

# 1. PRIMARY OBJECTIVE

Create a modern, premium, enterprise SaaS platform that allows a user to:

1. Add a website/domain.
2. Verify authorization/ownership where required.
3. Crawl and analyze the website.
4. Collect deterministic evidence using open-source engines.
5. Assign analysis tasks to specialist AI agents.
6. Use multiple free AI models through OpenRouter.
7. Use **OX Alpha as the master/orchestrator model**.
8. Allow OX Alpha to determine which specialist model is appropriate for each task.
9. Apply predefined instructions to each agent.
10. Allow OX Alpha to determine whether additional dynamic instructions are required.
11. Validate every important AI result against actual evidence.
12. Score the quality of results.
13. Automatically improve/regenerate insufficient results.
14. Detect workflow failures and realign the process.
15. Produce a verified final report.
16. Recommend fixes.
17. Optionally generate remediation patches.
18. Test fixes before acceptance.
19. Monitor the website continuously.
20. Manage HTTPS/SSL through ACME/Let's Encrypt where authorized.
21. Generate professional ZigmaNeural-branded reports.

The goal is NOT merely to generate AI text.

The goal is:

**Evidence → Analysis → Verification → Quality Scoring → Improvement → Final Verified Intelligence.**

---

# 2. PRODUCT POSITIONING

Product name:

**ZigmaNeural Website Intelligence**

Subtitle:

**Audit. Understand. Improve. Monitor.**

Core positioning:

> An AI-powered website intelligence and engineering platform that analyzes SEO, AI visibility, security, performance, accessibility and technical health, verifies findings against real evidence, and provides actionable improvements.

Do NOT position it as a generic chatbot.

Do NOT make it look like a simple SEO checker.

It must feel like an enterprise engineering intelligence platform.

---

# 3. CORE ARCHITECTURE

Use the following conceptual architecture:

```text
                         USER
                           |
                           v
                ZIGMANEURAL PLATFORM
                           |
                           v
                  OX ALPHA MASTER AI
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
        PLAN          MODEL ROUTING     INSTRUCTION
                                           CONTROL
          |                |                |
          +----------------+----------------+
                           |
                           v
                 SPECIALIST MODEL POOL
                           |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
     SEO MODEL        SECURITY MODEL      AEO/GEO MODEL
        |                  |                  |
        v                  v                  v
    SEO ENGINE        SECURITY ENGINE      AI ANALYSIS
        |                  |                  |
        +------------------+------------------+
                           |
                           v
                       EVIDENCE
                           |
                           v
                  OX ALPHA VERIFICATION
                           |
                           v
                     QUALITY SCORING
                           |
              +------------+------------+
              |                         |
              v                         v
           ACCEPT                    FAIL
                                        |
                                        v
                              FAILURE DIAGNOSIS
                                        |
                       +----------------+----------------+
                       |                |                |
                       v                v                v
                  New Model       New Instruction   More Evidence
                       |                |                |
                       +----------------+----------------+
                                        |
                                        v
                                   REGENERATE
                                        |
                                        v
                                   RE-VERIFY
                                        |
                                        v
                                  FINAL ACCEPTANCE
```

---

# 4. OX ALPHA — MASTER MODEL

OX Alpha is the central intelligence and orchestration model.

Do NOT treat OX Alpha as just another agent.

OX Alpha must conceptually control:

* task planning
* task decomposition
* agent assignment
* specialist model selection
* instruction selection
* dynamic instruction creation
* evidence requirements
* result verification
* contradiction detection
* completeness checking
* quality scoring
* regeneration decisions
* workflow correction
* final synthesis
* final quality approval

OX Alpha must NOT be treated as the authoritative source of infrastructure/security state.

Deterministic systems must establish factual state.

For example:

* HTTP status comes from HTTP tooling.
* TLS state comes from TLS tooling.
* SSL certificate state comes from certificate/ACME systems.
* Browser behavior comes from browser automation.
* Performance measurements come from performance tooling.
* Accessibility findings come from accessibility tooling.
* Database state comes from the database.
* Authentication and authorization come from deterministic controls.

OX Alpha interprets evidence rather than inventing it.

---

# 5. MULTI-MODEL ARCHITECTURE

Do NOT use one AI model for every task.

Do NOT hard-code one model permanently to one agent.

Use a **Model Registry + Intelligent Model Router**.

OpenRouter should act as the model access/gateway layer.

Use multiple free models where available.

OX Alpha chooses the appropriate model based on:

* task type
* task complexity
* reasoning requirement
* coding requirement
* structured-output requirement
* context requirements
* latency
* reliability
* historical performance
* current availability
* rate limits
* model benchmark score

OX Alpha remains the master model.

Supporting free models are workers.

---

# 6. MODEL REGISTRY

Create a model registry interface and backend concept.

Each model record should contain:

* model name
* provider
* OpenRouter model ID
* free/paid status
* context length
* reasoning capability
* coding capability
* vision capability
* tool-calling capability
* structured-output capability
* average latency
* reliability score
* task-specific scores
* current availability
* rate-limit information
* last benchmark date
* enabled/disabled status

Never assume a free model will remain available forever.

The architecture must allow models to be added, removed, replaced or re-ranked without redesigning the application.

---

# 7. MODEL BENCHMARKING

Create a model evaluation system.

Test available free models against standardized ZigmaNeural benchmark tasks.

Benchmark categories:

* SEO
* AEO
* GEO
* security reasoning
* accessibility
* performance analysis
* coding
* structured JSON generation
* reasoning
* summarization
* recommendation quality
* evidence interpretation

Store benchmark results.

Example:

```text
Model
SEO              94
Security         88
AEO              92
Coding           96
JSON             98
Reasoning        90
Reliability      95
Speed            91
```

OX Alpha should use benchmark results when selecting supporting models.

Do not select a model simply because it is free.

Select the best available free model for the specific task.

---

# 8. SPECIALIST AGENTS

Create the following specialist agents.

## 8.1 Discovery Agent

Responsibilities:

* crawl website
* discover pages
* discover links
* discover forms
* identify assets
* identify scripts
* identify APIs where authorized
* inspect robots.txt
* inspect sitemap.xml
* detect technologies
* create website structure

Output structured evidence.

---

## 8.2 SEO Agent

Analyze:

* title tags
* meta descriptions
* headings
* canonical URLs
* robots directives
* sitemap
* robots.txt
* internal links
* broken links
* duplicate metadata
* structured data
* indexability
* content structure
* technical SEO
* search intent
* keyword opportunities

Every finding must contain evidence.

Never invent affected URLs.

---

## 8.3 AI Visibility Agent

Analyze:

* AEO
* GEO
* GSO
* AI-search readiness
* entity recognition
* answerability
* FAQ opportunities
* citation readiness
* semantic structure
* structured information
* AI-readable content
* brand visibility
* content gaps

Do not claim actual AI-search visibility unless supported by real data.

Clearly distinguish:

* measured visibility
* inferred opportunity
* recommendation

---

## 8.4 Security Agent

Analyze authorized websites for:

* HTTPS
* TLS
* security headers
* cookies
* CORS
* exposed information
* common web security configuration issues
* dependency/security indicators
* configuration weaknesses

Use deterministic security scanners wherever possible.

Do not perform destructive testing.

Do not bypass authentication or authorization.

Do not perform unauthorized exploitation.

Every finding must be evidence-backed.

---

## 8.5 Performance Agent

Analyze:

* Core Web Vitals
* loading performance
* JavaScript
* CSS
* images
* caching
* compression
* render blocking
* network requests
* page weight

Use measured performance data.

---

## 8.6 Accessibility Agent

Analyze WCAG-oriented issues including:

* semantic HTML
* accessible names
* keyboard accessibility
* labels
* forms
* contrast
* ARIA
* alternative text
* navigation

Use deterministic accessibility tooling where possible.

---

## 8.7 QA Agent

Use browser automation such as Playwright-based open-source tooling where appropriate.

Test:

* navigation
* links
* forms
* buttons
* workflows
* page rendering
* browser compatibility
* regression
* visual changes

Every test must have a reproducible result.

---

## 8.8 SSL/Infrastructure Agent

Use deterministic ACME/Let's Encrypt systems.

Responsibilities:

* inspect HTTPS
* inspect certificate
* inspect expiration
* verify certificate chain
* verify TLS
* verify renewal
* manage authorized certificate operations

AI can explain infrastructure state.

AI must NOT fabricate certificate state.

---

## 8.9 Remediation/Coding Agent

Responsibilities:

* generate proposed fixes
* create patches
* modify authorized project files
* generate configuration changes
* generate SEO fixes
* generate accessibility fixes
* generate performance fixes

Every generated fix must go through testing and verification.

Do not automatically deploy production changes without explicit authorization.

---

# 9. INSTRUCTION INTELLIGENCE SYSTEM

Create a dedicated instruction system.

There must be three instruction layers.

## Layer 1 — Permanent System Instructions

Examples:

* never invent evidence
* never claim success without verification
* respect authorization
* do not bypass controls
* use actual tool evidence
* return structured output
* maintain auditability
* protect sensitive information

These cannot be overridden by an agent.

---

## Layer 2 — Agent Instructions

Each specialist receives predefined instructions.

Example:

```text
SEO Agent:

Analyze technical SEO using crawler evidence.

Every finding must identify the affected URL.

Do not infer missing metadata without inspecting HTML.

Do not report unsupported findings.
```

---

## Layer 3 — Dynamic Instructions

OX Alpha may determine that additional instructions are required.

Example:

```text
Initial instruction:
Analyze canonical tags.

Observed problem:
Model reported incorrect affected-page counts.

OX Alpha decision:
Additional verification instruction required.

Dynamic instruction:
"Verify canonical status directly against raw HTML for
every affected URL before producing the final finding."
```

Dynamic instructions must be:

* versioned
* logged
* associated with the task
* associated with the agent
* associated with the reason for creation
* evaluated for effectiveness

---

# 10. OX ALPHA INSTRUCTION DECISION

OX Alpha must explicitly determine:

```text
Are existing instructions sufficient?
YES → continue

NO → create additional instruction
```

Do not create dynamic instructions unnecessarily.

Every dynamic instruction must have:

* reason
* expected improvement
* source failure
* instruction text
* version
* affected agent
* affected task

---

# 11. EVIDENCE-FIRST ARCHITECTURE

Every major finding must have an evidence chain.

Use:

```text
Finding
  |
  +-- Source tool
  +-- Source URL
  +-- Raw evidence
  +-- Timestamp
  +-- Agent
  +-- Model
  +-- Instruction version
  +-- Verification status
  +-- Confidence
  +-- Quality score
```

No evidence:

**Do not promote the finding to a confirmed issue.**

---

# 12. QUALITY CONTROL LOOP

Every important AI result must pass through a quality gate.

Process:

```text
GENERATE
   ↓
VERIFY
   ↓
SCORE
   ↓
PASS?
   ├── YES → ACCEPT
   │
   └── NO
         ↓
   DIAGNOSE FAILURE
         ↓
   Determine action:
      - improve prompt
      - add instruction
      - change model
      - gather more evidence
      - split task
      - rerun engine
      - regenerate
         ↓
      REGENERATE
         ↓
      VERIFY
         ↓
      SCORE AGAIN
```

---

# 13. QUALITY SCORE

Use a multidimensional score.

Initial model:

```text
Accuracy                 25%
Evidence                 20%
Completeness             15%
Technical Correctness    15%
Relevance                10%
Actionability            10%
Consistency               5%
```

Calculate a score from 0–100.

Suggested quality gates:

```text
95–100 = Excellent
90–94  = Accept
80–89  = Improve
70–79  = Regenerate
<70    = Major failure / strategy change
```

Make thresholds configurable.

Do not allow OX Alpha to simply assign a high score without evidence.

Where possible, calculate scores using deterministic checks.

---

# 14. CROSS-MODEL VERIFICATION

For high-impact or uncertain findings, allow multiple supporting models to independently analyze the evidence.

Example:

```text
Security Finding

Model A → Finding
Model B → Finding
Model C → Finding

             ↓

          OX Alpha

             ↓

Evidence verification

             ↓

Confirmed / Rejected / Needs more evidence
```

Use cross-model verification when OX Alpha determines that:

* risk is high
* models disagree
* confidence is low
* evidence is ambiguous
* the finding could materially affect the customer

---

# 15. REGENERATION SYSTEM

Do not regenerate endlessly.

Create configurable limits.

Example:

```text
Maximum attempts = 5
```

If the score remains below the threshold:

```text
Attempt 1 → 71
Attempt 2 → 79
Attempt 3 → 84
Attempt 4 → 87
Attempt 5 → 88
```

Then OX Alpha must diagnose the underlying problem.

Possible outcomes:

* change model
* change strategy
* gather additional evidence
* split task
* mark low confidence
* request human review

Never create an infinite AI loop.

---

# 16. PROCESS MONITORING

OX Alpha must supervise the process itself.

It must detect:

* missing stages
* incomplete agents
* failed tools
* missing evidence
* contradictory outputs
* incorrect model selection
* instruction problems
* repeated failures
* incomplete reports
* unexpected workflow behavior

Example:

```text
Website Scan

✓ Discovery
✓ SEO
✓ Security
✓ Performance
✗ AEO
✓ Accessibility
```

OX Alpha must not finalize the report.

It should identify:

```text
AEO analysis incomplete.

Required action:
Retry AEO analysis.
```

---

# 17. WORKFLOW STATE MACHINE

Implement these conceptual states:

```text
CREATED
PLANNED
AUTHORIZATION_CHECK
CRAWLING
EVIDENCE_COLLECTION
ANALYSIS
VERIFICATION
QUALITY_CHECK
IMPROVEMENT
REANALYSIS
SYNTHESIS
FINAL_VALIDATION
COMPLETED
FAILED
HUMAN_REVIEW
```

Never allow the system to mark a task completed simply because an AI model says "done."

The backend/workflow state must confirm completion.

---

# 18. REPORT VALIDATION

Before publishing any final report, OX Alpha must audit the report.

Check:

* accuracy
* completeness
* evidence
* consistency
* duplicate findings
* severity
* prioritization
* technical correctness
* recommendations
* unsupported claims
* missing sections
* contradictory findings

Then calculate:

**Final Report Quality Score**

The report should only be finalized after the quality gate passes.

---

# 19. FINDING DATA MODEL

Every finding should conceptually include:

```text
finding_id
website_id
task_id
category
severity
title
description
affected_urls
evidence
source_tool
source_timestamp
agent
model
model_version
instruction_version
confidence
quality_score
verification_status
retry_count
status
created_at
updated_at
```

---

# 20. INSTRUCTION HISTORY

Store:

```text
instruction_id
agent
task
version
instruction
reason
created_by
created_at
result_before
result_after
score_before
score_after
effectiveness
```

This creates an auditable instruction improvement history.

---

# 21. MODEL EXECUTION HISTORY

Store:

```text
execution_id
task_id
agent
model
provider
prompt_version
instruction_version
input_reference
output_reference
latency
tokens
status
quality_score
retry_count
error
created_at
```

Never store unnecessary sensitive data.

---

# 22. OPEN-SOURCE ENGINE LAYER

The application must use open-source engines where suitable.

Potential categories:

* website crawling
* browser automation
* SEO analysis
* accessibility analysis
* performance analysis
* security analysis
* TLS inspection
* DNS inspection
* structured-data parsing
* monitoring
* observability
* evaluation

Do NOT blindly copy or rebrand an open-source project.

For every external engine:

1. Check license.
2. Check commercial-use rights.
3. Check modification requirements.
4. Check attribution/NOTICE requirements.
5. Check dependencies.
6. Check security history.
7. Check maintenance activity.
8. Isolate the engine behind an adapter.
9. Preserve compliance with its license.
10. Keep ZigmaNeural proprietary logic separate where appropriate.

The underlying engine must be replaceable.

---

# 23. LET'S ENCRYPT / ACME

Integrate SSL/HTTPS capabilities into:

**Infrastructure → SSL**

Display:

```text
HTTPS                  ✓
Certificate            ✓
Issuer                 Let's Encrypt
Expiration             71 days
Auto Renewal            ✓
TLS Configuration      Strong
Certificate Chain       Valid
```

For authorized domains provide:

* certificate status
* expiry monitoring
* renewal status
* ACME validation
* renewal notifications
* configuration assistance

Certificate issuance and infrastructure changes must use deterministic ACME tooling.

Do not allow an LLM to invent infrastructure state.

---

# 24. DASHBOARD

Create an enterprise-grade dashboard.

Main overview:

```text
ZigmaNeural Website Intelligence

Website:
example.com

Overall Score
87 / 100

SEO                 91
AI Visibility        76
Security             94
Performance          82
Accessibility        89
Technical Health     86
SSL                 100
QA                   88
```

Show:

* issues found
* critical issues
* improvements
* scan history
* AI visibility
* performance
* security
* SSL
* recommendations
* monitoring status

---

# 25. AI CONTROL CENTER

Create:

**AI Agents → Control Center**

Display:

```text
MASTER MODEL

OX Alpha
● Online
Role: Master Orchestrator

ACTIVE AGENTS

SEO                  ● Complete
Security             ● Complete
AI Visibility        ● Running
Performance          ● Complete
Accessibility        ● Complete
QA                   ● Running
SSL                  ● Complete
Synthesis            ● Waiting
```

---

# 26. MODEL ROUTING UI

Create:

**AI Agents → Model Router**

Display:

```text
TASK                 SELECTED MODEL       SCORE

SEO Analysis         Free Model A         94
Security             Free Model B         92
AEO/GEO              OX Alpha / Model C  95
Coding               Free Model B         96
Structured JSON      Free Model D         98
```

Show:

* current model
* fallback models
* benchmark score
* availability
* reason selected

---

# 27. QUALITY CONTROL UI

Create:

**AI Agents → Quality Control**

Example:

```text
Task:
SEO Analysis

Attempt 1
Model: Free Model A
Score: 71
Status: REJECTED

Reason:
Incorrect affected-page count

Attempt 2
Model: Free Model C
Score: 86
Status: IMPROVE

Additional Instruction:
Verify canonical tags directly against raw HTML.

Attempt 3
Model: Free Model C
Score: 95
Status: ACCEPTED
```

Show the complete improvement history.

---

# 28. EVIDENCE VIEWER

Every finding should have:

**View Evidence**

Display:

* URL
* source tool
* raw evidence
* screenshot where appropriate
* timestamp
* agent
* model
* confidence
* verification result

This is critical for enterprise trust.

---

# 29. REPORT

Create a premium report interface.

Sections:

1. Executive Summary
2. Overall Score
3. SEO
4. AI Visibility
5. Security
6. Performance
7. Accessibility
8. Technical Health
9. SSL
10. QA
11. Critical Findings
12. Recommended Actions
13. Evidence
14. Improvement Opportunities
15. Implementation Roadmap

Provide:

**Export Report**

with ZigmaNeural branding.

---

# 30. FIX WORKFLOW

For fixable findings:

```text
Finding
 ↓
Generate Fix
 ↓
Review Proposed Change
 ↓
Apply in authorized environment
 ↓
Run Tests
 ↓
Run Security Checks
 ↓
Run SEO/Performance/Accessibility Checks
 ↓
Verify
 ↓
Accept
```

Never deploy automatically without explicit authorization.

---

# 31. MONITORING

Allow users to schedule recurring scans.

Track:

* overall score
* SEO score
* AI visibility
* security
* performance
* accessibility
* SSL
* broken links
* regressions
* new issues
* resolved issues

Show historical trends.

Example:

```text
Monday       72
Wednesday    78
Friday       86
```

Show what caused the changes.

---

# 32. SECURITY ARCHITECTURE

Implement enterprise security principles.

Use:

* authentication
* RBAC
* tenant isolation
* authorization checks
* secure sessions
* rate limiting
* input validation
* CSRF protection where applicable
* secure cookies
* security headers
* audit logging
* secrets management
* API protection
* least privilege
* tool permission boundaries
* SSRF protections
* safe URL handling
* scan authorization controls

Do not rely on an LLM as the security enforcement mechanism.

Use deterministic authorization and policy controls.

---

# 33. OBSERVABILITY

Create structured logs for:

* agent execution
* model execution
* tool execution
* workflow state
* retries
* failures
* dynamic instructions
* quality scores
* authorization
* security events
* certificate operations
* report generation

Include correlation IDs.

Make every scan traceable.

---

# 34. ERROR HANDLING

Never silently fail.

Display useful states:

```text
Running
Waiting
Retrying
Rate Limited
Model Unavailable
Tool Failed
Evidence Missing
Verification Failed
Quality Failed
Human Review Required
Completed
```

If a free model becomes unavailable, automatically use the configured fallback model.

---

# 35. Figma MAKE REQUIREMENTS

Build the complete product in **Figma Make**.

Prioritize:

* premium enterprise UI
* clean information architecture
* responsive design
* desktop-first dashboard
* mobile-friendly critical screens
* light theme
* professional blue/white ZigmaNeural visual language
* strong typography
* clear hierarchy
* accessible components
* meaningful empty states
* loading states
* error states
* progress states
* skeleton screens
* charts
* score cards
* evidence panels
* agent status
* model routing
* quality history
* report views

Do not create a generic template dashboard.

Create a distinctive ZigmaNeural product identity.

---

# 36. UX PRINCIPLE

The user should always understand:

**What is happening?**

**Why is it happening?**

**What evidence supports it?**

**Which AI model performed the task?**

**Was the result verified?**

**What was the quality score?**

**Was the result regenerated?**

**What should I do next?**

Never hide important system states.

---

# 37. MAIN NAVIGATION

Use:

```text
Overview

Websites
  My Websites
  Add Website
  Scan History

Intelligence
  SEO
  AI Visibility
  Security
  Performance
  Accessibility
  Technical Health

Testing
  Browser Tests
  Regression
  Test Results

Infrastructure
  SSL / HTTPS
  Certificates
  Domains

AI Agents
  Control Center
  Model Router
  Model Registry
  Model Benchmarks
  Instructions
  Quality Control

Reports
  Reports
  Client Reports

Monitoring
  Website Health
  Changes
  Alerts

Settings
  Workspace
  Team
  Security
  API
  Integrations
```

---

# 38. LANDING / NEW SCAN EXPERIENCE

Create a simple entry point:

```text
Analyze your website

[ https://example.com ]

[ Start Intelligence Scan ]
```

Then show:

```text
Authorization
     ↓
Discovery
     ↓
Evidence Collection
     ↓
AI Analysis
     ↓
Verification
     ↓
Quality Control
     ↓
Final Intelligence Report
```

---

# 39. REAL-TIME SCAN EXPERIENCE

Create a scan progress screen.

Example:

```text
Website Intelligence Scan

● Authorization
● Discovery
● SEO
● Security
● Performance
● Accessibility
● AI Visibility
● QA
● SSL
○ Verification
○ Quality Control
○ Final Report
```

Show live status without exposing unnecessary technical complexity.

---

# 40. NO FAKE DATA

During implementation:

* Clearly distinguish mock/demo data from real data.
* Do not claim integrations are functional unless implemented.
* Do not fake model execution.
* Do not fake scan results.
* Do not fake certificate issuance.
* Do not fake AI visibility results.
* Do not present placeholder values as production measurements.

If an integration is not yet connected, show:

**Integration Required**

rather than pretending it works.

---

# 41. BACKEND-READY DESIGN

Design the frontend so it can connect cleanly to:

* REST APIs
* database
* authentication
* OpenRouter
* model registry
* agent orchestration
* workflow engine
* open-source engines
* browser automation
* ACME/Let's Encrypt
* monitoring
* observability

Use clear API/service boundaries.

Do not tightly couple the UI to one AI provider.

---

# 42. DATA SEPARATION

Separate:

```text
USER DATA
WEBSITE DATA
SCAN DATA
EVIDENCE
AGENT EXECUTIONS
MODEL EXECUTIONS
INSTRUCTIONS
QUALITY SCORES
REPORTS
AUDIT LOGS
```

Use tenant isolation.

Never allow one customer's website data, reports, evidence or scans to leak into another tenant.

---

# 43. AI SAFETY AND TRUST

The system must:

* avoid hallucinated findings
* cite evidence internally
* verify important claims
* distinguish fact from inference
* distinguish measured result from recommendation
* preserve authorization boundaries
* protect secrets
* avoid exposing sensitive data
* avoid unsafe autonomous actions
* require approval for impactful changes

---

# 44. FINAL QUALITY PRINCIPLE

The platform must optimize for:

**QUALITY > SPEED**

But still monitor:

* latency
* token usage
* model availability
* retries
* cost
* reliability

Do not accept poor results merely because they are fast.

Do not repeatedly regenerate without a reason.

Every retry must have a diagnosis.

---

# 45. MASTER EXECUTION LOOP

Implement this conceptual loop:

```text
1. OX Alpha understands objective.
2. OX Alpha creates execution plan.
3. Authorization is verified.
4. Deterministic engines collect evidence.
5. OX Alpha selects specialist agents.
6. OX Alpha selects appropriate free models.
7. Predefined instructions are applied.
8. Specialist models analyze evidence.
9. Results are returned.
10. OX Alpha verifies results.
11. Deterministic checks validate factual claims.
12. OX Alpha identifies contradictions.
13. Quality score is calculated.
14. If quality passes → accept.
15. If quality fails → diagnose.
16. OX Alpha decides whether:
       - add instruction
       - change model
       - split task
       - gather more evidence
       - rerun engine
       - regenerate
17. Re-run.
18. Verify again.
19. Score again.
20. Continue until quality threshold is achieved or controlled retry limit is reached.
21. If unresolved → human review.
22. OX Alpha synthesizes final report.
23. Final report is independently quality checked.
24. Report is published.
25. Monitoring begins if enabled.
```

---

# 46. NON-NEGOTIABLE RULES

DO:

* use OX Alpha as master orchestrator
* use multiple free models
* use model benchmarking
* use model routing
* use specialist agents
* use open-source engines
* use deterministic evidence
* use predefined instructions
* allow controlled dynamic instructions
* verify results
* score results
* regenerate poor results
* detect workflow failures
* maintain audit trails
* use Let's Encrypt/ACME for authorized SSL operations
* maintain model fallbacks
* preserve tenant isolation
* design for production

DO NOT:

* use only one model
* blindly use one free model for every task
* trust AI output without evidence
* allow models to invent infrastructure state
* use AI as the authorization mechanism
* regenerate infinitely
* hide failed attempts
* fake integrations
* fake scan results
* automatically deploy dangerous changes
* bypass authentication
* perform unauthorized security testing
* copy/rebrand open-source projects without license review
* lock the architecture to a single model/provider
* make the product look like a generic chatbot
* build multiple disconnected standalone tools

---

# 47. FIRST IMPLEMENTATION PRIORITY

Build the Figma Make experience in this order:

### Stage 1

Design system + application shell.

### Stage 2

Website onboarding + scan workflow.

### Stage 3

Main intelligence dashboard.

### Stage 4

Individual intelligence views.

### Stage 5

AI Agent Control Center.

### Stage 6

Model Registry + Model Router.

### Stage 7

Instruction Intelligence.

### Stage 8

Quality Control + regeneration history.

### Stage 9

Evidence viewer.

### Stage 10

Reports.

### Stage 11

SSL/Infrastructure.

### Stage 12

Monitoring.

### Stage 13

Security/admin/settings.

Do not sacrifice architecture quality for visual polish.

---

# 48. ACCEPTANCE CRITERIA

The Figma Make implementation should demonstrate:

* unified ZigmaNeural product
* clear agent architecture
* OX Alpha master model
* multiple free model concept
* model routing
* model benchmarking
* predefined instructions
* dynamic instruction decision
* quality scoring
* regeneration loop
* evidence verification
* workflow monitoring
* report validation
* SSL/Let's Encrypt capability
* open-source engine abstraction
* enterprise security concepts
* auditability
* monitoring
* premium UI/UX

The finished experience must communicate:

> **ZigmaNeural does not simply ask AI for an answer. ZigmaNeural collects evidence, delegates work to appropriate models, verifies the work, measures quality, corrects failures, and only then produces intelligence.**

Build this as the foundation of the **ZigmaNeural Website Intelligence platform**.
