# Backlink intelligence

Phase 5. Analyse a website's backlinks, compare referring domains with competitors, track new and lost links, and prioritize outreach. Everything shown comes from a named dataset or from our own live check. Authority scores, traffic, link counts or costs are never estimated.

## Implementation checklist (from the repository as it was)

- [x] Reuse the website-scoped API conventions (`/api/v1/websites/:id/...`): org membership checked in the database, 404 across tenants, non-viewer writes, audit, rate limits.
- [x] Reuse `safeFetch` for live checks: SSRF checks on the URL and every redirect, the connection pinned to the validated address against DNS rebinding, bounded redirects, timeouts and size caps. Reuse the crawler's robots.txt handling.
- [x] Reuse the worker tick for bounded, leased jobs, the cursor pagination helpers and the CSV writer that neutralizes formula injection.
- [x] Reuse the central integration registry for provider credentials. No licensed backlink provider exists, so it reports that state; nothing asks for a key.
- [x] Additive migration `035_backlinks.sql`: composite tenant foreign keys, unique keys for idempotency, RLS.
- [x] Replace the Backlinks placeholder page with a real section; Rankings stays a placeholder.
- [ ] Licensed provider adapter: needs a provider choice and cost approval (below).

## Data sources

| Source | Status | What it supplies |
| --- | --- | --- |
| **CSV import of an authorized export** | Available | Links (source URL; target URL, anchor, attributes, first and last seen, lost flag when the export has them), referring domains, history from repeated imports, and competitor data when you are entitled to a competitor's export |
| **Live link check** (ours) | Available | Whether the link is on the linking page right now, its rel attributes and anchor, and the HTTP status |
| Google Search Console API | **Not supported** | The API has no links endpoint. Use Search Console → Links → External links → Latest links → Export, then import the CSV |
| Licensed backlink index (Ahrefs, Semrush, Majestic, DataForSEO…) | **Not configured** | Not integrated. Automatic refresh, competitor discovery and provider metrics need one. It is paid and needs explicit approval |

### Recognised CSV columns

These are matched case-insensitively. Spaces and underscores are treated the same.

| Field | Header names |
| --- | --- |
| source URL (**required**) | `Source URL`, `Linking page` (Search Console), `Referring page URL` (Ahrefs), `Source url` (Semrush), `Source page`, `From URL`, `Backlink URL`, `Page URL` |
| target URL | `Target URL`, `Target page`, `Destination URL`, `To URL`, `Link URL` |
| anchor | `Anchor`, `Anchor text` |
| attributes | `Rel`, `Link type`, `Type`, `Attributes`, or the boolean columns `Nofollow`, `Sponsored`, `UGC` |
| first seen / last seen | `First seen`, `First indexed`, `Date found` / `Last seen`, `Last crawled` (Search Console), `Last checked` |
| lost | `Lost`, `Lost date`, `Lost link`, `Link status`, `Status` |

**Validation:**
- Limits: up to `BACKLINK_IMPORT_MAX_ROWS` rows (default 50,000) and `BACKLINK_IMPORT_MAX_BYTES` (default 10 MB). A file over the limit is refused, never partly imported.
- Encoding must be UTF-8. UTF-16 and mis-decoded files are refused with instructions.
- URLs must be http(s) with no credentials, at most 2,048 characters.
- Fields are at most 2,048 characters.
- Dates must be readable, from 1995 and not in the future; an unreadable date is left empty and counted in a warning.
- Blank rows are skipped. Identical links (same normalized source and target) are counted as duplicates and merged.

The preview reports accepted, rejected (with row numbers and reasons), duplicate and blank rows before anything is stored. Imported text is stored as text: it is never evaluated, and it is rendered as text in the UI. CSV exports prefix values starting with `=`, `+`, `-`, `@`, tab or CR with `'`.

Importing the same file again for the same subject returns the existing snapshot instead of creating a duplicate (`UNIQUE (org, website, subject, content hash)`).

### Normalization

- **URLs:** lowercase scheme and host, punycode host, default port removed, fragment removed. Path and query are kept.
- **Domains:** the host without a leading `www.`. There is no public-suffix list, so `blog.example.com` and `example.com` are different referring domains.
- **Link identity:** SHA-256 of the normalized source URL and target URL.

## Link states

