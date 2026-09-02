# ZigmaNeural — Phase 3H Master Implementation Prompt
# Adaptive Regeneration, Self-Improvement & Closed-Loop Verification

==================================================
CURRENT VERIFIED STATE
==================================================

Phases 3A–3G are COMPLETE.

Verified current state:

- Server tests: 241 passed, 5 skipped
- Frontend tests: 64 passed
- Server build: PASS
- Frontend production build: PASS

Existing architecture:

3A — OX Alpha execution
3B — Model registry/catalog
3C — Intelligent model routing
3D — Specialist agents
3E — Instruction intelligence
3F — Evidence intelligence
3G — Quality verification

The 241 passing server tests and 64 frontend tests are a
PROTECTED REGRESSION BASELINE.

Do not destabilize existing functionality.

==================================================
PHASE 3H OBJECTIVE
==================================================

Build the:

ZIGMANEURAL ADAPTIVE REGENERATION ENGINE.

The objective is to create a controlled closed-loop AI system:

                    TASK
                     |
                     v
                  OX ALPHA
                     |
                     v
              PLAN / ROUTE
                     |
                     v
             SPECIALIST AGENT
                     |
                     v
                   MODEL
                     |
                     v
                 RESULT
                     |
                     v
                 EVIDENCE
                     |
                     v
              QUALITY ENGINE
                     |
             +-------+-------+
             |               |
          ACCEPT          IMPROVE
                             |
                             v
                       OX ALPHA
                             |
              +--------------+--------------+
              |              |              |
         MORE EVIDENCE   NEW MODEL      NEW AGENT
              |              |              |
              +--------------+--------------+
                             |
                             v
                        REGENERATE
                             |
                             v
                         VERIFY AGAIN
                             |
                             v
                           DONE

The system must not blindly retry.

Every improvement cycle must have a reason.

==================================================
CORE PRINCIPLE
==================================================

NEVER:

if score < threshold:
    run same model again

Instead:

QUALITY RESULT
      ↓
DIAGNOSE FAILURE
      ↓
IDENTIFY ROOT CAUSE
      ↓
SELECT IMPROVEMENT STRATEGY
      ↓
OX ALPHA DECISION
      ↓
EXECUTE CONTROLLED IMPROVEMENT
      ↓
VERIFY AGAIN

==================================================
3H.1 — REGENERATION RUN
==================================================

Create a first-class RegenerationRun.

Minimum fields:

regeneration_run_id
tenant_id
task_id
parent_execution_id
current_execution_id
iteration_number
status
reason
strategy
created_at
completed_at

Statuses:

PLANNED
WAITING_FOR_EVIDENCE
REGENERATING
VERIFYING
ACCEPTED
REJECTED
BLOCKED
EXHAUSTED
FAILED
CANCELLED

==================================================
3H.2 — ITERATION MODEL
==================================================

Every attempt must remain immutable.

Example:

Attempt 1
Quality: 62
Decision: NEEDS_IMPROVEMENT

Attempt 2
Quality: 74
Decision: NEEDS_IMPROVEMENT

Attempt 3
Quality: 91
Decision: ACCEPT

Never overwrite Attempt 1 or Attempt 2.

Maintain complete lineage.

==================================================
3H.3 — IMPROVEMENT DIAGNOSIS
==================================================

Consume Phase 3G:

QualityAssessment
QualityDecision
ImprovementTargets
ReasonCodes

Create:

ImprovementDiagnosis

Minimum:

diagnosis_id
quality_assessment_id
root_causes
improvement_targets
recommended_actions
confidence
created_at

Possible root causes:

INSUFFICIENT_EVIDENCE
INSUFFICIENT_COVERAGE
WRONG_MODEL
WRONG_AGENT
INSUFFICIENT_INSTRUCTIONS
OUTPUT_SCHEMA_FAILURE
CONTRADICTION
LOW_REASONING_QUALITY
STALE_EVIDENCE
RESOURCE_SCOPE_PROBLEM
TASK_DEFINITION_PROBLEM
TOOL_FAILURE

==================================================
3H.4 — IMPROVEMENT STRATEGIES
==================================================

Supported strategies:

COLLECT_MORE_EVIDENCE

RETRY_SAME_AGENT_DIFFERENT_MODEL

RETRY_SAME_MODEL_IMPROVED_INSTRUCTIONS

