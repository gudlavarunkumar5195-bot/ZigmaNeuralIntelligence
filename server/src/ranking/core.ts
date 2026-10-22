/**
 * Rank tracking: pure, deterministic logic (no I/O). An observation either
 * has an observed position, or says the subject was not found down to a
 * known depth, or that no data / a failed collection exists. Nothing here
 * turns an absence into a number (no "101" convention) or a failure into a
 * ranking loss.
 */

export type ObservationStatus = "ranked" | "not_in_results" | "no_data" | "failed";

export interface Observation {
  id: string;
  observedDate: string; // YYYY-MM-DD
  status: ObservationStatus;
  position: number | null;
  resultDepth: number | null;
  rankingUrl: string | null;
  source: string;
  serpFeatures: string[];
  ownedFeatures: string[];
}

// ─── Positions ───────────────────────────────────────────────────────────────

/**
 * Parses a position cell of a ranking report. Numbers are positions; ">100",
 * "not in top 100", "-" and similar mean "not found" (with the depth when the
 * report states it); an empty cell means no data. Never invents a position.
 */
export function parsePosition(raw: string | undefined, depthRaw?: string): { status: ObservationStatus; position: number | null; depth: number | null } | { error: string } {
  const s = (raw ?? "").trim().toLowerCase();
  const depthCell = depthRaw?.trim() ? Number(depthRaw.trim()) : null;
  const depth = depthCell !== null && Number.isInteger(depthCell) && depthCell >= 1 && depthCell <= 1000 ? depthCell : null;
  if (!s || s === "n/a" || s === "na" || s === "no data") return { status: "no_data", position: null, depth: null };
  if (/^\d+$/.test(s)) {
    const p = Number(s);
    if (p < 1 || p > 1000) return { error: "Position must be between 1 and 1000" };
    if (depth !== null && p > depth) return { error: "Position is beyond the stated result depth" };
    return { status: "ranked", position: p, depth };
  }
  const beyond = /^(?:>|not in (?:the )?top|not ranked in (?:the )?top|out of top)\s*(\d+)$/.exec(s);
  if (beyond) return { status: "not_in_results", position: null, depth: Number(beyond[1]) <= 1000 ? Number(beyond[1]) : null };
  if (["-", "--", "not ranked", "not found", "not in results", "none", "unranked"].includes(s)) return { status: "not_in_results", position: null, depth };
  if (/^(failed|error)$/.test(s)) return { status: "failed", position: null, depth: null };
  return { error: "Unreadable position" };
}

// ─── SERP features ───────────────────────────────────────────────────────────

const FEATURE_ALIASES: Record<string, string[]> = {
  featured_snippet: ["featured snippet", "featured_snippet", "answer box", "answer_box"],
  local_pack: ["local pack", "local_pack", "map pack", "maps", "local results"],
  images: ["images", "image pack", "image results", "image_pack", "images pack"],
  videos: ["videos", "video", "video results", "video carousel"],
  shopping: ["shopping", "shopping results", "product listings", "popular products"],
  people_also_ask: ["people also ask", "people_also_ask", "paa", "related questions"],
  ai_overview: ["ai overview", "ai_overview", "ai overviews", "sge", "ai-generated answer", "ai answer"],
  top_stories: ["top stories", "news", "top_stories"],
  sitelinks: ["sitelinks", "site links"],
  knowledge_panel: ["knowledge panel", "knowledge graph", "knowledge_panel"],
  reviews: ["reviews", "review stars", "rich snippet reviews"],
};
export const KNOWN_FEATURES = Object.keys(FEATURE_ALIASES);

/** Canonical feature ids from a report cell ("Featured snippet; PAA, Images"); unknown names kept as other:<name>. */
export function parseFeatures(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(/[;,|]/)) {
    const name = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (!name) continue;
    const id = KNOWN_FEATURES.find((f) => FEATURE_ALIASES[f].includes(name));
    out.add(id ?? `other:${name.replace(/[^a-z0-9 _-]/g, "").slice(0, 40)}`);
  }
  return [...out].sort();
}

// ─── Changes between comparable observations ─────────────────────────────────

export type ChangeKind = "improved" | "declined" | "unchanged" | "entered" | "dropped_out" | "unavailable";

const conclusive = (o: Observation | null | undefined): boolean => !!o && (o.status === "ranked" || o.status === "not_in_results");

/** Observations are comparable only from the same source (same methodology); a project fixes engine, location, language and device. */
export const comparable = (a: Observation, b: Observation) => a.source === b.source;

/** The latest conclusive observation older than `current` from the same source. */
export function previousComparable(history: Observation[], current: Observation): Observation | null {
  return history
    .filter((o) => o.id !== current.id && o.observedDate < current.observedDate && conclusive(o) && comparable(o, current))
    .sort((a, b) => b.observedDate.localeCompare(a.observedDate))[0] ?? null;
}

