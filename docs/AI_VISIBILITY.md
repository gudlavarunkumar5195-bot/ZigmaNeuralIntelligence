# AI search visibility (Phase 8)

How monitored brands appear in AI-generated answers: which answers name them, which sources those answers cite, and how that compares with chosen competitors. Every number comes from stored observations and is shown with its sample.

## What works today

- **Brands and competitors** per organization: official domains, aliases, product names, disambiguation phrases, topics, language/country, owner; edit, disable, archive (history kept).
- **Query library** with versions: editing what is asked creates an immutable new version; observations keep the version they used.
- **Manual import (always available):** CSV or JSON of answers a user observed in ChatGPT, Google AI Overviews / AI Mode, Perplexity, Gemini, Copilot, Claude, Meta AI or another assistant. Preview, row-level errors, duplicate detection, idempotent re-import. Imports are labelled “manually imported — not an API result” everywhere.
- **Provider collection (needs configuration):** OpenRouter model answers through the existing OX Alpha executor (AI budget, free-model gate, attribution, audit). Explicitly confirmed runs, per-organization daily quota, leased worker with retries, timeouts and cancellation, and an opt-in weekly schedule.
- **Observations, mentions and citations** with full provenance; exclusion from metrics is a traceable event, not a rewrite.
- **Metrics, competitor comparison, cited sources and opportunities**, computed deterministically.
- **Optional AI summary**: a model describes patterns; its output is schema-checked and may only reference evidence it was given.

What is **not** available, by design: no consumer AI product (ChatGPT, Google AI Overviews / AI Mode, Perplexity app, Gemini, Copilot, Claude apps) offers an API for monitoring what it shows users, so none is automated, scraped or logged into. Those sources are “import only”.

## Sources (`GET /providers`)

| Source | Status without configuration | What it provides |
| --- | --- | --- |
| `openrouter_answer` – model answer via OpenRouter | `not_configured` (no key) → `available` with a key and a free model | The model's answer to the query **without web search**. Brand mentions; URLs written in the text are recorded as “inline URLs”, never as provider citations. |
| `openrouter_web` – model answer with OpenRouter web search | `requires_approval` | Structured `url_citation` annotations. OpenRouter bills web search per request, so it stays off until an operator sets `AIV_WEB_SEARCH_ENABLED=true` after approving the cost. Not verified against the live service (no paid call was made). |
| `chatgpt`, `google_ai_overviews`, `google_ai_mode`, `perplexity`, `gemini`, `copilot`, `claude`, `meta_ai`, `other` | `manual_import_only` | Answers a user observed and imported. |

Statuses: `available`, `not_configured`, `requires_approval`, `model_not_allowed` (the configured model is not a verified free model and paid models are disabled), `manual_import_only`. Anthropic and Sarvam are not in the credential registry of this repository, so they are not offered.

A model's API answer is **not** what a consumer product shows; the UI and every metric group keep API data (`provider_api`) and imports (`manual_import`) apart.

The prompt (`aiv-prompt-1`) is the query as the user message. When the query or brand has a language or country, one system line asks for that language and states the country. Nothing else is added.

## Separate concepts

The data model never merges these:

1. **Answered:** `answer_status` is `answered` or `truncated`. Empty, refused and failed requests are not answers. Failed requests create no observation at all.
2. **Mentioned:** `aiv_mentions` lists the monitored brands whose name, alias, product or official domain appears in the text.
3. **Cited:** `aiv_citations` lists URLs, with `kind`:
   - `provider_annotation` or `provider_citation_list`: from the provider's structured response;
   - `inline_text_url`: written in the answer text;
   - `imported`: supplied in an import.
4. **Cited the brand's domain:** `cited_brand_id` is set when the host is an official domain of a monitored brand, or one of its subdomains.
5. **Verified:** `aiv_sources.verification_status` is set only when a user verifies the page.
6. **Collected through a supported integration:** `collection_method` is `provider_api` (it has a `run_id`) or `manual_import` (it has an `import_id`). Database constraints enforce exactly one of the two.

Every observation stores provenance:

- provider, surface and model;
- collection method, run or import, and the provider request ID;
- observed time, query ID, query version and query text;
- prompt version, language and country, and whether web grounding was used.

## Brand matching

- Whole words only, Unicode-aware and case-insensitive. Any whitespace between words matches.
- Short all-caps names of three letters or fewer (`HP`, `IBM`) match case-sensitively.
- A domain matches the domain and its subdomains (`docs.acme.com`). It does not match inside a longer host (`acme.com.au`, `notacme.com`).
- “Phrases that are not this brand” remove matches inside them, for example `Apple` inside `apple pie`.
- Overlapping matches of one brand count once.