RETRY_DIFFERENT_AGENT

RETRY_DIFFERENT_MODEL_AND_AGENT

RECOMPUTE_WITH_NEW_EVIDENCE

REQUEST_HUMAN_REVIEW

STOP

Do not create unnecessary strategy types.

==================================================
3H.5 — OX ALPHA SUPERVISOR
==================================================

OX Alpha is the supervisory decision-maker.

Input:

Task
+
Current Agent
+
Current Model
+
Instruction Plan
+
Evidence State
+
Quality Assessment
+
Improvement Diagnosis
+
History

OX Alpha decides:

1. Is another iteration necessary?
2. What is the likely cause of failure?
3. What needs to change?
4. Should more evidence be collected?
5. Should instructions change?
6. Should model change?
7. Should agent change?
8. Should workflow change?
9. Should the task stop?
10. Should human review be requested?

OX Alpha should NOT simply be told:

"Regenerate."

It must receive structured failure information.

==================================================
3H.6 — OX ALPHA LIMITATIONS
==================================================

OX Alpha MUST NOT override:

- tenant isolation
- RBAC
- SSRF protections
- tool permissions
- evidence integrity
- evidence ownership
- deterministic security blockers
- mandatory policy restrictions
- invalid evidence
- authorization boundaries

If deterministic verification says:

BLOCK

OX Alpha cannot convert it into:

ACCEPT

==================================================
3H.7 — STRATEGY SELECTION
==================================================

Use deterministic rules first.

Example:

If evidence missing:

COLLECT_MORE_EVIDENCE

If model capability insufficient:

CHANGE_MODEL

If agent capability insufficient:

CHANGE_AGENT

If instructions incomplete:

IMPROVE_INSTRUCTIONS

If result conflicts with evidence:

RECOMPUTE_WITH_NEW_EVIDENCE

If quality is low but evidence and instructions are adequate:

TRY_DIFFERENT_MODEL

If repeated failure:

ESCALATE

OX Alpha can refine the decision.

==================================================
3H.8 — MODEL CHANGE
==================================================

When changing models:

DO NOT hard-code Claude/GPT/Gemini/etc.

Use Phase 3C routing.

Requirements:

TaskRequirements
+
FailureDiagnosis

→

Router

→

Eligible candidates

→

Scored candidates

→

OX Alpha selection

The new model must satisfy hard constraints.

==================================================
3H.9 — MULTI-MODEL STRATEGY
==================================================

Do not always use one model.

Example:

Generation:

Model A

Verification:

Model B

Improvement:

Model C

Synthesis:

Model D

OX Alpha determines whether multiple models are actually useful.

Do not invoke multiple models unnecessarily.

==================================================
3H.10 — MODEL DIVERSITY
==================================================

When repeated attempts fail:

avoid blindly repeating the same model.

Example:

Attempt 1:
Model A

Attempt 2:
Model A + improved instructions

Attempt 3:
Model B

Attempt 4:
Model C + new evidence

This should be policy-driven.

==================================================
3H.11 — AGENT CHANGE
==================================================

If failure indicates wrong specialist:

OX Alpha may select another agent.

Example:

SEO Agent
    ↓
quality failure:
structured data interpretation insufficient
    ↓
AEO/Technical Analysis Agent
    ↓
new analysis

But the new agent must remain within task scope.

==================================================
3H.12 — INSTRUCTION IMPROVEMENT
==================================================

Integrate Phase 3E.

If failure is instruction-related:

create a new instruction plan version.

Never mutate historical instructions.

Example:

Plan v1
→ result incomplete

Plan v2
→ adds explicit coverage requirement

Plan v2 is used only for the next iteration.

==================================================
3H.13 — EVIDENCE IMPROVEMENT
==================================================

If evidence is insufficient:

create EvidenceRequests.

Flow:

QUALITY FAILURE
     ↓
EVIDENCE GAP
     ↓
EVIDENCE REQUEST
     ↓
COLLECT
     ↓
VALIDATE
     ↓
REGENERATE
     ↓
VERIFY

Do not regenerate using the same incomplete evidence.

==================================================
3H.14 — REGENERATION CONTEXT
==================================================

The next attempt should receive:

Original task
+
Original requirements
+
Relevant instruction plan
+
Relevant evidence
+
Quality assessment
+
Improvement targets
+
Previous result summary
+
Required changes

