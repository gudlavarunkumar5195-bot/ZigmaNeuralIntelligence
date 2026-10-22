import { createHash } from "node:crypto";

/**
 * Backlink intelligence: pure, deterministic logic (no I/O). URL
 * normalization, CSV parsing and validation, snapshot change detection,
 * referring-domain gap and the opportunity score. Nothing here estimates a
 * metric a source did not supply.
 */

// ─── URLs and domains ─────────────────────────────────────────────────────────

const MAX_URL = 2048;

/** http(s) only; lowercase scheme and host, punycode, no default port, no fragment, no credentials. */
export function normalizeLinkUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) return null;
  if (!host.includes(".") && !host.startsWith("[")) return null;
  url.hostname = host;
  url.hash = "";
  const out = url.toString();
  return out.length <= MAX_URL ? out : null;
}

/** Host without a leading "www." (no public-suffix list: sub.example.com and example.com stay distinct). */
export function domainOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** Normalizes a bare domain or URL to the same form as domainOf. */
export function normalizeDomain(raw: string): string | null {
  const url = normalizeLinkUrl(raw.includes("/") || raw.includes(":") ? raw : `https://${raw.trim()}`);
  return url ? domainOf(url) : null;
}

export const linkKey = (sourceUrl: string, targetUrl: string | null) =>
  createHash("sha256").update(`${sourceUrl}\n${targetUrl ?? ""}`, "utf8").digest("hex");

// ─── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 parser (quotes, escaped quotes, CRLF/LF); delimiter detected from the header line. */
export function parseCsv(text: string, maxRows: number): { header: string[]; rows: string[][]; truncated: boolean; delimiter: string } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      if (out.length > maxRows) { truncated = true; break; }
    } else field += c;
  }
  if (!truncated && (field !== "" || row.length)) { row.push(field); out.push(row); }
  const [header = [], ...rows] = out;
  return { header: header.map((h) => h.trim()), rows: truncated ? rows.slice(0, maxRows) : rows, truncated, delimiter };
}

export type LinkField = "source_url" | "target_url" | "anchor" | "rel" | "nofollow" | "sponsored" | "ugc" | "first_seen" | "last_seen" | "lost";

/** Header names of common authorized exports (Search Console, Ahrefs, Semrush, Majestic) and a generic form. */
const ALIASES: Record<LinkField, string[]> = {
  source_url: ["source_url", "source url", "source", "linking page", "referring page url", "referring page", "source page", "from url", "url from", "sourceurl", "backlink url", "page url"],
  target_url: ["target_url", "target url", "target", "target page", "to url", "url to", "destination url", "targeturl", "link url"],
  anchor: ["anchor", "anchor text", "anchortext", "link anchor"],
  rel: ["rel", "link type", "type", "link attributes", "attributes"],
  nofollow: ["nofollow", "no follow", "is nofollow"],
  sponsored: ["sponsored", "is sponsored"],
  ugc: ["ugc", "is ugc"],
  first_seen: ["first_seen", "first seen", "firstindexeddate", "first indexed", "date found", "first found"],
  last_seen: ["last_seen", "last seen", "last crawled", "lastseendate", "last checked", "last visited"],
  lost: ["lost", "lost date", "is lost", "lost link", "link status", "status"],
};

const normHeader = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

export function mapHeaders(header: string[]): { mapping: Partial<Record<LinkField, number>>; unmapped: string[]; missingRequired: LinkField[] } {
  const mapping: Partial<Record<LinkField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(ALIASES) as LinkField[]) {
    const aliases = ALIASES[field].map(normHeader);
    const idx = header.findIndex((h, i) => !used.has(i) && aliases.includes(normHeader(h)));
    if (idx >= 0) { mapping[field] = idx; used.add(idx); }
  }
  return { mapping, unmapped: header.filter((_, i) => !used.has(i)), missingRequired: mapping.source_url === undefined ? ["source_url"] : [] };
}

export type LinkType = "follow" | "nofollow" | "sponsored" | "ugc";

export interface ParsedLink {
  linkKey: string;
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string | null;
  targetDomain: string | null;
  anchor: string | null;
  linkType: LinkType | null;
  firstSeen: string | null;
  lastSeen: string | null;
  providerLost: boolean | null;
  sourceRow: number;
}

const truthy = (v: string) => /^(true|yes|y|1|x)$/i.test(v.trim());
const falsy = (v: string) => /^(false|no|n|0|)$/i.test(v.trim());

function parseDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const t = iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (y < 1995 || t > Date.now() + 2 * 86_400_000) return null;
  return d.toISOString().slice(0, 10);
}

/** Link type only from what the export states; null when it says nothing. */
function linkTypeOf(get: (f: LinkField) => string | undefined): LinkType | null {
  const flags = { sponsored: get("sponsored"), ugc: get("ugc"), nofollow: get("nofollow") };
  const rel = (get("rel") ?? "").toLowerCase();
  if ((flags.sponsored && truthy(flags.sponsored)) || /\bsponsored\b/.test(rel)) return "sponsored";
  if ((flags.ugc && truthy(flags.ugc)) || /\bugc\b/.test(rel)) return "ugc";
  if ((flags.nofollow && truthy(flags.nofollow)) || /\bno ?follow\b/.test(rel)) return "nofollow";
  if (/\b(do)?follow\b/.test(rel)) return "follow";
  const anyFlag = Object.values(flags).filter((v) => v !== undefined);
  if (anyFlag.length && anyFlag.every((v) => falsy(v!))) return "follow";
  return null;
}

export interface ValidationOptions {
  maxRows: number;
  maxField: number;
  targetDomain?: string;
}

export interface ImportValidation {
  links: ParsedLink[];
  rowsTotal: number;
  rejected: Array<{ row: number; reason: string }>;
  duplicates: number;
  skipped: number;
  warnings: string[];
  observedFrom: string | null;
  observedTo: string | null;
}

/**
 * Validates parsed rows. Rows are rejected (with a reason) for an invalid or
 * oversized URL; blank rows are skipped; identical links are counted as
 * duplicates; a later duplicate merges its non-empty fields. Text is kept as
 * text: never evaluated, never trusted as HTML.
 */
export function validateRows(header: string[], rows: string[][], mapping: Partial<Record<LinkField, number>>, opts: ValidationOptions): ImportValidation {
  const byKey = new Map<string, ParsedLink>();
  const rejected: ImportValidation["rejected"] = [];
  let duplicates = 0;
  let skipped = 0;
  let badDates = 0;
  let foreignTargets = 0;
  rows.forEach((cells, i) => {
    const rowNo = i + 2; // 1-based, after the header
    if (cells.every((c) => !c.trim())) { skipped++; return; }
    const get = (f: LinkField) => (mapping[f] === undefined ? undefined : cells[mapping[f]!] ?? "");
    const tooLong = cells.find((c) => c.length > opts.maxField);
    if (tooLong !== undefined) return void rejected.push({ row: rowNo, reason: `A field is longer than ${opts.maxField} characters` });
    const sourceUrl = normalizeLinkUrl(get("source_url"));
    if (!sourceUrl) return void rejected.push({ row: rowNo, reason: "Missing or invalid source URL" });
    const rawTarget = get("target_url");
    const targetUrl = rawTarget && rawTarget.trim() ? normalizeLinkUrl(rawTarget) : null;
    if (rawTarget && rawTarget.trim() && !targetUrl) return void rejected.push({ row: rowNo, reason: "Invalid target URL" });
    const targetDomain = targetUrl ? domainOf(targetUrl) : null;
    if (opts.targetDomain && targetDomain && targetDomain !== opts.targetDomain && !targetDomain.endsWith(`.${opts.targetDomain}`)) foreignTargets++;
    const firstRaw = get("first_seen");
    const lastRaw = get("last_seen");
    const firstSeen = parseDate(firstRaw);
    const lastSeen = parseDate(lastRaw);
    if ((firstRaw?.trim() && !firstSeen) || (lastRaw?.trim() && !lastSeen)) badDates++;
    const lostRaw = get("lost");
    const providerLost = lostRaw === undefined ? null : /lost|removed|deleted/i.test(lostRaw) || /^\d{4}-\d{2}-\d{2}/.test(lostRaw.trim()) || truthy(lostRaw) ? true : falsy(lostRaw) || /live|active|ok/i.test(lostRaw) ? false : null;
    const anchorRaw = get("anchor")?.replace(/\s+/g, " ").trim();
    const link: ParsedLink = {
      linkKey: linkKey(sourceUrl, targetUrl),
      sourceUrl,
      sourceDomain: domainOf(sourceUrl),
      targetUrl,
      targetDomain,
      anchor: anchorRaw ? anchorRaw.slice(0, 500) : null,
      linkType: linkTypeOf(get),
      firstSeen,
      lastSeen,
      providerLost,
      sourceRow: rowNo,
    };
    const prior = byKey.get(link.linkKey);
    if (prior) {
      duplicates++;
      for (const k of ["anchor", "linkType", "firstSeen", "lastSeen", "providerLost"] as const) if (prior[k] === null && link[k] !== null) (prior as unknown as Record<string, unknown>)[k] = link[k];
      return;
    }
    byKey.set(link.linkKey, link);
  });
  const links = [...byKey.values()];
  const dates = links.flatMap((l) => [l.firstSeen, l.lastSeen]).filter((d): d is string => !!d).sort();
  const warnings: string[] = [];
  if (badDates) warnings.push(`${badDates} row(s) had an unreadable date; those dates were left empty.`);
  if (foreignTargets) warnings.push(`${foreignTargets} link(s) point to a domain other than ${opts.targetDomain}.`);
  if (mapping.target_url === undefined) warnings.push("No target URL column: links are stored without their destination page.");
  if (mapping.rel === undefined && mapping.nofollow === undefined && mapping.sponsored === undefined && mapping.ugc === undefined) warnings.push("No link attribute columns: follow/nofollow is unknown for every link.");
  return { links, rowsTotal: rows.length, rejected, duplicates, skipped, warnings, observedFrom: dates[0] ?? null, observedTo: dates[dates.length - 1] ?? null };
}

