# Unified SEO workspace (Phase 9)

The **SEO workspace** at `/intelligence/workspace` brings each module's real data for one website and one date range into one place. It adds:
- cross-module insights;
- an action center that does not duplicate source records;
- integration health;
- reports and CSV exports;
- an optional AI explanation.

It does not copy metrics: every number is read from the module that owns it.

## Integration map (what is reused)

| Module | Read through | Range support |
| --- | --- | --- |
| Search Console | `search-performance.service` `performance()`, `topRows()`, `compareMetrics()`; `gsc_properties`, `gsc_coverage`, `gsc_search_daily` | Full: daily data, Pacific Time days |
| Technical audit | `site-audit.service` `getCrawlOverview()`; `site_issues`, `site_issue_events`, `crawl_summaries`, `crawl_pages` | Latest-crawl snapshot + issue events in range |
| Rank tracking | `rank_projects`, `rank_keywords`, `rank_observations`, `rank_alert_events` (same comparison rules as the module) | Full: observations in range |
| Backlinks | `backlinks.service` `getSummary()`, `opportunities()`; `backlink_changes` | Latest-import snapshot + changes in range |
| Content | `content.service` `overview()`; `content_finding_events`, `content_opportunities`, `content_briefs` | Inventory snapshot + finding events in range |
| AI visibility | `ai-visibility.service` `getMetrics()` for brands linked to the website (`aiv_brands.website_id`) | Full: observations in range |
| Keyword research | `research_runs` | Snapshot (latest runs) |
| Jobs | `scans`, `gsc_sync_jobs`, `content_audit_runs`, `backlink_verification_jobs`, `rank_collection_jobs`, `aiv_runs`, `research_runs` | — |

The existing scan-score home page (`/`) is unchanged.

## API (`/api/v1/websites/:id/seo-workspace`, organization from `x-org-id`)

Every route needs authentication and organization membership. The website must belong to the caller's organization, otherwise the response is 404. Every source query is scoped by `org_id` and `website_id`. Writes need the owner, admin or member role, and are audited (`seo_*` actions).

| Route | Purpose |
| --- | --- |
| `GET /overview?preset&from&to&compare` | All sections plus the summary, completeness, jobs, top insights and top actions |
| `GET /integrations` | Health from job timestamps and recorded statuses |
| `GET /insights`, `GET /insights/:id`, `PATCH /insights/:id`, `POST /insights/refresh` | Insights explorer and lifecycle |
| `GET /actions`, `PATCH /actions`, `GET /actions/history` | Action center |
| `GET /report` | Report as JSON |
| `GET /report.md` | Report download as Markdown |
| `GET /export?dataset=actions\|insights\|search_pages\|search_queries\|issues\|rankings` | CSV export |
| `POST /summary` | Optional AI explanation |

Responses are `no-store`. No cache is used, because correctness is easier to guarantee than with cache invalidation across nine modules. Reads are rate-limited per session.

## Date ranges