Changing a brand's matching terms increments `config_version` and re-matches past answers whose full text is retained. The re-match is recorded as a `mentions_reprocessed` event. Answers whose text is not fully retained keep their earlier mentions. They are counted as `staleMentions` and shown in the UI.

## Citation URLs

- Only explicit `http(s)` URLs with a public-looking DNS host are accepted.
- These are rejected:
  - URLs with credentials;
  - IP literals;
  - single-label hosts;
  - reserved or internal suffixes (`localhost`, `.local`, `.internal`, `.test`, `.example`, `.invalid`, `.onion`, …);
  - malformed labels.
- The fragment and tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, …) are removed. All other parameters are kept.
- Punycode hosts are flagged `idn`, so look-alike domains are visible.
- The registrable domain is filled only for suffixes in a small curated list, otherwise it is `null`. This is not the full Public Suffix List.
- **Nothing is fetched automatically.** `POST …/sources/:id/verify` fetches one page on request:
  - robots.txt is honoured;
  - the fetch uses `safeFetch`, which applies SSRF checks to the URL and every redirect, pins the connection against DNS rebinding, and enforces size and time limits;
  - a daily cap of `AIV_VERIFY_MAX_PER_DAY` applies.
- A verification records whether the page loaded and whether its text names the brand. It does not check claims.

## Metrics (`GET /brands/:id/metrics`)

Metrics are computed per **group**: one collection method, provider and surface, plus the model for API collection. Groups are never added together. The default window is the last 90 days, and up to 20,000 newest observations are used (`truncated` is set beyond that). Excluded observations are not counted. Every value carries `numerator`, `denominator` and `smallSample` (denominator below `AIV_MIN_SAMPLE`, default 10). A `null` value means *no data*, never 0.

| Metric | Numerator | Denominator | Missing data |
| --- | --- | --- | --- |
| Mention rate | Answered observations naming the brand | Answered observations | No answered observations → no data |
| Query coverage | Queries with ≥1 answered observation naming the brand | Queries with ≥1 answered observation | Uncollected queries not counted |
| Share of observed mentions | Answered observations naming the brand | Σ over monitored brands (target + active competitors) of the same | No monitored brand mentioned → no data |
| Official-domain citation rate | Observations citing the brand's official domains | Observations with ≥1 citation | Observations without citations excluded |
| Citation share | Observations citing the brand's domains | Σ over monitored brands of the same | No monitored domain cited → no data |
| Competitor co-mention | Answered observations naming target and competitor | Answered observations naming the target | Target never named → no data |
| Consistency | Queries whose repeated answers all name, or all omit, the target | Queries with ≥2 answered observations | Single observations excluded |
| Most-cited source share | Observations citing the top host | Observations with ≥1 citation | No citations → no data |

The response also includes:

- first and last mention time;
- distinct cited hosts and the top hosts;
- a weekly trend, where a week without answers is `null`;
- the sample: answered and total counts, queries, languages, countries and date range.

The overview reports a “notable change” only between the last two weeks that each have at least the minimum sample, and only when the change is 20 points or more. There is no composite visibility score.

## Competitor comparison

Competitors are compared only within one group, so the provider, surface, model and method are the same. For each competitor, the comparison shows:

- mention rates and own-domain citation counts for both brands;
- queries where only the competitor is named, and queries where only the target is named, each with observation IDs;
- queries where both are named;
- cited hosts shared by answers naming either brand;
- an earlier-versus-later split. This is only shown when both halves have the minimum sample; otherwise it reads “Not enough history”.

## Opportunities

Opportunities are re-evaluated after each run, import, exclusion, verification and re-match, over the last 180 days. A user's status (`in_progress`, `done`, `dismissed`) is kept. Opportunities whose evidence disappeared become `obsolete`, and they reopen if the evidence comes back. Every change is recorded in `aiv_opportunity_events`.

| Kind | Rule |
| --- | --- |
| `frequently_cited_source` | A host that does not belong to a monitored brand is cited in ≥3 observations across ≥2 queries |
| `mentioned_not_cited` | The target is named in ≥2 answers that cite sources, but none cites its official domains (needs configured domains) |
| `competitor_only_queries` | For a query with ≥2 comparable answers, a competitor is named and the target never is |
| `insufficient_data` | Active queries with fewer than 3 answered observations (a coverage notice) |
| `unreachable_cited_source` | A source a user verified as unreachable is cited in ≥2 observations |

Every opportunity carries:

- supporting observation IDs, queries, brands and hosts or URLs;
- an explanation and a recommended action;
- its limitations;
- confidence, from sample size: high for 10 or more, medium for 5 or more, low otherwise;
- priority factors.

