import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Provider contract: a fake SERP provider replaces the (empty) registry. No network, no cost.
const fake = vi.hoisted(() => {
  process.env.RANK_MAX_REQUESTS_PER_ORG_PER_DAY = "40";
  return {
    behaviour: {} as Record<string, "ok" | "transient" | "invalid">,
    calls: [] as string[],
    site: "",
  };
});

vi.mock("../ranking/providers.js", async () => {
  const actual = await vi.importActual<typeof import("../ranking/providers.js")>("../ranking/providers.js");
  const provider = {
    info: { id: "fake_serp", name: "Fake SERP API", searchEngines: ["google"], targeting: { countries: true, languages: true, locations: false, devices: ["desktop", "mobile"] }, maxDepth: 100, features: ["featured_snippet", "people_also_ask"], historical: false, rateLimitPerMinute: 60, costNote: "test", attribution: "test" },
    missingConfiguration: () => [],
    async fetchSerp(q: { keyword: string }) {
      fake.calls.push(q.keyword);
      const b = fake.behaviour[q.keyword] ?? "ok";
      if (b === "transient") throw new actual.RankProviderError(503, "PROVIDER_UNAVAILABLE", "Provider is down", true);
      if (b === "invalid") throw new actual.RankProviderError(400, "QUERY_REJECTED", "Provider rejected the query", false);
      return {
        depth: 100,
        observedAt: new Date(),
        features: ["featured_snippet", "people_also_ask"],
        featureUrls: { featured_snippet: ["https://rival.example/answer"] },
        results: q.keyword === "absent" ? [{ position: 1, url: "https://rival.example/answer", type: "organic" }] : [
          { position: 1, url: "https://rival.example/answer", type: "organic" },
          { position: 4, url: `https://www.${fake.site}/page`, type: "organic" },
          { position: 9, url: `https://${fake.site}/other`, type: "organic" },
        ],
      };
    },
  };
  return { ...actual, rankProviders: () => [provider], resolveRankProvider: () => provider };
});

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("Rank tracking with a (fake) SERP provider: jobs, retries, quotas", () => {
  let h: Harness;
  let A: SeededOrg;
  let db: typeof import("../db/client.js");
  let svc: typeof import("../services/rank-tracking.service.js");
  let pid: string;
  const as = () => ({ token: A.users.member.token, orgId: A.id });
  const base = "/api/v1/rank-tracking";
  const job = async () => (await db.query("SELECT status, keywords_done, keywords_failed, claims, error, next_attempt_at > NOW() AS delayed FROM rank_collection_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [pid])).rows[0];
  const own = async (kw: string) => (await db.query("SELECT o.status, o.position, o.ranking_url, o.serp_features, o.owned_features, o.error_code FROM rank_observations o JOIN rank_keywords k ON k.id = o.keyword_id WHERE o.project_id = $1 AND k.keyword = $2 AND o.subject_domain = $3", [pid, kw, fake.site])).rows;
  const drain = async () => { for (let i = 0; i < 10 && (await svc.runRankSlice()) !== "idle"; i++) await db.query("UPDATE rank_collection_jobs SET next_attempt_at = NOW() WHERE project_id = $1", [pid]); };

  beforeAll(async () => {
    h = await createHarness();
    db = await import("../db/client.js");
    svc = await import("../services/rank-tracking.service.js");
    A = await seedOrg(h, "rank-prov");
    fake.site = (await db.query<{ domain: string }>("SELECT domain FROM websites WHERE id = $1", [A.websiteId])).rows[0].domain;
  });
  afterAll(async () => {
    await cleanupOrgs([A?.id].filter(Boolean) as string[]);
    await h?.close();
  });
  beforeEach(() => {
    fake.behaviour = {};
    fake.calls.length = 0;
  });

  it("allows scheduled projects only within the provider's declared targeting", async () => {
    const bad = await h.request("POST", `${base}/projects`, { ...as(), payload: { websiteId: A.websiteId, name: "x", searchEngine: "google", location: "London", frequency: "daily" } });
    expect(bad.json().error).toMatchObject({ code: "TARGETING_UNSUPPORTED", message: "Fake SERP API does not support location targeting." });
    expect((await h.request("POST", `${base}/projects`, { ...as(), payload: { websiteId: A.websiteId, name: "x", searchEngine: "bing", frequency: "daily" } })).json().error.code).toBe("TARGETING_UNSUPPORTED");
    const ok = await h.request("POST", `${base}/projects`, { ...as(), payload: { websiteId: A.websiteId, name: "US", searchEngine: "google", country: "us", device: "mobile", frequency: "daily" } });
    expect(ok.statusCode).toBe(201);
    pid = ok.json().data.id;
    await h.request("POST", `${base}/projects/${pid}/competitors`, { ...as(), payload: { domain: "rival.example" } });
    await h.request("POST", `${base}/projects/${pid}/keywords`, { ...as(), payload: { keywords: ["shoes", "absent", "flaky", "rejected"].map((keyword) => ({ keyword })) } });
  });

  it("refresh creates one job; duplicates return it; observations keep features apart from ownership", async () => {
    fake.behaviour = { flaky: "ok", rejected: "invalid" };
    const r = await h.request("POST", `${base}/projects/${pid}/refresh`, as());
    expect(r.statusCode).toBe(202);
    const dup = await h.request("POST", `${base}/projects/${pid}/refresh`, as());
    expect(dup.json().data).toMatchObject({ deduplicated: true, job: { id: r.json().data.job.id } });
    await drain();
    expect(await job()).toMatchObject({ status: "partial", keywords_done: 3, keywords_failed: 1 });
    // Best own result (position 4); features present; featured snippet owned by the rival only.
    expect(await own("shoes")).toEqual([{ status: "ranked", position: 4, ranking_url: `https://www.${fake.site}/page`, serp_features: ["featured_snippet", "people_also_ask"], owned_features: [], error_code: null }]);
    const rival = (await db.query("SELECT o.position, o.owned_features FROM rank_observations o JOIN rank_keywords k ON k.id = o.keyword_id WHERE o.project_id = $1 AND k.keyword = 'shoes' AND o.subject_domain = 'rival.example'", [pid])).rows[0];
    expect(rival).toEqual({ position: 1, owned_features: ["featured_snippet"] });
    expect(await own("absent")).toMatchObject([{ status: "not_in_results", position: null }]);
    expect(await own("rejected")).toMatchObject([{ status: "failed", position: null, error_code: "QUERY_REJECTED" }]);
    expect(fake.calls.sort()).toEqual(["absent", "flaky", "rejected", "shoes"]);
  });

  it("re-running never duplicates; a later success replaces a failure", async () => {
    fake.behaviour = { rejected: "ok" };
    await db.query("UPDATE rank_collection_jobs SET status = 'completed' WHERE project_id = $1", [pid]);
    await svc.requestRefresh(A.id, (await svc.getProject(A.id, pid))!, A.users.member.id);
    await drain();
    expect(fake.calls).toEqual(["rejected"]); // the others already have today's observation
    expect(await own("rejected")).toMatchObject([{ status: "ranked", position: 4, error_code: null }]);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM rank_observations WHERE project_id = $1", [pid])).rows[0].n).toBe(8);
  });

  it("transient errors retry with backoff, then give up and record failures (never ranking losses)", async () => {
    await db.query("DELETE FROM rank_observations WHERE project_id = $1", [pid]);
    await db.query("UPDATE rank_collection_jobs SET status = 'completed' WHERE project_id = $1", [pid]);
    fake.behaviour = { shoes: "transient", absent: "transient", flaky: "transient", rejected: "transient" };
    await svc.requestRefresh(A.id, (await svc.getProject(A.id, pid))!, A.users.member.id);
    expect(await svc.runRankSlice()).toBe("progress");
    expect(await job()).toMatchObject({ status: "queued", claims: 1, delayed: true, error: "Retrying: Provider is down" });
    expect(await svc.runRankSlice()).toBe("idle"); // backoff respected
    for (let i = 0; i < 7; i++) {
      await db.query("UPDATE rank_collection_jobs SET next_attempt_at = NOW() WHERE project_id = $1", [pid]);
      await svc.runRankSlice();
    }
    expect(await job()).toMatchObject({ status: "failed", claims: 8 });
    const statuses = (await db.query<{ status: string }>("SELECT DISTINCT status FROM rank_observations WHERE project_id = $1 AND subject_domain = $2", [pid, fake.site])).rows.map((r) => r.status);
    expect(statuses).toEqual(["failed"]);
  });

  it("recovers a job whose worker died (expired lease) and finishes it", async () => {
    await db.query("DELETE FROM rank_observations WHERE project_id = $1", [pid]);
    await db.query("UPDATE rank_collection_jobs SET status = 'completed' WHERE project_id = $1", [pid]);
    await svc.requestRefresh(A.id, (await svc.getProject(A.id, pid))!, A.users.member.id);
    await db.query("UPDATE rank_collection_jobs SET status = 'running', lease_owner = 'dead-worker', lease_until = NOW() - interval '1 minute' WHERE project_id = $1 AND status = 'queued'", [pid]);
    await drain();
    expect(await job()).toMatchObject({ status: "completed", keywords_done: 4 });
  });

  it("enforces the daily quota before and during collection", async () => {
    await db.query("UPDATE rank_provider_usage SET requests = 39 WHERE org_id = $1", [A.id]);
    await db.query("UPDATE rank_collection_jobs SET status = 'completed' WHERE project_id = $1", [pid]);
    const r = await h.request("POST", `${base}/projects/${pid}/refresh`, as());
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toMatchObject({ code: "QUOTA_EXCEEDED", details: { needed: 4, used: 39, limit: 40 } });
    const src = (await h.request("GET", `${base}/sources`, as())).json().data;
    expect(src.usage).toMatchObject({ used: 39, limit: 40 });
  });

  it("schedules at most one collection per project and day", async () => {
    await db.query("UPDATE rank_provider_usage SET requests = 0 WHERE org_id = $1", [A.id]);
    await db.query("DELETE FROM rank_collection_jobs WHERE project_id = $1", [pid]);
    expect(await svc.scheduleDueRankJobs()).toBe(1);
    expect(await svc.scheduleDueRankJobs()).toBe(0);
    await db.query("UPDATE rank_collection_jobs SET status = 'completed' WHERE project_id = $1", [pid]);
    expect(await svc.scheduleDueRankJobs()).toBe(0); // already ran today
    const jobs = (await h.request("GET", `${base}/projects/${pid}/jobs`, as())).json().data;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ trigger: "scheduled" });
  });

  it("pausing a project cancels its active job", async () => {
    await db.query("DELETE FROM rank_collection_jobs WHERE project_id = $1", [pid]);
    await svc.requestRefresh(A.id, (await svc.getProject(A.id, pid))!, A.users.member.id);
    await h.request("PATCH", `${base}/projects/${pid}`, { ...as(), payload: { status: "paused" } });
    expect((await job()).status).toBe("cancelled");
    expect((await h.request("POST", `${base}/projects/${pid}/refresh`, as())).json().error.code).toBe("PROJECT_NOT_ACTIVE");
  });
});
