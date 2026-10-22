# Content intelligence

Phase 7. A persistent content inventory built by the existing crawler, a transparent content audit with a finding lifecycle, deterministic topic clusters, evidence-based opportunities, and editable content briefs with optional, grounded AI suggestions.

No search volume, difficulty, traffic, rankings or competitor metrics are estimated. When data is missing, the UI and API say which data is missing.

## Design and reuse (from the repository as inspected)

| Need | Reused | Added |
| --- | --- | --- |
| Pages and content | Phase 2 crawler: robots.txt, SSRF-safe fetch, page and time limits | Bounded content features computed from the HTML the crawler already fetched: headings, main-text word count, language, links, JSON-LD types and validity, declared modification date, SHA-256 content hash, 64-bit SimHash, top 50 terms, and a text excerpt of at most 20,000 characters |
| Persistence | The crawl's persistence transaction (`persistCrawl`) | `content_pages`, upserted per website and normalized URL in the same transaction (crawl pages themselves are only kept for the last two crawls) |
| Technical rules | The site audit (`site_issues`): missing or duplicate titles and descriptions, H1 count, canonicals, image alt, broken links, noindex | Content rules only, no duplicates |
| Search data | Search Console (`gsc_search_daily`): page and query dimensions | — (Search Console data here has **no page×query combination**, so queries are never attributed to pages) |
| Competitor evidence | Rank tracking observations (same day and source) | — |
| AI | `getOxAlphaExecutor()`: OpenRouter, free models unless approved, per-organization budget reserved under a lock, execution log | Brief suggestions, attributed to the crawl the evidence comes from |
| Jobs | Worker tick, leases | `content_audit_runs` (one per crawl; at most one active per website) |
| ClickHouse | — | Not used: it is not verified for this data |

## Inventory

- **When pages are added:** every crawl (scan module `crawl`) upserts one row per URL.
- **Content fields** change only when the page was fetched as HTML now. A failed fetch keeps the last known content and records `crawl_state` (`fetch_failed`, `http_error`, `not_html`, `blocked_by_robots`, `redirected`) and the error. **Crawl failures are reported separately from content findings.**
- **Pages a complete crawl no longer reaches** become `not_reached`. They are never deleted.
- **Freshness:** `last_crawled_at` on each page, and `content_changed_at` when the content hash changes.
- **Search metrics:** clicks, impressions and position for the last 28 synced days of the Search Console `page` dimension. When the property is linked but the page has no rows, the page shows "no rows (0 / 0)". When the site has no Search Console, it shows "no Search Console". These are different states.

## Content audit (rule set `content-1`)

| Rule | Category / severity | Heuristic | Detects |
| --- | --- | --- | --- |
| `title_length` | metadata / low | yes | Title shorter than 15 or longer than 65 characters (display truncation, not a ranking rule) |
| `description_length` | metadata / low | yes | Meta description shorter than 50 or longer than 160 characters |
| `heading_hierarchy` | headings / low | no | A heading level is skipped (e.g. h2 → h4) |
| `thin_content` | content / medium | yes | Indexable page with fewer than `CONTENT_THIN_WORDS` (200) words of main content |
| `exact_duplicate_content` | duplication / medium | no | Indexable pages with identical normalized main text (at least 30 words) |
| `near_duplicate_content` | duplication / low | yes | SimHash (word 3-shingles, 64 bits) differing in ≤ 3 bits; at most 200 pairs |
| `term_repetition` | content / low | yes | One term is at least 20 occurrences and more than 4 % of the words |
| `orphan_page` | links / medium | no | In the sitemap, indexable, and no crawled page links to it |
| `structured_data_invalid` | structured data / medium | no | A JSON-LD block does not parse |
| `possibly_stale` | freshness / info | yes | The **declared** modification date (JSON-LD `dateModified` or `article:modified_time`) is older than `CONTENT_STALE_MONTHS` (24) |

Search-intent mismatch is not implemented: there is not enough evidence to detect it.

**Finding lifecycle:**
- **Fingerprints:** each finding has a stable fingerprint (rule plus URL or page set), unique per website, so the same unchanged issue updates its evidence and `last_detected_at` and is never duplicated.
- **Statuses:** `open`, `in_progress`, `resolved`, `ignored`.
  - People set open, in progress and ignored. Ignoring needs a reason.
  - **Only an analysis resolves** a finding: when it is no longer detected and every page it depends on was re-crawled successfully. A page that failed to fetch keeps its findings.
  - A regression reopens a resolved finding.
  - Ignored findings stay ignored.