Do NOT blindly send the entire previous output if unnecessary.

Minimize context where possible.

==================================================
3H.15 — PREVIOUS RESULT HANDLING
==================================================

Previous output is untrusted content.

Do not allow it to modify:

system instructions
policy
security rules
tool permissions
tenant boundaries

Treat previous output as:

DATA.

==================================================
3H.16 — REGENERATION PROMPT
==================================================

The regeneration request must explicitly communicate:

WHAT FAILED

WHY IT FAILED

WHAT MUST CHANGE

WHAT MUST NOT CHANGE

WHAT EVIDENCE IS AVAILABLE

WHAT NEW EVIDENCE WAS COLLECTED

WHAT REQUIREMENTS REMAIN

The model should not have to infer all of this from raw logs.

==================================================
3H.17 — QUALITY IMPROVEMENT
==================================================

After every iteration:

run Phase 3G again.

Never accept a regenerated result without verification.

Flow:

Generate
→ Evidence
→ Quality
→ Decision

Repeat until:

ACCEPT

or:

BLOCK

or:

EXHAUSTED

or:

HUMAN_REVIEW

==================================================
3H.18 — QUALITY DELTA
==================================================

Track improvement between iterations.

Example:

Attempt 1: 61
Attempt 2: 72
Attempt 3: 73
Attempt 4: 72

The system should recognize:

QUALITY_PLATEAU

Do not continue endlessly.

==================================================
3H.19 — REGRESSION DETECTION
==================================================

A new attempt can become worse.

Example:

Attempt 1: 85
Attempt 2: 76

Flag:

QUALITY_REGRESSION

OX Alpha should decide whether to:

restore previous best
try another strategy
stop
escalate

Never automatically replace the best result with a worse result.

==================================================
3H.20 — BEST RESULT TRACKING
==================================================

Maintain:

best_execution_id
best_quality_assessment_id
best_score

But remember:

highest score does NOT override blockers.

A blocked result is never the "best acceptable result."

==================================================
3H.21 — STOP CONDITIONS
==================================================

Create explicit stop policies.

Stop when:

ACCEPT

BLOCK

maximum iterations reached

maximum execution time reached

maximum model calls reached

maximum cost budget reached

quality plateau detected

no eligible model exists

required evidence unavailable

human review required

Do not retry indefinitely.

==================================================
3H.22 — ITERATION LIMIT
==================================================

Create configurable:

max_iterations

Do not hard-code it.

Example default:

3

But allow policy configuration.

==================================================
3H.23 — MODEL CALL BUDGET
==================================================

Create configurable:

max_model_calls

The regeneration system must count:

generation calls
evaluation calls
OX Alpha calls
other model-assisted calls

Do not accidentally create infinite recursive model execution.

==================================================
3H.24 — TIME BUDGET
==================================================

Support:

max_execution_duration

If exceeded:

STOP / EXHAUSTED

Do not continue background model execution indefinitely.

==================================================
3H.25 — COST BUDGET
==================================================

If token/cost information is available:

track:

input tokens
output tokens
estimated cost
model calls

Allow:

max_cost_budget

If exceeded:

STOP or ESCALATE.

Do not invent cost data where provider does not supply it.

==================================================
3H.26 — RECURSION PROTECTION
==================================================

Prevent:

OX Alpha
→ regeneration
→ OX Alpha
→ regeneration
→ infinite loop

Every workflow must have:

root_execution_id
iteration_number
parent_execution_id

The maximum iteration/call policy must be enforced server-side.

==================================================
3H.27 — IDEMPOTENCY
==================================================

Regeneration requests must be idempotent where applicable.

Repeated API request should not accidentally start duplicate regeneration workflows.

Use:

idempotency keys

or existing execution identifiers.

==================================================
3H.28 — CONCURRENCY
==================================================

Prevent multiple regeneration workflows from competing for the same task unless explicitly allowed.

Example:

Task X

Regeneration workflow A running.

Request B attempts to regenerate.

Expected:

reject or attach to existing workflow.

Do not run duplicate expensive workflows accidentally.

==================================================
3H.29 — FAILURE HANDLING
==================================================

Classify failures:

