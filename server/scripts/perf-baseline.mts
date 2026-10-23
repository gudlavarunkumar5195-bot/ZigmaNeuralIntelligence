// Reproducible performance baseline for the hottest read paths, run in-process
// against a THROWAWAY local PostgreSQL database (migrated first). It bulk-loads
// synthetic data with generate_series and times real requests through the app
// (Fastify inject: routing, auth, validation, SQL, serialization; no network).
//
//   DATABASE_URL=postgresql://…@127.0.0.1:…/zni_perf JWT_SECRET=<32+ chars> COOKIE_SECRET=<32+ chars> \
//     node --import tsx scripts/perf-baseline.mts [out.json]
//
// Nothing here calls an external service.
import fs from "node:fs";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/perf|test|ci|e2e/i.test(url.pathname)) {
  console.error("Refusing to run: DATABASE_URL must be a local throwaway database (name containing perf/test/ci/e2e).");
  process.exit(1);
}

const { buildApp } = await import("../src/app.ts");
const { query, closePool } = await import("../src/db/client.ts");

const SIZE = {
  gscDays: 365,
  gscQueries: 1_500, // rows per day in the "query" dimension
  gscPages: 300,
  scans: 3_000,
  findingsPerScan: 30,
  snapshots: 20_000,
  auditRows: 300_000,
};

async function seed() {
  const t = Date.now();
  const org = (await query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ('Perf', 'perf-' || md5(random()::text)) RETURNING id")).rows[0].id;
  const user = (await query<{ id: string }>("INSERT INTO users (email, password_hash, full_name) VALUES ('perf-' || md5(random()::text) || '@perf.test', '!x', 'Perf') RETURNING id")).rows[0].id;
  await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')", [user, org]);
  const site = (await query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified, created_by) VALUES ($1,'https://perf-site.test','perf-site.test',TRUE,$2) RETURNING id", [org, user])).rows[0].id;
  const integ = (await query<{ id: string }>("INSERT INTO integrations (org_id, provider, external_account_id, scopes, refresh_token_enc, key_id, status) VALUES ($1,'google_search_console','perf','{}','k1.x.y.z','k1','active') RETURNING id", [org])).rows[0].id;
  const prop = (await query<{ id: string }>("INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level, last_sync_success_at) VALUES ($1,$2,$3,'sc-domain:perf-site.test','domain','siteOwner',NOW()) RETURNING id", [org, site, integ])).rows[0].id;

  // Search Console: daily totals, queries and pages for a year, with complete coverage.
  await query(`INSERT INTO gsc_coverage (property_id, org_id, dimension_set, day, outcome, row_count, data_state)
    SELECT $1, $2, ds, d::date, 'complete', 1, 'final' FROM generate_series(CURRENT_DATE - $3::int, CURRENT_DATE - 1, '1 day') d, unnest(ARRAY['total','query','page']) ds`, [prop, org, SIZE.gscDays]);
  await query(`INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state)
    SELECT $1, $2, 'total', d::date, '', 500, 20000, 0.025, 8, 'final' FROM generate_series(CURRENT_DATE - $3::int, CURRENT_DATE - 1, '1 day') d`, [prop, org, SIZE.gscDays]);
  await query(`INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state)
    SELECT $1, $2, 'query', d::date, 'keyword ' || q, (q % 7), 10 + (q % 90), (q % 7)::float / (10 + (q % 90)), 1 + (q % 60), 'final'
      FROM generate_series(CURRENT_DATE - $3::int, CURRENT_DATE - 1, '1 day') d, generate_series(1, $4::int) q`, [prop, org, SIZE.gscDays, SIZE.gscQueries]);
  await query(`INSERT INTO gsc_search_daily (property_id, org_id, dimension_set, day, dim_value, clicks, impressions, ctr, position, data_state)
    SELECT $1, $2, 'page', d::date, 'https://perf-site.test/p/' || p, (p % 11), 20 + (p % 70), (p % 11)::float / (20 + (p % 70)), 1 + (p % 40), 'final'
      FROM generate_series(CURRENT_DATE - $3::int, CURRENT_DATE - 1, '1 day') d, generate_series(1, $4::int) p`, [prop, org, SIZE.gscDays, SIZE.gscPages]);

  // Scan history with findings, monitoring snapshots, and a large audit log.
  await query(`INSERT INTO scans (website_id, org_id, triggered_by, status, modules, started_at, completed_at, created_at)
    SELECT $1, $2, $3, 'completed', '{seo}', NOW() - (n || ' hours')::interval, NOW() - (n || ' hours')::interval, NOW() - (n || ' hours')::interval
      FROM generate_series(1, $4::int) n`, [site, org, user, SIZE.scans]);
  await query(`INSERT INTO findings (scan_id, website_id, org_id, module_name, category, severity, title, description, created_at)
    SELECT s.id, s.website_id, s.org_id, 'seo', 'seo', (ARRAY['critical','high','medium','low','info'])[1 + (f % 5)], 'Finding ' || f, 'Synthetic finding', s.created_at
      FROM scans s, generate_series(1, $2::int) f WHERE s.org_id = $1`, [org, SIZE.findingsPerScan]);
  await query(`INSERT INTO monitoring_snapshots (website_id, org_id, overall_score, seo_score, captured_at)
    SELECT $1, $2, 60 + (n % 40), 60 + (n % 30), NOW() - (n || ' minutes')::interval * 30 FROM generate_series(1, $3::int) n`, [site, org, SIZE.snapshots]);
  await query(`INSERT INTO audit_log (user_id, org_id, action, resource_type, result, timestamp)
    SELECT $1, $2, CASE WHEN n % 1000 = 0 THEN 'admin_user_deactivated' ELSE 'login' END, 'user', 'success', NOW() - (n || ' seconds')::interval
      FROM generate_series(1, $3::int) n`, [user, org, SIZE.auditRows]);
  await query("ANALYZE");
  return { org, user, site, seedMs: Date.now() - t };
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(pick(0.5)), p95: Math.round(pick(0.95)), max: Math.round(s[s.length - 1]) };
}