| State | Meaning |
| --- | --- |
| `unverified` | Imported from an export; not checked by us |
| `verification_missing_once` | Our last check fetched the page and did not find the link (one miss is not a loss) |
| `unverified_check_failed` | Our check could not decide: page unreachable, not HTML, blocked by robots.txt, or an unsafe address |
| `verified_live` | Our check found the link on the page |
| `lost_verified` | Two consecutive checks of a reachable HTML page did not find the link |
| `provider_reported_lost` | The export itself marks the link as lost |

A link is never claimed live without a successful check.

## Live checks

- Run as jobs: `POST /verifications {datasetId}`, at most one active job per dataset (partial unique index).
- Each job checks up to `BACKLINK_VERIFY_MAX_LINKS` links (default 200), processed by the worker in leased 15-second slices of at most 40 links.
- Up to `BACKLINK_VERIFY_CONCURRENCY` sites in parallel (default 4), with each site's pages fetched one after another.
- robots.txt is honoured and cached per site within a slice.
- Pages are capped at 2 MB, with a 15-second timeout.
- A re-claimed job skips links already checked since it started (idempotent). A job interrupted 50 times is failed.

## History and changes

Every import is a snapshot of one subject (your site or a competitor). Each new snapshot is compared with the previous one by export date:

| Change | Rule |
| --- | --- |
| `new` | In the newer snapshot, not in the older |
| `lost` | Missing from a newer snapshot **declared complete**; or marked lost by the source; or two consecutive live checks did not find it |
| `potentially_lost` | Missing from a newer snapshot declared partial or unknown. An export can omit links, so this is **not** proof of removal |
| `anchor_changed` / `attributes_changed` | The same link with a different anchor or attribute. Unknown values never count as a change |
| `target_changed` | The same source page now links to a different page of the subject |

Change events are unique per (snapshot, link, type), so repeated imports and checks never duplicate them. A snapshot older than `BACKLINK_STALE_DAYS` (default 30) is flagged stale.

## Competitor gap

- **Inputs:** the latest snapshot of your site and of each selected competitor, as referring domains.
- **Categories:**
  - `shared`: seen linking to you and to a competitor.
  - `competitor_only`: seen linking to a competitor and **not observed in your data**. This is never proof that the domain does not link to you.
  - `own_only`: seen linking only to you.
- **Compatibility:** datasets must have links and must have been exported within 180 days of each other.
  - If you name a competitor whose dataset fails this, the request is refused with the reason (`DATASETS_INCOMPATIBLE`).
  - Without a selection, such competitors are left out and listed in the warnings.
  - Warnings are also shown for spreads over 30 days, mixed sources (different tools index the web differently) and coverage not declared complete.
- **Shared anchor texts:** the 25 most frequent anchors used in links to both you and a competitor.

## Opportunity score

Candidates are:
- every referring domain of the compared competitors that is not in your latest snapshot (`competitor_only`);
- every domain that linked to your site in an earlier snapshot but not in the latest (`reclaim`).

**score = round(100 × Σ(weight × value) ÷ Σ(weight))**, summed over the **available** signals only. **Basis** is the share of the total weight that was available. Integer weights keep the result exact.

| Signal | Weight | Value | Unavailable when |
| --- | --- | --- | --- |
| Competitor linking | 30 % | competitors linked from the domain ÷ competitors compared | no competitor compared |
| Topical relevance | 20 % | topic terms found in linking URLs or anchors ÷ min(3, number of terms), capped at 1 | no topic terms: none entered and no Search Console queries for the site |
| Follow links | 15 % | 1 if any link from the domain is followed, else 0 | the data has no link attributes |
| Freshness | 15 % | 1 if last seen ≤ 90 days ago, 0.5 if ≤ 365, else 0 | no last-seen dates |
| Verified live | 10 % | 1 if our check found a link from the domain, 0 if it found none | never checked |
| Prior relationship | 10 % | 1 if the domain linked to your site in an earlier snapshot | (always available) |

Topic terms come from the topics you enter or, when you enter none, from the site's top 15 Search Console queries of the last 90 days, when that data exists. The UI shows every signal's weight, value (or "unavailable") and evidence.