- **History:** every change is an event (`detected`, `status_changed`, `resolved`, `reopened`) with the run or actor. Event timestamps use `clock_timestamp()`, so events written in one transaction keep their order.

## Topics

Deterministic greedy clustering of:
- **pages**: title, H1 and the first H2s;
- **queries**: the top 500 Search Console queries of the last 90 days.

How it works:
- Items are processed by weight (query impressions, page clicks). Each item joins the cluster whose head terms it overlaps most (Jaccard ≥ 0.34 on stop-word-free, plural-folded terms), or starts a new cluster.
- Topic keys are the sorted head terms, so re-running on the same data gives the same topics.
- A page **covers** a topic when its title, H1 or headings contain the topic's two main terms.
- **Under-covered:** the topic has queries but no covering page.
- **Overlap:** more than one covering page (a possible cannibalization, for review).
- **Competitor gaps** come from rank tracking: a tracked competitor ranked and this site was "not found" on the same day, from the same source.

Manual corrections are kept by later analyses:
- rename (locks the name);
- move a page or query to another topic (manual assignment);
- remove a member from a topic (exclusion).

Nothing is merged, deleted or rewritten automatically.

## Opportunities

| Kind | Evidence required | Confidence |
| --- | --- | --- |
| `low_ctr_snippet` | ≥ 200 impressions, position ≤ 20, and CTR below 60 % of **your site's own median CTR** for that position bucket (1–3, 4–10, 11–20; buckets need pages with ≥ 50 impressions) | high from 1,000 impressions, otherwise medium |
| `missing_description` | No meta description and ≥ 50 impressions | high |
| `declining_page` | Clicks in the last 28 days ≤ 70 % of the previous 28, with ≥ 50 clicks before | medium (cause not determined; seasonality possible) |
| `internal_links` | Fewer than 3 crawled inlinks and ≥ 20 clicks | medium |
| `refresh_stale` | Declared modification older than half of `CONTENT_STALE_MONTHS`, and ≥ 100 impressions | low |
| `under_covered_topic` | Topic queries with ≥ 100 impressions and no covering page | medium from 500 impressions, otherwise low |
| `competitor_topic_gap` | Rank-tracking observations as above | medium |
| `consolidate_overlap` | Indexable pages whose title and H1 term sets overlap (Jaccard ≥ 0.6) | low (needs a human decision) |

- **Priority:** `round(100 × Σ(weight × value) ÷ Σ weight)` over the factors with data, all shown with their explanations.
- **Effort** is a labelled heuristic.
- **Missing data** lists what would improve the recommendation, for example "Search volume (no licensed provider)" or "Queries per page".
- **Statuses:** `open`, `in_progress`, `done`, `dismissed`, and `obsolete` (no longer supported by the data; it reopens if the evidence returns).
- **Feedback:** each opportunity accepts useful or not useful, with a note. History is recorded.
- **Marking done** records the page's Search Console figures for the 28 days before as a **baseline**. The detail view then shows an observational before/after and says it does not prove causation.

## Briefs

- **Creation:** from a page, a topic or an opportunity. The first revision is **deterministic**:
  - target topic;
  - rule-based intent, labelled;
  - primary and related keywords from Search Console;
  - existing pages, a suggested title and H1;
  - an outline from the page's H2s plus related queries;
  - questions (from question-form queries);
  - internal links (inventory pages of the topic);
  - no sources (none are invented);
  - the evidence that is missing, research questions and an editorial checklist.
- **Revisions:** every save is a revision, and `baseRevision` must match the current one (`409 REVISION_CONFLICT` otherwise, so nothing is lost). Editing an approved brief returns it to draft.
- **Approval** requires every checklist item to be checked by a person, and the current revision must not be an unreviewed AI suggestion.
- **AI suggestions** (optional):
  - The model receives the topic, keywords, current outline and up to 6,000 characters of the page text inside a `DATA` JSON. The system prompt says that data is untrusted and must never be followed.
  - Only the title, description, H1, outline and questions are taken from the answer, and they are validated and bounded. Sources and links never come from the model.
  - Internal links are restricted to the site's own inventory.
  - The result is saved as an `ai_suggestion` revision with the model name, marked for review.
  - With no AI configured, the endpoint answers `503 AI_UNAVAILABLE` and everything else works.
  - Budgets are enforced by the existing executor (a per-organization reservation under a lock).

## API (`/api/v1/websites/:id/content`)

