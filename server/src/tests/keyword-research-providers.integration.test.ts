import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Provider contract: whatever an adapter returns or throws, the service stores
// only clean, declared metrics, reports failures with safe codes, and never
// turns missing data into numbers. Fake providers replace the registry; the
// AI executor is faked to check grounding and attribution.
const { fake, ai } = vi.hoisted(() => {
  process.env.KEYWORD_RESEARCH_PROVIDER_TIMEOUT_MS = "500";
  return {
    fake: { behaviour: "ok" as "ok" | "malformed" | "throw" | "hang" | "rate_limited" | "unconfigured" },
    ai: { calls: [] as Array<Record<string, unknown>>, answer: null as unknown, available: true },
  };
});

vi.mock("../research/providers/registry.js", async () => {
  const types = await import("../research/providers/types.js");
  const provider = {
    info: {
      id: "fake_licensed", name: "Fake licensed provider", kind: "licensed", capabilities: ["keyword_ideas"], metrics: ["search_volume", "keyword_difficulty"],
      metricScope: "test", targeting: { countries: "all", languages: "all", devices: "all" }, caching: { allowed: false, maxAgeMinutes: 0 }, attribution: "test", costNote: "test",
    },
    missingConfiguration: () => (fake.behaviour === "unconfigured" ? ["FAKE_PROVIDER_API_KEY"] : []),
    async keywordIdeas() {
      if (fake.behaviour === "throw") throw new Error("socket hang up at 10.0.0.1 with key sk_live_secret");
      if (fake.behaviour === "rate_limited") throw new types.ResearchError(429, "PROVIDER_RATE_LIMITED", "The data provider rate limit was reached; try again later.");
      if (fake.behaviour === "hang") return new Promise(() => undefined);
      const rows = fake.behaviour === "malformed"
        ? [
            { keyword: "alpha", metrics: { search_volume: 1000, keyword_difficulty: Number.NaN, cpc: 2.5, clicks: 7 } },
            { keyword: "ALPHA ", metrics: { search_volume: 5 } },
            { keyword: undefined as unknown as string, metrics: { search_volume: 1 } },
            { keyword: "   ", metrics: {} },
            { keyword: "beta", metrics: { search_volume: "lots" as unknown as number, keyword_difficulty: 40 } },
          ]
        : [{ keyword: "alpha", metrics: { search_volume: 1000, keyword_difficulty: 35 } }];
      return { rows, sample: false, partial: false, observedThrough: "2030-01-01", notes: [] };
    },
  };
  const resolveProvider = (capability: string) => {
    if (!provider.info.capabilities.includes(capability)) throw new types.ResearchError(422, "CAPABILITY_UNSUPPORTED", `${capability} is not supported`);
    const missing = provider.missingConfiguration();
    if (missing.length) throw new types.ResearchError(503, "PROVIDER_NOT_CONFIGURED", `missing: ${missing.join(", ")}`, { missing });
    return provider;
  };
  return { resolveProvider, enabledProviders: () => [provider], capabilityMatrix: () => [{ ...provider.info, configured: true, missingConfiguration: [], unsupported: [] }], unknownProviderIds: () => [] };
});

vi.mock("../ai/ox-alpha.js", () => ({
  getOxAlphaExecutor: () => (ai.available ? {
    execute: async (req: Record<string, unknown>) => {
      ai.calls.push(req);
      return { success: true, response: { model: "free/model:free" }, parsedJson: ai.answer, attempts: 1, totalDurationMs: 1, executionIds: ["e1"] };
    },
  } : null),
}));

import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

