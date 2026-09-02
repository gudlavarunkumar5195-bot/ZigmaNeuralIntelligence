# ZigmaNeural — Phase 3I
# Adaptive Multi-Agent / Multi-Model Intelligence

==================================================
CURRENT VERIFIED STATE
==================================================

Phases 3A–3H are complete.

Verified:

- Server tests: 244 passed, 5 skipped
- Frontend tests: 64 passed
- Server build: PASS
- Frontend production build: PASS

Architecture currently contains:

3A — OX Alpha execution
3B — Model registry
3C — Model routing
3D — Specialist agents
3E — Instruction intelligence
3F — Evidence intelligence
3G — Quality verification
3H — Controlled regeneration foundation

Treat all existing tests as a protected regression baseline.

Do not destabilize existing functionality.

==================================================
PHASE 3I OBJECTIVE
==================================================

Complete the adaptive intelligence loop.

The system must intelligently determine:

WHY a result failed

and then:

WHAT should change.

Possible changes:

- model
- agent
- instructions
- evidence
- workflow
- verification strategy
- parallelism
- human review

The system must NOT simply retry.

==================================================
TARGET ARCHITECTURE
==================================================

                    TASK
                     |
                     v
                  OX ALPHA
                     |
                     v
              WORKFLOW PLAN
                     |
          +----------+----------+
          |                     |
       AGENT A                AGENT B
          |                     |
       MODEL A                MODEL B
          |                     |
          +----------+----------+
                     |
                  EVIDENCE
                     |
                     v
               QUALITY ENGINE
                     |
              ACCEPTABLE?
              /          \
            YES           NO
             |             |
           DONE       DIAGNOSIS
                           |
                           v
                       OX ALPHA
                           |
              +------------+------------+
              |            |            |
          MORE DATA    NEW MODEL    NEW AGENT
              |            |            |
              +------------+------------+
                           |
                        REGENERATE
                           |
                           v
                        VERIFY
                           |
                           v
                          DONE

==================================================
3I.1 — ADAPTATION DECISION
==================================================

Create:

AdaptationDecision

Fields:

adaptation_id
regeneration_run_id
quality_assessment_id
diagnosis_id
strategy
selected_models
selected_agents
instruction_changes
evidence_requests
parallel_tasks
reason_codes
confidence
created_at

Strategies:

SAME_MODEL_NEW_INSTRUCTIONS
NEW_MODEL
NEW_AGENT
NEW_MODEL_AND_AGENT
MORE_EVIDENCE
PARALLEL_SPECIALISTS
INDEPENDENT_VERIFICATION
HUMAN_REVIEW
STOP

==================================================
3I.2 — ROOT-CAUSE CLASSIFICATION
==================================================

Use Phase 3G + 3H information.

Classify failures into:

EVIDENCE_PROBLEM
INSTRUCTION_PROBLEM
MODEL_CAPABILITY_PROBLEM
AGENT_CAPABILITY_PROBLEM
COVERAGE_PROBLEM
TOOL_PROBLEM
WORKFLOW_PROBLEM
QUALITY_PROBLEM
SECURITY_PROBLEM
AMBIGUITY
EXTERNAL_DEPENDENCY

Prefer deterministic classification when possible.

OX Alpha may refine ambiguous cases.

==================================================
3I.3 — OX ALPHA ADAPTATION INPUT
==================================================

Provide OX Alpha with structured data:

Task
Requirements
Agent
Model
InstructionPlan
EvidenceSummary
QualityAssessment
ImprovementTargets
PreviousIterations
FailureHistory
AvailableAgents
EligibleModels
BudgetState

Do not send unnecessary raw history.

==================================================
3I.4 — OX ALPHA OUTPUT
==================================================

OX Alpha must return structured JSON.

Example:

{
  "strategy": "NEW_MODEL",
  "reason_codes": [
    "LOW_REASONING_QUALITY"
  ],
  "model_requirements": {
    "reasoning": true,
    "structured_output": true
  },
  "agent": "seo_analysis",
  "evidence_requests": [],
  "instruction_changes": [],
  "confidence": 0.84
}

