/**
 * Keyword normalization, rule-based intent and keyword-gap classification.
 * Pure functions: no I/O, deterministic, fully unit-tested.
 *
 * Normalization (the matching key; the original text is always kept for
 * display):
 *   1. Unicode NFKC (full-width letters, ligatures -> canonical forms)
 *   2. lowercase
 *   3. trim, collapse internal whitespace to one space
 *   4. strip leading/trailing quotes and punctuation, but keep characters that
 *      change meaning inside terms ("c++", "c#", ".net", "node.js")
 * Two keywords match when their normalized keys are equal. No stemming, no
 * synonym or plural folding: "shoe" and "shoes" are different keywords, as
 * search engines report them.
 */

export const MAX_KEYWORD_LENGTH = 200;

// A leading dot is kept (".net"); a trailing one is not ("shoes." -> "shoes").
const EDGE_PUNCT = /^[\s"'`“”‘’«»()[\]{}<>,;:!?¡¿…–—-]+|[\s"'`“”‘’«»()[\]{}<>.,;:!?¡¿…–—-]+$/gu;

export function normalizeKeyword(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(EDGE_PUNCT, "")
    .trim()
    .slice(0, MAX_KEYWORD_LENGTH);
}

/** Validated user input: non-empty after normalization, bounded length, no control characters. */
export function isValidKeyword(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (input.length > MAX_KEYWORD_LENGTH * 2 || /[\u0000-\u001f\u007f]/u.test(input)) return false;
  return normalizeKeyword(input).length > 0;
}

// ─── Intent (rule-based, locally calculated) ────────────────────────────────

export type Intent = "informational" | "navigational" | "commercial" | "transactional";

const TRANSACTIONAL = /\b(buy|order|purchase|price|prices|pricing|cost|cheap|cheapest|discount|coupon|coupons|deal|deals|for sale|shop|subscribe|subscription|free trial|download|hire|quote|book|booking)\b/u;
const COMMERCIAL = /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|recommended|rated|ranking)\b/u;
const NAVIGATIONAL = /\b(login|log in|sign in|signin|sign up|signup|account|dashboard|official site|website|app|contact|support|customer service|near me)\b/u;
const INFORMATIONAL = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will)\b|\b(how to|guide|tutorial|tips|ideas|examples|meaning|definition|learn|explained)\b|\?$/u;

/**
 * Deterministic, explainable intent labels from wording only. Returns null
 * when no rule applies: no guess is made. Brand terms (e.g. the site's own
 * name) mark navigational intent.
 */
