// Seeds a THROWAWAY local database for the integration E2E suite
// (playwright.integration.config.ts). It uses the server's own services, so the
// records look exactly like real ones; nothing here talks to the network.
//
// Usage (from the repo root, after migrating the database):
//   DATABASE_URL=postgresql://…@127.0.0.1:…/zni_e2e node --import tsx e2e/integration/seed.mts e2e/.fixture.json
import fs from "node:fs";
import { randomBytes } from "node:crypto";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/e2e|test|ci/i.test(url.pathname)) {
  console.error("Refusing to seed: DATABASE_URL must point at a local test database (host 127.0.0.1/localhost, name containing e2e/test/ci).");
  process.exit(1);
}
const out = process.argv[2];
if (!out) {
  console.error("Usage: seed.mts <fixture-output.json>");
  process.exit(1);
}

const { query, closePool } = await import("../../server/src/db/client.ts");
const { register, hashPassword } = await import("../../server/src/services/auth.service.ts");
const { analyzeCrawl } = await import("../../server/src/scanner/crawl.ts");
const { persistCrawl } = await import("../../server/src/services/site-audit.service.ts");
const { createImport } = await import("../../server/src/services/backlinks.service.ts");
const { withTransaction } = await import("../../server/src/db/client.ts");

const run = randomBytes(4).toString("hex");
const password = `E2e-${randomBytes(12).toString("base64url")}`; // generated per run, written only to the git-ignored fixture
const email = (who: string) => `${who}-${run}@e2e.test`;

async function siteWithData(orgId: string, ownerId: string, domain: string) {
  const S = `https://${domain}`;
  const websiteId = (await query<{ id: string }>("INSERT INTO websites (org_id, url, domain, verified, created_by) VALUES ($1,$2,$3,TRUE,$4) RETURNING id", [orgId, S, domain, ownerId])).rows[0].id;
  const page = (p: string, over: Record<string, unknown> = {}) => ({ url: `${S}${p}`, finalUrl: `${S}${p}`, status: 200, finalStatus: 200, redirectChain: [], depth: 1, discoveredFrom: `${S}/`, contentType: "text/html", title: `Page ${p}`, metaDescription: `Description of ${p} long enough for the checks.`, canonicals: [`${S}${p}`], robotsMeta: null, h1Count: 1, internalLinks: [], indexable: true, inSitemap: false, fetchError: null, responseMs: 5, redirectTarget: null, outcome: "ok", xRobotsTag: null, imagesTotal: 0, imagesMissingAlt: 0, imagesMissingAltSample: [], indexabilityReasons: [], content: null, ...over });
  const result = {
    pages: [page("/"), page("/shoes", { title: null }), page("/gone", { status: 404, finalStatus: 404, outcome: "http_error", indexable: false, indexabilityReasons: ["status_404"] })],
    inlinks: { [`${S}/gone`]: { count: 1, sample: [`${S}/`] } },
    summary: { startUrl: `${S}/`, origin: S, pagesCrawled: 3, pagesDiscovered: 3, truncated: false, truncatedReason: null, robotsStatus: "parsed", startBlockedByRobots: false, sitemapStatus: "found", sitemapFiles: [], sitemapUrlCount: 0, durationMs: 10, maxPages: 100, reconcilable: true, pagesBlockedByRobots: 0, maxDepth: 5 },
  };
  const scanId = (await query<{ id: string }>("INSERT INTO scans (website_id, org_id, triggered_by, status, modules, completed_at) VALUES ($1,$2,$3,'completed','{crawl}',NOW()) RETURNING id", [websiteId, orgId, ownerId])).rows[0].id;
  await withTransaction((tx: never) => persistCrawl(tx, { scanId, orgId, websiteId, result: result as never, issues: analyzeCrawl(result as never), completed: true }));
  return { websiteId, scanId, domain };
}

// Organization A: owner + viewer, a website with crawl issues, two open alerts, a backlink import.
const a = await register({ email: email("owner"), password, fullName: "E2E Owner", orgName: `E2E A ${run}` });
// One account per role: real sign-ins are rate limited per email, and each role is exercised.
for (const role of ["admin", "member", "viewer"] as const) {
  const id = (await query<{ id: string }>("INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id", [email(role), await hashPassword(password), `E2E ${role}`])).rows[0].id;
  await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3)", [id, a.orgId, role]);
}
const siteA = await siteWithData(a.orgId, a.userId, `shop-${run}.test`);