MODEL_FAILURE
PROVIDER_FAILURE
ROUTING_FAILURE
AGENT_FAILURE
INSTRUCTION_FAILURE
EVIDENCE_FAILURE
QUALITY_FAILURE
SECURITY_BLOCK
TIMEOUT
BUDGET_EXCEEDED
NO_ELIGIBLE_MODEL
NO_ELIGIBLE_AGENT
INTEGRATION_REQUIRED

Never convert operational failure into:

LOW_QUALITY

unless it actually represents a quality failure.

==================================================
3H.30 — PARTIAL FAILURE
==================================================

If an improvement step partially succeeds:

preserve previous valid state.

Example:

new evidence collected
but new model execution fails.

Do not destroy:

previous evidence
previous accepted result
previous quality assessment.

==================================================
3H.31 — ACCEPTED RESULT PROTECTION
==================================================

Once a result is:

ACCEPTED

do not automatically replace it with a later result.

A later iteration must prove it is better and acceptable.

If later result fails:

retain the previous accepted result.

==================================================
3H.32 — HUMAN REVIEW
==================================================

Support:

HUMAN_REVIEW_REQUIRED

Use when:

- repeated disagreement
- high-risk security finding
- quality plateau
- no eligible strategy
- critical ambiguity
- policy requires human approval

Do not fabricate human approval.

==================================================
3H.33 — HUMAN REVIEW API
==================================================

Prepare secure endpoints:

POST /ai/regeneration/:id/review
GET /ai/regeneration/:id/review

Human actions:

APPROVE
REJECT
REQUEST_MORE_WORK

Record:

reviewer
timestamp
decision
reason

==================================================
3H.34 — REGENERATION HISTORY
==================================================

Create complete lineage.

Example:

Task
 |
 +-- Execution 1
 |    Model A
 |    Agent SEO
 |    Quality 64
 |
 +-- Execution 2
 |    Model A
 |    Agent SEO
 |    Quality 76
 |
 +-- Execution 3
 |    Model B
 |    Agent SEO
 |    Quality 91
 |
 +-- Accepted

The UI should make this understandable.

==================================================
3H.35 — REGENERATION DATABASE
==================================================

Create normalized tables where needed.

Potential:

regeneration_runs
regeneration_iterations
improvement_diagnoses
regeneration_decisions
regeneration_strategies
human_reviews

Reuse existing:

agent_executions
routing_decisions
instruction_plans
evidence
quality_assessments

Do not duplicate existing entities.

==================================================
3H.36 — OX ALPHA DECISION RECORD
==================================================

Every supervisory decision must be persisted.

Store:

decision_id
regeneration_run_id
quality_assessment_id
strategy
reason_codes
selected_agent
selected_model
requested_evidence
instruction_plan_version
decision_confidence
created_at

Do not store hidden chain-of-thought.

==================================================
3H.37 — OX ALPHA DECISION VALIDATION
==================================================

Before executing the decision:

validate:

selected agent is eligible
selected model is eligible
requested evidence is allowed
instruction plan is valid
tools are permitted
tenant scope is valid

If invalid:

reject decision.

Do not blindly trust OX Alpha output.

==================================================
3H.38 — DETERMINISTIC GUARDRAIL
==================================================

Architecture:

OX Alpha proposes.

Deterministic policy validates.

Only then:

execute.

Flow:

OX Alpha
   ↓
Proposed Action
   ↓
Policy Validator
   ↓
Allowed?
   |
   +-- NO → BLOCK
   |
   +-- YES → EXECUTE

==================================================
3H.39 — MULTI-AGENT IMPROVEMENT
==================================================

The system may use multiple specialist agents when appropriate.

Example:

SEO Agent
   ↓
Quality failure
   ↓
Technical Agent
   ↓
Evidence collection
   ↓
SEO Agent
   ↓
Quality verification

Do not invoke multiple agents simply because they are available.

OX Alpha must have a concrete reason.

==================================================
3H.40 — PARALLEL IMPROVEMENT
==================================================

If improvement tasks are independent:

they may execute in parallel.

Example:

Collect:

DNS evidence
TLS evidence
HTTP evidence

in parallel.

But dependent tasks must remain sequential.

Reuse Phase 3D workflow planning.

==================================================
3H.41 — EVIDENCE-FIRST STRATEGY
==================================================

If the failure is caused by insufficient evidence:

DO NOT regenerate first.

Collect evidence first.

Correct sequence:

