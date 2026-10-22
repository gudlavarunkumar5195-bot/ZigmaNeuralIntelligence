# Rank tracking and SERP intelligence

Phase 6. Track keyword positions for a website under a fixed search configuration, follow changes over time, compare competitors, see SERP features, and get evidence-based alerts. Every number comes from a stored observation and a documented calculation. Nothing is estimated, and a failed collection is never a ranking change.

## What works today

| Source | Status | Notes |
| --- | --- | --- |
| **Ranking-report import** | Available | Import a report from a rank-tracking tool you are entitled to use. This is the only source of rankings until a provider is approved |
| Licensed SERP data API | **Not configured** | No provider is integrated. Candidates (DataForSEO, SerpApi, Semrush and others) are paid, need explicit approval, and cannot be verified without an account. Scheduled tracking and **Refresh now** are disabled and say why |
| Google Search Console | **Not used** | It reports an average position over all impressions, not a position on one results page for one location and device. It stays under Search performance |

The provider-neutral adapter, scheduler and job processing are implemented and tested against a fake provider. A real provider plugs in without other changes (see below).

## Baseline and dependencies (as inspected)

- **Baseline:** main at `668ffd0` has a tree identical to the Phase 5 branch.
  - frontend 170/170, server 984/984 (with integration)
  - migrations verified, audits clean
  - the formatter check fails on 304 files (pre-existing)
- **Reused:**
  - website ownership and tenancy, RBAC, audit and rate limits
  - the cursor helpers and the CSV writer
  - keyword normalization from keyword research, and URL/domain normalization and the CSV parser from backlinks
  - the worker tick
  - the integration registry, for a future provider key
- **Not reused:** Search Console average position (not a SERP rank) and ClickHouse (not verified).

## Projects

A project is one website under one search configuration: engine (Google or Bing), country, language, device, an optional location, a time zone and a frequency.
- Keywords tracked under another configuration belong in another project, so they are never merged.
- Only one non-archived project may exist per website and configuration (unique index).
- `daily` and `weekly` frequencies need a configured provider that declares support for the engine, country, language, location and device. `manual` projects are filled by imports.
- Pausing or archiving a project cancels its active collection.

## Keywords and competitors

- Add keywords one per line or by CSV (`keyword`, optional `group` and `landing page`). Up to `RANK_MAX_KEYWORDS_PER_PROJECT` per project (default 500); the API refuses beyond that and says by how much.
- Keywords are normalized (NFKC, case, spacing) **within one project**. Language and device differences are separated by projects, not merged.
- Removing a keyword needs confirmation and is a soft delete: its history stays, and adding it again restores it.
- Competitors are domains, up to `RANK_MAX_COMPETITORS` (default 10). The project's own site is refused.

## Observations

Each observation is one keyword, one site (your own or a competitor), one day and one source.

| Status | Meaning |
| --- | --- |
| `ranked` | An observed position (1–1000) and, when known, the ranking URL |
| `not_in_results` | Not found down to `result_depth` (when the source states it). **No position is stored**: there is no "101" convention |
| `no_data` | The source has no value |
| `failed` | Collection failed. Never a ranking change |

Observations are unique per (keyword, site, day, source). A re-import adds nothing. A later successful collection replaces a failure for the same day, and nothing else is overwritten.

### Ranking-report import

- **Required columns:** keyword, date, position.
- **Optional columns:** URL, domain (your site or a project competitor), engine, country, language, device, depth, SERP features, owned features, result type.
- **Positions:** numbers are positions. `>100`, `not in top 50` and `-` mean not found (with a depth when stated). An empty cell means no data, and `failed` means failed.
- **Rejected rows** (with the row number and reason):
  - a future or unreadable date;
  - another engine, country, language or device than the project's;
  - a domain that is neither your site nor a competitor;
  - an owned feature that is not among the page's features;
  - an unreadable position, or a position beyond the stated depth.
- **Preview:** shows accepted, rejected, duplicate and blank rows, new keywords and statuses before anything is stored.
- **Idempotent:** importing the same file again changes nothing (content hash).
- **Limits:** `RANK_IMPORT_MAX_ROWS` (50,000) and `RANK_IMPORT_MAX_BYTES` (10 MB).

## Calculations

