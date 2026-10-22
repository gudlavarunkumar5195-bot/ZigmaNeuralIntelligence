# Keyword research and competitor intelligence

Phase 4. Keyword research (overview, ideas, related, organic keywords) and a competitor keyword gap, built on a provider-neutral interface. Every number shown comes from a named data source. When data is missing, the API returns an explicit unsupported or unavailable state. It never returns an estimate or a zero.

## What works today

The only implemented provider is **Google Search Console** (`google_search_console`, first-party). It reads the Search Console data that Phase 3 already synced into `gsc_search_daily`. It makes no extra Google call and has no per-request cost.

| Capability | Search Console provider | Notes |
| --- | --- | --- |
| `organic_keywords` | yes | Queries your website received impressions for, over the last 28 synced days |
| `keyword_ideas` | yes | Your queries containing every word of the seed |
| `related_keywords` | yes | Your queries sharing at least one word with the keyword |
| `keyword_overview` | yes | Exact matches; keywords with no data are listed as "no data, not zero", and the run is `partial` |
| `keyword_gap` | yes, limited | Competitors must be **other websites of your organization** with a linked Search Console property |
| `competitor_domains` | **no** | Needs a licensed provider |
| `serp_results` | **no** | Needs a licensed SERP provider |

| Metric | Available | Source |
| --- | --- | --- |
| clicks, impressions, CTR, average position | yes | Search Console, your own site only |
| search volume, keyword difficulty, CPC, competition | **no** | Needs a licensed keyword data provider. These are never estimated |

Limits of the Search Console data:
- It is a sample. Google omits anonymized queries and caps rows. This is why "missing" and "unique" in a gap mean "not observed in the sample".
- It covers only your own sites. It cannot be filtered by country, language or device here, so the API rejects targeting with `TARGETING_UNSUPPORTED`.

Live data needs Phase 3 to be configured: a Google OAuth client, a connected account, linked properties and a completed sync (see `docs/SEARCH_CONSOLE.md`). Without that, research returns `DATA_SOURCE_UNAVAILABLE` (422), with a link to Integrations in the UI.

