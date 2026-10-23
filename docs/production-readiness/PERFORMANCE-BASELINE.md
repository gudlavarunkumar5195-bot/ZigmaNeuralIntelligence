# Performance baseline (Phase 10)

The numbers below are from this phase. They were reproduced with `server/scripts/perf-baseline.mts`, which refuses non-local databases. Raw results: `perf-before.json` and `perf-after.json` in this folder.

## Method

- **Database:** a fresh, migrated local PostgreSQL 16 database (`zni_perf`) for each run. "Before" ran without migration 040 and the code fixes; "after" ran with them.
- **Data:** synthetic, inserted with `generate_series`.
  - Search Console: 365 days × (1,500 queries + 300 pages + totals), about 657,000 `gsc_search_daily` rows.
  - 3,000 scans with 90,000 findings.
  - 20,000 monitoring snapshots.
  - 300,000 audit-log rows.
- **Requests:** real requests through the app with Fastify `inject`, covering routing, JWT and org-membership checks, validation, SQL and serialization, with no network. Each endpoint ran 15 times (5 for the 400-day overview). The table reports the median (p50) and the slowest run.
- **Under load:** 6 concurrent 90-day workspace overviews, while 5 sequential cheap database-backed requests (`GET /websites`) measure pool contention.
- **Machine:** a Windows 10 developer machine running Node 24.21 and PostgreSQL 16, client and server on the same host. Absolute numbers will differ in production; compare before and after only.

## Results (same data, same machine)

| Request | Before p50 / max | After p50 / max | Response size before → after |
| --- | --- | --- | --- |
| `GET /dashboard?websiteId=` | 133 / 269 ms | **7 / 118 ms** | **3,362,622 → 63,942 bytes** |
| Workspace overview, 28 days | 225 / 403 ms | 241 / 599 ms | 15,234 (unchanged) |
| Workspace overview, 90 days | 340 / 358 ms | 313 / 328 ms | 19,832 |
| Workspace overview, 400 days | 282 / 298 ms | 282 / 283 ms | 42,928 |
| `GET /analytics/overview?days=365` | 141 / 164 ms | 141 / 162 ms | 6,080 |
| `GET /websites?pageSize=100` | 1 / 2 ms | 1 / 2 ms | 452 |
| Cheap request during 6 concurrent overviews | p50 **66 ms**, max 308 ms | p50 **8 ms**, max 309 ms | — |

Seeding took 42 s before and 36 s after.

## What changed and why

- **Dashboard history was unbounded.** It returned every monitoring snapshot (20,000 rows, 3.4 MB on every dashboard load). It is now limited to the latest 365 points, oldest first, which is all the chart uses.
- **Overview fan-out.** The overview now runs at most 2 sections at a time instead of 9. Its own latency is essentially unchanged: one 28-day run had a 599 ms outlier, while the 90- and 400-day runs were slightly faster. Other requests no longer queue behind it: the median cheap request under load fell from 66 ms to 8 ms. The first cheap request still waited about 300 ms in both runs, because it lands behind the initial burst. With n=5 this tail is not statistically meaningful.
- **Server-side timeouts.** These are not a latency change: a pathological query (for example a large long-range Search Console aggregation) now fails after 30 s instead of holding a connection indefinitely.
- **Indexes (migration 040).** At this data size the analytics overview did not change (141 ms): the synthetic organization owns all rows, so an org-leading index cannot be selective. The indexes matter with many tenants. Their effect on a multi-tenant production database has not been measured.

## Not measured (and why)

- **Production-like latency** (network, managed PostgreSQL, multiple instances): no production or staging environment was available.
- **Crawl throughput and memory over long jobs:** a real crawl fetches external sites. Crawl memory is bounded by design (≤1,000 pages, parsed fields only), but this was not measured.
- **Frontend runtime:** bundle sizes come from the production build (`vite build`).
  - Largest chunks: `index` 363 kB (110 kB gzip) and the recharts `LineChart` 354 kB (103 kB gzip).
  - Every page is route-split with `lazy()`.
  - No code change was made to the bundle in this phase.