const app = await buildApp();
await app.ready();
const ids = await seed();
const token = app.jwt.sign({ sub: ids.user, email: "perf@perf.test", orgIds: [ids.org] });
const headers = { authorization: `Bearer ${token}`, "x-org-id": ids.org };

async function time(path: string, runs = 15) {
  const samples: number[] = [];
  let bytes = 0;
  let status = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const res = await app.inject({ method: "GET", url: path, headers: { ...headers, "x-forwarded-for": `10.0.0.${i}` } });
    samples.push(performance.now() - t);
    bytes = res.body.length;
    status = res.statusCode;
  }
  return { path, status, bytes, ...stats(samples) };
}

const base = `/api/v1/websites/${ids.site}/seo-workspace`;
const results = [
  await time(`/api/v1/dashboard?websiteId=${ids.site}`),
  await time(`${base}/overview?preset=28d&compare=previous`),
  await time(`${base}/overview?preset=90d&compare=previous`),
  await time(`${base}/overview?preset=custom&from=${new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)}&to=${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}&compare=previous`, 5),
  await time(`/api/v1/analytics/overview?days=365`),
  await time(`/api/v1/websites?pageSize=100`),
];

// Pool pressure: one cheap DB request while 6 workspace overviews run at once.
const cheap: number[] = [];
const overviews = Array.from({ length: 6 }, (_, i) => app.inject({ method: "GET", url: `${base}/overview?preset=90d&compare=previous`, headers: { ...headers, "x-forwarded-for": `10.1.0.${i}` } }));
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  await app.inject({ method: "GET", url: "/api/v1/websites?pageSize=10", headers: { ...headers, "x-forwarded-for": "10.2.0.1" } });
  cheap.push(performance.now() - t);
}
const overviewStatuses = (await Promise.all(overviews)).map((r) => r.statusCode);
const out = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  size: SIZE,
  seedMs: ids.seedMs,
  sequential: results,
  underLoad: { concurrentOverviews: 6, overviewStatuses, cheapRequestDuringLoad: stats(cheap) },
};
console.log(JSON.stringify(out, null, 2));
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
await app.close();
await closePool();