**Limitations:**
- This is a prioritization aid for outreach. It is **not a search-engine ranking factor** and uses no authority or traffic data.
- Topical relevance is plain term matching.
- Competitor links are only as complete as the exports provided.
- Outreach feasibility (contacts, relationships beyond earlier links) is not available.

## API (`/api/v1/websites/:id/backlinks`)

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /sources` | any member | Data sources, their status and capabilities; score weights; limits |
| `GET /summary` | any member | Latest own snapshot (counts, attributes, link states), competitors, recent changes, last check |
| `GET /datasets` | any member | Import history |
| `GET /links?subject=&dataset=&linkType=&state=&domain=&search=&sort=&order=&limit=&cursor=` | any member | Backlinks (cursor pagination, limit ≤ 200) |
| `GET /referring-domains?subject=&search=&sort=&limit=&offset=` | any member | Referring domains |
| `GET /changes?type=&subject=&limit=&cursor=` | any member | New and lost links |
| `GET /gap?competitors=a,b&category=&limit=&offset=` | any member | Referring-domain gap (30/min) |
| `GET /opportunities?competitors=&topics=&kind=&minScore=&linkType=&limit=&offset=` | any member | Scored opportunities with signals (30/min) |
| `POST /imports/preview` | member+ | Validate a CSV without storing it (30/min per session) |
| `POST /imports` | member+ | Import a CSV as a snapshot (20/min per session; audited) |
| `POST /verifications` / `GET /verifications/:jobId` | member+ / any | Start or read a live check (10/min; audited) |
| `GET /export?kind=links\|referring_domains\|opportunities\|changes` | member+ | CSV export (20/min; audited) |

Every route checks the website against the caller's organization and returns 404 otherwise. Every query filters on `org_id` and `website_id`, query strings are strictly validated (unknown parameters are rejected), and errors carry a code without internal details.

## Database (migration 035, additive)

| Table | Purpose |
| --- | --- |
| `backlink_datasets` | One snapshot per import |
| `backlink_links` | The links of a snapshot, `UNIQUE (dataset, link_key)` |
| `backlink_link_checks` | Latest live check per (website, link) |
| `backlink_changes` | Change events, `UNIQUE (snapshot, link, type)` |
| `backlink_verification_jobs` | Live-check jobs, one active per dataset |

Every table has `org_id`, a composite foreign key to `websites (id, org_id)` or to `backlink_datasets (id, org_id)`, and RLS enabled. Client roles have no access. Data lives in PostgreSQL only. ClickHouse is not used for backlinks; it can be added for long-term event analytics once its connectivity is verified in Admin → Integrations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKLINK_IMPORT_MAX_ROWS` | 50000 | Row limit per import |
| `BACKLINK_IMPORT_MAX_BYTES` | 10000000 | Size limit per import |
| `BACKLINK_STALE_DAYS` | 30 | When a snapshot is flagged stale |
| `BACKLINK_VERIFY_MAX_LINKS` | 200 | Links checked per live-check job |
| `BACKLINK_VERIFY_CONCURRENCY` | 4 | Sites checked in parallel |

## Adding a licensed provider (needs cost approval)

1. Choose the provider and approve its pricing.
2. Add it to the integration registry (`server/src/platform/integrations.ts`) with a no-cost validation call, so its key is entered once in Admin → Integrations & API Keys and read through `resolveSecret()`.
3. Add `'licensed_<id>'` to `backlink_datasets.source` in a new migration.
4. Write an adapter that produces the same `ParsedLink` records as the CSV path, declaring the fields it really supplies.
5. Add scheduled refresh jobs using the same lease and idempotency pattern.
6. Test it against recorded fixtures, never live calls.

## Tests

| Suite | Coverage |
| --- | --- |
| `server/src/tests/backlinks-core.test.ts` | Normalization, CSV parsing and validation, change detection (no false losses), gap, compatibility, scoring with missing inputs, link finding, check outcomes including robots and SSRF refusals |
| `server/src/tests/backlinks.integration.test.ts` | PostgreSQL + HTTP: preview, idempotent imports and limits, filters and pagination, history rules, gap and opportunities, verification jobs (idempotency, one miss vs two), exports, tenant isolation, audit |
| `src/tests/backlink-pages.test.tsx` | Loading, empty, stale, error, success, unsupported and incompatible states; import preview and import; export permission; data sources |

No test calls a provider or the internet.
