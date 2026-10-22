import { createHash } from "node:crypto";
import { z } from "zod";
import { prioritize, type Factor } from "../content/core.js";

/**
 * Unified SEO workspace: pure, deterministic logic (no I/O). Date ranges,
 * freshness, cross-module insight rules, action normalization and report
 * rendering. Metrics are computed by their own modules; this layer only
 * combines what they measured and says what is missing.
 */

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const INSIGHT_RULES_VERSION = "insights-1";

// ─── Date ranges ─────────────────────────────────────────────────────────────

export const RANGE_PRESETS = ["7d", "28d", "90d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const MAX_RANGE_DAYS = 480;

const DAY_MS = 86_400_000;
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Today in Pacific Time: Search Console reports days in PT, so the workspace uses the same calendar. */
export function todayPT(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string } | null;
  timezone: "America/Los_Angeles";
  notes: string[];
}

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

/**
 * Resolves a requested range. Presets end yesterday (PT): today is never a
 * complete day in any source. Custom ranges must be real days, not in the
 * future, at most MAX_RANGE_DAYS long and inside the last MAX_RANGE_DAYS.
 * The comparison period is the preceding period of equal length.
 */
export function resolveRange(input: { preset?: RangePreset; from?: string; to?: string; compare?: "previous" | "none" }, now = new Date()): DateRange {
  const preset = input.preset ?? "28d";
  const today = todayPT(now);
  const yesterday = addDays(today, -1);
  const notes: string[] = [];
  let from: string;
  let to: string;
  if (preset === "custom") {
    if (!isDay(input.from) || !isDay(input.to)) throw new DateRangeError("A custom range needs from and to as YYYY-MM-DD.");
    from = input.from;
    to = input.to;
    if (from > to) throw new DateRangeError("The start date is after the end date.");
    if (to > today) throw new DateRangeError("The range cannot end in the future.");
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new DateRangeError(`A range can cover at most ${MAX_RANGE_DAYS} days.`);
    if (from < addDays(today, -MAX_RANGE_DAYS)) throw new DateRangeError(`Data older than ${MAX_RANGE_DAYS} days is not kept.`);
    if (to === today) notes.push("The range includes today, which no source has complete data for yet.");
  } else {
    if (input.from !== undefined || input.to !== undefined) throw new DateRangeError("from and to are only accepted with preset=custom.");
    const days = Number(preset.replace("d", ""));
    to = yesterday;
    from = addDays(to, -(days - 1));
  }
  const days = daysBetween(from, to) + 1;
  const previous = input.compare === "none" ? null : { from: addDays(from, -days), to: addDays(from, -1) };
  return { preset, from, to, days, previous, timezone: "America/Los_Angeles", notes };
}

// ─── Freshness ───────────────────────────────────────────────────────────────

export type FreshnessState = "fresh" | "stale" | "never";

export interface Freshness {
  state: FreshnessState;
  lastUpdatedAt: string | null;
  ageHours: number | null;
  staleAfterHours: number;
}

export function freshness(last: Date | string | null | undefined, staleAfterHours: number, now = new Date()): Freshness {
  if (!last) return { state: "never", lastUpdatedAt: null, ageHours: null, staleAfterHours };
  const t = typeof last === "string" ? Date.parse(last.length === 10 ? `${last}T00:00:00Z` : last) : last.getTime();
  if (Number.isNaN(t)) return { state: "never", lastUpdatedAt: null, ageHours: null, staleAfterHours };
  const ageHours = Math.max(0, Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10);
  return { state: ageHours > staleAfterHours ? "stale" : "fresh", lastUpdatedAt: new Date(t).toISOString(), ageHours, staleAfterHours };
}

// ─── Sections ────────────────────────────────────────────────────────────────

export type SectionStatus = "ok" | "partial" | "no_data" | "not_configured" | "auth_expired" | "error" | "timeout";
export type RangeSupport = "full" | "events_only" | "snapshot";

export interface Section<T> {
  module: string;
  status: SectionStatus;
  freshness: Freshness | null;
  range: { support: RangeSupport; note: string };
  notes: string[];
  link: string;
  data: T | null;
}

