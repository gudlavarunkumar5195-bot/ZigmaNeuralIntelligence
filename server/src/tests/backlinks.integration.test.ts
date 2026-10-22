import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Small row limit so the limit itself can be tested; set before config loads.
vi.hoisted(() => {
  process.env.BACKLINK_IMPORT_MAX_ROWS = "100";
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

// Synthetic exports only. No network: live checks use a fake verifier.
describe.skipIf(!INTEGRATION)("Backlink intelligence (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let site: string;
  let db: typeof import("../db/client.js");
  const as = (role: "owner" | "member" | "viewer" = "member", org: SeededOrg = A) => ({ token: org.users[role].token, orgId: org.id });
  const url = (path: string, w = A.websiteId) => `/api/v1/websites/${w}/backlinks${path}`;
  const get = (path: string, role: "owner" | "member" | "viewer" = "viewer") => h.request("GET", url(path), as(role));
  const csv = (rows: string[][], header = ["Source URL", "Target URL", "Anchor", "Rel", "First seen", "Last seen"]) =>
    [header, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const importCsv = (payload: Record<string, unknown>, role: "owner" | "member" | "viewer" = "member") =>
    h.request("POST", url("/imports"), { ...as(role), payload: { sourceLabel: "Ahrefs export", coverage: "partial", subject: "own", ...payload } });
  let ownV1: string;

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    A = await seedOrg(h, "bl-a");
    B = await seedOrg(h, "bl-b");
    site = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id = $1", [A.websiteId])).rows[0].domain;
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id, B?.id].filter(Boolean) as string[]);
    await h?.close();
  });

  it("without data: sources explain what is available; summary is empty; gap and opportunities say what to import", async () => {
    const sources = (await get("/sources")).json().data.sources;
    expect(sources.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual(["csv_import:available", "link_verification:available", "google_search_console:not_supported", "licensed_backlink_index:not_configured"]);
    const summary = (await get("/summary")).json().data;
    expect(summary).toMatchObject({ siteDomain: site, own: null, competitors: [] });
    expect((await get("/gap")).json().error.code).toBe("OWN_DATASET_MISSING");
    expect((await get("/opportunities")).json().error.code).toBe("OWN_DATASET_MISSING");
  });

  it("preview validates without storing; imports are validated, idempotent and role-checked", async () => {
    const file = csv([
      ["https://blog.example/post", `https://${site}/`, '=HYPERLINK("http://evil.example")', "nofollow", "2025-01-02", "2025-03-01"],
      ["https://blog.example/post", `https://${site}/`, "", "", "", ""],
      ["https://news.example/a", `https://${site}/pricing`, "pricing", "", "2025-01-10", "2025-03-02"],
      ["https://forum.example/t/9", `https://${site}/`, "running shoes forum", "ugc", "", "2025-02-20"],
      ["not a url", `https://${site}/`, "x", "", "", ""],
      ["", "", "", "", "", ""],
    ]);
    const preview = await h.request("POST", url("/imports/preview"), { ...as(), payload: { csv: file, subject: "own" } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ subjectDomain: site, rows: { total: 6, accepted: 3, rejected: 1, duplicate: 1, skipped: 1 }, missingRequired: [] });
    expect((await db.query("SELECT 1 FROM backlink_datasets WHERE org_id = $1", [A.id])).rows).toHaveLength(0);

    expect((await importCsv({ csv: file }, "viewer")).statusCode).toBe(403);
    const r = await importCsv({ csv: file, filename: "ahrefs.csv", exportedAt: "2025-03-05" });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.dataset).toMatchObject({ subject_kind: "own", subject_domain: site, coverage: "partial", rows_accepted: 3, rows_rejected: 1, rows_duplicate: 1, rows_skipped: 1, referring_domains: 3, observed_from: "2025-01-02", observed_to: "2025-03-02", stale: true });
    ownV1 = r.json().data.dataset.id;
    const again = await importCsv({ csv: file, filename: "ahrefs.csv", exportedAt: "2025-03-05" });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ duplicateImport: true, dataset: { id: ownV1 } });
    expect((await db.query("SELECT COUNT(*)::int AS n FROM backlink_links WHERE dataset_id = $1", [ownV1])).rows[0].n).toBe(3);
  });

  it("rejects unusable files with specific reasons", async () => {
    expect((await importCsv({ csv: "Domain,Links\nx.example,4" })).json().error.code).toBe("COLUMNS_MISSING");
    expect((await importCsv({ csv: "Source URL\nnot a url\nalso bad" })).json().error.code).toBe("NO_VALID_ROWS");
    const big = "Source URL\n" + Array.from({ length: 150 }, (_, i) => `https://s${i}.example/`).join("\n");
    const tooMany = await importCsv({ csv: big });
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.json().error.code).toBe("IMPORT_TOO_LARGE");
    expect((await importCsv({ csv: "S\u0000o\u0000u\u0000r\u0000c\u0000e" })).json().error.code).toBe("ENCODING_INVALID");
    expect((await importCsv({ csv: "Source URL\nhttps://a.example/", subject: "competitor", competitorDomain: site })).statusCode).toBe(400);
    expect((await importCsv({ csv: "Source URL\nhttps://a.example/", exportedAt: "2999-01-01" })).statusCode).toBe(400);
    expect((await importCsv({ csv: "Source URL\nhttps://a.example/", coverage: "everything" })).statusCode).toBe(400);
  });

  it("lists links with filters, stable cursor pagination and strict validation", async () => {
    const all = (await get("/links?limit=2")).json();
    expect(all.data.links).toHaveLength(2);
    expect(all.data.links.every((l: { state: string }) => l.state === "unverified")).toBe(true);
    const rest = (await get(`/links?limit=2&cursor=${encodeURIComponent(all.meta.nextCursor)}`)).json();
    expect(rest.data.links).toHaveLength(1);
    expect(new Set([...all.data.links, ...rest.data.links].map((l: { id: string }) => l.id)).size).toBe(3);
    expect((await get("/links?linkType=nofollow")).json().data.links.map((l: { source_domain: string }) => l.source_domain)).toEqual(["blog.example"]);
    expect((await get("/links?linkType=unknown")).json().data.links).toHaveLength(1);
    expect((await get("/links?search=pricing")).json().data.links).toHaveLength(1);
    const domains = (await get("/referring-domains")).json();
    expect(domains.meta.total).toBe(3);
    expect(domains.data.domains[0]).toMatchObject({ links: 1 });
    expect((await get("/links?limit=1000")).statusCode).toBe(400);
    expect((await get("/links?cursor=garbage")).statusCode).toBe(400);
    expect((await get("/links?bogus=1")).statusCode).toBe(400);
    expect((await get("/links?state=alive")).statusCode).toBe(400);
  });

  it("history: an incomplete snapshot never declares a link lost; a complete one does; changes are not duplicated", async () => {
    // v2 (partial): forum link missing, blog anchor changed, a new link.
    const v2 = csv([
      ["https://blog.example/post", `https://${site}/`, "best running shoes", "nofollow", "2025-01-02", "2025-04-01"],
      ["https://news.example/a", `https://${site}/pricing`, "pricing", "", "2025-01-10", "2025-04-02"],
      ["https://shop.example/r", `https://${site}/`, "shoe shop", "", "2025-03-20", "2025-04-02"],
    ]);
    const r2 = await importCsv({ csv: v2, exportedAt: "2025-04-05" });
    expect(r2.json().data.changes).toBe(3);
    const types = async () => (await get("/changes")).json().data.map((c: { change_type: string }) => c.change_type).sort();
    expect(await types()).toEqual(["anchor_changed", "new", "potentially_lost"]);
    // v3 (complete): only news + shop.
    const v3 = csv([["https://news.example/a", `https://${site}/pricing`, "pricing", "", "", ""], ["https://shop.example/r", `https://${site}/`, "shoe shop", "", "", ""]]);
    await importCsv({ csv: v3, exportedAt: "2025-04-20", coverage: "complete" });
    const lost = (await get("/changes?type=lost")).json().data;
    expect(lost.map((c: { source_url: string }) => c.source_url)).toEqual(["https://blog.example/post"]);
    expect(lost[0].evidence).toBe("Absent from a newer snapshot declared complete.");
    // Re-importing an existing file changes nothing.
    await importCsv({ csv: v3, exportedAt: "2025-04-20", coverage: "complete" });
    expect((await get("/changes")).json().data).toHaveLength(4);
  });

  it("gap and opportunities: compatible datasets only, explicit limitations, transparent scores", async () => {
    const comp = (domain: string, rows: string[][], exportedAt: string, coverage = "partial") =>
      importCsv({ csv: csv(rows), subject: "competitor", competitorDomain: domain, exportedAt, coverage, sourceLabel: "Ahrefs export" });
    expect((await comp("rival-one.example", [
      ["https://news.example/b", "https://rival-one.example/", "running shoes review", "", "", "2025-04-10"],
      ["https://reviews.example/top", "https://rival-one.example/", "best running shoes", "", "", "2025-04-12"],
      ["https://blog.example/post2", "https://rival-one.example/", "x", "nofollow", "", ""],
    ], "2025-04-15")).statusCode).toBe(201);
    await comp("rival-two.example", [["https://reviews.example/top", "https://rival-two.example/", "trail", "sponsored", "", "2025-04-01"]], "2025-04-18", "complete");

    const gap = (await get("/gap")).json().data;
    expect(gap.counts).toEqual({ shared: 1, competitor_only: 2, own_only: 1 }); // own latest: news, shop
    expect(gap.rows[0]).toEqual({ domain: "reviews.example", category: "competitor_only", competitors: ["rival-one.example", "rival-two.example"] });
    expect(gap.warnings.join(" ")).toMatch(/Not declared complete: rival-one\.example/);
    expect(gap.datasets.map((d: { subject: string }) => d.subject)).toEqual([site, "rival-one.example", "rival-two.example"]);

    const opp = (await get("/opportunities?topics=running shoes")).json().data;
    expect(opp.topics).toEqual({ terms: ["running", "shoes"], source: "input" });
    const reviews = opp.opportunities.find((o: { domain: string }) => o.domain === "reviews.example");
    expect(reviews).toMatchObject({ kind: "competitor_only", competitors: ["rival-one.example", "rival-two.example"] });
    expect(reviews.signals.find((s: { id: string }) => s.id === "verified_live").value).toBeNull();
    expect(reviews.why).toMatch(/not observed in your latest data \(complete coverage\)/);
    // blog.example linked to the own site in earlier snapshots and to rival-one now: a reclaim.
    expect(opp.opportunities.find((o: { domain: string }) => o.domain === "blog.example")).toMatchObject({ kind: "reclaim" });
    expect(opp.opportunities.find((o: { domain: string }) => o.domain === "forum.example")).toMatchObject({ kind: "reclaim", competitors: [] });
    expect(opp.opportunities.some((o: { domain: string }) => o.domain === "news.example")).toBe(false); // already links to the own site
    const noTopics = (await get("/opportunities")).json().data;
    expect(noTopics.topics.source).toBeNull();
    expect(noTopics.opportunities[0].signals.find((s: { id: string }) => s.id === "topical_relevance").value).toBeNull();
    expect((await get("/opportunities?kind=reclaim")).json().data.opportunities.every((o: { kind: string }) => o.kind === "reclaim")).toBe(true);

    // A competitor snapshot far older than the own one cannot be compared fairly.
    await comp("old-rival.example", [["https://x.example/", "https://old-rival.example/", "x", "", "", ""]], "2024-01-01");
    const stale = (await get("/gap?competitors=old-rival.example")).json();
    expect(stale.error.code).toBe("DATASETS_INCOMPATIBLE");
    // Without a selection it is left out with the reason; the others are still compared.
    const auto = (await get("/gap")).json().data;
    expect(auto.datasets.map((d: { subject: string }) => d.subject)).not.toContain("old-rival.example");
    expect(auto.warnings.join(" ")).toMatch(/old-rival\.example was left out: The datasets were exported \d+ days apart/);
  });

  it("live verification: bounded idempotent jobs; one miss is not a loss, two consecutive misses are", async () => {
    const { runVerificationSlice } = await import("../services/backlinks.service.js");
    const latestOwn = (await get("/summary")).json().data.own.dataset.id;
    const req = await h.request("POST", url("/verifications"), { ...as(), payload: { datasetId: latestOwn } });
    expect(req.statusCode).toBe(202);
    const dup = await h.request("POST", url("/verifications"), { ...as(), payload: { datasetId: latestOwn } });
    expect(dup.json().data).toMatchObject({ deduplicated: true, job: { id: req.json().data.job.id } });
    expect((await h.request("POST", url("/verifications"), { ...as("viewer"), payload: { datasetId: latestOwn } })).statusCode).toBe(403);

    const seen: string[] = [];
    const verifier = { check: vi.fn(async (l: { sourceUrl: string }) => { seen.push(l.sourceUrl); return l.sourceUrl.includes("news") ? { outcome: "link_found" as const, httpStatus: 200, linkType: "follow" as const, anchor: "pricing" } : { outcome: "link_missing" as const, httpStatus: 200, linkType: null, anchor: null }; }) };
    expect(await runVerificationSlice(verifier)).toBe("finished");
    expect(await runVerificationSlice(verifier)).toBe("idle"); // nothing left; completed jobs are not re-run
    expect(seen.sort()).toEqual(["https://news.example/a", "https://shop.example/r"]);
    const job = (await get(`/verifications/${req.json().data.job.id}`)).json().data;
    expect(job).toMatchObject({ status: "completed", links_total: 2, links_checked: 2 });

    const states = async () => Object.fromEntries((await get("/links")).json().data.links.map((l: { source_domain: string; state: string }) => [l.source_domain, l.state]));
    expect(await states()).toEqual({ "news.example": "verified_live", "shop.example": "verification_missing_once" });
    expect((await get("/changes?type=lost")).json().data).toHaveLength(1); // still only the snapshot loss

    const second = await h.request("POST", url("/verifications"), { ...as(), payload: { datasetId: latestOwn } });
    expect(second.statusCode).toBe(202);
    await runVerificationSlice(verifier);
    expect(await states()).toEqual({ "news.example": "verified_live", "shop.example": "lost_verified" });
    const lost = (await get("/changes?type=lost")).json().data.map((c: { evidence: string }) => c.evidence);
    expect(lost).toContain("Two consecutive live checks of the linking page did not find the link.");
    // Completing again never duplicates that event.
    await h.request("POST", url("/verifications"), { ...as(), payload: { datasetId: latestOwn } });
    await runVerificationSlice(verifier);
    expect((await get("/changes?type=lost")).json().data).toHaveLength(2);
    // Only own links were checked, so competitor-domain verification signals stay unavailable.
    const opp = (await get("/opportunities")).json().data.opportunities.find((o: { domain: string }) => o.domain === "reviews.example");
    expect(opp.signals.find((s: { id: string }) => s.id === "verified_live").value).toBeNull();
  });

  it("exports only authorized data with formula injection neutralized", async () => {
    expect((await h.request("GET", url("/export?kind=links&subject=" + site + "&competitors="), as("viewer"))).statusCode).toBe(403);
    // Exports use the latest snapshot; the formula-injection guard is checked on the shared CSV writer below.
    const links = await h.request("GET", url("/export?kind=links"), as("member"));
    expect(links.statusCode).toBe(200);
    expect(links.headers["content-type"]).toMatch(/text\/csv/);
    expect(links.body.split("\r\n")[0]).toBe("source_url,source_domain,target_url,anchor,link_type,first_seen,last_seen,state,checked_at,check_outcome,source,dataset_retrieved_at");
    const opp = await h.request("GET", url("/export?kind=opportunities"), as("member"));
    expect(opp.body).toMatch(/reviews\.example,competitor_only/);
    const { toCsv } = await import("../services/keyword-research.service.js");
    expect(toCsv([{ a: '=HYPERLINK("http://evil.example")' }], ["a"])).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
  });

  it("tenant isolation: another organization sees nothing and cannot use foreign ids", async () => {
    const other = (path: string) => h.request("GET", url(path), as("owner", B));
    for (const p of ["/summary", "/links", "/datasets", "/gap", "/opportunities", "/changes", "/referring-domains"]) expect((await other(p)).statusCode).toBe(404);
    // B's own website with A's dataset id.
    const foreign = await h.request("GET", url(`/links?dataset=${ownV1}`, B.websiteId), as("owner", B));
    expect(foreign.json().data).toMatchObject({ dataset: null, links: [] });
    const verify = await h.request("POST", url("/verifications", B.websiteId), { ...as("owner", B), payload: { datasetId: ownV1 } });
    expect(verify.json().error.code).toBe("DATASET_NOT_FOUND");
    const job = (await db.query<{ id: string }>("SELECT id FROM backlink_verification_jobs WHERE org_id = $1 LIMIT 1", [A.id])).rows[0].id;
    expect((await h.request("GET", url(`/verifications/${job}`, B.websiteId), as("owner", B))).statusCode).toBe(404);
    expect((await h.request("GET", url("/summary", "00000000-0000-4000-8000-000000000000"), as())).statusCode).toBe(404);
    expect((await h.request("GET", url("/summary"))).statusCode).toBe(401);
  });

  it("audits imports, verification requests and exports", async () => {
    const { rows } = await db.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE org_id = $1 AND action LIKE 'backlink_%'", [A.id]);
    expect(rows.map((r) => r.action).sort()).toEqual(["backlink_exported", "backlink_import_created", "backlink_verification_requested"]);
  });
});