Priority is an **internal heuristic**: `round(100 × Σ(weight × value) ÷ Σ(weight))` over the factors that have data, with each value between 0 and 1. Recommendations only cover legitimate work: corrections, clear public pages, documentation, structured data and useful original content. No placements, spam or pages written only to target the question wording.

## Import format (`POST /brands/:id/imports/preview`, then `/imports`)

The import accepts CSV with a header row, or JSON (an array, or `{"observations": [...]}`).

| Field | Required | Notes |
| --- | --- | --- |
| `query` | yes | 3–500 characters (CSV aliases: prompt, question) |
| `observed_at` | yes | `YYYY-MM-DD` (00:00 UTC) or ISO 8601 date-time with time zone; not in the future, not before 2020 |
| `surface` | yes | `chatgpt`, `google_ai_overviews`, `google_ai_mode`, `perplexity`, `gemini`, `copilot`, `claude`, `meta_ai`, `other` (common spellings accepted); API results cannot be imported as such |
| `response` | yes | The answer text, up to 100,000 characters |
| `cited_urls` | no | CSV: separated by spaces or `|`; JSON: list of URLs or `{url, title}`; at most 50; one invalid URL rejects the row |
| `model`, `language`, `country`, `notes` | no | Language like `en`/`en-gb`, country two letters |

- Limits are `AIV_IMPORT_MAX_ROWS` rows and `AIV_IMPORT_MAX_BYTES` bytes.
- A duplicate is the same surface, model, query, language, country, time and answer text. Duplicates are skipped, whether they repeat within the file or match an earlier import.
- Re-importing an identical file returns the earlier import.
- Unknown queries are added to the library, unless the user turns that off. When it is off, such rows are rejected.
- Imported rows keep the observation time the user supplied.
- Exports sanitise CSV cells against spreadsheet formula injection.

## Runs and scheduling

- `POST /runs/preview` makes no provider call. It returns:
  - the request count (queries × repeats);
  - today's quota;
  - the model and a cost note (for web search: “not calculable here”);
  - provider limitations and every blocker.
- `POST /runs` requires `confirm: true` and accepts an optional `idempotencyKey`. A brand can have only one active run. Each run is limited to `AIV_MAX_REQUESTS_PER_RUN` requests, and each organization to `AIV_MAX_REQUESTS_PER_ORG_PER_DAY`. The route is rate-limited to 5 per minute per session.
- The worker takes one leased slice per tick, with bounded concurrency (`AIV_PROVIDER_CONCURRENCY`) and a timeout per request (`AIV_REQUEST_TIMEOUT_MS`):
  - transient errors re-queue the run with exponential backoff;
  - an item fails after 3 attempts;
  - a run gives up after 8 claims;
  - an exhausted quota, an exhausted AI budget, a missing provider or a disallowed model stops the run as `partial`;
  - cancellation stops after the current request.
- Weekly schedule (`PUT /schedule`): enabling needs `confirm: true`, an available provider, and a request limit that covers the active queries. The approval and every change are recorded as events.
  - One scheduled run per brand per ISO week, enforced by a unique index.
  - Updating a schedule never creates a run.
  - A run is skipped, never trimmed, if the active queries outgrow the approved limit.
- Every provider call is an `agent_executions` row attributed to the brand (`aiv_brand_id`) and counted against the organization's AI budget.

## AI summary (`POST /brands/:id/ai/summaries`)

This uses the platform default model through the executor. The input contains:

- the deterministic metrics;
- the top cited hosts;
- up to 12 answer excerpts, tagged with their IDs and wrapped as untrusted `<data>`.

The output must match a strict schema (summary, patterns with observation IDs, source categories from a fixed list, caveats). References to IDs or hosts that were not in the input are dropped, and the dropped count is returned. The summary is stored separately (`aiv_ai_summaries`) and labelled as interpretation. Without a configured key the endpoint returns `AI_NOT_CONFIGURED`, and everything else keeps working.

## API (`/api/v1/ai-visibility`, organization from `x-org-id`)

Reads need membership. Writes need the owner, admin or member role. A brand in another organization returns 404, and so does a competitor ID used as a brand ID. Path IDs are validated as UUIDs.

