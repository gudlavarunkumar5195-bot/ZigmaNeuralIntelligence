import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RANK_MAX_KEYWORDS_PER_PROJECT = "20";
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

// No SERP provider is configured (the real state): rankings come from imported reports. Synthetic data only.
describe.skipIf(!INTEGRATION)("Rank tracking without a provider (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let site: string;
  let pid: string;
  let db: typeof import("../db/client.js");
  const as = (role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const base = "/api/v1/rank-tracking";
  const p = (path = "") => `${base}/projects/${pid}${path}`;
  const get = (url: string, role: "owner" | "member" | "viewer" = "viewer") => h.request("GET", url, as(role));
  const post = (url: string, payload: unknown, role: "owner" | "member" | "viewer" = "member") => h.request("POST", url, { ...as(role), payload });
  const report = (rows: string[][], header = ["Keyword", "Date", "Position", "URL", "Domain", "SERP features", "Owned features", "Device"]) =>
    [header, ...rows].map((r) => r.map((c) => (/[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    A = await seedOrg(h, "rank-a");
    B = await seedOrg(h, "rank-b");
    site = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id = $1", [A.websiteId])).rows[0].domain;
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id, B?.id].filter(Boolean) as string[]);
    await h?.close();
  });

  it("sources say plainly that no SERP provider is configured; scheduled tracking and refresh are refused", async () => {
    const s = (await get(`${base}/sources`)).json().data;
    expect(s.sources.map((x: { id: string; status: string }) => `${x.id}:${x.status}`)).toEqual(["csv_import:available", "google_search_console:not_supported", "licensed_serp_api:not_configured"]);
    const scheduled = await post(`${base}/projects`, { websiteId: A.websiteId, name: "Daily", searchEngine: "google", frequency: "daily" });
    expect(scheduled.statusCode).toBe(422);
    expect(scheduled.json().error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("creates projects with validated, unique search configurations", async () => {
    expect((await post(`${base}/projects`, { websiteId: A.websiteId, name: "x", searchEngine: "google" }, "viewer")).statusCode).toBe(403);
    expect((await post(`${base}/projects`, { websiteId: B.websiteId, name: "x", searchEngine: "google" })).statusCode).toBe(404); // other tenant's website
    expect((await post(`${base}/projects`, { websiteId: A.websiteId, name: "x", searchEngine: "google", timezone: "Mars/Olympus" })).statusCode).toBe(400);
    const r = await post(`${base}/projects`, { websiteId: A.websiteId, name: "UK desktop", searchEngine: "google", country: "GB", language: "en", device: "desktop", timezone: "Europe/London" });
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({ country: "gb", language: "en", device: "desktop", frequency: "manual", website_domain: site });
    pid = r.json().data.id;
    expect((await post(`${base}/projects`, { websiteId: A.websiteId, name: "dup", searchEngine: "google", country: "gb", language: "en", device: "desktop" })).json().error.code).toBe("PROJECT_EXISTS");
    // A different device is a different project (never merged).
    expect((await post(`${base}/projects`, { websiteId: A.websiteId, name: "UK mobile", searchEngine: "google", country: "gb", language: "en", device: "mobile" })).statusCode).toBe(201);
  });

  it("manages keywords: normalization, dedup, groups, limits, CSV, pause, confirmed removal that keeps history", async () => {
    const add = await post(p("/keywords"), { keywords: [{ keyword: "Running  Shoes", group: "shoes" }, { keyword: "running shoes" }, { keyword: "trail shoes", group: "shoes", landingPage: `https://${site}/trail` }, { keyword: "best running shoes", landingPage: "https://other.example/x" }, { keyword: "" }] });
    expect(add.json().data).toMatchObject({ added: 3, alreadyTracked: 0, invalid: [{ reason: "Empty or longer than 200 characters" }] });
    expect(add.json().data.warnings).toEqual(["Landing page https://other.example/x is not on " + site + "."]);
    const csv = await post(p("/keywords/import"), { csv: "Keyword,Group\nshoe sizes,guides\nRUNNING SHOES,\n" });
    expect(csv.json().data).toMatchObject({ added: 1, alreadyTracked: 1 });
    const list = (await get(p("/keywords?group=shoes"))).json();
    expect(list.data.map((k: { keyword: string }) => k.keyword)).toEqual(["Running Shoes", "trail shoes"]);
    expect(list.meta.groups).toEqual(["guides", "shoes"]);
    const many = await post(p("/keywords"), { keywords: Array.from({ length: 20 }, (_, i) => ({ keyword: `kw ${i}` })) });
    expect(many.statusCode).toBe(422);
    expect(many.json().error).toMatchObject({ code: "KEYWORD_LIMIT", details: { tracked: 4, adding: 20, limit: 20 } });
    const trail = list.data.find((k: { keyword: string }) => k.keyword === "trail shoes").id;
    expect((await h.request("PATCH", p(`/keywords/${trail}`), { ...as(), payload: { status: "paused" } })).statusCode).toBe(200);
    expect((await h.request("DELETE", p(`/keywords/${trail}`), { ...as(), payload: {} })).statusCode).toBe(400); // confirmation required
    expect((await h.request("DELETE", p(`/keywords/${trail}`), { ...as(), payload: { confirm: true } })).statusCode).toBe(200);
    expect((await get(p("/keywords"))).json().data).toHaveLength(3);
    expect((await post(p("/keywords"), { keywords: [{ keyword: "trail shoes" }] })).json().data.restored).toBe(1);
    expect((await get(p("/keywords?limit=500"))).statusCode).toBe(400);
    expect((await get(p("/keywords?cursor=junk"))).statusCode).toBe(400);
  });

  it("manages competitors with limits and refuses the own site", async () => {
    expect((await post(p("/competitors"), { domain: "https://www.Rival.example/" })).json().data).toEqual({ domain: "rival.example", added: true });
    expect((await post(p("/competitors"), { domain: site })).statusCode).toBe(400);
    expect((await post(p("/competitors"), { domain: "rival.example" })).json().data.added).toBe(false);
    await post(p("/competitors"), { domain: "second.example" });
    expect((await h.request("DELETE", p("/competitors/second.example"), as())).json().data.removed).toBe(true);
  });

  it("previews and imports ranking reports accurately; 'not found' is never a number; imports are idempotent", async () => {
    const r1 = report([
      ["running shoes", "2026-09-01", "8", `https://${site}/running`, "", "Featured snippet; PAA", "", "desktop"],
      ["running shoes", "2026-09-01", "3", "https://rival.example/r", "rival.example", "Featured snippet; PAA", "Featured snippet", "desktop"],
      ["trail shoes", "2026-09-01", ">100", "", "", "", "", "desktop"],
      ["shoe sizes", "2026-09-01", "15", `https://${site}/sizes`, "", "Images", "Images", "desktop"],
      ["running shoes", "2026-09-01", "9", `https://${site}/running`, "", "", "", "desktop"], // duplicate
      ["running shoes", "2026-09-01", "5", `https://${site}/x`, "", "", "", "mobile"], // other device
      ["new keyword", "2026-09-01", "22", `https://${site}/new`, "", "", "", "desktop"],
      ["running shoes", "2099-01-01", "5", "", "", "", "", "desktop"],
      ["running shoes", "2026-09-01", "5", "", "unknown.example", "", "", "desktop"],
      ["running shoes", "2026-09-01", "4", "", "", "Images", "Video", "desktop"],
    ]);
    const prev = (await post(p("/observations/preview"), { csv: r1 })).json().data;
    expect(prev.rows).toEqual({ total: 10, accepted: 5, rejected: 4, duplicate: 1, skipped: 0 });
    expect(prev.rejectedSamples.map((x: { reason: string }) => x.reason)).toEqual([
      "Device mobile differs from the project's desktop",
      "Missing, unreadable or future date",
      "unknown.example is neither the project's website nor one of its competitors",
      "An owned SERP feature is not listed among the page's features",
    ]);
    expect(prev).toMatchObject({ newKeywords: 1, statuses: { ranked: 4, not_in_results: 1 } });
    expect((await db.query("SELECT 1 FROM rank_observations WHERE project_id = $1", [pid])).rows).toHaveLength(0);

    const imp = await post(p("/observations/import"), { csv: r1, sourceLabel: "Tracker export", filename: "sept.csv" });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().data).toMatchObject({ inserted: 5, keywordsCreated: 1, rejected: 4, duplicates: 1 });
    const notFound = (await db.query("SELECT o.status, o.position, o.result_depth FROM rank_observations o JOIN rank_keywords k ON k.id = o.keyword_id WHERE k.keyword = 'trail shoes' AND o.project_id = $1", [pid])).rows[0];
    expect(notFound).toEqual({ status: "not_in_results", position: null, result_depth: 100 });
    const again = await post(p("/observations/import"), { csv: r1, sourceLabel: "Tracker export" });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.duplicateImport).toBe(true);
    expect((await post(p("/observations/import"), { csv: "Keyword,Position\nx,1", sourceLabel: "x" })).json().error.code).toBe("COLUMNS_MISSING");
    expect((await post(p("/observations/import"), { csv: r1, sourceLabel: "x" }, "viewer")).statusCode).toBe(403);
  });

  it("alert rules fire once per triggering observation; failures never look like ranking losses", async () => {
    const mk = (payload: object) => post(p("/alert-rules"), payload);
    expect((await mk({ type: "position_change", params: { positions: 3 } })).statusCode).toBe(201);
    expect((await mk({ type: "threshold_cross", params: { position: 10, direction: "out_of" } })).statusCode).toBe(201);
    expect((await mk({ type: "competitor_overtake", params: { competitor: "rival.example" } })).statusCode).toBe(201);
    expect((await mk({ type: "competitor_overtake", params: { competitor: "nobody.example" } })).statusCode).toBe(400);
    expect((await mk({ type: "collection_failures", params: { consecutive: 2 } })).statusCode).toBe(201);
    // Week 2: running shoes 8 → 14 (declined 6, out of the top 10, overtaken by rival who stays at 3); shoe sizes fails; trail shoes enters at 40.
    const r2 = report([
      ["running shoes", "2026-09-08", "14", `https://${site}/running`, "", "PAA", "", "desktop"],
      ["running shoes", "2026-09-08", "3", "https://rival.example/r", "rival.example", "PAA", "", "desktop"],
      ["trail shoes", "2026-09-08", "40", `https://${site}/trail`, "", "", "", "desktop"],
      ["shoe sizes", "2026-09-08", "failed", "", "", "", "", "desktop"],
    ]);
    const imp = (await post(p("/observations/import"), { csv: r2, sourceLabel: "Tracker export" })).json().data;
    expect(imp.alertsCreated).toBe(2); // position_change + threshold out_of (rival was already ahead: no overtake)
    const alerts = (await get(p("/alerts"))).json().data.map((a: { rule_type: string; keyword: string }) => `${a.rule_type}:${a.keyword}`).sort();
    expect(alerts).toEqual(["position_change:Running Shoes", "threshold_cross:Running Shoes"]);
    // Re-evaluating (new rule creation triggers evaluation) never duplicates.
    await mk({ type: "url_change" });
    expect((await get(p("/alerts"))).json().data).toHaveLength(2);
    // A second failure in a row: only collection_failures fires.
    await post(p("/observations/import"), { csv: report([["shoe sizes", "2026-09-15", "failed", "", "", "", "", "desktop"]]), sourceLabel: "Tracker export" });
    const types = (await get(p("/alerts"))).json().data.map((a: { rule_type: string }) => a.rule_type).sort();
    expect(types).toEqual(["collection_failures", "position_change", "threshold_cross"]);
    const ev = (await get(p("/alerts?unacknowledged=true"))).json().data[0].id;
    expect((await post(p(`/alerts/${ev}/acknowledge`), {})).json().data.acknowledged).toBe(true);
    expect((await get(p("/alerts?unacknowledged=true"))).json().data).toHaveLength(2);
  });

  it("rankings, dashboard and history are computed from stored observations only", async () => {
    const rows = (await get(p("/rankings"))).json().data;
    const by = Object.fromEntries(rows.map((r: { keyword: string; change: { kind: string; delta: number | null } }) => [r.keyword, r.change]));
    expect(by["Running Shoes"]).toMatchObject({ kind: "declined", delta: -6 });
    expect(by["trail shoes"]).toMatchObject({ kind: "entered" });
    expect(by["shoe sizes"]).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/collection failed/) });
    expect(by["new keyword"]).toMatchObject({ kind: "unavailable", reason: "No earlier comparable observation from the same source." });
    expect((await get(p("/rankings?change=declined"))).json().data).toHaveLength(1);

    const d = (await get(p("/dashboard?from=2026-09-01&to=2026-09-30"))).json().data;
    // unavailable: shoe sizes (failed), new keyword (one observation only), best running shoes (never observed)
    expect(d.changes).toEqual({ improved: 0, declined: 1, unchanged: 0, entered: 1, dropped_out: 0, unavailable: 3 });
    expect(d.distribution).toMatchObject({ "11-20": 1, "21-50": 2, unavailable: 2 });
    expect(d.top10Trend).toEqual([
      { day: "2026-09-01", source: "csv_import", share: 25, top10: 1, conclusive: 4, excluded: 0 },
      { day: "2026-09-08", source: "csv_import", share: 0, top10: 0, conclusive: 2, excluded: 1 },
      { day: "2026-09-15", source: "csv_import", share: null, top10: 0, conclusive: 0, excluded: 1 },
    ]);
    expect(d.topPages[0]).toMatchObject({ url: `https://${site}/running`, keywords: 1, averagePosition: 14 });

    const kw = rows.find((r: { keyword: string }) => r.keyword === "Running Shoes").keywordId;
    const hist = (await get(p(`/keywords/${kw}/history?from=2026-09-01&to=2026-09-07`))).json().data;
    expect(hist.observations.map((o: { subject_domain: string; position: number }) => `${o.subject_domain}:${o.position}`).sort()).toEqual([`${site}:8`, "rival.example:3"]);
  });

  it("separates SERP features observed from features the site earned; compares competitors only when comparable", async () => {
    const f = (await get(p("/serp-features"))).json().data;
    expect(f.features.find((x: { feature: string }) => x.feature === "people_also_ask")).toMatchObject({ present: 1, owned: 0 });
    const c = (await get(p("/competitor-comparison"))).json().data.competitors[0];
    expect(c.competitor).toBe("rival.example");
    const running = c.keywords.find((k: { keyword: string }) => k.keyword === "Running Shoes");
    expect(running).toMatchObject({ relation: "both_ranked", ahead: "competitor", date: "2026-09-08", own: { position: 14 }, competitor: { position: 3 } });
    // No rival observation for trail shoes: not comparable, not "rival outranks you".
    expect(c.keywords.find((k: { keyword: string }) => k.keyword === "trail shoes")).toMatchObject({ relation: "not_comparable", ahead: null });
    expect((await get(p("/competitor-comparison?competitor=nobody.example"))).json().error.code).toBe("NO_COMPETITORS");
  });

  it("refresh without a provider is refused; exports are authorized and safe", async () => {
    const r = await post(p("/refresh"), {});
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect((await get(p("/export?kind=rankings"), "viewer")).statusCode).toBe(403);
    const csv = await get(p("/export?kind=history"), "member");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\r\n")[0]).toBe("keyword,subject_domain,date,status,position,result_depth,ranking_url,serp_features,owned_features,source_label");
    expect(csv.body).toMatch(/trail shoes,.*,2026-09-01,not_in_results,,100,/);
  });

  it("tenant isolation: another organization cannot see or touch the project", async () => {
    const other = { ...as("owner", B) };
    for (const path of ["", "/keywords", "/rankings", "/dashboard", "/alerts", "/competitor-comparison", "/serp-features", "/jobs", "/imports"]) {
      expect((await h.request("GET", p(path), other)).statusCode).toBe(404);
    }
    expect((await h.request("POST", p("/keywords"), { ...other, payload: { keywords: [{ keyword: "x" }] } })).statusCode).toBe(404);
    expect((await h.request("GET", `${base}/projects`, other)).json().data).toEqual([]);
    expect((await h.request("GET", p())).statusCode).toBe(401);
  });

  it("project changes are audited", async () => {
    expect((await h.request("PATCH", p(), { ...as(), payload: { status: "paused" } })).json().data.status).toBe("paused");
    const { rows } = await db.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE org_id = $1 AND action LIKE 'rank_%'", [A.id]);
    expect(rows.map((r) => r.action).sort()).toEqual(expect.arrayContaining(["rank_alert_rule_created", "rank_competitor_added", "rank_competitor_removed", "rank_exported", "rank_keyword_removed", "rank_keywords_added", "rank_keywords_imported", "rank_observations_imported", "rank_project_created", "rank_project_updated"]));
  });
});