Never accept free-form supervisory decisions.

==================================================
3I.5 — DECISION VALIDATION
==================================================

Before execution:

Validate:

model eligibility
agent eligibility
tool permissions
instruction plan
evidence permissions
tenant scope
budget
iteration limits
task scope

Reject invalid decisions.

OX Alpha is NOT an authorization layer.

==================================================
3I.6 — MODEL SELECTION
==================================================

All model selection must go through Phase 3C.

Never hard-code:

Claude
GPT
Gemini
Qwen
Llama
etc.

Use:

TaskRequirements
+
AdaptationRequirements
+
RoutingPolicy

→

Candidate Filter
→
Candidate Scorer
→
OX Alpha selection
→
Deterministic validation

==================================================
3I.7 — MODEL DIVERSITY
==================================================

Track previous model attempts.

Example:

Attempt 1:
Model A

Attempt 2:
Model A

Attempt 3:
Model B

If Model A repeatedly fails for the same reason:

prefer a qualified alternative.

Do not switch models merely for randomness.

==================================================
3I.8 — MODEL CAPABILITY FEEDBACK
==================================================

Track failure patterns.

Example:

Model A:

structured output:
excellent

deep reasoning:
poor

long-context:
excellent

evidence grounding:
medium

Model B:

structured output:
excellent

deep reasoning:
excellent

evidence grounding:
excellent

Do not manually hard-code these conclusions.

Derive future signals from verified execution outcomes.

==================================================
3I.9 — SAMPLE SIZE PROTECTION
==================================================

Do not make routing conclusions from tiny samples.

Reuse the existing Phase 3C reliability rules.

Unknown data:

UNKNOWN

not:

BAD

not:

GOOD

Do not automatically promote or demote a model based on one failure.

==================================================
3I.10 — AGENT ADAPTATION
==================================================

Use Phase 3D registry.

If current agent repeatedly fails because required capability is missing:

select another eligible specialist.

Example:

SEO Agent
fails structured-data analysis

↓

Technical Analysis Agent

The new agent must be explicitly capable of the task.

==================================================
3I.11 — MULTI-AGENT STRATEGY
==================================================

Support multiple agents when justified.

Example:

Agent A:
SEO technical analysis

Agent B:
AEO analysis

Agent C:
independent verification

Then:

Evidence
+
Findings
+
Quality verification

Do not automatically run every agent.

OX Alpha must provide a structured reason.

==================================================
3I.12 — PARALLEL AGENTS
==================================================

Independent agents may execute in parallel.

Example:

SEO Agent
AEO Agent
Performance Agent

Run concurrently when:

- dependencies permit
- budget permits
- task scope permits

Use Phase 3D workflow planning.

==================================================
3I.13 — DEPENDENCY-AWARE EXECUTION
==================================================

Example:

Evidence Collection
        ↓
SEO Analysis
        ↓
AEO Analysis
        ↓
Synthesis

Do not execute synthesis before its dependencies complete.

Reuse existing topological planning.

==================================================
3I.14 — INDEPENDENT VERIFICATION
==================================================

For high-risk or disputed results:

Generation:

Model A

Verification:

Model B

Do not allow the generator to self-approve.

Verification must use:

requirements
evidence
quality policy

==================================================
3I.15 — EVALUATOR DIVERSITY
==================================================

If model-based evaluation is used:

prefer an evaluator different from the generator.

But:

do not require a second model when deterministic checks are sufficient.

Cost-aware selection is mandatory.

==================================================
3I.16 — DISAGREEMENT
==================================================

If two evaluators disagree:

AGREEMENT
MINOR_DISAGREEMENT
MAJOR_DISAGREEMENT

OX Alpha determines whether:

- one result is clearly supported
- additional evidence is needed
- another evaluator is required
- human review is needed