/** Runs a module collector with a timeout; failures become an error section instead of failing the dashboard. */
export async function collect<T>(module: string, link: string, support: RangeSupport, supportNote: string, timeoutMs: number, fn: () => Promise<Omit<Section<T>, "module" | "link" | "range">>): Promise<Section<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    const r = await Promise.race([fn(), timeout]);
    if (r === "timeout") return { module, link, status: "timeout", freshness: null, range: { support, note: supportNote }, notes: [`This module did not answer within ${Math.round(timeoutMs / 1000)} s; other sections are unaffected.`], data: null };
    return { module, link, range: { support, note: supportNote }, ...r };
  } catch (err) {
    console.error(`[seo-workspace] ${module} section failed:`, (err as Error).message);
    return { module, link, status: "error", freshness: null, range: { support, note: supportNote }, notes: ["This module could not be read right now; other sections are unaffected."], data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Change between two measured values; null when either side is missing (never treated as zero). */
export function change(current: number | null | undefined, previous: number | null | undefined) {
  if (current === null || current === undefined || previous === null || previous === undefined) return { change: null, changePct: null };
  return { change: current - previous, changePct: previous === 0 ? null : (current - previous) / previous };
}

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Comparison key for page URLs across modules: lowercase host without www, no fragment, no trailing slash (except root). */
export function urlKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "/";
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return null;
  }
}

// ─── Insight rules ───────────────────────────────────────────────────────────

export interface EvidenceRef {
  module: "search_console" | "technical" | "content" | "rankings" | "backlinks" | "ai_visibility";
  kind: string;
  id?: string;
  url?: string;
  label: string;
  observedAt?: string | null;
  link?: string;
}

export interface InsightCandidate {
  ruleId: string;
  fingerprint: string;
  entityType: "website" | "page" | "keyword" | "competitor" | "source" | "topic";
  entityValue: string;
  title: string;
  explanation: string;
  action: string;
  evidence: EvidenceRef[];
  modules: string[];
  observedFrom: string | null;
  observedTo: string | null;
  limitations: string[];
  factors: Factor[];
  priority: number;
  confidence: "high" | "medium" | "low";
}

export const INSIGHT_RULES: Record<string, { title: string; modules: string[]; description: string }> = {
  low_ctr_with_snippet_issue: { title: "Low CTR on a page with a title or description problem", modules: ["search_console", "technical", "content"], description: "Pages with at least 100 impressions whose CTR is below half the site's CTR, that also have an open title or meta description finding." },
  search_page_not_indexable: { title: "Page with search impressions is not indexable in the latest crawl", modules: ["search_console", "technical"], description: "Pages with impressions in the range that the latest crawl found non-indexable (noindex, canonicalised elsewhere, error status, …)." },
  broken_links_on_landing_page: { title: "Important landing page links to a broken URL", modules: ["search_console", "technical"], description: "Open broken-internal-link issues whose linking pages include one of the site's 20 pages with the most clicks in the range." },
  declining_keyword_with_page_issue: { title: "Tracked keyword declined while its page has an open technical issue", modules: ["rankings", "technical"], description: "Tracked keywords that declined or dropped out between comparable observations, whose ranking or landing page has an open medium-or-higher technical issue." },
  competitor_outranks_with_backlink_evidence: { title: "Competitor outranks you and has imported backlink evidence", modules: ["rankings", "backlinks"], description: "Competitors ahead of your site on at least 2 tracked keywords in same-day, same-source observations, for which a competitor backlink dataset was imported." },
  ai_cited_source_without_link: { title: "AI answers cite a site that does not link to you", modules: ["ai_visibility", "backlinks"], description: "A third-party host cited in at least 2 AI answers about your monitored queries that is not a referring domain in your latest backlink dataset." },
};

const CORRELATION = "This is a correlation between observations from different modules, not proof that one caused the other.";
const confidenceFor = (n: number): InsightCandidate["confidence"] => (n >= 10 ? "high" : n >= 3 ? "medium" : "low");
const cap = (x: number) => Math.max(0, Math.min(1, x));
const finish = (c: Omit<InsightCandidate, "priority">): InsightCandidate => ({ ...c, priority: prioritize(c.factors) });

