# Phase 11: autonomous free-model router

**Branch:** `feat/p11-ai-router`, from `feat/p10-production-readiness` at `a7b1c1c`.
**Recorded:** 23 Oct 2026.
**Principle:** models propose; deterministic application policy decides what is permitted.

The verification evidence for every claim is in section 12. Each claim is marked one of:
- **Verified:** executed in a test.
- **Implemented, not verified live:** needs a real OpenRouter key or production traffic.
- **Blocked:** missing credentials or environment.
- **Not implemented.**

## 1. What existed before (Phase 11.1 inspection)

| Area | Before Phase 11 |
| --- | --- |
| Catalog | `ai/catalog.service.ts` fetched `/api/v1/models`. Free meant prompt and completion price both 0. Refresh was manual only, and new models waited for admin review. |
| Router | `ai/router/*`: hard filter plus a weighted score. Its benchmark and reliability inputs were never written, so every model scored a neutral 50. No cooldowns; `Retry-After` was ignored. |
| Execution | `OxAlphaExecutor` (`ai/ox-alpha.ts`): retries, a fallback list, a per-org daily count of calls, and a "registry says FREE" check. No token estimate, no token budget, no output guard. |
| Callers | Agents went through the router. Five services (content brief, research insights, SEO workspace summary, AI-visibility answers and summary) called the executor directly with a hard-coded default model (`meta-llama/llama-3.1-8b-instruct:free`), which is no longer in OpenRouter's catalog. |
| Safety | An untrusted-data sanitizer, used only by the agent orchestrator; regex checks on instruction plans. |
| Tools | Agent tool names were declared, but nothing executed tools. |
| Providers | OpenRouter only. No Anthropic or Sarvam provider exists in the application code. |

Phase 11 extends these components; it does not add a parallel system.

## 2. Architecture

```
caller (agent / feature)
  │  messages + taskType/feature (+ optional pinned model)
  ▼
OxAlphaExecutor.execute  ── the only path to a provider ──────────────────────────────┐
  1. attribution check (org + scan/research/brand), cancellation, settings          │
  2. trusted policy message + canary prepended; input screened for injection         │
  3. task run opened (shared budget scope)                                           │
  4. model chain: pinned (re-validated) or resolveRouting():                         │
       hard gates → learned stats → min-quality → scoring → pin/exploration          │
  5. per model: call-time gate (pricing class, trial, freshness, review, exclusion) │
                 cooldown check → context plan (fit or reduce, never cut required)   │
  6. per attempt, ONE transaction: org request budget (advisory lock)                │
                 → account free/trial quota + per-minute pace → token reservation   │
                 → attempt row                                                       │
  7. provider call with provider.max_price = 0 for free/trial models                 │
  8. settle tokens (provider usage, else marked ESTIMATED); classify failure;        │
     cooldown/quota marking; deterministic evaluation + output guard                 │
  9. accept, retry same model, try next model, or stop (category policy)             │
└────────────────────────────────────────────────────────────────────────────────────┘
AgentSupervisor (multi-agent): count/depth/parallelism/deadline/cancel, schema per agent,
  agent output screened + wrapped as untrusted before reuse. Tool registry: separate,
  server-authorized, approvals bound to exact arguments.
```

**New modules**
- `ai/pricing.ts`, `ai/tokens.ts`, `ai/failures.ts`, `ai/quota.ts`, `ai/task-runs.ts`, `ai/governance.ts`, `ai/evaluation.ts`, `ai/retention.ts`
- `ai/router/settings.ts`, `task-profiles.ts`, `learning.ts`, `scoring-v2.ts`
- `ai/security/injection-detector.ts`, `output-guard.ts`, `events.ts`
- `ai/tools/registry.ts`, `ai/agents/supervisor.ts`
- `routes/ai-router.ts`
- `observability/*`, `instrument.ts`

## 3. Model catalog and free eligibility

- **Source:** OpenRouter's public `GET /api/v1/models`. The key is sent when configured; fetching the catalog makes no inference call.
- **Refresh:** a scheduler refreshes when the catalog is older than the configured interval (default 6 h; checked every 10 min; single-flight). A model whose pricing is older than `maxStaleHours` (default 24 h) triggers one refresh at call time and is refused if pricing still cannot be confirmed.