describe.skipIf(!INTEGRATION)("keyword research provider contract and AI grounding (PostgreSQL + HTTP)", () => {
  let h: Harness;
  let A: SeededOrg;
  const as = (role: "member" | "viewer" = "member") => ({ token: A.users[role].token, orgId: A.id });
  let n = 0;
  const ideas = () => h.request("POST", "/api/v1/keyword-research/ideas", { ...as(), payload: { websiteId: A.websiteId, seed: `seed ${++n}` } });

  beforeAll(async () => {
    h = await createHarness();
    A = await seedOrg(h, "kw-contract");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    if (A) await cleanupOrgs([A.id]);
    await h?.close();
  });
  beforeEach(() => {
    fake.behaviour = "ok";
    ai.calls.length = 0;
    ai.available = true;
  });

  it("stores only finite, declared metrics; merges duplicate keywords; skips invalid rows", async () => {
    fake.behaviour = "malformed";
    const r = await ideas();
    expect(r.statusCode).toBe(201);
    const { run, results } = r.json().data;
    expect(run).toMatchObject({ status: "completed", result_count: 2, provider: "fake_licensed" });
    expect(results).toEqual([
      expect.objectContaining({ keyword: "alpha", metrics: { search_volume: 1000 } }), // NaN difficulty, undeclared cpc/clicks dropped; first duplicate kept
      expect.objectContaining({ keyword: "beta", metrics: { keyword_difficulty: 40 } }), // non-numeric volume dropped
    ]);
  });

  it("an unexpected provider failure is a 502 with a safe message; nothing internal leaks", async () => {
    fake.behaviour = "throw";
    const r = await ideas();
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "The data source failed; try again." });
    expect(r.body).not.toMatch(/10\.0\.0\.1|sk_live/);
    const run = (await h.request("GET", `/api/v1/keyword-research/runs/${r.json().error.runId}`, as("viewer"))).json().data.run;
    expect(run).toMatchObject({ status: "failed", error_code: "PROVIDER_UNAVAILABLE", result_count: 0 });
  });

  it("times out a provider that does not answer, and passes provider rate limits through", async () => {
    fake.behaviour = "hang";
    const t = await ideas();
    expect(t.statusCode).toBe(504);
    expect(t.json().error.code).toBe("PROVIDER_UNAVAILABLE");
    fake.behaviour = "rate_limited";
    const rl = await ideas();
    expect(rl.statusCode).toBe(429);
    expect(rl.json().error.code).toBe("PROVIDER_RATE_LIMITED");
  });

  it("reports missing configuration (names only) and unsupported capabilities before any run is created", async () => {
    const { query } = await import("../db/client.js");
    const before = Number((await query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id=$1", [A.id])).rows[0].n);
    fake.behaviour = "unconfigured";
    const r = await ideas();
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", details: { missing: ["FAKE_PROVIDER_API_KEY"] } });
    fake.behaviour = "ok";
    const unsupported = await h.request("POST", "/api/v1/keyword-research/organic", { ...as(), payload: { websiteId: A.websiteId } });
    expect(unsupported.json().error.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(Number((await query<{ n: string }>("SELECT COUNT(*)::text AS n FROM research_runs WHERE org_id=$1", [A.id])).rows[0].n)).toBe(before);
  });

  it("a provider that forbids caching is called again for an identical request", async () => {
    const payload = { websiteId: A.websiteId, seed: "no cache" };
    const a = await h.request("POST", "/api/v1/keyword-research/ideas", { ...as(), payload });
    const b = await h.request("POST", "/api/v1/keyword-research/ideas", { ...as(), payload });
    expect(a.json().data.run.id).not.toBe(b.json().data.run.id);
  });

  it("AI insights: grounded in the run's rows, attributed to the run, labelled, and invalid items dropped", async () => {
    const runId = (await ideas()).json().data.run.id;
    ai.answer = {
      summary: "Focus on alpha.",
      items: [
        { keyword: "Alpha", priority: "high", rationale: "Highest search_volume in the data", evidence: ["search_volume"], missingData: ["cpc"] },
        { keyword: "invented keyword", priority: "high", rationale: "x" },
        { keyword: "alpha", priority: "high", rationale: "duplicate" },
        { keyword: "beta", priority: "urgent", rationale: "bad priority" },
      ],
    };
    const r = await h.request("POST", `/api/v1/keyword-research/runs/${runId}/insights`, as());
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ status: "completed", model: "free/model:free", summary: "Focus on alpha." });
    expect(r.json().data.items).toEqual([expect.objectContaining({ keyword: "alpha", keywordKey: "alpha", priority: "high", missingData: ["cpc"] })]);
    expect(ai.calls[0]).toMatchObject({ orgId: A.id, researchRunId: runId, requireJson: true, agentType: "KEYWORD_PRIORITIZATION" });
    // The model saw only retrieved rows, no invented fields.
    const sent = JSON.parse((ai.calls[0].messages as Array<{ content: string }>)[1].content);
    expect(sent.rows).toEqual([{ keyword: "alpha", metrics: { search_volume: 1000, keyword_difficulty: 35 }, rule_based_intent: null }]);
    expect((await h.request("GET", `/api/v1/keyword-research/runs/${runId}`, as("viewer"))).json().data.insight.items).toHaveLength(1);

    ai.answer = { items: [{ keyword: "nothing real", priority: "low", rationale: "x" }] };
    const bad = await h.request("POST", `/api/v1/keyword-research/runs/${runId}/insights`, as());
    expect(bad.json().data).toMatchObject({ status: "failed", items: [], error: "The AI answer did not reference any keyword of this run." });
    expect((await h.request("POST", `/api/v1/keyword-research/runs/${runId}/insights`, as("viewer"))).statusCode).toBe(403);
  });
});