/** Rough UTF-8 sanity checks on decoded text (UTF-16 shows NUL bytes; mis-decoding shows U+FFFD). */
export function encodingProblem(text: string): string | null {
  const sample = text.slice(0, 20_000);
  if (sample.includes("\u0000")) return "The file looks like UTF-16. Save it as UTF-8 CSV and try again.";
  const bad = (sample.match(/�/g) ?? []).length;
  if (bad > 5) return "The file is not valid UTF-8. Save it as UTF-8 CSV and try again.";
  return null;
}

// ─── Snapshot changes ─────────────────────────────────────────────────────────

export type ChangeType = "new" | "lost" | "potentially_lost" | "anchor_changed" | "target_changed" | "attributes_changed";

export interface SnapshotLink {
  linkKey: string;
  sourceUrl: string;
  targetUrl: string | null;
  anchor: string | null;
  linkType: LinkType | null;
  providerLost: boolean | null;
}

export interface Change {
  type: ChangeType;
  linkKey: string;
  sourceUrl: string;
  targetUrl: string | null;
  evidence: string;
  details: Record<string, unknown>;
}

/**
 * Changes from an older to a newer snapshot of the same subject. A link
 * missing from the newer snapshot is "lost" only when the newer snapshot is
 * declared complete or the source itself reports it lost; otherwise it is
 * only "potentially lost" (an export can omit links).
 */
export function compareSnapshots(older: SnapshotLink[], newer: SnapshotLink[], newerCoverage: "complete" | "partial" | "unknown"): Change[] {
  const oldByKey = new Map(older.map((l) => [l.linkKey, l]));
  const newByKey = new Map(newer.map((l) => [l.linkKey, l]));
  const newBySource = new Map<string, SnapshotLink[]>();
  for (const l of newer) newBySource.set(l.sourceUrl, [...(newBySource.get(l.sourceUrl) ?? []), l]);
  const oldSources = new Set(older.map((l) => l.sourceUrl));
  const out: Change[] = [];
  const retargeted = new Set<string>();

  for (const o of older) {
    const n = newByKey.get(o.linkKey);
    if (n) {
      if (n.providerLost && !o.providerLost) {
        out.push({ type: "lost", linkKey: o.linkKey, sourceUrl: o.sourceUrl, targetUrl: o.targetUrl, evidence: "The source reports this link as lost.", details: {} });
        continue;
      }
      if ((o.anchor ?? "") !== (n.anchor ?? "") && o.anchor !== null && n.anchor !== null) {
        out.push({ type: "anchor_changed", linkKey: o.linkKey, sourceUrl: o.sourceUrl, targetUrl: o.targetUrl, evidence: "Anchor text differs between snapshots.", details: { from: o.anchor, to: n.anchor } });
      }
      if (o.linkType !== null && n.linkType !== null && o.linkType !== n.linkType) {
        out.push({ type: "attributes_changed", linkKey: o.linkKey, sourceUrl: o.sourceUrl, targetUrl: o.targetUrl, evidence: "Link attributes differ between snapshots.", details: { from: o.linkType, to: n.linkType } });
      }
      continue;
    }
    // Same source page now linking to a different target page of the subject.
    const moved = (newBySource.get(o.sourceUrl) ?? []).find((n2) => !oldByKey.has(n2.linkKey) && !retargeted.has(n2.linkKey));
    if (moved && o.targetUrl && moved.targetUrl) {
      retargeted.add(moved.linkKey);
      out.push({ type: "target_changed", linkKey: moved.linkKey, sourceUrl: o.sourceUrl, targetUrl: moved.targetUrl, evidence: "The same source page links to a different target page.", details: { from: o.targetUrl, to: moved.targetUrl } });
      continue;
    }
    out.push(
      newerCoverage === "complete"
        ? { type: "lost", linkKey: o.linkKey, sourceUrl: o.sourceUrl, targetUrl: o.targetUrl, evidence: "Absent from a newer snapshot declared complete.", details: {} }
        : { type: "potentially_lost", linkKey: o.linkKey, sourceUrl: o.sourceUrl, targetUrl: o.targetUrl, evidence: "Absent from a newer snapshot that may be incomplete; not proof the link was removed.", details: { newerCoverage } },
    );
  }
  for (const n of newer) {
    if (oldByKey.has(n.linkKey) || retargeted.has(n.linkKey)) continue;
    out.push({ type: "new", linkKey: n.linkKey, sourceUrl: n.sourceUrl, targetUrl: n.targetUrl, evidence: oldSources.has(n.sourceUrl) ? "New target from a known source page." : "Not in the previous snapshot.", details: {} });
  }
  return out;
}