`GET /providers` · `GET|POST /brands` · `GET|PATCH /brands/:brandId` · `GET /brands/:brandId/overview` · `PUT …/schedule` · `POST …/reprocess` · `GET|POST …/competitors` · `PATCH …/competitors/:competitorId` · `GET|POST …/queries` · `PATCH …/queries/:queryId` · `GET …/queries/:queryId/versions` · `POST …/runs/preview` · `GET|POST …/runs` · `GET …/runs/:runId` · `POST …/runs/:runId/cancel` · `GET …/observations` (cursor) · `GET …/observations/:id` · `POST …/observations/:id/exclude|include` · `GET …/sources` · `GET …/domains` · `POST …/sources/:sourceId/verify` · `GET …/metrics` · `GET …/competitor-comparison` · `GET …/opportunities` · `GET|PATCH …/opportunities/:id` · `POST …/imports/preview` · `GET|POST …/imports` · `GET|POST …/ai/summaries` · `GET …/export?kind=observations|sources|metrics`.

Sensitive writes are audited (`aiv_*` actions): brand, competitor, query and schedule changes, runs, cancellations, imports, exclusions, verifications, opportunity updates, AI summaries and exports.

## Database (migration 038, additive)

Migration 038 adds the following tables, with tenant-scoped composite foreign keys, RLS enabled, and access revoked from `anon` and `authenticated`:

- `aiv_brands`, `aiv_queries`, `aiv_query_versions`;
- `aiv_runs`, `aiv_run_items`, `aiv_imports`;
- `aiv_observations`, `aiv_mentions`, `aiv_sources`, `aiv_citations`;
- `aiv_events`, `aiv_opportunities`, `aiv_opportunity_events`;
- `aiv_ai_summaries`, `aiv_provider_usage`.

It also adds `agent_executions.aiv_brand_id` (composite FK) and widens the `agent_executions_attributed` check to accept it. No existing data is changed, and no table is dropped. ClickHouse is not used: the volumes are small and PostgreSQL is the source of truth.

## Configuration

These are listed in `server.env.example`:

- `AIV_ANSWER_MODEL` (empty uses `OX_ALPHA_MODEL`)
- `AIV_WEB_SEARCH_ENABLED`, `AIV_WEB_SEARCH_MAX_RESULTS`
- `AIV_MAX_BRANDS_PER_ORG`, `AIV_MAX_COMPETITORS`, `AIV_MAX_QUERIES_PER_BRAND`
- `AIV_MAX_REQUESTS_PER_RUN`, `AIV_MAX_REQUESTS_PER_ORG_PER_DAY`
- `AIV_PROVIDER_CONCURRENCY`, `AIV_REQUEST_TIMEOUT_MS`
- `AIV_RESPONSE_MAX_CHARS` (0 keeps no answer text)
- `AIV_IMPORT_MAX_ROWS`, `AIV_IMPORT_MAX_BYTES`
- `AIV_MIN_SAMPLE`, `AIV_VERIFY_MAX_PER_DAY`

To enable collection:

1. An administrator adds the OpenRouter key in Admin → Integrations & API Keys.
2. The answer model must be registered as `FREE` in the model registry, unless paid models are approved.

## Known limitations

- Live collection has only been tested with a mocked model transport. No OpenRouter key was available, and no paid call was made. Web search is implemented but has not been verified.
- Mention matching is lexical. It cannot tell two organizations with the same name apart, beyond the exclusion phrases.
- Registrable domains come from a curated suffix list, so unknown suffixes give `null`.
- Answers whose text is not fully retained cannot be re-matched after a brand's terms change.
- Metrics read at most 20,000 observations per request.

## Tests

- **`server/src/tests/visibility-core.test.ts`** (unit) covers:
  - brand matching and disambiguation;
  - URL normalization and SSRF-relevant rejections;
  - inline URL extraction and provider citation parsing;
  - import validation;
  - metric formulas and missing data;
  - group separation, competitor comparison and opportunities;
  - AI output validation.
- **`server/src/tests/ai-visibility.integration.test.ts`** (PostgreSQL + HTTP, with a mocked model transport behind the real executor) covers:
  - tenant isolation on every route;
  - roles and validation;
  - CRUD and versions;
  - import preview, idempotency and duplicates;
  - provenance;
  - exact metric values from fixtures;
  - comparison;
  - the opportunity lifecycle;
  - exclusion events and verification outcomes, including SSRF refusal;
  - re-matching and CSV formula safety;
  - runs: confirmation, idempotency, retry, timeout, non-retryable failure, quota, cancellation and AI attribution;
  - schedule idempotency;
  - the AI summary validation.
- **`src/tests/ai-visibility-pages.test.tsx`** (UI) covers:
  - setup;
  - the unavailable-provider notice;
  - overview values, no-data and small-sample display;
  - error and empty states;
  - queries, versions and run preview/confirmation;
  - observation detail and exclusion;
  - citations and verification;
  - comparison;
  - recommendations;
  - import.