## Configuration (server-only; names only, never commit values)

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEYWORD_RESEARCH_PROVIDERS` | `google_search_console` | Comma-separated enabled providers. Unknown ids fail config validation |
| `KEYWORD_RESEARCH_MAX_RUNS_PER_ORG_PER_DAY` | 200 | New (non-cached) runs per organization per 24 h; then `429 QUOTA_EXCEEDED` |
| `KEYWORD_RESEARCH_MAX_RESULTS` | 500 | Max keywords stored per run |
| `KEYWORD_RESEARCH_RETENTION_DAYS` | 400 | Runs older than this are pruned by the worker |
| `KEYWORD_RESEARCH_PROVIDER_TIMEOUT_MS` | 30000 | Per-call provider timeout, then `504 PROVIDER_UNAVAILABLE` |

A licensed provider, once implemented, would add its own credential variables, for example `<PROVIDER>_API_LOGIN` and `<PROVIDER>_API_KEY`. They would be stored as App Platform secrets. `GET /capabilities` reports missing settings by name only.

## Adding a licensed provider (requires owner approval: paid)

Implement `KeywordResearchProvider` (`server/src/research/providers/types.ts`):
- Declare exactly the capabilities, metrics, targeting, caching rules, attribution and cost note of the provider.
- Register it in `server/src/research/providers/registry.ts` and in the `KEYWORD_RESEARCH_PROVIDERS` allow-list (`config.ts`).

The service enforces the following, whatever an adapter returns:
- It drops undeclared or non-finite metrics.
- It deduplicates keywords.
- It caps the number of rows.
- It times out calls.
- It maps unknown failures to a safe `502` without leaking internals.

`server/src/tests/keyword-research-providers.integration.test.ts` is the contract test to extend for a new adapter. Use recorded or synthetic fixtures in it, never live calls in CI.

Candidates. Verify current pricing and terms with the vendor before approval; none is configured, and no paid call has been made:

| Provider | Data | Pricing model | Approval / notes |
| --- | --- | --- | --- |
| DataForSEO | Volume, CPC, competition, difficulty, ideas, SERPs, domain keywords, competitors | Pay-as-you-go per request, with a prepaid balance | API login and password; terms allow use in your own product |
| Semrush API | Keyword and domain analytics, competitors, gap | Subscription plan with API access, plus API units per row | Requires a plan that includes API units; check redistribution terms |
| Ahrefs API | Keywords Explorer, Site Explorer, competitors | Higher-tier subscription with API access | Check display and redistribution terms |
| Google Ads API (Keyword Planner) | Volume ranges, CPC bid ranges, competition, ideas | No per-call fee, but requires a Google Ads account and an approved developer token | Exact volumes may need active ad spend; ranges must be shown as ranges |

Never scrape these services' web interfaces, and never copy their datasets.

## Freshness, caching and retention

- Each run records `provider`, `observed_through` (the last data day), `sample`, `notes` and `created_at`. The UI shows all of these next to the results.
- An identical request (same org, website, kind and normalized parameters) is answered from the stored run when the provider allows caching. Search Console allows 60 minutes. The response then has `meta.reused = "cache"`. A concurrent identical request gets the running run (`"in_progress"`) and is not run twice.
- Runs, results, AI insights and list provenance are pruned after `KEYWORD_RESEARCH_RETENTION_DAYS`. Saved list items keep their keyword after the source run is pruned.

## Gap semantics

The gap is deterministic, in `classifyGap` in `server/src/research/keywords.ts`. Keywords are normalized before comparison: NFKC, lowercase, whitespace collapsed, edge punctuation stripped.

| Category | Meaning |
| --- | --- |
| `shared` | Observed for the customer and at least one competitor |
| `missing` | Observed for a competitor, not for the customer |
| `unique` | Observed for the customer, for no competitor |

`absence_from_sample` is true when the absence relies on a sampled dataset. `competitors_present` counts the competitors where the keyword was observed. A competitor without a permitted data source is listed in `summary.unavailable` and makes the run `partial`. If no competitor has data, the request fails with `422 COMPETITOR_DATA_UNAVAILABLE`.

Intent (`informational`, `navigational`, `commercial`, `transactional`) is rule-based. The matching rule is stored in `intent_rule`. Keywords that match no rule are `null` (shown as "unclassified"), never guessed.

## AI prioritization (optional, labelled)

`POST /runs/:id/insights` sends at most the top 40 rows of a run to the configured free AI model. The prompt contains keyword, returned metrics and rule-based intent only. The answer is validated:
- keywords not in the run, duplicates and invalid priorities are dropped;
- each item names its evidence and its missing data.

The result is stored and shown with an "AI-generated" label. Without `OPENROUTER_API_KEY` it returns `503 AI_UNAVAILABLE`, and everything else still works. Calls are attributed to the run (`agent_executions.research_run_id`) and count against the existing per-org AI budget.

## API (`/api/v1/keyword-research`, org-scoped via `x-org-id`, 404 across tenants)

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /capabilities` | any member | Providers, capabilities, metrics, missing configuration, limits |
| `POST /organic` `{websiteId, limit?}` | member+ | Your organic keywords |
| `POST /ideas` `{websiteId, seed}` | member+ | Ideas |
| `POST /related` `{websiteId, keyword}` | member+ | Related keywords |
| `POST /overview` `{websiteId, keywords[≤100]}` | member+ | Overview |
| `POST /gap` `{websiteId, competitors[1–5]}` | member+ | Keyword gap |
| `GET /runs?websiteId=&kind=&cursor=` | any member | History |
| `GET /runs/:id?sort=&order=&intent=&gap=&search=&cursor=` | any member | Run, paged results, insight, provider |
| `GET /runs/:id/compare/:otherId` | any member | Added, removed and changed keywords between two runs of the same kind and website |
| `GET /runs/:id/export` | member+ | CSV with source and date columns; formula injection neutralized |
| `POST /runs/:id/insights` | member+ | AI prioritization |
| `GET/POST /lists`, `GET /lists/:listId`, `POST /lists/:listId/items`, `DELETE /lists/:listId/items?keyword=`, `DELETE /lists/:listId` | read: any; write: member+ | Saved keyword lists (≤1000 items) |