// ─── Referring-domain gap ────────────────────────────────────────────────────

export interface DomainSet {
  subject: string;
  domains: Set<string>;
}

export interface GapRow {
  domain: string;
  category: "shared" | "competitor_only" | "own_only";
  competitors: string[];
}

/**
 * Referring-domain gap between the own site and competitors. "competitor_only"
 * means observed for a competitor and not observed in the own dataset, which
 * is never proof that the own site has no link from that domain.
 */
export function referringDomainGap(own: DomainSet, competitors: DomainSet[]): GapRow[] {
  const all = new Map<string, Set<string>>();
  for (const c of competitors) for (const d of c.domains) all.set(d, (all.get(d) ?? new Set()).add(c.subject));
  const rows: GapRow[] = [];
  for (const [domain, subjects] of all) rows.push({ domain, category: own.domains.has(domain) ? "shared" : "competitor_only", competitors: [...subjects].sort() });
  for (const d of own.domains) if (!all.has(d)) rows.push({ domain: d, category: "own_only", competitors: [] });
  return rows.sort((a, b) => b.competitors.length - a.competitors.length || a.domain.localeCompare(b.domain));
}

export interface DatasetMeta {
  id: string;
  subject: string;
  sourceLabel: string;
  coverage: "complete" | "partial" | "unknown";
  retrievedAt: Date;
  exportedAt: string | null;
  links: number;
}

export const MAX_GAP_SPREAD_DAYS = 180;

/** Whether snapshots can be compared fairly; blocking problems and warnings. */
export function gapCompatibility(datasets: DatasetMeta[]): { compatible: boolean; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const d of datasets) if (d.links === 0) problems.push(`${d.subject} has no links in its latest dataset.`);
  const dates = datasets.map((d) => (d.exportedAt ? Date.parse(d.exportedAt) : d.retrievedAt.getTime()));
  const spreadDays = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
  if (spreadDays > MAX_GAP_SPREAD_DAYS) problems.push(`The datasets were exported ${Math.round(spreadDays)} days apart (more than ${MAX_GAP_SPREAD_DAYS}); refresh the older ones first.`);
  else if (spreadDays > 30) warnings.push(`The datasets were exported up to ${Math.round(spreadDays)} days apart.`);
  if (new Set(datasets.map((d) => d.sourceLabel.toLowerCase())).size > 1) warnings.push(`Different sources (${[...new Set(datasets.map((d) => d.sourceLabel))].join(", ")}) index the web differently; differences can come from the source.`);
  const incomplete = datasets.filter((d) => d.coverage !== "complete").map((d) => d.subject);
  if (incomplete.length) warnings.push(`Not declared complete: ${incomplete.join(", ")}. "Competitor only" means not observed in your data, not absent.`);
  return { compatible: problems.length === 0, problems, warnings };
}

// ─── Opportunity score ───────────────────────────────────────────────────────