Never blindly majority-vote high-risk decisions.

==================================================
3I.17 — EVIDENCE ADAPTATION
==================================================

Use Phase 3F.

If quality failure is evidence-related:

generate precise evidence requests.

Example:

Requirement:
Verify canonical tags.

Existing evidence:
2/50 pages.

Request:

canonical evidence
for remaining 48 pages.

Do not request "more evidence" generically.

==================================================
3I.18 — EVIDENCE REQUEST VALIDATION
==================================================

Before execution validate:

resource scope
tenant ownership
collector permissions
tool permissions
allowed domains
SSRF protection
evidence freshness requirements

Never allow OX Alpha to bypass evidence security.

==================================================
3I.19 — INSTRUCTION ADAPTATION
==================================================

Use Phase 3E.

If failure is caused by instructions:

create a new instruction profile/version.

Example:

v1:

"Analyze the website."

v2:

"Analyze every discovered URL and provide evidence-backed
findings for each required SEO criterion."

Do not mutate v1.

==================================================
3I.20 — INSTRUCTION SAFETY
==================================================

OX Alpha cannot modify:

system policy
security policy
tenant rules
tool permissions
trust boundaries

Only permitted instruction layers may be modified.

==================================================
3I.21 — COMBINED ADAPTATION
==================================================

Allow:

new evidence
+
new instructions
+
new model

when justified.

Example:

Evidence is complete.

Instructions are adequate.

Reasoning quality remains poor.

→ new model.

Different example:

Evidence incomplete.

→ collect evidence first.

Do not unnecessarily change the model.

==================================================
3I.22 — STRATEGY PRIORITY
==================================================

Prefer the smallest effective change.

Default strategy priority:

1. Fix missing evidence
2. Fix deterministic validation issue
3. Improve instructions
4. Change model
5. Change agent
6. Add independent verification
7. Multi-agent workflow
8. Human review

But OX Alpha may select another strategy when evidence supports it.

==================================================
3I.23 — ADAPTATION COST
==================================================

Every strategy has cost.

Estimate when possible:

model calls
token usage
execution time
tool calls

Do not fabricate cost.

Prefer:

highest expected quality improvement
within:

time
model-call
token
cost

budgets.

==================================================
3I.24 — EXPECTED IMPROVEMENT
==================================================

Track:

quality_before
expected_quality_after
quality_after

Do not treat expected improvement as actual improvement.

Actual quality is determined only after verification.

==================================================
3I.25 — ADAPTATION EFFECTIVENESS
==================================================

After every iteration:

record:

strategy
quality_before
quality_after
delta
resolved_targets
remaining_targets

Example:

NEW_MODEL

64 → 88

successful.

==================================================
3I.26 — STRATEGY FAILURE FEEDBACK
==================================================

Example:

Strategy:

SAME_MODEL_NEW_INSTRUCTIONS

64 → 65

Minimal improvement.

Mark:

LOW_EFFECTIVENESS

Next iteration should consider another strategy.

==================================================
3I.27 — PLATEAU DETECTION
==================================================

Existing Phase 3H plateau protection remains authoritative.

Enhance it with:

score delta
target resolution
repeated failure reason
model repetition
agent repetition

Example:

70
71
70

→ plateau.

Stop or escalate.

==================================================
3I.28 — REGRESSION
==================================================

If:

90 → 75

the previous accepted/best result remains protected.

New result must never automatically replace a better accepted result.

==================================================
3I.29 — ACCEPTANCE
==================================================

Acceptance still comes exclusively from Phase 3G.

Phase 3I cannot introduce another acceptance mechanism.

Flow:

Adapt
→ Execute
→ Evidence
→ Quality
→ Decision

==================================================
3I.30 — FEEDBACK TO ROUTER
==================================================

Collect:

model performance
agent performance
instruction performance
strategy effectiveness

Feed these as historical signals into routing.

Do NOT automatically rewrite routing policy.