Rate limits: 30 runs per minute, 20 exports per minute and 10 AI calls per minute per client, plus the daily org quota. The research POST endpoints also accept `country`, `language` and `device`. Providers that cannot honour them answer `TARGETING_UNSUPPORTED`.

Example with synthetic data:

```http
POST /api/v1/keyword-research/organic
{ "websiteId": "00000000-0000-0000-0000-000000000001" }

201
{ "data": { "run": { "kind": "organic", "provider": "google_search_console", "status": "completed",
    "sample": true, "observed_through": "2030-01-28", "result_count": 2, ... },
  "results": [ { "keyword": "example shoes", "metrics": { "clicks": 12, "impressions": 340, "ctr": 0.035, "position": 4.2 },
                 "intent": null, "intent_rule": null, ... } ] },
  "meta": { "reused": null, "nextCursor": null } }
```

### Errors

| Status | Code | When |
| --- | --- | --- |
| 422 | `CAPABILITY_UNSUPPORTED` | No enabled provider supports it (no run is created) |
| 422 | `TARGETING_UNSUPPORTED` | Country, language or device given to a provider that cannot filter |
| 422 | `DATA_SOURCE_UNAVAILABLE` | No linked or synced Search Console data for the website |
| 422 | `COMPETITOR_DATA_UNAVAILABLE` | No competitor has a permitted data source |
| 503 | `PROVIDER_NOT_CONFIGURED` | Credentials missing (names in `details.missing`) |
| 429 | `QUOTA_EXCEEDED` / `PROVIDER_RATE_LIMITED` | Org daily quota, or the provider's limit |
| 502 / 504 | `PROVIDER_UNAVAILABLE` | Provider failure or timeout (the run is stored as `failed`) |
| 503 | `AI_UNAVAILABLE` | AI not configured |

## Database (migration 033, additive)

The new tables are `research_runs`, `research_results`, `research_insights`, `keyword_lists` and `keyword_list_items`:
- Composite foreign keys tie `website_id` and `org_id` together, so no row can point across tenants.
- Row-level security is enabled on all of them, as on other tenant tables.

`agent_executions.scan_id` becomes nullable, and the new `research_run_id` column is added. A CHECK constraint requires one of the two to be set.

## Privacy

- Search inputs (`search`, `keyword`, `seed`, `q` query parameters) are redacted from request logs. POST bodies are not logged.
- A provider failure is logged with its run id and error class only.
- Research is visible to the organization's members only.

## Tests (no credentials needed)

```bash
pnpm --dir server test        # unit: normalization, intent, gap, snapshot comparison, log redaction
RUN_INTEGRATION=1 TEST_DATABASE_URL=postgres://.../throwaway pnpm --dir server test   # + API and provider contract against PostgreSQL
pnpm test                     # frontend pages with mocked API responses shaped like the backend's
```

The integration tests seed synthetic Search Console rows. A fake licensed provider is used to test sanitizing, timeouts, rate limits, configuration errors and AI grounding. No test calls a real provider.

## Known limitations

- Only first-party Search Console data is available. Search volume, difficulty, CPC, competition, SERPs and competitor discovery stay unsupported until a licensed provider is approved and implemented.
- Search Console gap analysis only works between websites of the same organization.
- Runs execute inside the request; they are not queued. This is fine for the database-backed provider. A slow licensed provider should move to the worker queue: the `research_runs.status = 'running'` state is already modelled.
- Ideas and related keywords are limited to queries your site already has impressions for. They do not discover new keywords.