- **Comparable observations:** two observations of the same keyword and site from the **same source**. The project fixes the engine, location, language and device.
- **Change:** the latest observation against the latest earlier comparable one that is `ranked` or `not_in_results`.

  | Change | Rule |
  | --- | --- |
  | Improved / declined / unchanged | Both ranked; `delta = previous − current` (positive is better) |
  | Entered | Not found before; ranked now |
  | Dropped out | Ranked before; not found now, **and** the new check looked at least as deep as the old position |
  | No comparison | Failed or no data now, no earlier comparable observation, or a shallower search than the old position |

- **Distribution:** latest positions in buckets 1–3, 4–10, 11–20, 21–50, 51–100 and 101+. "Not found" and "no data" are counted separately.
- **Top-10 share** (the only visibility figure): for each day and source, keywords observed in positions 1–10 divided by keywords with a conclusive (`ranked` or `not_in_results`) observation that day. Excluded keywords are counted. No click-through curve, search volume or traffic is used.
- **Top ranking pages:** keywords whose latest observation ranks with that URL, with their average and best position.
- **Competitor comparison:** per keyword, the latest day on which both your site and the competitor have conclusive observations **from the same source**.
  - Relations: both ranked (and who is ahead), only you, only them, neither, or **not comparable**.
  - Missing data on either side is never read as one site outranking the other.
  - Competitor movement uses the same change rules.
- **SERP features:** canonical ids, from the latest observation per keyword: featured snippet, local pack, images, videos, shopping, People Also Ask, AI overview, top stories, sitelinks, knowledge panel, reviews, and `other:<name>`.
  - "Seen" means the feature was on the page.
  - "Yours" requires the report's owned-features column, or the provider attributing the feature to your URL. Presence alone never counts as ownership.

## Alerts (in-app)

| Rule | Fires when |
| --- | --- |
| `threshold_cross` | The latest comparable observation enters (or leaves) the top N |
| `position_change` | It moved by at least N positions |
| `url_change` | The ranking URL changed between two ranked comparable observations |
| `became_unavailable` | The last N comparable observations are "not found" after a ranked one, each check looking deep enough |
| `competitor_overtake` | On comparable days, the competitor was behind and is now ahead |
| `collection_failures` | The last N collections failed. This is the only rule a failure can trigger |

- Rules are evaluated after every import and every collection job.
- Each event is unique per (rule, triggering observation), so re-evaluation never duplicates it, and it records its evidence.
- `notify: none` silences a rule.
- Only in-app delivery exists, because no email provider is configured.

## Collection jobs (when a provider is configured)

- **Manual refresh:** `POST /refresh` creates one job, with at most one active job per project. A repeated request returns the active job.
- **Scheduler** (worker tick): queues today's job for due daily and weekly projects, at most one scheduled job per project and day (unique index).
- **Processing:**
  - leased slices of 25 keywords;
  - `RANK_PROVIDER_CONCURRENCY` parallel requests (default 2);
  - a 30-second timeout per request;
  - keywords already observed today are skipped, so restarts and re-runs never duplicate observations.
- **Errors:**
  - A non-retryable provider error records a `failed` observation for that keyword. It is not retried within the same job; a later job retries it.
  - A transient error re-queues the job with exponential backoff (30 s, doubling, up to 1 h).
  - After 8 claims, the remaining keywords are recorded as failed and the job fails.
  - A job whose worker died (expired lease) is reclaimed.
- **Quota:** `RANK_MAX_REQUESTS_PER_ORG_PER_DAY` (default 1,000) is checked before a refresh (`429 QUOTA_EXCEEDED`, with what is needed and what is left) and during collection. When it is used up, the job stops as `partial`.
- **Job states:** `queued`, `running`, `completed`, `partial`, `failed`, `cancelled`. Requests and failures are counted per organization, provider and day in `rank_provider_usage`.

## API (`/api/v1/rank-tracking`, organization from `x-org-id`)