Respect minimum sample thresholds.

==================================================
3I.31 — FEEDBACK TO AGENT REGISTRY
==================================================

Collect:

agent success rate
quality
failure types
average iterations
task-specific outcomes

Do not automatically disable agents from tiny samples.

==================================================
3I.32 — FEEDBACK TO INSTRUCTION INTELLIGENCE
==================================================

Collect:

instruction version
quality
failure types
improvement rate

This allows future selection of better instruction profiles.

==================================================
3I.33 — CROSS-TASK LEARNING
==================================================

Do not mix unrelated task types.

Example:

Security performance

must not directly determine:

SEO routing.

Feedback must remain:

task-type scoped
capability scoped
agent scoped
model scoped

==================================================
3I.34 — TENANT ISOLATION
==================================================

Feedback must not leak tenant-specific sensitive information.

Aggregate safely.

Never expose:

tenant content
private evidence
customer URLs
private findings

to another tenant.

==================================================
3I.35 — SECURITY
==================================================

Adaptive intelligence must preserve:

RBAC
RLS
tenant isolation
SSRF
tool permissions
evidence ownership
instruction trust boundaries
audit logging

No adaptation may weaken security.

==================================================
3I.36 — PROMPT INJECTION
==================================================

Treat all external content as untrusted:

website content
scanner output
previous model output
findings
evidence descriptions
user content

These must never modify:

system instructions
security policy
tool permissions
tenant boundaries

==================================================
3I.37 — OX ALPHA FAILURE
==================================================

If OX Alpha is unavailable:

do not invent adaptive decisions.

Use deterministic fallback only when explicitly supported.

Otherwise:

ADAPTATION_UNAVAILABLE

Do not silently retry indefinitely.

==================================================
3I.38 — MODEL PROVIDER FAILURE
==================================================

Provider failure is operational failure.

Use Phase 3A retry/fallback behavior.

Do not classify provider outage as:

poor model quality.

==================================================
3I.39 — OBSERVABILITY
==================================================

Record:

adaptation_id
strategy
task
agent
model
quality_before
quality_after
reason_codes
evidence_changes
instruction_changes
iteration
duration
token usage where available
provider
failure_type

Never store secrets.

Never store hidden reasoning.

==================================================
3I.40 — API
==================================================

Create secure APIs:

POST /ai/adaptation/simulate
GET /ai/regeneration/:id/adaptations
GET /ai/adaptation/:id

Admin-only simulator.

Execution endpoints remain protected by existing authorization.

==================================================
3I.41 — SIMULATOR
==================================================

Simulator input:

task
requirements
current agent
current model
quality assessment
diagnosis
evidence state
available agents
eligible models
budget

Output:

recommended strategy
candidate model
candidate agent
instruction changes
evidence requests
parallel tasks
reason codes
confidence

Simulator must NOT execute anything.

No fake decisions.

==================================================
3I.42 — FRONTEND
==================================================

Add:

AI Agents
→ Adaptive Intelligence

Display:

Current iteration
Current quality
Previous quality
Quality delta
Current model
Current agent
Selected strategy
Reason codes
Improvement targets
Evidence changes
Instruction changes
Model changes
Agent changes

Timeline:

Attempt 1
64
Evidence incomplete

↓

Evidence collected

↓

Attempt 2
76
Instruction improvement

↓

Attempt 3
91
Model changed

↓

ACCEPTED

==================================================
3I.43 — NO FAKE UI
==================================================

Demo mode must show:

INTEGRATION REQUIRED

unless actual API data exists.

Never fabricate:

quality
model selection
adaptation
iterations
cost
confidence

==================================================
3I.44 — HUMAN REVIEW
==================================================

Human review is required when policy determines:

high-risk disagreement
security ambiguity
quality plateau
no viable strategy
budget exhausted
critical unresolved finding

Human review must remain explicit.

Never simulate approval.

==================================================
3I.45 — HARD LIMITS
==================================================

