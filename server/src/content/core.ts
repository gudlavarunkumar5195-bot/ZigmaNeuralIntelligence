import { createHash } from "node:crypto";
import { classifyIntent } from "../research/keywords.js";
import { contentTerms, hammingHex } from "./extract.js";

/**
 * Content intelligence: deterministic rules, clustering, opportunities and
 * briefs (no I/O). Rules that the technical site audit already runs (missing
 * or duplicate titles and descriptions, H1 count, canonicals, image alt,
 * broken links, noindex) are not repeated here. Heuristics are labelled as
 * heuristics; no search volume, difficulty or traffic is ever estimated.
 */

export const RULES_VERSION = "content-1";
export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface Thresholds {
  titleMin: number;
  titleMax: number;
  descriptionMin: number;
  descriptionMax: number;
  thinWords: number;
  staleMonths: number;
  stuffingShare: number;
  stuffingMinCount: number;
  nearDuplicateBits: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { titleMin: 15, titleMax: 65, descriptionMin: 50, descriptionMax: 160, thinWords: 200, staleMonths: 24, stuffingShare: 0.04, stuffingMinCount: 20, nearDuplicateBits: 3 };

export type Category = "metadata" | "headings" | "content" | "duplication" | "links" | "structured_data" | "freshness" | "images";
export type Severity = "high" | "medium" | "low" | "info";

export interface RuleInfo {
  id: string;
  category: Category;
  severity: Severity;
  heuristic: boolean;
  title: string;
}

export const CONTENT_RULES: Record<string, RuleInfo> = {
  title_length: { id: "title_length", category: "metadata", severity: "low", heuristic: true, title: "Title is unusually short or long" },
  description_length: { id: "description_length", category: "metadata", severity: "low", heuristic: true, title: "Meta description is unusually short or long" },
  heading_hierarchy: { id: "heading_hierarchy", category: "headings", severity: "low", heuristic: false, title: "Heading levels are skipped" },
  thin_content: { id: "thin_content", category: "content", severity: "medium", heuristic: true, title: "Little main content" },
  exact_duplicate_content: { id: "exact_duplicate_content", category: "duplication", severity: "medium", heuristic: false, title: "Identical main content on several pages" },
  near_duplicate_content: { id: "near_duplicate_content", category: "duplication", severity: "low", heuristic: true, title: "Nearly identical main content" },
  term_repetition: { id: "term_repetition", category: "content", severity: "low", heuristic: true, title: "One term is repeated unusually often" },
  orphan_page: { id: "orphan_page", category: "links", severity: "medium", heuristic: false, title: "In the sitemap but not linked from crawled pages" },
  structured_data_invalid: { id: "structured_data_invalid", category: "structured_data", severity: "medium", heuristic: false, title: "Structured data (JSON-LD) does not parse" },
  possibly_stale: { id: "possibly_stale", category: "freshness", severity: "info", heuristic: true, title: "Declared modification date is old" },
};

export interface AuditPage {
  id: string;
  url: string;
  crawlState: string;
  indexable: boolean | null;
  inSitemap: boolean;
  inlinks: number | null;
  title: string | null;
  metaDescription: string | null;
  headings: Array<{ level: number; text: string }>;
  wordCount: number | null;
  structuredData: { types?: string[]; blocks?: number; invalidBlocks?: number };
  modifiedAt: string | null;
  modifiedSource: string | null;
  contentHash: string | null;
  simhash: string | null;
  topTerms: Array<{ term: string; count: number }>;
}

export interface FindingCandidate {
  ruleId: string;
  pageId: string | null;
  fingerprint: string;
  /** Pages the finding depends on: it can only be resolved after all of them were re-audited. */
  pageIds: string[];
  evidence: Record<string, unknown>;
  explanation: string;
  recommendation: string;
}

const fp = (ruleId: string, key: string) => sha(`${RULES_VERSION.split("-")[0]}|${ruleId}|${key}`);

/** Runs every content rule over the inventory. Pages not fetched as HTML are skipped (crawl state is reported separately). */
export function auditPages(pages: AuditPage[], t: Thresholds = DEFAULT_THRESHOLDS, now = new Date()): FindingCandidate[] {
  const out: FindingCandidate[] = [];
  const ok = pages.filter((p) => p.crawlState === "ok");
  const add = (ruleId: string, page: AuditPage | null, key: string, evidence: Record<string, unknown>, explanation: string, recommendation: string, pageIds = page ? [page.id] : []) =>
    out.push({ ruleId, pageId: page?.id ?? null, fingerprint: fp(ruleId, key), pageIds, evidence, explanation, recommendation });

  for (const p of ok) {
    if (p.title) {
      const n = [...p.title].length;
      if (n < t.titleMin || n > t.titleMax) add("title_length", p, p.url, { title: p.title, length: n, range: [t.titleMin, t.titleMax] },
        `The title has ${n} characters. Outside roughly ${t.titleMin}–${t.titleMax} characters, titles tend to be ${n > t.titleMax ? "truncated in search results" : "too vague to describe the page"} (a display heuristic, not a ranking rule).`,
        n > t.titleMax ? "Put the most important words first and shorten the title." : "Describe the page's subject more specifically.");
    }
    if (p.metaDescription) {
      const n = [...p.metaDescription].length;
      if (n < t.descriptionMin || n > t.descriptionMax) add("description_length", p, p.url, { length: n, range: [t.descriptionMin, t.descriptionMax] },
        `The meta description has ${n} characters. Search engines often ${n > t.descriptionMax ? "cut longer descriptions" : "replace very short ones"} (a display heuristic).`,
        "Write a specific summary of what the page offers.");
    }
    const levels = p.headings.map((h) => h.level);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        add("heading_hierarchy", p, p.url, { from: `h${levels[i - 1]}`, to: `h${levels[i]}`, heading: p.headings[i].text },
          `An <h${levels[i - 1]}> is followed by an <h${levels[i]}> ("${p.headings[i].text.slice(0, 80)}"), skipping a level. Assistive technologies use the heading structure to navigate.`,
          `Use <h${levels[i - 1] + 1}> here or restructure the section.`);
        break;
      }
    }
    if (p.indexable && p.wordCount !== null && p.wordCount < t.thinWords) {
      add("thin_content", p, p.url, { wordCount: p.wordCount, threshold: t.thinWords },
        `The main content has ${p.wordCount} words (threshold ${t.thinWords}, configurable). Short pages can be fine; this flags pages to review, it is not a ranking rule.`,
        "Check whether the page fully answers what visitors come for; expand, merge or leave it as is.");
    }
    const top = p.topTerms[0];
    if (p.wordCount && top && top.count >= t.stuffingMinCount && top.count / p.wordCount > t.stuffingShare) {
      add("term_repetition", p, `${p.url}|${top.term}`, { term: top.term, count: top.count, wordCount: p.wordCount, share: Math.round((top.count / p.wordCount) * 1000) / 10 },
        `"${top.term}" appears ${top.count} times (${Math.round((top.count / p.wordCount) * 1000) / 10}% of words). Heavy repetition can read as unnatural.`,
        "Read the page aloud; vary wording where repetition does not help the reader.");
    }
    if (p.indexable && p.inSitemap && p.inlinks === 0) {
      add("orphan_page", p, p.url, { inSitemap: true, inlinks: 0 },
        "The page is listed in the sitemap but no crawled page links to it, so visitors and crawlers following links cannot reach it.",
        "Link to it from related pages, or remove it from the sitemap if it should not be found.");
    }
    if ((p.structuredData.invalidBlocks ?? 0) > 0) {
      add("structured_data_invalid", p, p.url, { invalidBlocks: p.structuredData.invalidBlocks, blocks: p.structuredData.blocks },
        `${p.structuredData.invalidBlocks} JSON-LD block(s) could not be parsed, so search engines cannot use them.`,
        "Fix the JSON syntax (validate with a structured-data testing tool).");
    }
    if (p.modifiedAt) {
      const months = (now.getTime() - Date.parse(p.modifiedAt)) / (30.44 * 86_400_000);
      if (months > t.staleMonths) add("possibly_stale", p, p.url, { modifiedAt: p.modifiedAt, source: p.modifiedSource, months: Math.floor(months) },
        `The page declares it was last modified ${Math.floor(months)} months ago (${p.modifiedSource}). Whether that matters depends on the topic.`,
        "Review time-sensitive facts; update the content and its modification date if it changed.");
    }
  }

  // Exact duplicates: identical normalized main text among indexable pages.
  const byHash = new Map<string, AuditPage[]>();
  for (const p of ok) if (p.indexable && p.contentHash && (p.wordCount ?? 0) >= 30) byHash.set(p.contentHash, [...(byHash.get(p.contentHash) ?? []), p]);
  const exactPairs = new Set<string>();
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    const sorted = group.sort((a, b) => a.url.localeCompare(b.url));
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) exactPairs.add(`${sorted[i].id}|${sorted[j].id}`);
    add("exact_duplicate_content", sorted[0], hash, { pages: sorted.slice(0, 20).map((p) => p.url), count: sorted.length },
      `${sorted.length} indexable pages have identical main content.`, "Keep one page and redirect or canonicalize the others, or make each page distinct.", sorted.map((p) => p.id));
  }
  // Near duplicates: SimHash of word 3-shingles within a few bits.
  const cands = ok.filter((p) => p.indexable && p.simhash && (p.wordCount ?? 0) >= 50).sort((a, b) => a.url.localeCompare(b.url));
  let pairs = 0;
  for (let i = 0; i < cands.length && pairs < 200; i++) {
    for (let j = i + 1; j < cands.length && pairs < 200; j++) {
      const a = cands[i], b = cands[j];
      if (exactPairs.has(`${a.id}|${b.id}`) || exactPairs.has(`${b.id}|${a.id}`)) continue;
      const d = hammingHex(a.simhash!, b.simhash!);
      if (d <= t.nearDuplicateBits) {
        pairs++;
        add("near_duplicate_content", a, `${a.url}|${b.url}`, { pages: [a.url, b.url], differingBits: d, of: 64 },
          `The main content of these pages is nearly identical (SimHash differs in ${d} of 64 bits). Similar pages can compete with each other.`,
          "Review both pages; differentiate them or consolidate. Nothing is merged automatically.", [a.id, b.id]);
      }
    }
  }
  return out;
}