/**
 * Change between a previous and a current observation. Failed or missing
 * data is "unavailable", never a decline. "dropped_out" requires the current
 * search to have looked at least as deep as the previous position.
 */
export function classifyChange(prev: Observation | null, cur: Observation | null): { kind: ChangeKind; delta: number | null; reason: string } {
  if (!cur) return { kind: "unavailable", delta: null, reason: "No observation yet." };
  if (!conclusive(cur)) return { kind: "unavailable", delta: null, reason: cur.status === "failed" ? "The latest collection failed; this is not a ranking change." : "The latest observation has no data." };
  if (!prev) return { kind: "unavailable", delta: null, reason: "No earlier comparable observation from the same source." };
  if (prev.status === "ranked" && cur.status === "ranked") {
    const delta = prev.position! - cur.position!;
    return { kind: delta > 0 ? "improved" : delta < 0 ? "declined" : "unchanged", delta, reason: `Position ${prev.position} on ${prev.observedDate} → ${cur.position} on ${cur.observedDate}.` };
  }
  if (prev.status === "ranked" && cur.status === "not_in_results") {
    if (cur.resultDepth !== null && cur.resultDepth < prev.position!) return { kind: "unavailable", delta: null, reason: `The latest check only looked ${cur.resultDepth} results deep; the previous position was ${prev.position}.` };
    return { kind: "dropped_out", delta: null, reason: `Position ${prev.position} on ${prev.observedDate}; not found${cur.resultDepth ? ` in the top ${cur.resultDepth}` : ""} on ${cur.observedDate}.` };
  }
  if (prev.status === "not_in_results" && cur.status === "ranked") return { kind: "entered", delta: null, reason: `Not found on ${prev.observedDate}; position ${cur.position} on ${cur.observedDate}.` };
  return { kind: "unchanged", delta: null, reason: "Not found in either observation." };
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

export const DISTRIBUTION_BUCKETS = [
  { id: "1-3", min: 1, max: 3 },
  { id: "4-10", min: 4, max: 10 },
  { id: "11-20", min: 11, max: 20 },
  { id: "21-50", min: 21, max: 50 },
  { id: "51-100", min: 51, max: 100 },
  { id: "101+", min: 101, max: 1000 },
] as const;

export function distribution(latest: Array<Observation | null>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries([...DISTRIBUTION_BUCKETS.map((b) => [b.id, 0]), ["not_in_results", 0], ["unavailable", 0]]);
  for (const o of latest) {
    if (o?.status === "ranked") out[DISTRIBUTION_BUCKETS.find((b) => o.position! >= b.min && o.position! <= b.max)!.id]++;
    else if (o?.status === "not_in_results") out.not_in_results++;
    else out.unavailable++;
  }
  return out;
}

/**
 * Top-10 share for one day: keywords observed in positions 1–10 ÷ keywords
 * with a conclusive observation that day. Keywords without conclusive data
 * are excluded (and counted), never treated as not ranking. No click-through
 * curve or search volume is involved.
 */
export function top10Share(dayObservations: Observation[]): { share: number | null; top10: number; conclusive: number; excluded: number } {
  const c = dayObservations.filter(conclusive);
  const top10 = c.filter((o) => o.status === "ranked" && o.position! <= 10).length;
  return { share: c.length ? Math.round((top10 / c.length) * 1000) / 10 : null, top10, conclusive: c.length, excluded: dayObservations.length - c.length };
}

// ─── Competitors ─────────────────────────────────────────────────────────────

export type CompetitorRelation = "both_ranked" | "own_only" | "competitor_only" | "neither" | "not_comparable";

/**
 * Own vs competitor for one keyword, using observations from the same source
 * and day only. Missing data on either side is "not_comparable": it is
 * never read as one side outranking the other.
 */
export function compareWithCompetitor(own: Observation | null, comp: Observation | null): { relation: CompetitorRelation; ahead: "own" | "competitor" | "tie" | null; reason: string } {
  if (!own || !comp || !conclusive(own) || !conclusive(comp)) return { relation: "not_comparable", ahead: null, reason: "No conclusive observations for both sites." };
  if (own.observedDate !== comp.observedDate || own.source !== comp.source) return { relation: "not_comparable", ahead: null, reason: `Observed on different days or by different sources (${own.observedDate} vs ${comp.observedDate}).` };
  if (own.status === "ranked" && comp.status === "ranked") return { relation: "both_ranked", ahead: own.position! < comp.position! ? "own" : own.position! > comp.position! ? "competitor" : "tie", reason: `You ${own.position}, competitor ${comp.position}.` };
  if (own.status === "ranked") return { relation: "own_only", ahead: "own", reason: `You ${own.position}; competitor not found${comp.resultDepth ? ` in the top ${comp.resultDepth}` : ""}.` };
  if (comp.status === "ranked") return { relation: "competitor_only", ahead: "competitor", reason: `Competitor ${comp.position}; you were not found${own.resultDepth ? ` in the top ${own.resultDepth}` : ""}.` };
  return { relation: "neither", ahead: null, reason: "Neither site was found." };
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export type RuleType = "threshold_cross" | "position_change" | "url_change" | "became_unavailable" | "competitor_overtake" | "collection_failures";

export interface AlertRule {
  id: string;
  type: RuleType;
  params: { position?: number; direction?: "into" | "out_of"; positions?: number; consecutive?: number; competitor?: string };
}

export interface AlertEvent {
  eventKey: string;
  observationId: string;
  message: string;
  evidence: Record<string, unknown>;
}

/**
 * Evaluates one rule for one keyword against its own history (any order)
 * and, for competitor_overtake, the competitor's history. Only the latest
 * observation can trigger; the event key names that observation, so
 * re-evaluation is idempotent. Failed collections only ever trigger
 * collection_failures.
 */
export function evaluateRule(rule: AlertRule, keyword: string, own: Observation[], competitor: Observation[] = []): AlertEvent | null {
  const sorted = [...own].sort((a, b) => b.observedDate.localeCompare(a.observedDate));
  const cur = sorted[0];
  if (!cur) return null;
  const key = (suffix = "") => `${rule.type}:${cur.id}${suffix}`;

  if (rule.type === "collection_failures") {
    const n = Math.max(2, rule.params.consecutive ?? 3);
    const lastN = sorted.slice(0, n);
    if (lastN.length < n || !lastN.every((o) => o.status === "failed")) return null;
    return { eventKey: key(), observationId: cur.id, message: `Collection failed ${n} times in a row for “${keyword}”.`, evidence: { failedDates: lastN.map((o) => o.observedDate) } };
  }
  if (!conclusive(cur)) return null;
  const prev = previousComparable(sorted, cur);
  const change = classifyChange(prev, cur);

  switch (rule.type) {
    case "threshold_cross": {
      const n = rule.params.position ?? 10;
      if (!prev) return null;
      const within = (o: Observation) => o.status === "ranked" && o.position! <= n;
      const into = (rule.params.direction ?? "into") === "into";
      if (into && !within(prev) && within(cur)) return { eventKey: key(), observationId: cur.id, message: `“${keyword}” entered the top ${n} (position ${cur.position}).`, evidence: { previous: prev, current: cur } };
      if (!into && within(prev) && !within(cur) && change.kind !== "unavailable") return { eventKey: key(), observationId: cur.id, message: `“${keyword}” left the top ${n}.`, evidence: { previous: prev, current: cur } };
      return null;
    }
    case "position_change": {
      const n = rule.params.positions ?? 5;
      if (change.delta === null || Math.abs(change.delta) < n) return null;
      return { eventKey: key(), observationId: cur.id, message: `“${keyword}” ${change.delta > 0 ? "improved" : "declined"} by ${Math.abs(change.delta)} positions (${prev!.position} → ${cur.position}).`, evidence: { previous: prev, current: cur } };
    }
    case "url_change": {
      if (!prev || prev.status !== "ranked" || cur.status !== "ranked" || !prev.rankingUrl || !cur.rankingUrl || prev.rankingUrl === cur.rankingUrl) return null;
      return { eventKey: key(), observationId: cur.id, message: `The ranking URL for “${keyword}” changed.`, evidence: { from: prev.rankingUrl, to: cur.rankingUrl } };
    }
    case "became_unavailable": {
      // "Sufficient comparable observations": the last N conclusive ones from this source are all "not found", after a ranked one.
      const n = Math.max(1, rule.params.consecutive ?? 2);
      const series = sorted.filter((o) => conclusive(o) && comparable(o, cur));
      const recent = series.slice(0, n);
      const before = series[n];
      if (recent.length < n || !recent.every((o) => o.status === "not_in_results") || !before || before.status !== "ranked") return null;
      if (recent.some((o) => o.resultDepth !== null && o.resultDepth < before.position!)) return null;
      return { eventKey: key(), observationId: cur.id, message: `“${keyword}” has not been found in ${n} consecutive checks (last position ${before.position} on ${before.observedDate}).`, evidence: { lastRanked: before, notFound: recent.map((o) => o.observedDate) } };
    }
    case "competitor_overtake": {
      const compCur = competitor.find((o) => o.observedDate === cur.observedDate && o.source === cur.source) ?? null;
      if (!prev) return null;
      const compPrev = competitor.find((o) => o.observedDate === prev.observedDate && o.source === prev.source) ?? null;
      const now = compareWithCompetitor(cur, compCur);
      const then = compareWithCompetitor(prev, compPrev);
      if (now.relation === "not_comparable" || then.relation === "not_comparable") return null;
      if (then.ahead === "own" && now.ahead === "competitor") {
        return { eventKey: key(`:${rule.params.competitor ?? ""}`), observationId: cur.id, message: `${rule.params.competitor} overtook you for “${keyword}” (${now.reason})`, evidence: { before: then.reason, after: now.reason } };
      }
      return null;
    }
  }
}