Enforce server-side:

max iterations
max model calls
max execution duration
max cost budget where available
max parallel agents
max evaluator calls

OX Alpha cannot override these.

==================================================
3I.46 — IDEMPOTENCY
==================================================

Adaptive execution must be idempotent.

Repeated requests must not accidentally:

start duplicate workflows
double-spend budgets
duplicate model calls

Reuse existing regeneration identifiers and idempotency mechanisms.

==================================================
3I.47 — CONCURRENCY
==================================================

Prevent competing adaptive workflows for the same task unless
explicitly supported.

Preserve the existing best/accepted result.

==================================================
3I.48 — TESTING
==================================================

Add comprehensive tests.

Strategy:

- same model + new instructions
- new model
- new agent
- model + agent
- more evidence
- parallel agents
- independent verification

Validation:

- invalid model rejected
- invalid agent rejected
- invalid instruction rejected
- unauthorized evidence rejected

Feedback:

- successful strategy
- ineffective strategy
- regression
- plateau

Security:

- tenant isolation
- RBAC
- SSRF
- prompt injection
- unauthorized tools

Budgets:

- iteration limit
- model-call limit
- time limit
- cost limit

Concurrency:

- duplicate prevention
- idempotency
- concurrent execution

Failure:

- OX Alpha unavailable
- provider unavailable
- model timeout
- evidence collector failure
- routing failure
- agent failure

==================================================
3I.49 — END-TO-END TEST
==================================================

Implement a complete scenario:

TASK

↓

Agent A
+
Model A

↓

Result

↓

Evidence

↓

Quality = 65

↓

Diagnosis:

LOW_REASONING_QUALITY

↓

OX Alpha

↓

Select Model B

↓

Validate routing eligibility

↓

Execute

↓

Quality = 91

↓

ACCEPT

Verify complete lineage.

==================================================
3I.50 — EVIDENCE-FIRST TEST
==================================================

Scenario:

Quality = 60

Reason:

EVIDENCE_INCOMPLETE

Expected:

collect evidence first.

Do NOT switch model.

After evidence:

regenerate.

Verify quality again.

==================================================
3I.51 — INSTRUCTION-FIRST TEST
==================================================

Scenario:

Evidence sufficient.

Model capable.

Instruction incomplete.

Expected:

new instruction version.

Same model may be reused.

Verify:

old instruction remains immutable.

==================================================
3I.52 — AGENT SWITCH TEST
==================================================

Scenario:

Current agent lacks required capability.

Expected:

new eligible specialist agent.

Verify:

tool permissions remain scoped.

==================================================
3I.53 — MULTI-AGENT TEST
==================================================

Scenario:

Two independent analyses are required.

Expected:

parallel execution where allowed.

Verify:

dependencies
tenant isolation
budget
lineage.

==================================================
3I.54 — MODEL DISAGREEMENT TEST
==================================================

Two evaluators disagree.

Expected:

structured disagreement.

OX Alpha chooses:

additional evidence
or
third evaluator
or
human review

according to policy.

==================================================
3I.55 — SECURITY BLOCK TEST
==================================================

Quality:

95

But:

tenant violation.

Expected:

BLOCK.

OX Alpha cannot override.

==================================================
3I.56 — REGRESSION TEST
==================================================

Attempt 1:

90 ACCEPTED

Attempt 2:

72

Expected:

Attempt 1 remains best accepted result.

==================================================
3I.57 — ROUTING FEEDBACK TEST
==================================================

Generate sufficient historical outcomes.

Verify feedback is collected.

Verify routing can consume historical signal.

Verify small sample does NOT automatically alter routing.

==================================================
3I.58 — NO SELF-IMPROVEMENT CLAIMS
==================================================

Do not describe the system as:

"learning automatically"

unless the implementation actually performs controlled learning.

This phase is:

adaptive decision-making using verified historical feedback.

Do not invent machine-learning capabilities.