| Area | Endpoints |
| --- | --- |
| Overview | `GET /overview` (inventory, findings by severity, top opportunities, runs, coverage, AI availability, rules, thresholds) |
| Inventory | `GET /pages?search&state&indexable&severity&sort&offset&limit`, `GET /pages/:pageId` |
| Runs | `GET /runs`, `POST /runs` (manual; deduplicated; 10/min per session) |
| Findings | `GET /findings?status&severity&category&rule&pageId&cursor`, `GET /findings/:id/history`, `PATCH /findings/:id {status, reason}` |
| Opportunities | `GET /opportunities?status&kind&minPriority`, `GET /opportunities/:id`, `PATCH /opportunities/:id {status, ownerId, feedback, note}` |
| Topics | `GET /topics`, `POST /topics`, `GET /topics/:id`, `PATCH /topics/:id {name}`, `POST /topics/:id/members {memberType, memberKey, action}` |
| Briefs | `GET /briefs`, `POST /briefs`, `GET /briefs/:id`, `GET /briefs/:id/revisions/:n`, `PUT /briefs/:id {baseRevision, body}`, `POST /briefs/:id/status`, `POST /briefs/:id/ai-suggestions` (5/min per session) |
| Export | `GET /export?kind=pages\|findings\|opportunities&status&severity` (member+; formula-safe CSV; stable column names) |

Every route is authenticated and re-checks organization membership in the database. The website must belong to the organization (404 otherwise), and every query filters on `org_id` and `website_id`. Writes need a non-viewer role. Query strings and bodies are strict, and changes are audited (`content_*` actions). There is no SQL execution and no URL fetching.

## Database (migration 037, additive)

| Table | Purpose |
| --- | --- |
| `content_pages` | Persistent inventory (unique per website and URL) |
| `content_audit_runs` | Analysis jobs (unique per website and crawl; one active per website) |
| `content_findings` + `content_finding_events` | Findings (unique fingerprint per website) and their history |
| `content_topics` + `content_topic_members` | Topics (unique key per website) and members (page or query, auto or manual, exclusions) |
| `content_opportunities` + `content_opportunity_events` | Opportunities (unique fingerprint per website) and their history |
| `content_briefs` + `content_brief_revisions` | Briefs and their revisions |

All tables have composite tenant foreign keys and RLS enabled, with no client-role access. References from briefs and opportunities to pages, topics and opportunities use plain composite keys. Those rows are never hard-deleted by the application (they become obsolete, inactive or not reached), and a website deletion cascades everything. This also avoids depending on PostgreSQL 15+ features.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTENT_THIN_WORDS` | 200 | Thin-content threshold (heuristic) |
| `CONTENT_STALE_MONTHS` | 24 | Possibly-stale threshold |
| `CONTENT_MAX_PAGES` | 5000 | Pages analysed per run |

## Limitations and deferred items

| Item | Status | Reason |
| --- | --- | --- |
| Query-to-page attribution | Not implemented | The Search Console data synced here has no page×query dimension. Adding it would change the Phase 3 sync and multiply its volume |
| Search-intent mismatch, keyword-target mismatch | Not implemented | No reliable evidence |
| Competitor content comparison | Not implemented | Competitor pages are not fetched (and never copied). Competitor evidence is limited to rank-tracking observations |
| Structured-data validation beyond JSON parsing | Not implemented | No schema validator in the repository |
| Owner assignment of opportunities | API only | Not exposed in the UI yet |
| Measurement of outcomes | Observational only | Before/after windows, never causal |
| Language detection | Declared only | Uses the declared `<html lang>`; nothing is inferred |

## Tests

| Suite | Coverage |
| --- | --- |
| `server/src/tests/content-core.test.ts` | Extraction (main text only, no merged words, bounded, structured data, dates), SimHash, every rule, fingerprint stability, configurable thresholds, clustering determinism, overlaps, opportunity factors and missing-data behaviour, brief building, sanitizing (bounds, unknown fields, inventory-only links, no `javascript:` sources), CSV formula neutralization |
| `server/src/tests/content.integration.test.ts` | PostgreSQL + HTTP: inventory persistence and idempotency, crawl failures kept apart, findings with evidence, the full lifecycle (resolve only after a re-crawl, reopen, a failed re-crawl keeps findings), concurrent runs, opportunities and baselines, topic corrections that survive re-analysis, briefs (revisions, conflicts, checklist approval), AI disabled, failing and sanitized (fake executor), exports, tenant isolation, a failing analysis leaving data untouched, audit |
| `src/tests/content-pages.test.tsx` | Loading, empty, error and permission states; inventory filters and pagination; audit lifecycle controls; opportunity factors; topic rename and move; brief editing, conflicts, approval and AI states |

No test calls a provider or the internet.