Quality failure
→ evidence request
→ collection
→ validation
→ analysis
→ quality

==================================================
3H.42 — MODEL-FIRST STRATEGY
==================================================

If evidence is sufficient but reasoning quality is inadequate:

change model or agent.

Do not repeatedly collect the same evidence.

==================================================
3H.43 — INSTRUCTION-FIRST STRATEGY
==================================================

If the model followed an incomplete instruction profile:

update instructions.

Do not change the model unnecessarily.

==================================================
3H.44 — COMBINED STRATEGY
==================================================

For complex failures:

OX Alpha may select:

new evidence
+
new instructions
+
new model

But only when justified.

Avoid unnecessary complexity.

==================================================
3H.45 — QUALITY IMPROVEMENT TARGET TRACKING
==================================================

Track each target:

OPEN
IN_PROGRESS
RESOLVED
FAILED
WAIVED

A regeneration attempt should demonstrate whether targets were resolved.

Example:

Target:

EVIDENCE_INCOMPLETE

Attempt 2:

Evidence coverage 100%

Target:

RESOLVED

==================================================
3H.46 — NO FAKE IMPROVEMENT
==================================================

Never mark:

"resolved"

because the model says it fixed it.

Resolution must be verified through:

deterministic validation
or evidence
or quality assessment.

==================================================
3H.47 — QUALITY TARGET
==================================================

Do not require:

"100/100"

The goal is:

policy-compliant
evidence-grounded
requirement-complete
high-quality
safe

A score of 90 may be acceptable.

A score of 100 may still be blocked.

==================================================
3H.48 — RESULT COMPARISON
==================================================

Compare attempts using:

quality score
blocking issues
evidence completeness
coverage
requirements
security state

Do not compare only numerical scores.

==================================================
3H.49 — MODEL PERFORMANCE FEEDBACK
==================================================

Persist useful aggregate feedback.

Examples:

Model A:

SEO tasks
average score
failure rate
evidence grounding
latency
successful acceptance rate

Model B:

same metrics

This information can later improve Phase 3C routing.

Do not alter routing weights automatically in Phase 3H.

Only collect feedback.

==================================================
3H.50 — AGENT PERFORMANCE FEEDBACK
==================================================

Similarly track:

agent
task type
success rate
quality
failure categories
iteration count

This becomes future routing intelligence.

==================================================
3H.51 — INSTRUCTION PERFORMANCE FEEDBACK
==================================================

Track:

instruction plan version
agent
task type
quality
failure categories
iteration count

This can later help determine which instruction profiles work best.

==================================================
3H.52 — FEEDBACK LOOP
==================================================

Architecture:

Execution
 ↓
Quality
 ↓
Regeneration
 ↓
Outcome
 ↓
Feedback
 ↓
Future Routing

But:

DO NOT automatically modify routing policy based on small sample sizes.

Respect the existing reliability threshold logic from Phase 3C.

==================================================
3H.53 — FRONTEND
==================================================

Add:

AI Agents
→ Regeneration

Display:

Current status
Current iteration
Best score
Current score
Decision
Strategy
Improvement targets
Evidence changes
Model changes
Agent changes
Instruction changes
Iteration timeline

Example:

ITERATION 1

SEO Agent
Model A
Score 64
NEEDS IMPROVEMENT

Issue:
Evidence incomplete

↓

ITERATION 2

Additional evidence collected
SEO Agent
Model A
Score 78

↓

ITERATION 3

SEO Agent
Model B
Score 93
ACCEPTED

==================================================
3H.54 — NO FAKE UI
==================================================

Demo mode must show:

INTEGRATION REQUIRED

unless actual API data exists.

Never create:

fake iterations
fake scores
fake model changes
fake accepted results.

==================================================
3H.55 — API
==================================================

Create secure APIs consistent with existing architecture.

Conceptually:

POST /ai/regeneration
GET /ai/regeneration/:id
GET /ai/tasks/:id/regeneration
GET /ai/regeneration/:id/iterations
GET /ai/regeneration/:id/decisions
POST /ai/regeneration/:id/cancel

Human review endpoints as defined above.

All endpoints:

tenant scoped
RBAC protected
validated
audited

==================================================
3H.56 — SIMULATOR
==================================================

Create admin-only non-executing simulator.

Input:

task
agent result
quality assessment
improvement targets
available models
available agents
evidence state

Output:

recommended strategy
reason codes
candidate model
candidate agent
evidence requirements
instruction changes
stop decision

The simulator must NOT execute models/tools.

==================================================
3H.57 — SECURITY
==================================================

Regeneration must preserve all previous security boundaries.

Never allow regeneration to:

- bypass SSRF
- bypass RBAC
- bypass tenant isolation
- bypass tool permissions
- bypass evidence validation
- bypass instruction trust boundaries
- bypass policy blockers

A model change must not silently change permissions.

==================================================
3H.58 — PROMPT INJECTION
==================================================

Every regeneration input is potentially untrusted.

This includes:

previous model output
evidence
scanner output
website content
user-provided content
quality explanations

None may modify:

system policy
security policy
tool permissions
tenant scope

==================================================
3H.59 — OBSERVABILITY
==================================================

Record:

regeneration_run_id
iteration
task
agent
model
strategy
quality_before
quality_after
decision
reason_codes
duration
token usage where available
provider errors
failure type

Do not log secrets or hidden reasoning.

==================================================
3H.60 — TESTING
==================================================

Add comprehensive tests.

Basic:

- first generation accepted
- first generation rejected
- improvement required

Evidence strategy:

- missing evidence triggers evidence collection
- stale evidence triggers refresh
- evidence failure stops workflow

Model strategy:

- model change selected
- ineligible model rejected
- routing constraints preserved

Agent strategy:

- agent change selected
- ineligible agent rejected

Instruction strategy:

- instruction version changes
- previous version preserved

Quality:

- quality reruns after regeneration
- improvement target resolution
- quality regression detection
- best result tracking

Stopping:

- max iterations
- max model calls
- time budget
- cost budget
- plateau
- no eligible model
- blocked

Security:

- tenant isolation
- RBAC
- SSRF
- unauthorized tool
- prompt injection
- deterministic blocker cannot be overridden by OX Alpha

Concurrency:

- duplicate regeneration protection
- idempotency
- concurrent workflow handling

Failure:

- provider failure
- model timeout
- agent failure
- evidence failure
- routing failure

Human review:

- request review
- approve
- reject
- request more work

Regression:

ALL existing 241 server tests must continue passing.

ALL existing frontend tests must continue passing.

==================================================
3H.61 — INTEGRATION TEST
==================================================

Create at least one complete end-to-end test:

TASK
 ↓
OX ALPHA
 ↓
AGENT
 ↓
MODEL
 ↓
RESULT
 ↓
EVIDENCE
 ↓
QUALITY
 ↓
NEEDS_IMPROVEMENT
 ↓
DIAGNOSIS
 ↓
OX ALPHA
 ↓
NEW STRATEGY
 ↓
REGENERATION
 ↓
QUALITY
 ↓
ACCEPT

Verify the complete lineage.

==================================================
3H.62 — NEGATIVE END-TO-END TEST
==================================================

Create a test where:

result fails
+
evidence cannot be collected
+
no eligible alternative model exists

Expected:

EXHAUSTED / HUMAN_REVIEW / BLOCKED

depending on policy.

Never infinite retry.

==================================================
3H.63 — QUALITY REGRESSION TEST
==================================================

Example:

Attempt 1 = 90 ACCEPT

Attempt 2 = 74

Expected:

Attempt 1 remains accepted/best.

Do not replace it with Attempt 2.

==================================================
3H.64 — OX ALPHA FAILURE
==================================================

If OX Alpha is unavailable:

the system must NOT silently execute arbitrary regeneration.

Possible:

DETERMINISTIC_FALLBACK

only where explicitly supported by policy.

Otherwise:

INTEGRATION_REQUIRED

or:

REGENERATION_UNAVAILABLE

==================================================
3H.65 — PROVIDER FAILURE
==================================================

If selected provider fails:

reuse Phase 3A retry/fallback behavior.

Do not confuse:

provider failure

with:

quality failure.

==================================================
3H.66 — NO INFINITE SELF-IMPROVEMENT
==================================================

Hard server-side limits are mandatory.

Even if:

OX Alpha says "continue"

the system must stop when:

iteration
or model call
or time
or cost

limits are reached.

==================================================
3H.67 — ARCHITECTURE DOCUMENTATION
==================================================

Update:

ARCHITECTURE.md