==================================================
3I.59 — ARCHITECTURE DOCUMENTATION
==================================================

Update:

ARCHITECTURE.md

Add:

Phase 3I

Document:

- adaptive intelligence
- strategy selection
- OX Alpha supervision
- model adaptation
- agent adaptation
- instruction adaptation
- evidence adaptation
- multi-agent execution
- evaluator diversity
- disagreement handling
- feedback
- routing integration
- budgets
- security
- prompt injection
- concurrency
- idempotency
- human review
- limitations

Clearly state:

"OX Alpha is the adaptive supervisor, but deterministic platform
controls remain authoritative."

==================================================
3I.60 — ACCEPTANCE CRITERIA
==================================================

Phase 3I is complete only when:

[ ] AdaptationDecision exists
[ ] Root-cause classification exists
[ ] OX Alpha receives structured failure context
[ ] OX Alpha returns structured adaptation decisions
[ ] Deterministic validation protects decisions
[ ] Model adaptation works
[ ] Agent adaptation works
[ ] Instruction adaptation works
[ ] Evidence adaptation works
[ ] Multi-agent workflows work
[ ] Parallel independent work works
[ ] Independent verification works
[ ] Evaluator diversity works
[ ] Disagreement handling works
[ ] Strategy effectiveness is tracked
[ ] Quality delta is tracked
[ ] Regression detection works
[ ] Plateau detection works
[ ] Feedback is collected
[ ] Feedback is task scoped
[ ] Small sample protection works
[ ] Routing can consume historical signals
[ ] No automatic routing mutation
[ ] Budgets enforced
[ ] Iteration limits enforced
[ ] Model-call limits enforced
[ ] Time limits enforced
[ ] Cost limits supported where available
[ ] Concurrency protected
[ ] Idempotency protected
[ ] Human review supported
[ ] Tenant isolation preserved
[ ] RBAC preserved
[ ] SSRF preserved
[ ] Tool permissions preserved
[ ] Prompt injection defenses preserved
[ ] No self-approval
[ ] No fake scores
[ ] No fake adaptation
[ ] No hidden reasoning storage
[ ] Simulator exists
[ ] APIs exist
[ ] Frontend exists
[ ] Demo mode contains no fake data
[ ] End-to-end adaptive test passes
[ ] Negative tests pass
[ ] All existing 244 server tests pass
[ ] All existing frontend tests pass
[ ] New Phase 3I tests pass
[ ] TypeScript clean
[ ] Production build passes
[ ] ARCHITECTURE.md updated

==================================================
IMPLEMENTATION ORDER
==================================================

FIRST:

Inspect Phase 3A–3H.

SECOND:

Reuse all existing engines.

THIRD:

Implement AdaptationDecision.

FOURTH:

Implement root-cause classification.

FIFTH:

Implement deterministic strategy selection.

SIXTH:

Integrate OX Alpha.

SEVENTH:

Validate OX Alpha decisions.

EIGHTH:

Implement model/agent/instruction/evidence adaptation.

NINTH:

Implement multi-agent and evaluator diversity.

TENTH:

Implement feedback collection.

ELEVENTH:

Integrate historical feedback with routing safely.

TWELFTH:

Implement simulator.

THIRTEENTH:

Implement frontend.

FOURTEENTH:

Add end-to-end tests.

FIFTEENTH:

Run ALL regression tests.

SIXTEENTH:

Run TypeScript checks.

SEVENTEENTH:

Run production build.

EIGHTEENTH:

Update ARCHITECTURE.md.

Do NOT bypass Phase 3G quality verification.

Do NOT bypass Phase 3H regeneration controls.

Do NOT allow OX Alpha to authorize itself.

Do NOT allow models to modify security policy.

Do NOT create uncontrolled autonomous loops.

Do NOT fabricate model performance.

Do NOT fabricate quality.

Do NOT fabricate adaptation decisions.

Do NOT store chain-of-thought.

Do not declare Phase 3I complete without actual verification evidence.