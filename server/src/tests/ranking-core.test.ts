import { describe, expect, it } from "vitest";
import {
  classifyChange,
  compareWithCompetitor,
  distribution,
  evaluateRule,
  parseFeatures,
  parsePosition,
  previousComparable,
  top10Share,
  type Observation,
} from "../ranking/core.js";

// Synthetic observations only.
let n = 0;
const obs = (date: string, status: Observation["status"], position: number | null = null, over: Partial<Observation> = {}): Observation => ({
  id: `o${++n}`, observedDate: date, status, position, resultDepth: status === "not_in_results" ? 100 : null, rankingUrl: position ? "https://me.example/p" : null, source: "csv_import", serpFeatures: [], ownedFeatures: [], ...over,
});

describe("position parsing", () => {
  it("keeps positions, 'not found to depth N', no data and failures distinct; never invents 101", () => {
    expect(parsePosition("7")).toEqual({ status: "ranked", position: 7, depth: null });
    expect(parsePosition(">100")).toEqual({ status: "not_in_results", position: null, depth: 100 });
    expect(parsePosition("Not in top 50")).toEqual({ status: "not_in_results", position: null, depth: 50 });
    expect(parsePosition("-", "100")).toEqual({ status: "not_in_results", position: null, depth: 100 });
    expect(parsePosition("-")).toEqual({ status: "not_in_results", position: null, depth: null });
    expect(parsePosition("")).toEqual({ status: "no_data", position: null, depth: null });
    expect(parsePosition("n/a")).toEqual({ status: "no_data", position: null, depth: null });
    expect(parsePosition("failed")).toEqual({ status: "failed", position: null, depth: null });
    expect(parsePosition("0")).toEqual({ error: "Position must be between 1 and 1000" });
    expect(parsePosition("55", "50")).toEqual({ error: "Position is beyond the stated result depth" });
    expect(parsePosition("about 3")).toEqual({ error: "Unreadable position" });
  });
});

describe("SERP feature parsing", () => {
  it("maps names to canonical ids and keeps unknown ones as other:", () => {
    expect(parseFeatures("Featured snippet; PAA, Images | AI Overview")).toEqual(["ai_overview", "featured_snippet", "images", "people_also_ask"]);
    expect(parseFeatures("Local pack;Jobs widget")).toEqual(["local_pack", "other:jobs widget"]);
    expect(parseFeatures(undefined)).toEqual([]);
  });
});

describe("changes between comparable observations", () => {
  it("classifies improved, declined, unchanged with deltas", () => {
    expect(classifyChange(obs("2026-01-01", "ranked", 8), obs("2026-01-08", "ranked", 3))).toMatchObject({ kind: "improved", delta: 5 });
    expect(classifyChange(obs("2026-01-01", "ranked", 3), obs("2026-01-08", "ranked", 9))).toMatchObject({ kind: "declined", delta: -6 });
    expect(classifyChange(obs("2026-01-01", "ranked", 4), obs("2026-01-08", "ranked", 4))).toMatchObject({ kind: "unchanged", delta: 0 });
  });
  it("a failed or empty collection is never a decline", () => {
    expect(classifyChange(obs("2026-01-01", "ranked", 3), obs("2026-01-08", "failed"))).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/not a ranking change/) });
    expect(classifyChange(obs("2026-01-01", "ranked", 3), obs("2026-01-08", "no_data"))).toMatchObject({ kind: "unavailable" });
    expect(classifyChange(null, obs("2026-01-08", "ranked", 3))).toMatchObject({ kind: "unavailable" });
  });
  it("dropped out only when the new check looked deep enough", () => {
    expect(classifyChange(obs("2026-01-01", "ranked", 12), obs("2026-01-08", "not_in_results"))).toMatchObject({ kind: "dropped_out" });
    expect(classifyChange(obs("2026-01-01", "ranked", 60), obs("2026-01-08", "not_in_results", null, { resultDepth: 50 }))).toMatchObject({ kind: "unavailable" });
    expect(classifyChange(obs("2026-01-01", "not_in_results"), obs("2026-01-08", "ranked", 40))).toMatchObject({ kind: "entered" });
  });
  it("previous comparable skips failures, other sources and later days", () => {
    const cur = obs("2026-01-10", "ranked", 5);
    const history = [cur, obs("2026-01-09", "failed"), obs("2026-01-08", "ranked", 2, { source: "other_tool" }), obs("2026-01-07", "ranked", 7), obs("2026-01-11", "ranked", 1)];
    expect(previousComparable(history, cur)!.observedDate).toBe("2026-01-07");
  });
});

describe("aggregates", () => {
  it("distribution and top-10 share use only conclusive observations", () => {
    const latest = [obs("d", "ranked", 1), obs("d", "ranked", 9), obs("d", "ranked", 15), obs("d", "ranked", 120), obs("d", "not_in_results"), obs("d", "failed"), null];
    expect(distribution(latest)).toEqual({ "1-3": 1, "4-10": 1, "11-20": 1, "21-50": 0, "51-100": 0, "101+": 1, not_in_results: 1, unavailable: 2 });
    expect(top10Share(latest.filter((o): o is Observation => !!o))).toEqual({ share: 40, top10: 2, conclusive: 5, excluded: 1 });
    expect(top10Share([obs("d", "failed")])).toEqual({ share: null, top10: 0, conclusive: 0, excluded: 1 });
  });
});