export interface SearchPageFact { url: string; clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface IssueFact { id: string; ruleId: string; severity: string; url: string; firstSeenAt: string; details?: Record<string, unknown> | null }
export interface ContentFindingFact { id: string; ruleId: string; url: string; severity: string }
export interface CrawlPageFact { url: string; indexable: boolean | null; reasons: string[]; statusCode: number | null; scanId: string; crawledAt: string }
export interface KeywordFact { keywordId: string; keyword: string; projectId: string; change: KeywordChange; position: number | null; previousPosition: number | null; url: string | null; landingPage: string | null; observedDate: string | null; previousDate: string | null; observationId: string | null }
export interface CompetitorWinFact { domain: string; projectId: string; keywords: Array<{ keyword: string; own: number | null; competitor: number; observedDate: string; observationId: string }> }
export interface CompetitorDatasetFact { domain: string; datasetId: string; referringDomains: number | null; collectedOn: string | null; coverage: string }
export interface CitedHostFact { host: string; brandId: string; observationIds: string[]; lastObservedAt: string | null }

export interface InsightInput {
  websiteId: string;
  domain: string;
  range: { from: string; to: string };
  search: { available: boolean; siteCtr: number | null; pages: SearchPageFact[] };
  issues: IssueFact[];
  contentFindings: ContentFindingFact[];
  crawlPages: CrawlPageFact[];
  keywords: KeywordFact[];
  competitorWins: CompetitorWinFact[];
  competitorDatasets: CompetitorDatasetFact[];
  ownBacklinks: { datasetId: string; referringDomains: Set<string>; collectedOn: string | null } | null;
  citedHosts: CitedHostFact[];
}

const SNIPPET_ISSUE_RULES = new Set(["title_missing", "title_duplicate", "meta_description_missing", "meta_description_duplicate"]);
const SNIPPET_CONTENT_RULES = /^(title_|meta_description|description_)/;
const PAGE_ISSUE_SEVERITY = new Set(["critical", "high", "medium"]);

export function evaluateInsights(input: InsightInput): { insights: InsightCandidate[]; skipped: Array<{ ruleId: string; reason: string }> } {
  const out: InsightCandidate[] = [];
  const skipped: Array<{ ruleId: string; reason: string }> = [];
  const issuesByUrl = new Map<string, IssueFact[]>();
  for (const i of input.issues) {
    const k = urlKey(i.url);
    if (k) issuesByUrl.set(k, [...(issuesByUrl.get(k) ?? []), i]);
  }
  const findingsByUrl = new Map<string, ContentFindingFact[]>();
  for (const f of input.contentFindings) {
    const k = urlKey(f.url);
    if (k) findingsByUrl.set(k, [...(findingsByUrl.get(k) ?? []), f]);
  }
  const range = input.range;
  const gscRef = (p: SearchPageFact): EvidenceRef => ({ module: "search_console", kind: "page_metrics", url: p.url, label: `${p.impressions} impressions, ${p.clicks} clicks${p.ctr !== null ? `, CTR ${(p.ctr * 100).toFixed(2)}%` : ""} (${range.from} – ${range.to})`, observedAt: range.to, link: "/search/performance" });
  const issueRef = (i: IssueFact): EvidenceRef => ({ module: "technical", kind: "site_issue", id: i.id, url: i.url, label: `${i.ruleId} (${i.severity}), open since ${i.firstSeenAt.slice(0, 10)}`, observedAt: i.firstSeenAt, link: "/intelligence/technical-health" });

  // 1 & 2 & 3 need Search Console.
  if (!input.search.available) {
    for (const r of ["low_ctr_with_snippet_issue", "search_page_not_indexable", "broken_links_on_landing_page"]) skipped.push({ ruleId: r, reason: "Search Console is not connected or has no data in the range." });
  } else {
    const siteCtr = input.search.siteCtr;
    if (siteCtr === null || siteCtr === 0) skipped.push({ ruleId: "low_ctr_with_snippet_issue", reason: "The site's CTR in the range is unknown." });
    else {
      for (const p of input.search.pages) {
        if (p.impressions < 100 || p.ctr === null || p.ctr >= siteCtr * 0.5) continue;
        const k = urlKey(p.url);
        if (!k) continue;
        const issues = (issuesByUrl.get(k) ?? []).filter((i) => SNIPPET_ISSUE_RULES.has(i.ruleId));
        const findings = (findingsByUrl.get(k) ?? []).filter((f) => SNIPPET_CONTENT_RULES.test(f.ruleId));
        if (!issues.length && !findings.length) continue;
        out.push(finish({
          ruleId: "low_ctr_with_snippet_issue", fingerprint: sha(`low_ctr_with_snippet_issue|${input.websiteId}|${k}`), entityType: "page", entityValue: p.url,
          title: `Low CTR on ${p.url} while its title or description has an open finding`,
          explanation: `In ${range.from} – ${range.to} this page had ${p.impressions} impressions and a CTR of ${((p.ctr ?? 0) * 100).toFixed(2)}%, under half the site's ${(siteCtr * 100).toFixed(2)}%. Its search snippet has open findings: ${[...issues.map((i) => i.ruleId), ...findings.map((f) => f.ruleId)].join(", ")}.`,
          action: "Fix the title and meta description findings for this page so the snippet describes it accurately, then compare CTR over a later period of the same length.",
          evidence: [gscRef(p), ...issues.map(issueRef), ...findings.map((f): EvidenceRef => ({ module: "content", kind: "content_finding", id: f.id, url: f.url, label: `${f.ruleId} (${f.severity})`, link: "/intelligence/content/audit" }))],
          modules: ["search_console", ...(issues.length ? ["technical"] : []), ...(findings.length ? ["content"] : [])], observedFrom: range.from, observedTo: range.to,
          limitations: [CORRELATION, "CTR also depends on position, SERP features and query mix; a snippet fix is not guaranteed to change it."],
          factors: [
            { name: "impressions", weight: 0.5, value: cap(Math.log10(p.impressions) / 5), explanation: `${p.impressions} impressions (100 000 or more counts as full).` },
            { name: "ctr_gap", weight: 0.3, value: cap(1 - (p.ctr ?? 0) / siteCtr), explanation: `CTR is ${Math.round((1 - (p.ctr ?? 0) / siteCtr) * 100)}% below the site's CTR.` },
            { name: "finding_count", weight: 0.2, value: cap((issues.length + findings.length) / 3), explanation: `${issues.length + findings.length} open snippet findings.` },
          ],
          confidence: p.impressions >= 1000 ? "high" : "medium",
        }));
      }
    }
    if (!input.crawlPages.length) skipped.push({ ruleId: "search_page_not_indexable", reason: "No completed crawl to compare with." });
    else {
      const crawled = new Map(input.crawlPages.map((c) => [urlKey(c.url), c]));
      for (const p of input.search.pages) {
        const c = crawled.get(urlKey(p.url));
        if (!c || c.indexable !== false || p.impressions < 10) continue;
        out.push(finish({
          ruleId: "search_page_not_indexable", fingerprint: sha(`search_page_not_indexable|${input.websiteId}|${urlKey(p.url)}`), entityType: "page", entityValue: p.url,
          title: `${p.url} gets search impressions but is not indexable in the latest crawl`,
          explanation: `Search Console recorded ${p.impressions} impressions for this page in ${range.from} – ${range.to}, but the crawl on ${c.crawledAt.slice(0, 10)} found it not indexable (${c.reasons.join(", ") || `status ${c.statusCode ?? "unknown"}`}).`,
          action: "Check whether the page should be indexed. If yes, remove the noindex, fix the status code or canonical; if not, make sure internal links and sitemaps point to the right page.",
          evidence: [gscRef(p), { module: "technical", kind: "crawl_page", id: c.scanId, url: c.url, label: `Not indexable: ${c.reasons.join(", ") || "see crawl"}`, observedAt: c.crawledAt, link: "/intelligence/technical-health" }],
          modules: ["search_console", "technical"], observedFrom: range.from, observedTo: range.to,
          limitations: ["Search Console impressions may predate the change that made the page non-indexable.", "Indexability is as seen by our crawler, not by Google."],
          factors: [{ name: "impressions", weight: 1, value: cap(Math.log10(p.impressions) / 5), explanation: `${p.impressions} impressions.` }],
          confidence: p.impressions >= 100 ? "high" : "medium",
        }));
      }
    }
    const top = [...input.search.pages].sort((a, b) => b.clicks - a.clicks).slice(0, 20).filter((p) => p.clicks > 0);
    const topKeys = new Map(top.map((p) => [urlKey(p.url), p]));
    for (const i of input.issues.filter((x) => x.ruleId === "broken_internal_link")) {
      const from = Array.isArray(i.details?.linkedFrom) ? (i.details!.linkedFrom as unknown[]).filter((u): u is string => typeof u === "string") : [];
      const hits = from.map((u) => topKeys.get(urlKey(u))).filter((p): p is SearchPageFact => !!p);
      if (!hits.length) continue;
      out.push(finish({
        ruleId: "broken_links_on_landing_page", fingerprint: sha(`broken_links_on_landing_page|${input.websiteId}|${i.id}`), entityType: "page", entityValue: hits[0].url,
        title: `${hits.length === 1 ? "A top landing page links" : `${hits.length} top landing pages link`} to a broken URL: ${i.url}`,
        explanation: `${i.url} returns an error, and it is linked from ${hits.map((h) => `${h.url} (${h.clicks} clicks)`).join(", ")} — among the 20 pages with the most search clicks in ${range.from} – ${range.to}.`,
        action: "Fix or remove the broken links on these landing pages, or restore/redirect the target.",
        evidence: [issueRef(i), ...hits.map(gscRef)], modules: ["technical", "search_console"], observedFrom: range.from, observedTo: range.to,
        limitations: ["The crawler records a sample of linking pages; more pages may link to the broken URL."],
        factors: [
          { name: "landing_clicks", weight: 0.7, value: cap(Math.log10(hits.reduce((s, h) => s + h.clicks, 0) + 1) / 4), explanation: `${hits.reduce((s, h) => s + h.clicks, 0)} clicks on the linking pages.` },
          { name: "pages", weight: 0.3, value: cap(hits.length / 5), explanation: `${hits.length} top pages link to it.` },
        ],
        confidence: "high",
      }));
    }
  }

  // 4. Declining tracked keywords whose page has an open technical issue.
  if (!input.keywords.length) skipped.push({ ruleId: "declining_keyword_with_page_issue", reason: "No tracked keyword has comparable observations." });
  for (const k of input.keywords) {
    if (k.change !== "declined" && k.change !== "dropped_out") continue;
    const pages = [k.url, k.landingPage].map(urlKey).filter((x): x is string => !!x);
    const issues = [...new Set(pages)].flatMap((p) => issuesByUrl.get(p) ?? []).filter((i) => PAGE_ISSUE_SEVERITY.has(i.severity));
    if (!issues.length) continue;
    const drop = k.position !== null && k.previousPosition !== null ? k.position - k.previousPosition : null;
    out.push(finish({
      ruleId: "declining_keyword_with_page_issue", fingerprint: sha(`declining_keyword_with_page_issue|${input.websiteId}|${k.keywordId}`), entityType: "keyword", entityValue: k.keyword,
      title: `“${k.keyword}” ${k.change === "dropped_out" ? "dropped out of the observed results" : `declined ${drop ?? ""} positions`.trim()} while its page has open technical issues`,
      explanation: `Comparable observations: position ${k.previousPosition ?? "not found"} on ${k.previousDate ?? "?"} → ${k.position ?? "not found"} on ${k.observedDate ?? "?"}. The page ${k.url ?? k.landingPage} has open issues: ${issues.map((i) => `${i.ruleId} (${i.severity})`).join(", ")}.`,
      action: "Review and fix the open issues on this page first; then watch the next observations of this keyword.",
      evidence: [{ module: "rankings", kind: "rank_observation", id: k.observationId ?? undefined, url: k.url ?? undefined, label: `${k.keyword}: ${k.previousPosition ?? "—"} → ${k.position ?? "not found"}`, observedAt: k.observedDate, link: "/search/rankings" }, ...issues.map(issueRef)],
      modules: ["rankings", "technical"], observedFrom: k.previousDate, observedTo: k.observedDate,
      limitations: [CORRELATION, "Rankings move for many reasons (competition, algorithm updates, query intent)."],
      factors: [
        { name: "position_loss", weight: 0.5, value: k.change === "dropped_out" ? 1 : cap((drop ?? 0) / 10), explanation: k.change === "dropped_out" ? "Dropped out of the observed depth." : `Lost ${drop} positions.` },
        { name: "issue_severity", weight: 0.5, value: issues.some((i) => i.severity === "critical" || i.severity === "high") ? 1 : 0.5, explanation: `Highest severity: ${issues.some((i) => i.severity === "critical") ? "critical" : issues.some((i) => i.severity === "high") ? "high" : "medium"}.` },
      ],
      confidence: "medium",
    }));
  }

  // 5. Competitor ahead on tracked keywords with imported backlink evidence.
  const datasets = new Map(input.competitorDatasets.map((d) => [d.domain, d]));
  if (!input.competitorWins.length) skipped.push({ ruleId: "competitor_outranks_with_backlink_evidence", reason: "No competitor outranks the site in comparable rank observations." });
  for (const w of input.competitorWins) {
    const d = datasets.get(w.domain);
    if (w.keywords.length < 2 || !d) continue;
    const ownRd = input.ownBacklinks?.referringDomains.size ?? null;
    out.push(finish({
      ruleId: "competitor_outranks_with_backlink_evidence", fingerprint: sha(`competitor_outranks_with_backlink_evidence|${input.websiteId}|${w.domain}`), entityType: "competitor", entityValue: w.domain,
      title: `${w.domain} ranks ahead of you on ${w.keywords.length} tracked keywords`,
      explanation: `In same-day, same-source observations ${w.domain} ranked above your site for ${w.keywords.slice(0, 5).map((k) => `“${k.keyword}” (${k.competitor} vs ${k.own ?? "not found"})`).join(", ")}${w.keywords.length > 5 ? ", …" : ""}. An imported backlink dataset for ${w.domain} lists ${d.referringDomains ?? "an unknown number of"} referring domains${ownRd !== null ? ` (yours: ${ownRd})` : ""}.`,
      action: "Review the competitor's link-gap opportunities in Backlinks and the content of their ranking pages; pursue legitimate links and content improvements only.",
      evidence: [
        ...w.keywords.slice(0, 10).map((k): EvidenceRef => ({ module: "rankings", kind: "rank_observation", id: k.observationId, label: `“${k.keyword}”: ${w.domain} ${k.competitor} vs you ${k.own ?? "not found"}`, observedAt: k.observedDate, link: "/search/rankings/competitors" })),
        { module: "backlinks", kind: "backlink_dataset", id: d.datasetId, label: `${w.domain}: ${d.referringDomains ?? "?"} referring domains (${d.coverage} coverage, ${d.collectedOn ?? "date unknown"})`, observedAt: d.collectedOn, link: "/search/backlinks" },
      ],
      modules: ["rankings", "backlinks"], observedFrom: w.keywords.map((k) => k.observedDate).sort()[0] ?? null, observedTo: w.keywords.map((k) => k.observedDate).sort().reverse()[0] ?? null,
      limitations: [CORRELATION, `Backlink counts come from an imported dataset with ${d.coverage} coverage; they are not an internet-wide count.`],
      factors: [
        { name: "keywords_behind", weight: 0.6, value: cap(w.keywords.length / 10), explanation: `${w.keywords.length} keywords behind (10 or more counts as full).` },
        { name: "link_difference", weight: 0.4, value: d.referringDomains !== null && ownRd !== null && d.referringDomains > ownRd ? cap((d.referringDomains - ownRd) / Math.max(d.referringDomains, 1)) : null, explanation: d.referringDomains !== null && ownRd !== null ? `${d.referringDomains} vs ${ownRd} referring domains.` : "Referring-domain comparison unavailable." },
      ],
      confidence: confidenceFor(w.keywords.length),
    }));
  }

  // 6. AI answers cite a third-party host that does not link to the site.
  if (!input.citedHosts.length) skipped.push({ ruleId: "ai_cited_source_without_link", reason: "No AI visibility citations for brands linked to this website." });
  else if (!input.ownBacklinks) skipped.push({ ruleId: "ai_cited_source_without_link", reason: "No backlink dataset for this website to check referring domains." });
  else {
    const own = input.domain.replace(/^www\./, "");
    for (const c of input.citedHosts) {
      if (c.observationIds.length < 2 || c.host === own || c.host.endsWith(`.${own}`)) continue;
      const linked = [...input.ownBacklinks.referringDomains].some((d) => d === c.host || c.host.endsWith(`.${d}`) || d.endsWith(`.${c.host}`));
      if (linked) continue;
      out.push(finish({
        ruleId: "ai_cited_source_without_link", fingerprint: sha(`ai_cited_source_without_link|${input.websiteId}|${c.host}`), entityType: "source", entityValue: c.host,
        title: `AI answers cite ${c.host}, which does not link to your site`,
        explanation: `${c.host} was cited in ${c.observationIds.length} AI answers about your monitored queries, and it is not a referring domain in your latest backlink dataset${input.ownBacklinks.collectedOn ? ` (${input.ownBacklinks.collectedOn})` : ""}.`,
        action: `Check what ${c.host} says about your topic. If your offering is missing or described inaccurately, offer the publisher accurate information; do not buy links or placements.`,
        evidence: [
          ...c.observationIds.slice(0, 10).map((id): EvidenceRef => ({ module: "ai_visibility", kind: "aiv_observation", id, label: `AI answer citing ${c.host}`, link: "/intelligence/ai-visibility/observations" })),
          { module: "backlinks", kind: "backlink_dataset", id: input.ownBacklinks.datasetId, label: `${input.ownBacklinks.referringDomains.size} referring domains, ${c.host} not among them`, observedAt: input.ownBacklinks.collectedOn, link: "/search/backlinks" },
        ],
        modules: ["ai_visibility", "backlinks"], observedFrom: null, observedTo: c.lastObservedAt?.slice(0, 10) ?? null,
        limitations: ["A citation does not prove the page supports the answer.", "The backlink dataset may not be complete; the host may link to you without appearing in it."],
        factors: [{ name: "citations", weight: 1, value: cap(c.observationIds.length / 10), explanation: `${c.observationIds.length} citing answers (10 or more counts as full).` }],
        confidence: confidenceFor(c.observationIds.length),
      }));
    }
  }
  return { insights: out.sort((a, b) => b.priority - a.priority), skipped };
}

// ─── Rank change ─────────────────────────────────────────────────────────────

export type KeywordChange = "improved" | "declined" | "unchanged" | "entered" | "dropped_out" | "no_comparison";

/** Same rules as rank tracking: only conclusive observations of the same source are compared. */
export function keywordChange(cur: { status: string; position: number | null; depth: number | null } | null, prev: { status: string; position: number | null } | null): KeywordChange {
  if (!cur || !prev) return "no_comparison";
  if (cur.status === "ranked" && prev.status === "ranked") {
    if (cur.position! < prev.position!) return "improved";
    if (cur.position! > prev.position!) return "declined";
    return "unchanged";
  }
  if (cur.status === "ranked" && prev.status === "not_in_results") return "entered";
  if (cur.status === "not_in_results" && prev.status === "ranked") return cur.depth !== null && cur.depth >= prev.position! ? "dropped_out" : "no_comparison";
  if (cur.status === "not_in_results" && prev.status === "not_in_results") return "unchanged";
  return "no_comparison";
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export const ACTION_SOURCES = ["site_issue", "content_opportunity", "content_finding", "insight", "aiv_opportunity", "rank_alert", "backlink_opportunity", "integration"] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];
export const ACTION_CATEGORIES = ["critical_technical", "page_improvement", "search_performance", "keyword_ranking", "content_gap", "backlink", "ai_visibility", "integration_data_quality"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];
export const ACTION_STATUSES = ["open", "in_progress", "completed", "dismissed"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionItem {
  key: string;
  source: ActionSource;
  sourceRef: string;
  sourceStatus: string;
  category: ActionCategory;
  title: string;
  detail: string;
  recommendedAction: string;
  evidence: string[];
  priority: number;
  priorityBasis: string;
  effort: "small" | "medium" | "large";
  link: string;
  detectedAt: string | null;
  state: { status: ActionStatus; ownerId: string | null; dueDate: string | null; note: string | null; updatedAt: string | null };
}

export const actionKey = (source: ActionSource, ref: string) => `${source}:${ref}`;

export const SEVERITY_PRIORITY: Record<string, number> = { critical: 95, high: 80, medium: 55, low: 30, info: 10 };

const TECHNICAL_CRITICAL = new Set(["status_codes", "links", "indexability", "canonicalization", "redirects", "crawlability", "sitemaps"]);

/** Category for a site issue: severe crawl/status problems are critical; the rest are page improvements. */
export function issueCategory(category: string, severity: string): ActionCategory {
  return (severity === "critical" || severity === "high") && TECHNICAL_CRITICAL.has(category) ? "critical_technical" : "page_improvement";
}

export function contentOpportunityCategory(kind: string): ActionCategory {
  if (kind === "low_ctr_snippet" || kind === "declining_page") return "search_performance";
  if (kind === "under_covered_topic" || kind === "competitor_topic_gap") return "content_gap";
  return "page_improvement";
}

export function insightCategory(ruleId: string): ActionCategory {
  if (ruleId === "low_ctr_with_snippet_issue") return "search_performance";
  if (ruleId === "declining_keyword_with_page_issue" || ruleId === "competitor_outranks_with_backlink_evidence") return "keyword_ranking";
  if (ruleId === "ai_cited_source_without_link") return "ai_visibility";
  return "critical_technical";
}

/** Effort is a heuristic by kind of work, labelled as such in the UI. */
export const EFFORT_HEURISTIC: Record<string, ActionItem["effort"]> = {
  site_issue: "small", content_finding: "small", rank_alert: "small", integration: "small",
  content_opportunity: "medium", insight: "medium", aiv_opportunity: "medium", backlink_opportunity: "large",
};

export function sortActions(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => b.priority - a.priority || (a.detectedAt ?? "").localeCompare(b.detectedAt ?? "") || a.key.localeCompare(b.key));
}

// ─── Deterministic summary ───────────────────────────────────────────────────

export interface SummaryFacts {
  range: { from: string; to: string; previous: { from: string; to: string } | null };
  search: { status: string; clicks: number | null; clicksChangePct: number | null; impressions: number | null; incomplete: boolean } | null;
  technical: { status: string; openBySeverity: Record<string, number>; detected: number | null; fixed: number | null } | null;
  rankings: { status: string; tracked: number; improved: number; declined: number } | null;
  backlinks: { status: string; referringDomains: number | null; coverage: string | null; newLinks: number | null; lostLinks: number | null } | null;
  content: { status: string; openFindings: number; openOpportunities: number } | null;
  aiVisibility: { status: string; brands: number; observations: number } | null;
  insights: number;
  actions: number;
}

const pctText = (p: number | null) => (p === null ? "no comparable previous value" : `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}% vs the previous period`);

/** Plain-language summary built only from measured values; states what is missing. */
export function deterministicSummary(f: SummaryFacts): string[] {
  const lines: string[] = [];
  const s = f.search;
  if (!s || s.status === "not_configured") lines.push("Search Console is not connected, so search clicks and impressions are unavailable.");
  else if (s.clicks === null) lines.push("Search Console has no data for this range.");
  else lines.push(`Search Console: ${s.clicks} clicks and ${s.impressions ?? 0} impressions in ${f.range.from} – ${f.range.to} (${pctText(s.clicksChangePct)})${s.incomplete ? "; some days are incomplete or not yet synced" : ""}.`);
  const t = f.technical;
  if (!t || t.status === "not_configured" || t.status === "no_data") lines.push("No completed crawl yet: technical health is unavailable.");
  else {
    const open = Object.values(t.openBySeverity).reduce((a, b) => a + b, 0);
    lines.push(`Technical: ${open} open issues (${["critical", "high", "medium"].map((k) => `${t.openBySeverity[k] ?? 0} ${k}`).join(", ")})${t.detected !== null ? `; ${t.detected} newly detected and ${t.fixed} fixed in the range` : ""}.`);
  }
  const r = f.rankings;
  if (!r || r.status === "not_configured") lines.push("No rank-tracking project for this website.");
  else lines.push(`Rankings: ${r.tracked} tracked keywords; ${r.improved} improved and ${r.declined} declined between comparable observations.`);
  const b = f.backlinks;
  if (!b || b.status === "not_configured" || b.status === "no_data") lines.push("No backlink dataset imported for this website.");
  else lines.push(`Backlinks: ${b.referringDomains ?? "unknown"} referring domains in the latest imported dataset (${b.coverage ?? "unknown"} coverage)${b.newLinks !== null ? `; ${b.newLinks} new and ${b.lostLinks} lost links detected in the range` : ""}.`);
  const c = f.content;
  if (!c || c.status === "no_data" || c.status === "not_configured") lines.push("No content inventory yet.");
  else lines.push(`Content: ${c.openFindings} open findings and ${c.openOpportunities} open opportunities.`);
  const a = f.aiVisibility;
  if (!a || a.status === "not_configured") lines.push("AI visibility is not set up for this website.");
  else lines.push(`AI visibility: ${a.observations} observations for ${a.brands} monitored brand${a.brands === 1 ? "" : "s"} in the range.`);
  lines.push(`${f.insights} cross-module insights and ${f.actions} open actions.`);
  return lines;
}

// ─── AI summary validation ───────────────────────────────────────────────────

export const AiWorkspaceSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  points: z.array(z.object({ statement: z.string().trim().min(1).max(400), sources: z.array(z.string()).min(1).max(8) }).strict()).max(8),
  insufficientEvidence: z.array(z.string().trim().min(1).max(300)).max(6),
}).strict();
export type AiWorkspaceSummary = z.infer<typeof AiWorkspaceSummarySchema>;

/** Points must cite only provided source ids (sections and insights); others are dropped. */
export function validateWorkspaceSummary(raw: unknown, allowed: Set<string>): { summary: AiWorkspaceSummary; dropped: number } | null {
  const parsed = AiWorkspaceSummarySchema.safeParse(raw);
  if (!parsed.success) return null;
  let dropped = 0;
  const points = parsed.data.points
    .map((p) => ({ ...p, sources: p.sources.filter((s) => allowed.has(s)) }))
    .filter((p) => (p.sources.length ? true : (dropped++, false)));
  return { summary: { ...parsed.data, points }, dropped };
}

// ─── Report rendering ────────────────────────────────────────────────────────

/** Escapes untrusted text for Markdown (no HTML, no table breaks, no links injected). */
export const md = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/([\\`*_{}[\]()#+!|<>])/g, "\\$1").slice(0, 500);