const monitoringId = (await query<{ id: string }>("INSERT INTO monitoring_configs (org_id, website_id, frequency, next_run_at) VALUES ($1,$2,'weekly',NOW() + interval '7 days') RETURNING id", [a.orgId, siteA.websiteId])).rows[0].id;
const alertTitles: string[] = [];
for (const [i, title] of [`Title removed on /shoes (${run})`, `New 404 on /gone (${run})`].entries()) {
  const changeId = (await query<{ id: string }>(
    "INSERT INTO monitoring_changes (monitoring_id, org_id, website_id, scan_id, signature, change_type, domain, severity, impact) VALUES ($1,$2,$3,$4,$5,'seo_change','seo','high','Search snippets may change') RETURNING id",
    [monitoringId, a.orgId, siteA.websiteId, siteA.scanId, `sig-${run}-${i}`],
  )).rows[0].id;
  await query("INSERT INTO alerts (org_id, monitoring_id, website_id, change_id, scan_id, signature, severity, title) VALUES ($1,$2,$3,$4,$5,$6,'high',$7)", [a.orgId, monitoringId, siteA.websiteId, changeId, siteA.scanId, `sig-${run}-${i}`, title]);
  alertTitles.push(title);
}
await createImport({ id: siteA.websiteId, orgId: a.orgId, domain: siteA.domain } as never, a.userId, {
  subject: "own", sourceLabel: "E2E export (synthetic)", coverage: "partial",
  // The second anchor looks like a spreadsheet formula: exports must neutralize it.
  csv: `Source URL,Target URL,Anchor text\nhttps://blog-${run}.test/a,https://${siteA.domain}/,running shoes\nhttps://news-${run}.test/b,https://${siteA.domain}/shoes,"=HYPERLINK(""http://evil.test"")"\n`,
} as never);

// A saved keyword list, and a Search Console property linked to site A (no Google call is ever made).
const listId = (await query<{ id: string }>("INSERT INTO keyword_lists (org_id, name, created_by) VALUES ($1,$2,$3) RETURNING id", [a.orgId, `Shoes ${run}`, a.userId])).rows[0].id;
for (const k of ["trail running shoes", "waterproof hiking boots"]) {
  await query("INSERT INTO keyword_list_items (list_id, org_id, keyword_key, keyword, added_by) VALUES ($1,$2,$3,$3,$4)", [listId, a.orgId, k, a.userId]);
}
const integrationId = (await query<{ id: string }>(
  "INSERT INTO integrations (org_id, provider, external_account_id, account_email, scopes, refresh_token_enc, key_id, status) VALUES ($1,'google_search_console',$2,$3,'{}','k1.e2e.not.real','k1','active') RETURNING id",
  [a.orgId, `e2e-${run}`, `gsc-${run}@e2e.test`],
)).rows[0].id;
await query("INSERT INTO gsc_properties (org_id, website_id, integration_id, site_url, property_type, permission_level) VALUES ($1,$2,$3,$4,'domain','siteOwner')", [a.orgId, siteA.websiteId, integrationId, `sc-domain:${siteA.domain}`]);

// A synthetic model in the (global) registry of this throwaway database; nothing calls a provider.
await query("INSERT INTO models (openrouter_id, display_name, provider) VALUES ($1,$2,'e2e')", [`e2e/test-model-${run}`, `E2E Test Model ${run}`]);

// Organization B: another tenant whose data must never be visible to A.
const b = await register({ email: email("other"), password, fullName: "E2E Other", orgName: `E2E B ${run}` });
const siteB = await siteWithData(b.orgId, b.userId, `other-${run}.test`);

fs.writeFileSync(out, JSON.stringify({ password, owner: email("owner"), ownerId: a.userId, modelName: `E2E Test Model ${run}`, listName: `Shoes ${run}`, admin: email("admin"), member: email("member"), viewer: email("viewer"), other: email("other"), orgA: a.orgId, orgB: b.orgId, siteA, siteB, alertTitles }, null, 2));
await closePool();
console.log(`seeded e2e fixture (run ${run})`);