Add complete Phase 3H documentation:

- regeneration architecture
- iteration model
- diagnosis
- strategies
- OX Alpha supervisor
- deterministic guardrails
- model switching
- agent switching
- instruction improvement
- evidence improvement
- quality loop
- stop conditions
- budgets
- recursion protection
- concurrency
- idempotency
- best result
- regression detection
- human review
- feedback collection
- APIs
- frontend
- security
- prompt injection
- testing
- limitations

Clearly document:

"OX Alpha proposes adaptive actions, but deterministic platform controls
remain authoritative."

==================================================
3H.68 — ACCEPTANCE CRITERIA
==================================================

Phase 3H is complete only when:

[ ] RegenerationRun exists
[ ] Iterations are immutable
[ ] ImprovementDiagnosis exists
[ ] Improvement strategies exist
[ ] OX Alpha supervisor integration exists
[ ] OX Alpha receives structured quality failures
[ ] Deterministic guardrails validate OX Alpha decisions
[ ] Model switching works
[ ] Agent switching works
[ ] Instruction improvement works
[ ] Evidence improvement works
[ ] Multi-model workflows work when justified
[ ] Multi-agent workflows work when justified
[ ] Parallel independent work is supported
[ ] Quality reruns after every improvement
[ ] Quality regression is detected
[ ] Best result is preserved
[ ] Improvement targets are tracked
[ ] Stop conditions exist
[ ] Max iterations enforced
[ ] Max model calls enforced
[ ] Time budget enforced
[ ] Cost budget supported where data exists
[ ] Recursion protection exists
[ ] Idempotency exists
[ ] Concurrency protection exists
[ ] Human review supported
[ ] Complete lineage exists
[ ] Model feedback collected
[ ] Agent feedback collected
[ ] Instruction feedback collected
[ ] No automatic routing policy mutation
[ ] Secure APIs exist
[ ] Regeneration UI exists
[ ] Simulator exists
[ ] Demo mode contains no fake data
[ ] Prompt injection defenses preserved
[ ] Tenant isolation preserved
[ ] RBAC preserved
[ ] SSRF preserved
[ ] Tool permissions preserved
[ ] Deterministic blockers cannot be overridden
[ ] No infinite regeneration
[ ] No fake quality improvements
[ ] Complete end-to-end test passes
[ ] Negative end-to-end test passes
[ ] All existing 241 server tests pass
[ ] All existing frontend tests pass
[ ] New Phase 3H tests pass
[ ] TypeScript clean
[ ] Production build passes
[ ] ARCHITECTURE.md updated

==================================================
IMPLEMENTATION DISCIPLINE
==================================================

FIRST:

Inspect all Phase 3A–3G implementations.

SECOND:

Reuse existing:

OX Alpha executor
Model router
Agent orchestrator
Instruction intelligence
Evidence engine
Quality engine
Audit mechanisms
Tenant/RBAC controls

Do not duplicate existing functionality.

THIRD:

Implement immutable regeneration/iteration model.

FOURTH:

Implement ImprovementDiagnosis.

FIFTH:

Implement deterministic strategy selection.

SIXTH:

Integrate OX Alpha as supervisor.

SEVENTH:

Validate every OX Alpha decision before execution.

EIGHTH:

Implement evidence-first improvement.

NINTH:

Implement model/agent/instruction adaptation.

TENTH:

Run quality verification after every iteration.

ELEVENTH:

Implement stop/budget/recursion/concurrency controls.

TWELFTH:

Implement APIs and simulator.

THIRTEENTH:

Implement frontend timeline and status.

FOURTEENTH:

Add complete end-to-end tests.

FIFTEENTH:

Run complete regression suite.

SIXTEENTH:

Run TypeScript checks.

SEVENTEENTH:

Run frontend production build.

EIGHTEENTH:

Update ARCHITECTURE.md.

Do not introduce uncontrolled autonomous behavior.

Do not bypass Phase 3G.

Do not let OX Alpha override deterministic platform controls.

Do not create fake data.

Do not implement hidden chain-of-thought storage.

START WITH:

RegenerationRun
→ diagnosis
→ deterministic strategy
→ OX Alpha supervisor
→ guarded execution
→ quality verification

Then add adaptive model/agent/instruction/evidence changes.

Do not declare Phase 3H complete without actual verification evidence.