**Classification** (`classifyPricing`; observed on the live catalog of 23 Oct 2026: 468 models, 20 with zero prompt/completion price):

| Class | Rule | Used? |
| --- | --- | --- |
| FREE | every listed price field is exactly 0, including request, image, web_search, internal_reasoning, cache and audio fields, and every time-of-day override; no expiration date | yes |
| TRIAL | as FREE, but the catalog lists an `expiration_date` in the future (e.g. `poolside/laguna-s-2.1:free` until 31 Oct 2026) | only when trials are enabled; counts against a daily trial cap |
| PAID | any price above 0, in the base pricing or any override | never (unless `AI_ALLOW_PAID_MODELS=true`) |
| UNKNOWN | missing or unparseable prices, negative prices (OpenRouter's marker for dynamic routers such as `openrouter/auto`), or an expiry already passed | never |

**Further rules**
- A `:free` suffix or "free" in the name is never evidence.
- Routing aliases (`openrouter/*`, dynamic prices) and models that output anything other than text (e.g. `google/lyria-*` music models, priced at 0) are excluded.
- **Auto-approval:** a FREE text model, or a TRIAL text model when trials are enabled, becomes AVAILABLE automatically (history event `AUTO_APPROVED`). Paid and unknown models never do. An administrator's disable or exclusion always wins.
- **Belt and braces:** every free or trial request also sends `provider: { max_price: {prompt:0, completion:0, request:0, image:0}, require_parameters: true }`, so OpenRouter itself refuses any priced endpoint. Billed web search is stripped from free requests.

## 4. Task classification and model selection

**Classification.** Categories (`task-profiles.ts`): CLASSIFICATION, STRUCTURED_EXTRACTION, SUMMARIZATION, CONTENT_GENERATION, SEO_ANALYSIS, TECHNICAL_REASONING, CODE_GENERATION, RESEARCH_SYNTHESIS, PLANNING, AGENT_COORDINATION, TOOL_USE, VERIFICATION.
- The category comes from the calling feature or agent type, never from content. Each feature is tagged: `content_brief`, `research_insights`, `seo_workspace_summary`, `aiv_summary`, `aiv_answer`, `agent`.
- Each profile has a resource tier (LIGHT, STANDARD or HEAVY), the output it needs, the benchmark it leans on, and whether it is splittable.

**Hard gates** run before ranking. A candidate is excluded for any of:
- disabled, unreviewed or stale status;
- price CHANGED; PAID or UNKNOWN; a disabled or expired TRIAL;
- free or trial quota exhausted;
- pricing not confirmed within `maxStaleHours`;
- cooling down;
- routing alias; non-text output;
- missing structured output, tools or vision;
- context window or output cap too small for the request (approximate estimate);
- below minimum reliability (needs ≥10 samples), or below minimum quality (only when quality is KNOWN);
- excluded by an administrator.

**Ranking formula** (`scoring-v2.ts`; weights in settings, default in brackets, must sum to 1):

```
score = 0.30·quality + 0.20·reliability + 0.10·structured + 0.05·latency
      + 0.05·context + 0.10·availability + 0.10·security + 0.10·resourceFit
```

- **quality:** Bayesian decayed mean of evaluation scores for this category, shrunk toward a prior.
  - The prior is 50, or OpenRouter's published Artificial Analysis index mapped into 35–65, so benchmark headlines can only nudge it.
  - It counts as KNOWN only with ≥ `minSamples` (5) evaluations.
- **reliability:** Wilson 95% lower bound of recent attempt success (14 days). 50 below `minSamples`.
  - Failures not attributable to the model (budget, cancellation, auth, our own refusals, oversized requests, safety refusals) are not counted.
- **structured:** observed JSON validity, else declared `structured_outputs` (75) or `response_format` (65) support.
- **latency:** recent median latency.
- **context:** context window relative to the request size.
- **availability:** reduced by recent consecutive failures and by a low remaining trial allowance.
- **security:** smoothed share of evaluations without a security violation.
- **resourceFit:**
  - LIGHT tasks prefer models that do not always reason and are not the largest;
  - HEAVY tasks prefer windows ≥ 64k and output ≥ 8k.
  - This implements "lowest-resource model that reliably satisfies the task".

**Other selection rules**
- **Pins:** an administrator pin per category wins only among candidates that passed every gate.
- **Exploration:** with probability `explorationRate` (default 10%), deterministic per correlation id, and only for LOW-risk tasks, a low-confidence candidate among the top three is tried first; the best-ranked model stays first fallback. This is how new free models earn data.
- **Coordinator:** for multi-agent work the PLANNER and SYNTHESIZER use the PLANNING and AGENT_COORDINATION categories, which rank on the `agentic` benchmark prior and measured results. No model is permanently hard-coded.

## 5. Token estimation and budgets

**Estimator.** `ceil(UTF-8 bytes / 3)` plus 8 tokens per message and 16 per request. It is **always marked approximate**, because no provider tokenizer is available for most models.
- English BPE averages about 4 bytes per token, so English is over-estimated by about a third.
- CJK text comes out at about 1 token per character.
- Each model's p90 ratio of provider-reported to estimated prompt tokens (last 50 attempts, ≥5 samples) **raises** estimates for that model, clamped to 1–2.5×. It never lowers them.

**Feasibility per model:**

```
estimated_input + reserved_output + max(256, 5%·context) ≤ context_length
```

- Output reservation is capped by the model's own output limit, and tripled for models that always reason.
- An unreported window is assumed to be 4,096 tokens.
- Reduction order: drop history → agent messages → tool output → retrieved docs → optional evidence → tool specs, then lower the output reservation, never below the task minimum.
- Policy, instructions, the user request and required evidence are **never dropped or cut**.
- If the request still does not fit, the next (larger) model is tried; if none fits, the task is SPLIT_REQUIRED.

**Budgets.** All ceilings are in code, and settings can only lower them:

| Budget | Default (ceiling) |
| --- | --- |
| Free requests per day, account-wide | 50 (1,000) |
| Free requests per minute | 16 (20) |
| Trial requests per day | 20 |
| Requests per organization per day | 200, never above the deployment's `AI_MAX_EXECUTIONS_PER_ORG_PER_DAY` |
| Tokens per organization, rolling 24 h | 2,000,000 |
| Per task: tokens | 120k |
| Per task: calls | 6 (12) |
| Per task: agents | 5 (8) |
| Per task: depth | 2 (3) |
| Per task: parallel agents | 2 (4) |
| Per task: retries per model | 2 (3) |
| Per task: fallback models | 3 (5) |
| Per task: wall clock | 240 s (600 s) |
| Per task: input / output tokens | 48k input, 4,096 output |
| Per task: reductions | 3 |
| Per task: repairs | 1 |

**Reservation** (`governance.reserveAttempt`). One transaction under the organization's advisory lock and a global quota lock:
1. organization request count;
2. account quota and per-minute pace;
3. organization 24 h tokens;
4. task tokens and calls (row lock);
5. the attempt row.

Any refusal rolls everything back.

**Settlement and accounting**
- Usage is settled with the provider's figures: input, output, cached, reasoning, and `cost` (0 for free models).
- Without provider usage, the estimate is settled and marked **ESTIMATED**.
- A reservation for a call that was never sent is **RELEASED**.
- Tokens are integers. Cost is stored as `NUMERIC(14,8)`.

**Provider allowance**
- OpenRouter's own `free_model_daily_requests` (from `GET /api/v1/key`, no inference) is synced every 15 minutes, and the effective limit is the lower of it and the setting.
- A 429 that reports the daily allowance marks the pool exhausted until the next UTC day.

## 6. Fallback state machine

Each failure is classified once (`failures.ts`), and the category decides what happens next:

| Category | Same model | Next model | Stop task | Cooldown |
| --- | --- | --- | --- | --- |
| RATE_LIMITED | only a short provider `Retry-After` (≤10 s) | yes | | 60 s, or `Retry-After` (max 6 h) |
| QUOTA_EXHAUSTED | | | **yes**; pool marked exhausted | |
| PROVIDER_UNAVAILABLE / TIMEOUT | yes, with jittered backoff (if the provider says retryable) | yes | | after 2 consecutive failures |
| CONTEXT_OVERFLOW | never (resending is pointless) | yes, replanned | | |
| UNSUPPORTED_CAPABILITY | | yes | | 15 min |
| REQUEST_REJECTED (other 4xx) | | yes | | none |
| MALFORMED_OUTPUT / EMPTY_RESPONSE | 1 repair attempt | yes | | |
| TRUNCATED_OUTPUT, INVALID_PROVIDER_RESPONSE, QUALITY_FAILED | | yes | | |
| SAFETY_REJECTION | | **no** (no evasion via weaker models) | **yes** | |
| SECURITY_VIOLATION (output guard) | | | **yes** | |
| AUTH_CONFIG, BUDGET_EXHAUSTED, CANCELLED | | | **yes** | |

**Further fallback rules**
- Each fallback re-runs the call-time gate, cooldown check, context plan and reservation.
- Tenant, permissions, tools and policy are fixed by the caller and never change on fallback.
- A paid model is never reached: the gate refuses it and records `PAID_MODEL_BLOCKED`.

## 7. Multi-agent orchestration

`AgentSupervisor` (`ai/agents/supervisor.ts`):
- **Roles:** PLANNER, RESEARCHER, EXTRACTOR, ANALYST, IMPLEMENTER, VERIFIER, SYNTHESIZER.
- **Limits:** agent count (counted before queueing), delegation depth, a parallelism semaphore and a deadline.
- **Shared budget:** every call carries the task run, so the per-call reservation enforces the task's tokens and calls.
- **Cancellation:** one AbortController reaches running and queued agents. `POST /api/v1/ai/tasks/:id/cancel` is checked by the executor before every provider call.
- **Output:** each agent has a fixed zod schema, enforced inside the executor as the task validator and again after.
- **Agent output is untrusted:** it is screened by the injection detector (HIGH means rejected, with a security event) and wrapped as untrusted data before another agent sees it.
- **No self-escalation:** agents cannot call tools, spawn agents or change budgets; only application code calls `run()`.

The existing scan pipeline now runs specialists with bounded parallelism (`maxConcurrency`) instead of all at once.

**Not implemented:** an LLM-planned dynamic workflow exposed in the UI. The supervisor is a library used by application code; there is no end-user "run multi-agent task" screen.

## 8. Quality evaluation and learning

**What is evaluated**
- Every completed attempt is evaluated deterministically: non-empty, JSON validity, truncation, the output guard, and a caller-supplied task validator.
- Structural checks alone are **LOW** confidence, because fluent output is not correctness. A task validator raises the confidence to MEDIUM.
- User feedback (one vote per user per task) adds a LOW-confidence evaluation (score 85 or 25).
- The evaluator-model method exists in the schema but is off by default (`maxEvaluationAttempts=0`), so the free allowance is not spent on grading.

**How learning works**
- Exponential decay (half-life 14 days), a prior worth 4 pseudo-observations, and KNOWN only at ≥5 samples.
- Evidence weights: deterministic MEDIUM 0.8, LOW 0.5; a user rating 0.25; at most 3 ratings per organization per model are counted.
- One rating moves a model by at most a few points, and one organization's ratings cannot push a measured model below the quality threshold (both tested).
- Learning only produces scores; it cannot change prompts, policies, permissions or limits.
- Security violations lower the security component; they are never "learned" as acceptable.
- Evaluations are aggregated across organizations as **scores only** (no content), so all tenants benefit. The `/quality` view shows an organization admin only their own organization's evaluations; platform administrators see the aggregate.

## 9. Prompt-injection defenses and security boundaries

**Trust hierarchy** (highest first): application policy, trusted task instructions, the authenticated user, retrieved/uploaded content, model and agent output.
- Every request starts with an application security-policy message containing a per-request **canary**.
- Untrusted material is wrapped in the existing `UNTRUSTED_DATA` markers.

**Input screening** (`injection-detector.ts`). Deterministic, layered, and not keyword-only:
- normalization: NFKC, zero-width and bidi stripping, homoglyph and leetspeak folding;
- obfuscation: split letters, reversed and ROT13 text;
- bounded decoding: base64, hex, percent-encoding, HTML entities, escapes;
- about 70 phrase and anchor-window rules across 13 categories;
- discussion and quotation discounting;
- source weighting: retrieved and tool content counts more than user text;
- split-across-parts detection.

Results are recorded as `PROMPT_INJECTION_SUSPECTED` events; the content remains data.

**Output guard** (`output-guard.ts`). An output is rejected, with a stop and a security event, for any of:
- canary leak, including when obfuscated;
- system-prompt shingle leak;
- secret patterns: OpenRouter, sk-, Bearer, JWT, AWS, GitHub, Slack, Google keys, private keys, database URLs;
- unapproved hosts or markdown exfiltration links;
- claims of approval;
- tool names outside the allowlist.

**Tool registry** (`ai/tools/registry.ts`). A call is executed only when all of these pass:
- the tool exists;
- it is on the task's allowlist;
- its arguments pass a strict zod schema (extra fields like `approved:true` are rejected);
- the user's **real** role is high enough (from auth middleware, never from a model);
- HIGH and CRITICAL tools have an approval for the **exact** tool and argument hash, requested by the same user, decided by an admin of the same organization (not the requester, unless they are the owner), unexpired, and consumed once;
- it runs within a timeout, with a bounded result, and is audited.

Initial tools are `alerts.list` (read) and `alerts.create_rule` (HIGH, approval required).

**SSRF.** The crawler's existing pinned-DNS fetch is unchanged: scheme checks, private/link-local/metadata blocking, a per-redirect re-check, size and time limits, and the gzip hang fix from Phase 10. Provider requests use fixed hosts with `redirect: "error"`.

**Data protection**
- Keys stay server-side.
- Log redaction is extended for Sentry: headers, bodies and token patterns.
- Security events store only categories and weights, never raw prompts or outputs.
- Retention defaults to 180 days (setting: 30–730).

**Not claimed:** immunity to prompt injection. Known gaps are in section 13.

## 10. Database (migration 041, additive)

**New tables**
- `ai_router_settings` (versioned, one active)
- `ai_model_health`
- `ai_provider_quota_days`
- `ai_task_runs`
- `ai_token_reservations`
- `ai_model_evaluations`
- `ai_feedback`
- `ai_security_events`
- `ai_tool_approvals`
- `ai_agent_runs`

**New columns**
- `models`: pricing class, raw pricing, expiry, output cap, reasoning, JSON schema, router flag, tokenizer, published benchmark indices, pricing check time.
- `agent_executions`: failure category, task run, estimates, estimated flag, cached and reasoning tokens, cost, pricing class, fallback reason.
- `routing_decisions` and `routing_candidates`: task run, feature, score components.

**Tenancy, indexes and safety**
- Tenant tables carry `org_id`, with composite foreign keys to `ai_task_runs (id, org_id)`.
- Two partial indexes support account-wide pacing and per-model statistics.
- Nothing is dropped or rewritten.
- **Not run in production.** Before the first deploy that includes 041, follow the runbook.

## 11. API and frontend

- **API:** `/api/v1/ai/*` (`routes/ai-router.ts`) with routes for:
  - status, models, settings (GET for admins; PUT for platform admins with optimistic version), quota sync;
  - feasibility preview (no model call; plain-language message);
  - usage (estimated vs provider-reported, labelled);
  - task runs and details, cancel, feedback;
  - quality, security events, tools, approvals and decisions.
- **Every tenant query is filtered by the caller's organization.** Catalog, settings and quota data are global and contain no tenant data or secrets.
- **Frontend:** the Model Intelligence admin page (see the final report for files).

## 12. Verification

### Independent security review (read-only)

**Result:** no P0, and no path to a paid or unknown-price call while `AI_ALLOW_PAID_MODELS=false`.

**Fixed, each with a regression test:**
- **P1:** a model that reappeared after going stale skipped review. Fix: it now returns to its earlier review state, and the call-time gate requires an approved, text-only model.
- **P2:** the price-change flag cleared itself on the next refresh. It is now sticky until an admin enables the model again.
- **P2:** an upstream "quota" 429 could switch off free AI for every tenant. Now only OpenRouter's `free-models-per-day` marker counts, and only for free and trial models.
- **P2:** AI-visibility answers were labelled web-grounded when no web search ran. Web search is now refused in free-only mode.
- **P2:** the cancel endpoint had no effect. The executor now checks it before every call.
- **P2:** one organization's ratings could steer rankings for everyone. Feedback is now down-weighted and capped per organization.
- **P2:** calls that named an explicit model bypassed the organization's routing policy. The policy is now applied at call time.

**Fixed (P3):**
- same-model retries now honour cooldowns;
- NaN attempt limits now fall back safely;
- approvals are bound to the requester;
- prototype keys in task classification;
- the feasibility check no longer allocates the input text;
- the routing policy's `maxAttempts` is applied;
- a `null` price no longer counts as zero;
- `/quality` is scoped to the caller's organization.

**Accepted (P3):** counters stay incremented when an abort arrives after reservation (it overcounts, which is safe).

See `PHASE-11-RESULTS` at the end of this file, filled in from the executed gate.

## 13. Remaining limitations and external dependencies

- **Live behaviour with a real key is BLOCKED here:** no OpenRouter key and no outbound inference.
  - The catalog was read from the live public endpoint, and pricing and classification were checked against it.
  - Inference, provider usage fields and live 429 texts are verified only against documented shapes, through fakes.
- **The quota is tight:** with fewer than 10 credits ever purchased (the account has about $2), OpenRouter allows **50 free requests per day** for the whole account.
  - One AI scan with discovery, specialists and synthesis can use 10+ requests.
  - Buying credits up to 10 lifetime raises this to 1,000 per day, still at $0 per request on free models (the router never spends credits).
  - The daily limit is a setting, and the provider's own figure is synced.
- **Token estimates are approximate.** Calibration only raises them.
- **Injection detection:** deterministic detection misses novel paraphrases, non-English attacks and double encoding, and may flag pages that use attack-like wording (see the detector header). The output guard and the tool-approval rules are the backstop. Neither is a guarantee.
- **Learning starts empty:** until real evaluations exist, rankings are LOW-confidence and rely on declared capabilities and a narrow benchmark prior. The dashboard says so.
- **Library only, so far:** `AgentSupervisor` and the tool registry are implemented and tested, but no product feature calls them yet. Today's agent flow is still the existing scan pipeline, now with bounded parallelism.
- **AI-visibility web search** is unavailable in free-only mode: billed web search is never sent with a free request, so `openrouter_web` reports "requires approval".
- **Not implemented:**
  - an evaluator-model grading pass (schema only, off by default);
  - an end-user multi-agent workflow UI;
  - tokenizer-exact counting.
- **Pacing scope:** the per-minute pace counts attempts in this database. Requests made with the same key elsewhere are only seen through the daily `/key` sync.

## PHASE-11-RESULTS (executed 23 Oct 2026, fresh PostgreSQL 16 cluster)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` (root and server) | pass |
| Type check (frontend, server) | pass / pass |
| Frontend tests | **297 passed** (27 files); 18 new Model Intelligence tests |
| Server tests (real PostgreSQL, `RUN_INTEGRATION=1`) | **1,380 passed** (97 files), 0 failed, 0 skipped |
| New Phase 11 server tests | `ai-router-v2` (52 policy tests), `ai-router.integration` (17, real DB), `ai-supervisor` (9), `ai-quota-executor` (4), `injection-detector` and `output-guard` (125), `observability-*` (37) |
| Migration verification | pass: fresh install, no-op re-run, and upgrades from `1ca145b` and `origin/main` through 041, with a schema identical to a fresh install |
| Migrate twice | pass |
| Build (frontend and server) | pass |
| `pnpm audit --prod` / server | No known vulnerabilities found / No known vulnerabilities found |
| Whitespace (`git diff --check`) | pass |
| Browser, signed-out smoke | **5 passed** |
| Browser, real API and database | **24 passed**, including the axe-core WCAG 2.2 scan of every navigable page (now including Model Intelligence) |
| Format (`oxfmt --check`) | fail: pre-existing since Phase 8, unchanged |

**Not executed:**
- live OpenRouter inference (no key here);
- live Sentry ingestion (no DSN);
- the DigitalOcean deployment;
- production migrations.