| Area | Endpoints |
| --- | --- |
| Sources and usage | `GET /sources` |
| Projects | `GET /projects`, `POST /projects`, `GET /projects/:id`, `PATCH /projects/:id` (name, frequency, time zone, status) |
| Keywords | `GET /projects/:id/keywords?search&group&status&cursor`, `POST …/keywords`, `POST …/keywords/import`, `PATCH …/keywords/:kid`, `DELETE …/keywords/:kid {confirm:true}` |
| Competitors | `GET`/`POST …/competitors`, `DELETE …/competitors/:domain` |
| Imports | `POST …/observations/preview`, `POST …/observations/import`, `GET …/imports` |
| Rankings | `GET …/dashboard?group&from&to`, `GET …/rankings?group&change&search&sort&offset&limit`, `GET …/keywords/:kid/history?from&to`, `GET …/serp-features`, `GET …/competitor-comparison?competitor` |
| Jobs | `POST …/refresh`, `GET …/jobs`, `POST …/jobs/:jid/cancel` |
| Alerts | `GET`/`POST …/alert-rules`, `PATCH …/alert-rules/:rid`, `GET …/alerts?unacknowledged&cursor`, `POST …/alerts/:eid/acknowledge` |
| Export | `GET …/export?kind=rankings\|history\|keywords` (member+, formula-safe CSV) |

Every route is authenticated and re-checks organization membership in the database. A project is only reachable through its organization (404 otherwise). Writes need a non-viewer role. Inputs and query strings are strict (unknown parameters are rejected) and pagination is bounded. Refresh, import and export are rate-limited, and changes are audited (`rank_*` actions).

## Database (migration 036, additive)

| Table | Purpose |
| --- | --- |
| `rank_projects` | Projects |
| `rank_keywords` | Tracked keywords |
| `rank_competitors` | Competitor domains |
| `rank_imports` | Ranking-report imports |
| `rank_observations` | Observations; indexed by keyword, site and date for history, and by project and date for dashboards |
| `rank_collection_jobs` | Collection jobs |
| `rank_provider_usage` | Requests and failures per organization, provider and day |
| `rank_alert_rules` | Alert rules |
| `rank_alert_events` | Alert events |

All tables are tenant-scoped through composite foreign keys, with RLS enabled and no client-role access. Data stays in PostgreSQL. There is no retention pruning: history is kept, and any future aggregation or retention policy will be documented before it is applied.

## Adding a SERP provider (needs cost approval)

1. Choose a provider whose terms allow storing results, and approve its pricing.
2. Register its key in the integration registry (`server/src/platform/integrations.ts`) with a no-cost validation call, so it is entered once in Admin → Integrations & API Keys and read through `resolveSecret()`.
3. Implement `SerpProvider` (`server/src/ranking/providers.ts`), declaring only what its documentation guarantees: engines, targeting, devices, depth, features, history, rate limit and cost. Add it to `rankProviders()`.
4. Extend `server/src/tests/rank-tracking-provider.integration.test.ts` with recorded responses. Never make live calls in tests.

## Configuration

| Variable | Default |
| --- | --- |
| `RANK_MAX_KEYWORDS_PER_PROJECT` | 500 |
| `RANK_MAX_COMPETITORS` | 10 |
| `RANK_MAX_REQUESTS_PER_ORG_PER_DAY` | 1000 |
| `RANK_IMPORT_MAX_ROWS` | 50000 |
| `RANK_IMPORT_MAX_BYTES` | 10000000 |
| `RANK_PROVIDER_CONCURRENCY` | 2 |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "No comparison" everywhere | Only one observation per keyword so far, or the observations come from different sources. Import a second report from the same tool |
| Rows rejected for device or country | The report is for another configuration. Create a project for it |
| Competitor rows rejected | Add the domain as a competitor first |
| Refresh says the provider is not configured | Expected until a provider is approved. Import reports instead |
| A job is stuck in `queued` with a "Retrying" error | The provider is failing transiently. It backs off and gives up after 8 attempts |

## Tests

```bash
pnpm --dir server test
RUN_INTEGRATION=1 TEST_DATABASE_URL=postgres://…/throwaway pnpm --dir server test
pnpm test
```

| Suite | Coverage |
| --- | --- |
| `ranking-core.test.ts` | Parsing, changes, aggregates, competitor comparison, alert rules |
| `rank-tracking.integration.test.ts` | No-provider flows, imports, alerts, isolation and RBAC |
| `rank-tracking-provider.integration.test.ts` | Fake provider: jobs, retries, quotas, scheduling, recovery |
| `rank-tracking-pages.test.tsx` | UI states |