describe("competitor comparison", () => {
  it("compares only same-day, same-source conclusive observations; missing data is not comparable", () => {
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), obs("2026-01-01", "ranked", 5))).toMatchObject({ relation: "both_ranked", ahead: "own" });
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), obs("2026-01-01", "not_in_results"))).toMatchObject({ relation: "own_only", ahead: "own" });
    expect(compareWithCompetitor(obs("2026-01-01", "not_in_results"), obs("2026-01-01", "ranked", 8))).toMatchObject({ relation: "competitor_only", ahead: "competitor" });
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), null)).toMatchObject({ relation: "not_comparable", ahead: null });
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), obs("2026-01-01", "failed"))).toMatchObject({ relation: "not_comparable" });
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), obs("2026-01-02", "ranked", 1))).toMatchObject({ relation: "not_comparable" });
    expect(compareWithCompetitor(obs("2026-01-01", "ranked", 3), obs("2026-01-01", "ranked", 1, { source: "other" }))).toMatchObject({ relation: "not_comparable" });
  });
});

describe("alert rules", () => {
  const rule = (type: Parameters<typeof evaluateRule>[0]["type"], params = {}) => ({ id: "r", type, params });
  it("threshold crossing, both directions, keyed on the triggering observation", () => {
    const into = [obs("2026-01-08", "ranked", 9), obs("2026-01-01", "ranked", 14)];
    const e = evaluateRule(rule("threshold_cross", { position: 10 }), "kw", into)!;
    expect(e.message).toBe("“kw” entered the top 10 (position 9).");
    expect(e.eventKey).toBe(`threshold_cross:${into[0].id}`);
    expect(evaluateRule(rule("threshold_cross", { position: 10, direction: "out_of" }), "kw", [obs("2026-01-08", "not_in_results"), obs("2026-01-01", "ranked", 4)])).not.toBeNull();
  });
  it("a failed collection never triggers a ranking alert", () => {
    const h = [obs("2026-01-08", "failed"), obs("2026-01-01", "ranked", 4)];
    for (const t of ["threshold_cross", "position_change", "url_change", "became_unavailable"] as const) expect(evaluateRule(rule(t, { direction: "out_of", positions: 1, consecutive: 1 }), "kw", h)).toBeNull();
  });
  it("position change by at least N; URL change", () => {
    expect(evaluateRule(rule("position_change", { positions: 5 }), "kw", [obs("2026-01-08", "ranked", 12), obs("2026-01-01", "ranked", 3)])!.message).toMatch(/declined by 9 positions/);
    expect(evaluateRule(rule("position_change", { positions: 5 }), "kw", [obs("2026-01-08", "ranked", 5), obs("2026-01-01", "ranked", 3)])).toBeNull();
    expect(evaluateRule(rule("url_change"), "kw", [obs("2026-01-08", "ranked", 5, { rankingUrl: "https://me.example/b" }), obs("2026-01-01", "ranked", 5, { rankingUrl: "https://me.example/a" })])!.evidence).toEqual({ from: "https://me.example/a", to: "https://me.example/b" });
  });
  it("became unavailable needs N consecutive 'not found' after a ranked one", () => {
    const once = [obs("2026-01-08", "not_in_results"), obs("2026-01-01", "ranked", 6)];
    expect(evaluateRule(rule("became_unavailable", { consecutive: 2 }), "kw", once)).toBeNull();
    const twice = [obs("2026-01-15", "not_in_results"), obs("2026-01-08", "not_in_results"), obs("2026-01-05", "failed"), obs("2026-01-01", "ranked", 6)];
    expect(evaluateRule(rule("became_unavailable", { consecutive: 2 }), "kw", twice)!.message).toMatch(/not been found in 2 consecutive checks \(last position 6/);
  });
  it("competitor overtake only from comparable observations on both days", () => {
    const own = [obs("2026-01-08", "ranked", 6), obs("2026-01-01", "ranked", 3)];
    const comp = [obs("2026-01-08", "ranked", 2), obs("2026-01-01", "ranked", 5)];
    expect(evaluateRule(rule("competitor_overtake", { competitor: "rival.example" }), "kw", own, comp)!.message).toMatch(/rival\.example overtook you/);
    expect(evaluateRule(rule("competitor_overtake", { competitor: "rival.example" }), "kw", own, [comp[0]])).toBeNull(); // no comparable earlier day
  });
  it("collection failures after N consecutive failures", () => {
    expect(evaluateRule(rule("collection_failures", { consecutive: 3 }), "kw", [obs("3", "failed"), obs("2", "failed"), obs("1", "failed")])).not.toBeNull();
    expect(evaluateRule(rule("collection_failures", { consecutive: 3 }), "kw", [obs("3", "failed"), obs("2", "ranked", 1), obs("1", "failed")])).toBeNull();
  });
});