- **Presets:** last 7, 28 or 90 days, ending **yesterday in Pacific Time**. Search Console reports days in PT, and no source has a complete "today".
- **Custom ranges:** must be real days, not in the future, at most 480 days long, and within the last 480 days (Search Console's history). Invalid ranges return `400 INVALID_RANGE`.
- **Comparison:** the preceding period with the same number of days, or none.
- **Timestamps:** timestamp-based events (issue events, backlink changes, AI observations) are bucketed into PT days the same way.
- **Range support:** each section states `full`, `events_only` or `snapshot`, so modules that cannot honour the range say so.
- **URL state:** the range lives in the URL (`?preset=&from=&to=&compare=`), so it is kept across tabs and reloads. The website uses the existing selected-website store.

## KPI rules

- **Clicks and impressions:** sums over synced days. CTR is clicks ÷ impressions over the range. Position is the impression-weighted average.
  - These come from the Search Console module unchanged.
  - Unsynced days are reported, and the section becomes `partial`.
  - A day with no row in a complete total answer counts as 0. A day that was never synced is "No data".
- **Changes:** reported only when both periods have synced data, otherwise `null` ("no comparison"). Missing values are never treated as zero.
- **Search movers:** the five pages and five queries with the largest absolute click change between the two periods. Only computed when the previous period has data.
- **Technical:** open `site_issues` by severity. "New" means DETECTED plus REOPENED events in the range; "fixed" means FIXED events. Other counts:
  - broken internal link targets (`broken_internal_link`);
  - canonical issues (`canonical_*`);
  - indexability of the latest crawl.
  - **There is no technical health score.**
- **Rankings:** the latest observation in the range per keyword, compared with the latest earlier conclusive observation from the same source. This matches the rank-tracking module's rules: improved, declined, unchanged, entered, dropped out, or no comparison. Keywords without an observation get no position.
- **Backlinks:** counts from the latest imported dataset, together with its source label, coverage and date. They are never presented as internet-wide. New and lost links are `backlink_changes` within the range.
- **AI visibility:** per brand linked to the website, the target's mention and citation rates per provider and surface, with sample sizes.

## Section envelope and partial failure

Each section is `{ module, status, freshness, range: { support, note }, notes[], link, data }`.

**Status** is one of `ok`, `partial`, `no_data`, `not_configured`, `auth_expired`, `error` or `timeout`.

**Freshness** is `fresh`, `stale` or `never`, with the following stale thresholds:

| Module | Stale after |
| --- | --- |
| Search Console last successful sync | 48 h |
| Crawl | 14 days |
| Backlinks | `BACKLINK_STALE_DAYS` |
| Rankings | 48 h (daily projects), 9 days (weekly), 30 days (manual) |
| Content | 14 days |
| AI visibility | 30 days |

**Failure isolation:** sections are collected concurrently, each with a 10-second timeout. A failing or slow module becomes an `error` or `timeout` section with a generic message; details go to the server log. The rest of the dashboard is returned.

## Insights (`seo_insights`, rules `insights-1`)

Insights are created only when every piece of evidence exists, and each one references its source records. The rules are:

| Rule | Evidence required |
| --- | --- |
| `low_ctr_with_snippet_issue` | A page with ≥100 impressions and a CTR below half the site's CTR, **and** an open title or meta-description site issue or content finding for that URL |
| `search_page_not_indexable` | A page with ≥10 impressions that the latest crawl found not indexable |
| `broken_links_on_landing_page` | An open `broken_internal_link` issue whose recorded linking pages include one of the 20 pages with the most clicks |
| `declining_keyword_with_page_issue` | A tracked keyword that declined or dropped out, whose ranking or landing page has an open medium-or-higher issue |
| `competitor_outranks_with_backlink_evidence` | A competitor ahead on ≥2 keywords in same-day, same-source observations, **and** an imported backlink dataset for that competitor |
| `ai_cited_source_without_link` | A third-party host cited in ≥2 AI answers that is not a referring domain in the latest own backlink dataset |

How insights behave:
- **Evaluation:** they are evaluated on request (`POST /insights/refresh`, Re-evaluate for this range). Rules whose inputs are missing are skipped, and the reason is stored and shown.
- **Upsert:** upserts use a stable fingerprint, so there are no duplicates.
- **Status:** the user's status (`in_progress`, `resolved`, `dismissed`) is kept. Insights whose evidence disappears become `obsolete`, and reopen if it returns.
- **History:** every change is an event.
- **Correlation:** cross-module relationships are labelled as **correlations**. No rule claims a cause.
- **Priority:** `round(100 × Σ(weight × value) ÷ Σ(weight))` over factors that have data.
- **Confidence:** comes from sample size.

## Action center

Actions are computed on every read from these sources:
- open `site_issues` (critical, high and medium);
- open or in-progress `content_opportunities`;
- high-severity `content_findings`;
- open `seo_insights`;
- `aiv_opportunities` of linked brands;
- unacknowledged `rank_alert_events`;
- the top 20 computed backlink opportunities;
- integration problems.

Nothing is copied. `seo_action_states` stores only the user's workflow (status, owner, due date, note), keyed by `(website, source, source_ref)` with an idempotent upsert. Changes are recorded in `seo_action_events`.

- **Source resolved:** when the source resolves (issue fixed, opportunity done or obsolete), the action disappears. Its stored state remains for history.
- **Validation:** updating an action checks that it currently exists for the website, so other websites' or tenants' references are refused.

Priority comes from each source's documented priority:

| Source | Priority |
| --- | --- |
| Critical issue | 95 |
| High issue | 80 |
| Medium issue | 55 |
| High content finding | 70 |
| Rank alert | 60 |
| Backlink opportunity | score × 0.8 |
| Integration: auth expired | 85 |
| Integration: failed job | 70 |
| Integration: stale | 50 |
| Integration: setup | 40 |

Effort is a labelled heuristic per kind of work. Every action links to its module to make the actual fix; the workspace never changes a website, DNS or configuration.

## Integration health

Health covers Search Console, crawl engine, keyword data, backlink data, rank tracking, AI visibility, content analysis, background jobs and the database. It is computed from recorded statuses and job timestamps only:
- no provider is called;
- stored credentials alone never count as healthy;
- no secret is returned.

**States:** `healthy`, `stale`, `configuration_required`, `auth_expired`, `provider_unavailable`, `recent_job_failed`, `not_supported`, `unknown`.

**Background jobs:** shown as `unknown` when the worker does not run in the API process.

## Reports and exports

- **`GET /report`:** returns the executive summary, the selected sections, completeness, the top 25 actions, data sources, definitions and limitations.
- **`GET /report.md`:** the same report as a Markdown file. All values from data are escaped. No PDF library was added: the repository has none, and a new rendering dependency would need a security and maintenance review.
- **CSV exports:** use the existing formula-safe `toCsv`.
- **Access:** exports and the Markdown download need a non-viewer role, are scoped to the website, and are audited.

## AI explanation (optional)

`POST /summary` uses the existing executor (free-model gate, budget), attributed to the website's latest scan.
- **Input:** the deterministic summary, section statuses and insight titles. No crawled or imported text is included.
- **Output:** must match a strict schema. Every point must cite a provided source key, and others are dropped. Extra fields, such as invented numbers, reject the whole output.
- **Separation:** the deterministic summary is always shown, and the AI text is labelled as interpretation.
- **When AI is not configured:** the endpoint returns `AI_NOT_CONFIGURED` and nothing else changes.

## Database (migration 039, additive)

Migration 039 adds `seo_insights`, `seo_insight_events`, `seo_insight_runs`, `seo_action_states` and `seo_action_events`. All have composite foreign keys to `websites(id, org_id)`, have RLS enabled, and have access revoked from `anon` and `authenticated`. It does not change existing tables or copy source data. ClickHouse is not used.

## Tests

- **`server/src/tests/workspace-core.test.ts`** (unit) covers:
  - date ranges (presets, PT boundary, validation);
  - freshness;
  - null-vs-zero changes;
  - timeout and error isolation;
  - URL matching and rank change rules;
  - categories and sorting;
  - Markdown escaping;
  - every insight rule, including skips and non-matches;
  - the deterministic summary;
  - AI output validation.
- **`server/src/tests/seo-workspace.integration.test.ts`** (PostgreSQL + HTTP) seeds every module through its own code paths or tables. It covers:
  - aggregation with exact values;
  - tenant isolation;
  - range validation and custom ranges;
  - a simulated module failure;
  - insight evaluation, idempotency and lifecycle;
  - action aggregation, state persistence, idempotency and history;
  - integration health;
  - report and export access;
  - CSV formula safety and audit entries;
  - AI validation.
- **`src/tests/seo-workspace-pages.test.tsx`** (UI) covers:
  - KPIs with zero vs no data;
  - partial and missing modules;
  - website and range changes kept in the URL;
  - range errors;
  - AI labelling and permission errors;
  - the insights explorer;
  - the action center;
  - integration states;
  - report preview and export errors.

## Known limitations

- Insights are evaluated on request, not on a schedule.
- Search Console page URLs are matched to crawl and issue URLs after normalization (host without `www`, no trailing slash, no fragment). Pages served under different URL variants may not match.
- Each action source is capped (200 per source, top 20 backlink opportunities). Larger backlogs stay complete in their own modules.
- Keyword volume and difficulty are unavailable: no licensed provider is integrated.