export interface OpportunityEvidence {
  domain: string;
  kind: "competitor_only" | "reclaim";
  competitorsLinking: number;
  competitorsCompared: number;
  /** null when no link from this domain carries attribute information. */
  anyFollow: boolean | null;
  /** Most recent last-seen date of a link from this domain, or null. */
  lastSeen: string | null;
  /** true/false when our own check verified a link from this domain; null when never verified. */
  verifiedLive: boolean | null;
  /** Matched / available topic terms in the linking URLs and anchors; null when no topic terms were given. */
  topicMatches: { matched: string[]; terms: number } | null;
  /** true when an older own snapshot had a link from this domain. */
  previouslyLinked: boolean;
}

export const SCORE_WEIGHTS = {
  competitor_linking: 0.3,
  topical_relevance: 0.2,
  follow_links: 0.15,
  freshness: 0.15,
  verified_live: 0.1,
  prior_relationship: 0.1,
} as const;
export type SignalId = keyof typeof SCORE_WEIGHTS;

export interface Signal {
  id: SignalId;
  weight: number;
  value: number | null;
  explanation: string;
}

/**
 * Deterministic outreach-priority score (0–100) from available evidence
 * only: Σ(weight × value) over AVAILABLE signals ÷ Σ(weight of available
 * signals). Unavailable inputs are listed, not guessed; `basis` is the share
 * of total weight that was available. A prioritization heuristic for this
 * tool, not a search-engine ranking factor.
 */
export function scoreOpportunity(e: OpportunityEvidence, today = new Date()): { score: number; basis: number; signals: Signal[] } {
  const days = e.lastSeen ? (today.getTime() - Date.parse(e.lastSeen)) / 86_400_000 : null;
  const signals: Signal[] = [
    {
      id: "competitor_linking",
      weight: SCORE_WEIGHTS.competitor_linking,
      value: e.competitorsCompared ? e.competitorsLinking / e.competitorsCompared : null,
      explanation: e.competitorsCompared ? `Links to ${e.competitorsLinking} of ${e.competitorsCompared} compared competitor(s).` : "No competitors compared.",
    },
    {
      id: "topical_relevance",
      weight: SCORE_WEIGHTS.topical_relevance,
      value: e.topicMatches && e.topicMatches.terms ? Math.min(1, e.topicMatches.matched.length / Math.min(3, e.topicMatches.terms)) : null,
      explanation: e.topicMatches ? (e.topicMatches.matched.length ? `Linking URLs/anchors mention: ${e.topicMatches.matched.join(", ")}.` : "No topic term found in linking URLs or anchors.") : "Unavailable: no topic terms given.",
    },
    {
      id: "follow_links",
      weight: SCORE_WEIGHTS.follow_links,
      value: e.anyFollow === null ? null : e.anyFollow ? 1 : 0,
      explanation: e.anyFollow === null ? "Unavailable: the data has no link attributes." : e.anyFollow ? "At least one followed link from this domain." : "Only nofollow/sponsored/UGC links observed.",
    },
    {
      id: "freshness",
      weight: SCORE_WEIGHTS.freshness,
      value: days === null ? null : days <= 90 ? 1 : days <= 365 ? 0.5 : 0,
      explanation: days === null ? "Unavailable: no last-seen dates." : `Last seen ${e.lastSeen} (${Math.max(0, Math.round(days))} days ago).`,
    },
    {
      id: "verified_live",
      weight: SCORE_WEIGHTS.verified_live,
      value: e.verifiedLive === null ? null : e.verifiedLive ? 1 : 0,
      explanation: e.verifiedLive === null ? "Unavailable: not verified by a live check." : e.verifiedLive ? "A live check found the link on the page." : "A live check did not find the link.",
    },
    {
      id: "prior_relationship",
      weight: SCORE_WEIGHTS.prior_relationship,
      value: e.previouslyLinked ? 1 : 0,
      explanation: e.previouslyLinked ? "This domain linked to your site in an earlier snapshot." : "No earlier link to your site in your snapshots.",
    },
  ];
  // Integer weights (hundredths) keep the arithmetic exact, so equal evidence always rounds the same way.
  const available = signals.filter((s) => s.value !== null);
  const basis = available.reduce((sum, s) => sum + Math.round(s.weight * 100), 0);
  const points = available.reduce((sum, s) => sum + Math.round(s.weight * 100) * s.value!, 0);
  return { score: basis ? Math.round((points * 100) / basis) : 0, basis: basis / 100, signals };
}

/** Lowercase words of 3+ letters from free-text topics, deduplicated, at most 20. */
export function topicTerms(input: string | undefined): string[] {
  return [...new Set((input ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 20);
}

export function matchTopics(terms: string[], texts: string[]): string[] {
  const hay = texts.join(" ").toLowerCase();
  return terms.filter((t) => hay.includes(t));
}