export function classifyIntent(keyword: string, brandTerms: string[] = []): { intent: Intent; rule: string } | null {
  const k = normalizeKeyword(keyword);
  if (!k) return null;
  const brands = brandTerms.map(normalizeKeyword).filter((b) => b.length >= 3);
  const brand = brands.find((b) => new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u").test(k));
  if (brand) return { intent: "navigational", rule: `brand term "${brand}"` };
  const checks: Array<[Intent, RegExp]> = [
    ["transactional", TRANSACTIONAL],
    ["commercial", COMMERCIAL],
    ["navigational", NAVIGATIONAL],
    ["informational", INFORMATIONAL],
  ];
  for (const [intent, re] of checks) {
    const m = re.exec(k);
    if (m) return { intent, rule: `contains "${m[0].trim() || "?"}"` };
  }
  return null;
}

/** Brand terms from a domain: "www.acme-shop.co.uk" -> ["acme-shop", "acme shop"]. */
export function brandTermsFromDomain(domain: string): string[] {
  const host = domain.toLowerCase().replace(/^www\./u, "");
  const label = host.split(".")[0] ?? "";
  if (label.length < 3) return [];
  return [...new Set([label, label.replace(/[-_]+/gu, " ")])];
}

// ─── Keyword gap ─────────────────────────────────────────────────────────────

export interface Observation {
  keyword: string;
  position?: number | null;
  clicks?: number | null;
  impressions?: number | null;
}

export interface GapDataset {
  id: string;
  label: string;
  role: "customer" | "competitor";
  /** False when the source returns a sample (top rows, omitted rare queries): absence is then "not observed", not "absent". */
  complete: boolean;
  observedAt: string | null;
  rows: Observation[];
}

export type GapCategory = "shared" | "missing" | "unique";

export interface GapRow {
  key: string;
  keyword: string;
  category: GapCategory;
  /** True when the category relies on absence from a dataset that is only a sample. */
  absenceFromSample: boolean;
  competitorsPresent: number;
  observations: Record<string, { position: number | null; clicks: number | null; impressions: number | null; duplicates: number }>;
}

export interface GapResult {
  rows: GapRow[];
  counts: Record<GapCategory, number>;
  datasets: Array<{ id: string; label: string; role: string; complete: boolean; observedAt: string | null; keywords: number; duplicatesMerged: number; invalidSkipped: number }>;
}

/**
 * Classify every keyword across one customer dataset and N competitor
 * datasets:
 * - shared:  observed for the customer and at least one competitor;
 * - missing: observed for at least one competitor, not for the customer;
 * - unique:  observed for the customer, for no competitor.
 * Duplicates within a dataset merge into one observation (best position,
 * summed clicks/impressions) and are counted. Missing metrics stay null,
 * never zero. Absence-based categories carry absenceFromSample when the
 * dataset that "lacks" the keyword is only a sample.
 */
export function classifyGap(customer: GapDataset, competitors: GapDataset[]): GapResult {
  if (customer.role !== "customer" || competitors.some((c) => c.role !== "competitor")) throw new Error("classifyGap: dataset roles are wrong");
  const all = [customer, ...competitors];
  const ids = new Set(all.map((d) => d.id));
  if (ids.size !== all.length) throw new Error("classifyGap: dataset ids must be unique");
  const display = new Map<string, string>();
  const perDataset = new Map<string, Map<string, GapRow["observations"][string]>>();
  const stats = all.map((d) => ({ id: d.id, label: d.label, role: d.role, complete: d.complete, observedAt: d.observedAt, keywords: 0, duplicatesMerged: 0, invalidSkipped: 0 }));

  all.forEach((dataset, i) => {
    const seen = new Map<string, GapRow["observations"][string]>();
    for (const row of dataset.rows) {
      const key = typeof row.keyword === "string" ? normalizeKeyword(row.keyword) : "";
      if (!key) {
        stats[i].invalidSkipped++;
        continue;
      }
      if (!display.has(key) || dataset.role === "customer") display.set(key, row.keyword.trim());
      const prev = seen.get(key);
      const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (!prev) {
        seen.set(key, { position: num(row.position), clicks: num(row.clicks), impressions: num(row.impressions), duplicates: 0 });
        continue;
      }
      stats[i].duplicatesMerged++;
      const pos = num(row.position);
      prev.position = prev.position === null ? pos : pos === null ? prev.position : Math.min(prev.position, pos);
      const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
      prev.clicks = add(prev.clicks, num(row.clicks));
      prev.impressions = add(prev.impressions, num(row.impressions));
      prev.duplicates++;
    }
    stats[i].keywords = seen.size;
    perDataset.set(dataset.id, seen);
  });

  const rows: GapRow[] = [];
  for (const [key, keyword] of display) {
    const inCustomer = perDataset.get(customer.id)!.has(key);
    const present = competitors.filter((c) => perDataset.get(c.id)!.has(key));
    const category: GapCategory = inCustomer ? (present.length > 0 ? "shared" : "unique") : "missing";
    const absenceFromSample =
      category === "missing" ? !customer.complete : category === "unique" ? competitors.some((c) => !c.complete) : false;
    const observations: GapRow["observations"] = {};
    for (const d of all) {
      const o = perDataset.get(d.id)!.get(key);
      if (o) observations[d.id] = o;
    }
    rows.push({ key, keyword, category, absenceFromSample, competitorsPresent: present.length, observations });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category) || b.competitorsPresent - a.competitorsPresent || a.key.localeCompare(b.key));
  const counts = { shared: 0, missing: 0, unique: 0 } as Record<GapCategory, number>;
  for (const r of rows) counts[r.category]++;
  return { rows, counts, datasets: stats };
}

/** Compare two snapshots of the same kind: added, removed, changed (by key). */
export function compareSnapshots<T extends { key: string; metrics: Record<string, number | null | undefined> }>(older: T[], newer: T[]) {
  const a = new Map(older.map((r) => [r.key, r]));
  const b = new Map(newer.map((r) => [r.key, r]));
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed: Array<{ key: string; changes: Record<string, { from: number | null; to: number | null }> }> = [];
  for (const [key, row] of b) {
    const prev = a.get(key);
    if (!prev) continue;
    const changes: Record<string, { from: number | null; to: number | null }> = {};
    for (const metric of new Set([...Object.keys(prev.metrics), ...Object.keys(row.metrics)])) {
      const from = prev.metrics[metric] ?? null;
      const to = row.metrics[metric] ?? null;
      if (from !== to) changes[metric] = { from, to };
    }
    if (Object.keys(changes).length) changed.push({ key, changes });
  }
  changed.sort((x, y) => x.key.localeCompare(y.key));
  return { added, removed, changed };
}