// ─── Topic clustering ────────────────────────────────────────────────────────

export interface TopicItem {
  type: "page" | "query";
  key: string;
  text: string;
  weight: number;
}

export interface TopicCluster {
  key: string;
  name: string;
  terms: string[];
  members: Array<{ type: "page" | "query"; key: string }>;
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Deterministic greedy clustering. Items are processed by descending weight
 * (then key); each joins the cluster whose head terms it overlaps most
 * (Jaccard ≥ threshold) or starts a new one. The cluster key is its sorted
 * head terms, so re-running on the same data gives the same clusters.
 */
export function clusterTopics(items: TopicItem[], threshold = 0.34, maxClusters = 300): TopicCluster[] {
  const clusters: Array<{ head: Set<string>; termCounts: Map<string, number>; members: TopicItem[] }> = [];
  const sorted = [...items].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  for (const item of sorted) {
    const terms = new Set(contentTerms(item.text));
    if (!terms.size) continue;
    let best: (typeof clusters)[number] | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      const s = jaccard(terms, c.head);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= threshold) {
      best.members.push(item);
      for (const t of terms) best.termCounts.set(t, (best.termCounts.get(t) ?? 0) + 1);
    } else if (clusters.length < maxClusters) {
      clusters.push({ head: terms, termCounts: new Map([...terms].map((t) => [t, 1])), members: [item] });
    }
  }
  return clusters.map((c) => {
    const terms = [...c.termCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
    const headSorted = [...c.head].sort();
    return { key: headSorted.join(" ").slice(0, 120), name: terms.slice(0, 3).join(" "), terms: terms.slice(0, 12), members: c.members.map((m) => ({ type: m.type, key: m.key })) };
  });
}

// ─── Opportunities ───────────────────────────────────────────────────────────

export interface Factor {
  name: string;
  weight: number;
  value: number | null;
  explanation: string;
}

export const prioritize = (factors: Factor[]) => {
  const available = factors.filter((f) => f.value !== null);
  const w = available.reduce((s, f) => s + Math.round(f.weight * 100), 0);
  const p = available.reduce((s, f) => s + Math.round(f.weight * 100) * f.value!, 0);
  return w ? Math.round((p * 100) / w) : 0;
};

export interface OpportunityCandidate {
  kind: "low_ctr_snippet" | "missing_description" | "under_covered_topic" | "competitor_topic_gap" | "consolidate_overlap" | "internal_links" | "refresh_stale" | "declining_page";
  fingerprint: string;
  pageId: string | null;
  topicKey: string | null;
  title: string;
  evidence: Record<string, unknown>;
  problem: string;
  action: string;
  factors: Factor[];
  priority: number;
  confidence: "high" | "medium" | "low";
  confidenceBasis: string;
  missingData: string[];
  effort: "small" | "medium" | "large";
}

export interface PageMetrics {
  pageId: string;
  url: string;
  title: string | null;
  metaDescription: string | null;
  indexable: boolean | null;
  inlinks: number | null;
  modifiedAt: string | null;
  /** Search Console, last 28 days and the 28 days before (null = no data for this page). */
  current: { clicks: number; impressions: number; position: number | null } | null;
  previous: { clicks: number; impressions: number } | null;
}

export interface TopicCoverage {
  key: string;
  name: string;
  terms: string[];
  queryImpressions: number;
  queries: Array<{ query: string; impressions: number; clicks: number }>;
  pages: Array<{ pageId: string; url: string; title: string | null; covers: boolean }>;
  competitorGaps: Array<{ keyword: string; competitor: string; position: number; date: string }>;
}

const positionBucket = (p: number) => (p <= 3 ? "1-3" : p <= 10 ? "4-10" : p <= 20 ? "11-20" : "21+");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const logScale = (v: number, max: number) => (max > 1 ? Math.min(1, Math.log10(v + 1) / Math.log10(max + 1)) : v > 0 ? 1 : 0);

export function findOpportunities(input: { pages: PageMetrics[]; topics: TopicCoverage[]; overlaps: Array<{ pageIds: [string, string]; urls: [string, string]; reason: string; similarity: number }>; staleMonths: number; gscAvailable: boolean }, now = new Date()): OpportunityCandidate[] {
  const out: OpportunityCandidate[] = [];
  const noGsc = input.gscAvailable ? [] : ["Search Console data (connect and sync a property)"];
  const withData = input.pages.filter((p) => p.current && p.current.impressions > 0 && p.current.position !== null);
  const maxImpr = Math.max(0, ...withData.map((p) => p.current!.impressions));
  // Site's own CTR by position bucket (no external benchmark).
  const bucketCtr = new Map<string, number>();
  for (const b of ["1-3", "4-10", "11-20", "21+"]) {
    const m = median(withData.filter((p) => positionBucket(p.current!.position!) === b && p.current!.impressions >= 50).map((p) => p.current!.clicks / p.current!.impressions));
    if (m !== null) bucketCtr.set(b, m);
  }
  const push = (c: Omit<OpportunityCandidate, "priority">) => out.push({ ...c, priority: prioritize(c.factors) });

  for (const p of withData) {
    const cur = p.current!;
    const ctr = cur.clicks / cur.impressions;
    const bucket = positionBucket(cur.position!);
    const ref = bucketCtr.get(bucket);
    if (cur.impressions >= 200 && cur.position! <= 20 && ref !== undefined && ref > 0 && ctr < ref * 0.6) {
      push({
        kind: "low_ctr_snippet", fingerprint: sha(`low_ctr_snippet|${p.pageId}`), pageId: p.pageId, topicKey: null,
        title: `Improve the search snippet of ${p.url}`,
        evidence: { source: "Google Search Console (28 days)", impressions: cur.impressions, clicks: cur.clicks, ctr: Math.round(ctr * 1000) / 10, position: Math.round(cur.position! * 10) / 10, siteMedianCtrForPosition: Math.round(ref * 1000) / 10, bucket, title: p.title, metaDescription: p.metaDescription },
        problem: `The page gets ${cur.impressions} impressions at average position ${Math.round(cur.position! * 10) / 10}, but its CTR (${Math.round(ctr * 1000) / 10}%) is well below your site's median for that position (${Math.round(ref * 1000) / 10}%).`,
        action: "Rewrite the title and meta description to match what searchers look for; measure CTR again after Google shows the new snippet.",
        factors: [
          { name: "impressions", weight: 0.4, value: logScale(cur.impressions, maxImpr), explanation: `${cur.impressions} impressions (log-scaled against your top page).` },
          { name: "ctr_gap", weight: 0.4, value: Math.min(1, (ref - ctr) / ref), explanation: `CTR is ${Math.round((1 - ctr / ref) * 100)}% below your median for positions ${bucket}.` },
          { name: "position", weight: 0.2, value: cur.position! <= 10 ? 1 : 0.5, explanation: `Average position ${Math.round(cur.position! * 10) / 10}.` },
        ],
        confidence: cur.impressions >= 1000 ? "high" : "medium", confidenceBasis: `Measured Search Console data (${cur.impressions} impressions); compared with your own site, not an industry benchmark.`,
        missingData: ["Queries per page (Search Console data is synced per query and per page separately)"], effort: "small",
      });
    }
    if (!p.metaDescription && cur.impressions >= 50 && p.indexable) {
      push({
        kind: "missing_description", fingerprint: sha(`missing_description|${p.pageId}`), pageId: p.pageId, topicKey: null,
        title: `Write a meta description for ${p.url}`,
        evidence: { source: "Crawl + Google Search Console (28 days)", impressions: cur.impressions, clicks: cur.clicks },
        problem: `The page has no meta description but receives ${cur.impressions} impressions, so search engines pick a snippet from the page.`,
        action: "Write a specific description of what the page offers (see also the technical audit).",
        factors: [{ name: "impressions", weight: 1, value: logScale(cur.impressions, maxImpr), explanation: `${cur.impressions} impressions.` }],
        confidence: "high", confidenceBasis: "Measured: the page has no description; impressions from Search Console.", missingData: [], effort: "small",
      });
    }
    if (p.previous && p.previous.clicks >= 50 && cur.clicks <= p.previous.clicks * 0.7) {
      const drop = 1 - cur.clicks / p.previous.clicks;
      push({
        kind: "declining_page", fingerprint: sha(`declining_page|${p.pageId}`), pageId: p.pageId, topicKey: null,
        title: `Investigate falling clicks on ${p.url}`,
        evidence: { source: "Google Search Console", clicksLast28: cur.clicks, clicksPrevious28: p.previous.clicks, impressionsLast28: cur.impressions, impressionsPrevious28: p.previous.impressions },
        problem: `Clicks fell ${Math.round(drop * 100)}% (${p.previous.clicks} → ${cur.clicks}) between the previous and the last 28 days.`,
        action: "Check whether impressions or CTR changed, which queries moved, and whether the page or competing pages changed. Seasonality is a possible cause.",
        factors: [
          { name: "drop", weight: 0.6, value: Math.min(1, drop), explanation: `${Math.round(drop * 100)}% fewer clicks.` },
          { name: "previous_clicks", weight: 0.4, value: logScale(p.previous.clicks, Math.max(...withData.map((x) => x.previous?.clicks ?? 0))), explanation: `${p.previous.clicks} clicks before.` },
        ],
        confidence: "medium", confidenceBasis: "Measured change over two 28-day windows; the cause is not determined.", missingData: ["Seasonality baseline (needs a year of data)"], effort: "medium",
      });
    }
    if (p.indexable && (p.inlinks ?? 0) < 3 && cur.clicks >= 20) {
      push({
        kind: "internal_links", fingerprint: sha(`internal_links|${p.pageId}`), pageId: p.pageId, topicKey: null,
        title: `Link to ${p.url} from related pages`,
        evidence: { source: "Crawl + Google Search Console (28 days)", inlinks: p.inlinks ?? 0, clicks: cur.clicks },
        problem: `The page earns ${cur.clicks} clicks from search but only ${p.inlinks ?? 0} crawled page(s) link to it.`,
        action: "Add contextual links from pages on the same topic (see Topic intelligence for candidates).",
        factors: [
          { name: "clicks", weight: 0.6, value: logScale(cur.clicks, Math.max(...withData.map((x) => x.current!.clicks))), explanation: `${cur.clicks} clicks.` },
          { name: "few_inlinks", weight: 0.4, value: 1 - Math.min(3, p.inlinks ?? 0) / 3, explanation: `${p.inlinks ?? 0} internal links in.` },
        ],
        confidence: "medium", confidenceBasis: "Measured inlinks (from the last crawl) and clicks; the benefit of more links is a hypothesis.", missingData: [], effort: "small",
      });
    }
    if (p.modifiedAt && (now.getTime() - Date.parse(p.modifiedAt)) / (30.44 * 86_400_000) > input.staleMonths / 2 && cur.impressions >= 100) {
      const months = Math.floor((now.getTime() - Date.parse(p.modifiedAt)) / (30.44 * 86_400_000));
      push({
        kind: "refresh_stale", fingerprint: sha(`refresh_stale|${p.pageId}`), pageId: p.pageId, topicKey: null,
        title: `Review and refresh ${p.url}`,
        evidence: { source: "Page's declared modification date + Google Search Console", modifiedAt: p.modifiedAt, months, impressions: cur.impressions },
        problem: `The page still gets ${cur.impressions} impressions but declares no update for ${months} months.`,
        action: "Check facts, examples and dates; update what changed.",
        factors: [
          { name: "impressions", weight: 0.5, value: logScale(cur.impressions, maxImpr), explanation: `${cur.impressions} impressions.` },
          { name: "age", weight: 0.5, value: Math.min(1, months / (input.staleMonths * 2)), explanation: `${months} months since the declared modification.` },
        ],
        confidence: "low", confidenceBasis: "Declared dates are not always maintained; whether the topic needs updates is not known.", missingData: [], effort: "medium",
      });
    }
  }

  const maxTopicImpr = Math.max(0, ...input.topics.map((t) => t.queryImpressions));
  for (const t of input.topics) {
    const covering = t.pages.filter((p) => p.covers);
    if (t.queryImpressions >= 100 && covering.length === 0) {
      push({
        kind: "under_covered_topic", fingerprint: sha(`under_covered_topic|${t.key}`), pageId: null, topicKey: t.key,
        title: `No page focuses on “${t.name}”`,
        evidence: { source: "Google Search Console queries + crawl", queryImpressions: t.queryImpressions, queries: t.queries.slice(0, 10), pagesInTopic: t.pages.slice(0, 10).map((p) => p.url) },
        problem: `Queries about “${t.name}” brought ${t.queryImpressions} impressions, but no crawled page has these terms in its title, H1 or headings.`,
        action: t.pages.length ? "Strengthen the most relevant existing page for this topic (headings, sections) before creating a new one." : "Consider a page for this topic if it fits your offer; create a brief to plan it.",
        factors: [
          { name: "query_impressions", weight: 0.7, value: logScale(t.queryImpressions, maxTopicImpr), explanation: `${t.queryImpressions} impressions on ${t.queries.length} query(ies).` },
          { name: "no_existing_page", weight: 0.3, value: t.pages.length ? 0.5 : 1, explanation: t.pages.length ? "Related pages exist but none focuses on it." : "No related page found." },
        ],
        confidence: t.queryImpressions >= 500 ? "medium" : "low", confidenceBasis: "Queries are measured; coverage is a term match against titles and headings, not a judgement of quality.",
        missingData: ["Search volume (no licensed provider)", "Queries per page"], effort: t.pages.length ? "medium" : "large",
      });
    }
    if (t.competitorGaps.length) {
      push({
        kind: "competitor_topic_gap", fingerprint: sha(`competitor_topic_gap|${t.key}`), pageId: null, topicKey: t.key,
        title: `Competitors rank for “${t.name}”; you were not found`,
        evidence: { source: "Rank tracking observations (same day and source)", gaps: t.competitorGaps.slice(0, 10) },
        problem: `${t.competitorGaps.length} tracked keyword(s) in this topic: a competitor ranked and your site was not found in the same check.`,
        action: "Compare what the competitor pages answer with your relevant page; plan improvements with a brief. Do not copy their content.",
        factors: [
          { name: "keywords", weight: 0.6, value: Math.min(1, t.competitorGaps.length / 5), explanation: `${t.competitorGaps.length} keyword(s).` },
          { name: "competitor_position", weight: 0.4, value: Math.min(1, 10 / Math.min(...t.competitorGaps.map((g) => g.position))) , explanation: `Best competitor position ${Math.min(...t.competitorGaps.map((g) => g.position))}.` },
        ],
        confidence: "medium", confidenceBasis: "Observed rankings from your rank-tracking data.", missingData: ["Competitor page content (not fetched)"], effort: "large",
      });
    }
  }

  for (const o of input.overlaps) {
    push({
      kind: "consolidate_overlap", fingerprint: sha(`consolidate_overlap|${[...o.pageIds].sort().join("|")}`), pageId: o.pageIds[0], topicKey: null,
      title: `Review overlapping pages: ${o.urls[0]} and ${o.urls[1]}`,
      evidence: { source: "Crawl", pages: o.urls, reason: o.reason, similarity: o.similarity },
      problem: `These pages ${o.reason}. Pages that target the same intent can compete with each other.`,
      action: "Decide whether both are needed: differentiate their focus, or consolidate into one and redirect. Never merge automatically.",
      factors: [{ name: "similarity", weight: 1, value: o.similarity, explanation: `Similarity ${Math.round(o.similarity * 100)}%.` }],
      confidence: "low", confidenceBasis: "Similarity of titles/headings or content; whether the intents really overlap needs a human decision.", missingData: ["Queries per page"], effort: "large",
    });
  }
  return out.map((o) => (noGsc.length && o.kind !== "consolidate_overlap" ? { ...o, missingData: [...new Set([...o.missingData, ...noGsc])] } : o)).sort((a, b) => b.priority - a.priority || a.fingerprint.localeCompare(b.fingerprint));
}

/** Pages whose title + H1 term sets overlap strongly (cannibalization candidates). */
export function titleOverlaps(pages: Array<{ id: string; url: string; title: string | null; h1: string | null; indexable: boolean | null }>, threshold = 0.6) {
  const items = pages.filter((p) => p.indexable && (p.title || p.h1)).map((p) => ({ ...p, terms: new Set(contentTerms(`${p.title ?? ""} ${p.h1 ?? ""}`)) })).filter((p) => p.terms.size >= 2).sort((a, b) => a.url.localeCompare(b.url));
  const out: Array<{ pageIds: [string, string]; urls: [string, string]; reason: string; similarity: number }> = [];
  for (let i = 0; i < items.length && out.length < 100; i++) {
    for (let j = i + 1; j < items.length && out.length < 100; j++) {
      const s = jaccard(items[i].terms, items[j].terms);
      if (s >= threshold) out.push({ pageIds: [items[i].id, items[j].id], urls: [items[i].url, items[j].url], reason: "share most words of their titles and H1", similarity: Math.round(s * 100) / 100 });
    }
  }
  return out;
}

// ─── Briefs ──────────────────────────────────────────────────────────────────

export interface BriefBody {
  targetTopic: string;
  intent: { value: string | null; rule: string | null; note: string };
  primaryKeyword: string | null;
  relatedKeywords: string[];
  existingPages: Array<{ url: string; title: string | null }>;
  suggestedTitle: string;
  suggestedMetaDescription: string;
  h1: string;
  outline: Array<{ heading: string; points: string[] }>;
  questions: string[];
  internalLinks: Array<{ url: string; anchorHint: string }>;
  sources: Array<{ label: string; url: string | null }>;
  missingEvidence: string[];
  researchQuestions: string[];
  checklist: Array<{ item: string; done: boolean }>;
}

export const EDITORIAL_CHECKLIST = [
  "Facts and figures are checked against cited sources",
  "The page answers the questions listed in this brief",
  "No text is copied from competitors or other sites",
  "Title and meta description are specific and accurate",
  "Internal links point to relevant, existing pages",
  "A human editor approved the final text",
];

const QUESTION = /^(how|what|why|when|where|which|who|can|does|do|is|are|should)\b/i;
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** A deterministic brief from real evidence only; every suggestion is editable and needs approval. */
export function buildBrief(input: {
  topicName: string;
  siteName: string;
  page: { url: string; title: string | null; metaDescription: string | null; headings: Array<{ level: number; text: string }> } | null;
  queries: Array<{ query: string; impressions: number }>;
  relatedPages: Array<{ url: string; title: string | null; inlinks: number | null }>;
  gscAvailable: boolean;
}): BriefBody {
  const queries = [...input.queries].sort((a, b) => b.impressions - a.impressions);
  const primary = queries[0]?.query ?? input.topicName;
  const intent = classifyIntent(primary, []);
  const questions = queries.map((q) => q.query).filter((q) => QUESTION.test(q)).slice(0, 10);
  const existingH2 = input.page ? input.page.headings.filter((h) => h.level === 2).map((h) => h.text).slice(0, 12) : [];
  const subtopics = queries.slice(1, 9).map((q) => q.query).filter((q) => !QUESTION.test(q));
  const outline = [
    ...existingH2.map((h) => ({ heading: h, points: ["Existing section: review and update"] })),
    ...subtopics.filter((s) => !existingH2.some((h) => h.toLowerCase().includes(s.toLowerCase()))).slice(0, 6).map((s) => ({ heading: titleCase(s), points: [`Searchers use “${s}”; cover it if relevant`] })),
  ];
  const suggestedTitle = input.page?.title && input.page.title.length <= 65 ? input.page.title : `${titleCase(primary)} | ${input.siteName}`.slice(0, 70);
  return {
    targetTopic: input.topicName,
    intent: { value: intent?.intent ?? null, rule: intent?.rule ?? null, note: intent ? "Rule-based from the primary keyword; confirm by looking at the current results." : "Not determinable by rule; check the current results page." },
    primaryKeyword: queries[0]?.query ?? null,
    relatedKeywords: queries.slice(1, 16).map((q) => q.query),
    existingPages: input.relatedPages.slice(0, 10).map((p) => ({ url: p.url, title: p.title })),
    suggestedTitle,
    suggestedMetaDescription: input.page?.metaDescription ?? "",
    h1: input.page?.headings.find((h) => h.level === 1)?.text ?? titleCase(input.topicName),
    outline,
    questions,
    internalLinks: input.relatedPages.filter((p) => p.url !== input.page?.url).sort((a, b) => (b.inlinks ?? 0) - (a.inlinks ?? 0)).slice(0, 6).map((p) => ({ url: p.url, anchorHint: p.title ?? input.topicName })),
    sources: [],
    missingEvidence: [
      ...(input.gscAvailable ? [] : ["Search Console queries (no synced data)"]),
      "Search volume and difficulty (no licensed provider)",
      "Competitor page content (not fetched; never copied)",
      ...(queries.length ? [] : ["Queries for this topic"]),
    ],
    researchQuestions: ["Which sources support the key facts?", "What do the current top results answer that this page does not?", "Which customer questions (support, sales) relate to this topic?"],
    checklist: EDITORIAL_CHECKLIST.map((item) => ({ item, done: false })),
  };
}

/** Validates and bounds a brief body (from an editor or the AI); unknown fields are dropped. */
export function sanitizeBrief(raw: unknown, allowedUrls: Set<string>): BriefBody | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const strs = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
  const intent = (r.intent && typeof r.intent === "object" ? r.intent : {}) as Record<string, unknown>;
  const linkOk = (u: string) => allowedUrls.has(u);
  return {
    targetTopic: str(r.targetTopic, 120),
    intent: { value: str(intent.value, 40) || null, rule: str(intent.rule, 80) || null, note: str(intent.note, 300) },
    primaryKeyword: str(r.primaryKeyword, 200) || null,
    relatedKeywords: strs(r.relatedKeywords, 30, 200),
    existingPages: (Array.isArray(r.existingPages) ? r.existingPages : []).map((p) => ({ url: str((p as Record<string, unknown>)?.url, 2048), title: str((p as Record<string, unknown>)?.title, 300) || null })).filter((p) => linkOk(p.url)).slice(0, 20),
    suggestedTitle: str(r.suggestedTitle, 120),
    suggestedMetaDescription: str(r.suggestedMetaDescription, 320),
    h1: str(r.h1, 200),
    outline: (Array.isArray(r.outline) ? r.outline : []).map((s) => ({ heading: str((s as Record<string, unknown>)?.heading, 200), points: strs((s as Record<string, unknown>)?.points, 10, 300) })).filter((s) => s.heading).slice(0, 30),
    questions: strs(r.questions, 20, 300),
    // Links only to pages of the site's own inventory: never arbitrary URLs.
    internalLinks: (Array.isArray(r.internalLinks) ? r.internalLinks : []).map((l) => ({ url: str((l as Record<string, unknown>)?.url, 2048), anchorHint: str((l as Record<string, unknown>)?.anchorHint, 200) })).filter((l) => linkOk(l.url)).slice(0, 20),
    sources: (Array.isArray(r.sources) ? r.sources : []).map((s) => ({ label: str((s as Record<string, unknown>)?.label, 300), url: (() => { const u = str((s as Record<string, unknown>)?.url, 2048); return /^https:\/\/[^\s]+$/.test(u) ? u : null; })() })).filter((s) => s.label).slice(0, 20),
    missingEvidence: strs(r.missingEvidence, 20, 300),
    researchQuestions: strs(r.researchQuestions, 20, 300),
    checklist: (Array.isArray(r.checklist) ? r.checklist : []).map((c) => ({ item: str((c as Record<string, unknown>)?.item, 300), done: (c as Record<string, unknown>)?.done === true })).filter((c) => c.item).slice(0, 30),
  };
}
