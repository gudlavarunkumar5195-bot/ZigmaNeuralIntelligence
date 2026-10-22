import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeDomain, normalizeLinkUrl, parseCsv } from "../backlinks/core.js";
import { prioritize, type Factor } from "../content/core.js";
import { isIpLiteral } from "../scanner/ssrf.js";

/**
 * AI search visibility: pure, deterministic logic (no I/O). Brand mention
 * matching, citation URL normalization, manual-import parsing, metrics,
 * competitor comparison and opportunity rules. Every number is computed from
 * stored observations; nothing here estimates or fills in missing data.
 */

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const PROMPT_VERSION = "aiv-prompt-1";

/** Where an observation's answer was seen. API providers record "model_api". */
export const SURFACES: Record<string, string> = {
  model_api: "Model answer via API",
  chatgpt: "ChatGPT",
  google_ai_overviews: "Google AI Overviews",
  google_ai_mode: "Google AI Mode",
  perplexity: "Perplexity",
  gemini: "Gemini",
  copilot: "Microsoft Copilot",
  claude: "Claude",
  meta_ai: "Meta AI",
  other: "Other AI assistant",
};
export const IMPORT_SURFACES = Object.keys(SURFACES).filter((s) => s !== "model_api");

const SURFACE_ALIASES: Record<string, string> = {
  chatgpt: "chatgpt", "chat gpt": "chatgpt", openai: "chatgpt", "openai chatgpt": "chatgpt", "chatgpt search": "chatgpt",
  "google ai overviews": "google_ai_overviews", "google ai overview": "google_ai_overviews", "ai overviews": "google_ai_overviews", "ai overview": "google_ai_overviews", aio: "google_ai_overviews", sge: "google_ai_overviews",
  "google ai mode": "google_ai_mode", "ai mode": "google_ai_mode",
  perplexity: "perplexity", "perplexity ai": "perplexity",
  gemini: "gemini", "google gemini": "gemini",
  copilot: "copilot", "microsoft copilot": "copilot", "bing copilot": "copilot", "bing chat": "copilot",
  claude: "claude", "claude.ai": "claude",
  "meta ai": "meta_ai", meta: "meta_ai",
  other: "other",
};

export function parseSurface(raw: string): string | null {
  const k = raw.normalize("NFKC").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return SURFACE_ALIASES[k] ?? (IMPORT_SURFACES.includes(k.replace(/ /g, "_")) ? k.replace(/ /g, "_") : null);
}

/** Case-, width- and whitespace-insensitive key for names and query text. */
export const termKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// ─── Brand mentions ──────────────────────────────────────────────────────────

export interface BrandTerms {
  id: string;
  name: string;
  aliases: string[];
  products: string[];
  domains: string[];
  excludeTerms: string[];
}

export type MatchedBy = "name" | "alias" | "product" | "domain";

export interface MentionHit {
  brandId: string;
  matchCount: number;
  firstOffset: number;
  matchedTerms: string[];
  matchedBy: MatchedBy[];
  excerpt: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])";

/**
 * A regex for one term. Whole words only (Unicode letters/digits), any
 * whitespace between words. Short all-caps terms ("HP", "IBM") match case-
 * sensitively so ordinary words are not counted. Domains must not continue
 * into a longer host ("acme.com" does not match inside "acme.com.au").
 */
export function termPattern(term: string, kind: MatchedBy): RegExp | null {
  const t = term.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t || t.length > 120) return null;
  const body = t.split(" ").map(escapeRe).join("\\s+");
  const after = kind === "domain" ? "(?![\\p{L}\\p{N}_]|\\.[\\p{L}\\p{N}])" : NOT_WORD_AFTER;
  const caseSensitive = t.length <= 3 && t === t.toUpperCase() && /\p{Lu}/u.test(t);
  return new RegExp(`${NOT_WORD_BEFORE}${body}${after}`, caseSensitive ? "gu" : "giu");
}

interface Span { start: number; end: number; term: string; by: MatchedBy }

function spans(text: string, term: string, kind: MatchedBy): Span[] {
  const re = termPattern(term, kind);
  if (!re) return [];
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, term, by: kind });
    if (out.length >= 1_000) break;
  }
  return out;
}

const excerptAround = (text: string, start: number, end: number) => {
  const from = Math.max(0, start - 120);
  const to = Math.min(text.length, end + 120);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`.slice(0, 400);
};

/**
 * Which of the given brands the text names. Overlapping matches of one brand
 * count once (the longest wins); matches inside an excluded phrase (for
 * disambiguation, e.g. "apple pie") do not count.
 */
export function detectMentions(text: string, brands: BrandTerms[], opts: { excerpt: boolean } = { excerpt: true }): MentionHit[] {
  const norm = text.normalize("NFKC");
  const hits: MentionHit[] = [];
  for (const b of brands) {
    const excluded = b.excludeTerms.flatMap((t) => spans(norm, t, "alias"));
    const candidates = [
      ...spans(norm, b.name, "name"),
      ...b.aliases.flatMap((t) => spans(norm, t, "alias")),
      ...b.products.flatMap((t) => spans(norm, t, "product")),
      ...b.domains.flatMap((t) => spans(norm, t, "domain")),
    ]
      .filter((s) => !excluded.some((x) => s.start >= x.start && s.end <= x.end))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: Span[] = [];
    for (const s of candidates) {
      const last = kept[kept.length - 1];
      if (last && s.start < last.end) continue; // overlaps a longer/earlier match
      kept.push(s);
    }
    if (!kept.length) continue;
    hits.push({
      brandId: b.id,
      matchCount: kept.length,
      firstOffset: kept[0].start,
      matchedTerms: [...new Set(kept.map((s) => s.term))].slice(0, 20),
      matchedBy: [...new Set(kept.map((s) => s.by))],
      excerpt: opts.excerpt ? excerptAround(norm, kept[0].start, kept[0].end) : null,
    });
  }
  return hits;
}

// ─── Citation URLs ───────────────────────────────────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_eid|_hsenc|_hsmi)$/i;
const NON_PUBLIC_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|test|invalid|example|onion)$/;

export interface NormalizedSource {
  normalizedUrl: string;
  urlKey: string;
  host: string;
  registrableDomain: string | null;
  idn: boolean;
}

/**
 * Normalizes a cited URL for comparison. Only explicit http(s) URLs with a
 * public-looking DNS host are accepted: no credentials, IP literals,
 * single-label or reserved/internal hosts. The fragment and tracking
 * parameters (utm_*, click ids) are removed; every other query parameter is
 * kept because it may identify the content. Nothing is fetched.
 */
export function normalizeSourceUrl(raw: string): NormalizedSource | null {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const n = normalizeLinkUrl(text);
  if (!n) return null;
  const url = new URL(n);
  const host = url.hostname;
  if (isIpLiteral(host) || host.startsWith("[") || !host.includes(".")) return null;
  const labels = host.split(".");
  if (host.length > 253 || labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return null;
  if (NON_PUBLIC_SUFFIX.test(host) || /^\d+$/.test(labels[labels.length - 1])) return null;
  for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(k)) url.searchParams.delete(k);
  const normalizedUrl = url.toString();
  const bare = host.replace(/^www\./, "");
  return { normalizedUrl, urlKey: sha(normalizedUrl), host: bare, registrableDomain: registrableDomain(bare), idn: labels.some((l) => l.startsWith("xn--")) };
}

// Suffixes under which each label is a separate registrant (a small, curated
// list, not the full Public Suffix List). Unknown suffixes give null.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "gov.in", "edu.in",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.my",
  "com.br", "net.br", "org.br", "com.mx", "com.ar", "com.co", "com.tr", "co.za", "org.za", "co.il", "com.ph", "com.vn", "com.pk", "com.ng", "com.eg", "com.sa",
  "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "wordpress.com", "substack.com", "medium.com", "web.app", "firebaseapp.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com",
]);
const SINGLE_LABEL_SUFFIXES = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "ai", "co", "dev", "app", "info", "biz", "me", "us", "eu", "de", "fr", "nl", "es", "it", "ca", "ch", "se", "no", "fi", "dk", "pl", "be", "at", "ie", "pt", "cz", "gr", "ro", "hu",
  "xyz", "tech", "online", "site", "store", "shop", "blog", "news", "cloud", "so", "gg", "tv", "fm", "ly", "to", "sh", "in", "ru", "ua", "is", "lt", "lv", "ee", "sk", "si", "hr", "rs", "bg", "lu", "li", "mt", "cy",
  "agency", "digital", "media", "software", "solutions", "systems", "academy", "health", "finance", "legal", "travel", "io", "page", "wiki", "review", "reviews", "guide", "world", "global", "group", "company", "network", "today",
]);

/** The registrable domain when it can be determined from the curated lists above; otherwise null. */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2) return null;
  const two = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(two)) return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  const three = labels.slice(-3).join(".");
  if (labels.length >= 4 && MULTI_LABEL_SUFFIXES.has(three)) return labels.slice(-4).join(".");
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-3).join("."))) return null;
  return SINGLE_LABEL_SUFFIXES.has(labels[labels.length - 1]) ? two : null;
}

/** True when the host is the domain or one of its subdomains. */
export const hostMatchesDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Normalizes the brand's official domains ("https://www.Acme.com/" → "acme.com"). */
export function normalizeBrandDomain(raw: string): string | null {
  const d = normalizeDomain(raw.trim());
  if (!d || isIpLiteral(d) || !d.includes(".") || NON_PUBLIC_SUFFIX.test(d)) return null;
  return d;
}

/** Bare URLs written in the answer text (not provider citations). Trailing punctuation is trimmed. */
export function extractInlineUrls(text: string, max = 50): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\]\\]+/gi)) {
    let u = m[0];
    for (;;) {
      const last = u[u.length - 1];
      if (".,;:!?*_'\"".includes(last)) u = u.slice(0, -1);
      else if (last === ")" && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1);
      else break;
    }
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

export function answerStatus(content: string, finishReason: string): "answered" | "truncated" | "empty" | "refused" {
  if (finishReason === "content_filter") return "refused";
  if (!content.trim()) return "empty";
  return finishReason === "length" ? "truncated" : "answered";
}

/** Observations whose answer counts as an answer for mention metrics. */
export const isAnswered = (status: string) => status === "answered" || status === "truncated";

// ─── Manual import ───────────────────────────────────────────────────────────

export type ImportField = "query" | "observed_at" | "surface" | "model" | "response" | "cited_urls" | "language" | "country" | "notes";
const IMPORT_ALIASES: Record<ImportField, string[]> = {
  query: ["query", "prompt", "question", "query text"],
  observed_at: ["observed at", "observed", "date", "timestamp", "collected at", "observation date"],
  surface: ["surface", "platform", "engine", "assistant", "ai", "source"],
  model: ["model"],
  response: ["response", "answer", "response text", "output", "answer text"],
  cited_urls: ["cited urls", "citations", "sources", "urls", "source urls", "cited url"],
  language: ["language", "lang"],
  country: ["country", "market"],
  notes: ["notes", "note", "comment"],
};
export const REQUIRED_IMPORT_FIELDS: ImportField[] = ["query", "observed_at", "surface", "response"];

export interface ImportCitation { url: string; title: string | null; position: number; source: NormalizedSource }

export interface ImportRow {
  line: number;
  query: string;
  queryKey: string;
  observedAt: Date;
  surface: string;
  model: string | null;
  response: string;
  citations: ImportCitation[];
  language: string | null;
  country: string | null;
  notes: string | null;
  dedupeKey: string;
}

export interface ImportParse {
  format: "csv" | "json";
  rowsTotal: number;
  rows: ImportRow[];
  rejected: Array<{ line: number; reason: string }>;
  duplicatesInFile: number;
  truncated: boolean;
  mapping: Partial<Record<ImportField, string>>;
  missingColumns: ImportField[];
  fatal: string | null;
}

const MIN_OBSERVED = Date.UTC(2020, 0, 1);

export function parseObservedAt(raw: string, now: Date): Date | string {
  const t = raw.trim();
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) d = new Date(`${t}T00:00:00Z`);
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(t)) d = new Date(t.replace(" ", "T"));
  else return "observed_at must be YYYY-MM-DD or an ISO 8601 date-time with a time zone";
  if (Number.isNaN(d.getTime())) return "observed_at is not a valid date";
  if (d.getTime() > now.getTime() + 86_400_000) return "observed_at is in the future";
  if (d.getTime() < MIN_OBSERVED) return "observed_at is before 2020-01-01";
  return d;
}

interface RawRecord { query?: unknown; observed_at?: unknown; surface?: unknown; model?: unknown; response?: unknown; cited_urls?: unknown; language?: unknown; country?: unknown; notes?: unknown }

export function importDedupeKey(r: Pick<ImportRow, "surface" | "model" | "queryKey" | "language" | "country" | "observedAt" | "response">) {
  return sha(["import", r.surface, r.model ?? "", r.queryKey, r.language ?? "", r.country ?? "", r.observedAt.toISOString(), sha(r.response)].join("\n"));
}

function validateRecord(rec: RawRecord, line: number, now: Date, maxResponseChars: number): ImportRow | string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : v == null ? "" : null);
  const query = str(rec.query);
  if (query === null || query.length < 3 || query.length > 500) return "query must be 3–500 characters";
  const when = str(rec.observed_at);
  if (!when) return "observed_at is required";
  const observedAt = parseObservedAt(when, now);
  if (typeof observedAt === "string") return observedAt;
  const surfaceRaw = str(rec.surface);
  const surface = surfaceRaw ? parseSurface(surfaceRaw) : null;
  if (!surface) return `surface must be one of: ${IMPORT_SURFACES.join(", ")}`;
  const model = str(rec.model);
  if (model === null || model.length > 200) return "model must be text up to 200 characters";
  const response = typeof rec.response === "string" ? rec.response.replace(/\r\n/g, "\n") : null;
  if (!response || !response.trim()) return "response (the answer text) is required";
  if (response.length > maxResponseChars) return `response is longer than ${maxResponseChars} characters`;
  const language = str(rec.language)?.toLowerCase() ?? null;
  if (language && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) return "language must be a language code such as en or en-gb";
  const country = str(rec.country)?.toLowerCase() ?? null;
  if (country && !/^[a-z]{2}$/.test(country)) return "country must be a two-letter country code";
  const notes = str(rec.notes);
  if (notes === null || notes.length > 1000) return "notes must be text up to 1000 characters";
  let urls: Array<{ url: string; title: string | null }> = [];
  if (Array.isArray(rec.cited_urls)) {
    for (const u of rec.cited_urls) {
      if (typeof u === "string") urls.push({ url: u.trim(), title: null });
      else if (u && typeof u === "object" && typeof (u as { url?: unknown }).url === "string") {
        const t = (u as { title?: unknown }).title;
        urls.push({ url: ((u as { url: string }).url).trim(), title: typeof t === "string" && t.trim() ? t.trim().slice(0, 300) : null });
      } else return "cited_urls must be a list of URLs (or {url, title} objects)";
    }
  } else if (typeof rec.cited_urls === "string") {
    urls = rec.cited_urls.split(/[\s|]+/).filter(Boolean).map((url) => ({ url, title: null }));
  } else if (rec.cited_urls != null) return "cited_urls must be a list of URLs";
  if (urls.length > 50) return "more than 50 cited URLs";
  const citations: ImportCitation[] = [];
  for (const u of urls.filter((x) => x.url)) {
    const source = normalizeSourceUrl(u.url);
    if (!source) return `invalid cited URL "${u.url.slice(0, 120)}" (only public http(s) URLs are accepted)`;
    if (!citations.some((c) => c.source.urlKey === source.urlKey)) citations.push({ url: u.url.slice(0, 2048), title: u.title, position: citations.length + 1, source });
  }
  const row = { line, query: query.replace(/\s+/g, " "), queryKey: termKey(query), observedAt, surface, model: model || null, response, citations, language: language || null, country: country || null, notes: notes || null };
  return { ...row, dedupeKey: importDedupeKey(row) };
}

const normHeader = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

/** Parses and validates a CSV or JSON file of manually observed AI answers. */
export function parseObservationImport(content: string, opts: { format?: "csv" | "json"; maxRows: number; maxResponseChars: number; now?: Date }): ImportParse {
  const now = opts.now ?? new Date();
  const text = content.replace(/^﻿/, "");
  const format = opts.format ?? (/^\s*[[{]/.test(text) ? "json" : "csv");
  const out: ImportParse = { format, rowsTotal: 0, rows: [], rejected: [], duplicatesInFile: 0, truncated: false, mapping: {}, missingColumns: [], fatal: null };
  let records: Array<{ line: number; rec: RawRecord }> = [];
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...out, fatal: "The file is not valid JSON." };
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { observations?: unknown }).observations) ? (parsed as { observations: unknown[] }).observations : null;
    if (!list) return { ...out, fatal: 'JSON must be an array of observations or {"observations": [...]}.' };
    out.truncated = list.length > opts.maxRows;
    records = list.slice(0, opts.maxRows).map((rec, i) => ({ line: i + 1, rec: rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as RawRecord) : ({ query: null } as RawRecord) }));
  } else {
    const csv = parseCsv(text, opts.maxRows);
    out.truncated = csv.truncated;
    const used = new Set<number>();
    for (const field of Object.keys(IMPORT_ALIASES) as ImportField[]) {
      const idx = csv.header.findIndex((h, i) => !used.has(i) && (normHeader(h) === field.replace(/_/g, " ") || IMPORT_ALIASES[field].includes(normHeader(h))));
      if (idx >= 0) {
        used.add(idx);
        out.mapping[field] = csv.header[idx];
      }
    }
    out.missingColumns = REQUIRED_IMPORT_FIELDS.filter((f) => !out.mapping[f]);
    if (out.missingColumns.length) return { ...out, rowsTotal: csv.rows.length, fatal: `Missing required columns: ${out.missingColumns.join(", ")}.` };
    const col = (row: string[], f: ImportField) => (out.mapping[f] ? row[csv.header.indexOf(out.mapping[f]!)] : undefined);
    records = csv.rows
      .map((row, i) => ({ line: i + 2, row }))
      .filter(({ row }) => row.some((c) => c.trim()))
      .map(({ line, row }) => ({ line, rec: Object.fromEntries((Object.keys(IMPORT_ALIASES) as ImportField[]).map((f) => [f, col(row, f)])) as RawRecord }));
  }
  out.rowsTotal = records.length;
  const seen = new Set<string>();
  for (const { line, rec } of records) {
    const r = validateRecord(rec, line, now, opts.maxResponseChars);
    if (typeof r === "string") {
      out.rejected.push({ line, reason: r });
      continue;
    }
    if (seen.has(r.dedupeKey)) {
      out.duplicatesInFile++;
      continue;
    }
    seen.add(r.dedupeKey);
    out.rows.push(r);
  }
  return out;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

/** One stored, non-excluded observation reduced to the facts metrics use. */
export interface ObsFact {
  id: string;
  queryId: string;
  provider: string;
  surface: string;
  method: "provider_api" | "manual_import";
  model: string | null;
  observedAt: Date;
  language: string | null;
  country: string | null;
  answerStatus: string;
  /** Brand ids the answer mentions. */
  mentioned: string[];
  /** Brand ids whose official domains the observation cites. */
  citedBrands: string[];
  /** Number of citations (structured, inline or imported). */
  citationCount: number;
  /** Distinct cited hosts. */
  citedHosts: string[];
}

export interface BrandRef { id: string; name: string; kind: "target" | "competitor" }

export interface MetricValue {
  value: number | null;
  numerator: number;
  denominator: number;
  smallSample: boolean;
}

export const METRIC_DEFINITIONS = {
  mentionRate: {
    label: "Mention rate",
    numerator: "Answered observations whose text names the brand (name, alias, product or official domain)",
    denominator: "Answered observations (status answered or truncated) in the group and window",
    missing: "Empty, refused and failed collections are excluded; with no answered observation the value is 'no data', not 0.",
  },
  queryCoverage: {
    label: "Query coverage",
    numerator: "Queries with at least one answered observation mentioning the brand",
    denominator: "Queries with at least one answered observation",
    missing: "Queries never collected are not counted.",
  },
  mentionShare: {
    label: "Share of observed mentions",
    numerator: "Answered observations mentioning the brand",
    denominator: "Sum over all monitored brands (target and active competitors) of answered observations mentioning that brand",
    missing: "No data when no monitored brand is mentioned. Brands that are not monitored are not counted.",
  },
  citationRate: {
    label: "Official-domain citation rate",
    numerator: "Observations citing at least one of the brand's official domains",
    denominator: "Observations with at least one citation",
    missing: "Observations without any citation are excluded (most model answers without web search cite nothing).",
  },
  citationShare: {
    label: "Citation share among monitored domains",
    numerator: "Observations citing the brand's official domains",
    denominator: "Sum over monitored brands of observations citing that brand's official domains",
    missing: "No data when no monitored domain is cited.",
  },
  coMention: {
    label: "Competitor co-mention rate",
    numerator: "Answered observations mentioning both the target and the competitor",
    denominator: "Answered observations mentioning the target",
    missing: "No data when the target is never mentioned.",
  },
  consistency: {
    label: "Mention consistency",
    numerator: "Queries whose repeated answers all mention, or all omit, the target",
    denominator: "Queries with at least two answered observations in the group",
    missing: "Queries observed once are excluded.",
  },
  topSourceShare: {
    label: "Most-cited source share",
    numerator: "Observations citing the most frequently cited host",
    denominator: "Observations with at least one citation",
    missing: "No data without citations.",
  },
} as const;

export const metric = (numerator: number, denominator: number, minSample: number): MetricValue => ({
  value: denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : null,
  numerator,
  denominator,
  smallSample: denominator < minSample,
});

export interface GroupKey { method: ObsFact["method"]; provider: string; surface: string; model: string | null }

/** Observations are only aggregated within one method, provider, surface and (for API collection) model. */
export const groupKeyOf = (f: ObsFact): GroupKey => ({ method: f.method, provider: f.provider, surface: f.surface, model: f.method === "provider_api" ? f.model : null });
const keyString = (k: GroupKey) => [k.method, k.provider, k.surface, k.model ?? ""].join("|");

export function groupFacts(facts: ObsFact[]): Array<{ key: GroupKey; facts: ObsFact[] }> {
  const m = new Map<string, { key: GroupKey; facts: ObsFact[] }>();
  for (const f of facts) {
    const key = groupKeyOf(f);
    const ks = keyString(key);
    if (!m.has(ks)) m.set(ks, { key, facts: [] });
    m.get(ks)!.facts.push(f);
  }
  return [...m.values()].sort((a, b) => b.facts.length - a.facts.length);
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface GroupMetrics {
  key: GroupKey;
  sample: { observations: number; answered: number; unanswered: number; queries: number; withCitations: number; firstObservedAt: string | null; lastObservedAt: string | null; languages: string[]; countries: string[] };
  brands: Array<{ brandId: string; name: string; kind: BrandRef["kind"]; mentionRate: MetricValue; queryCoverage: MetricValue; mentionShare: MetricValue; citationRate: MetricValue; citationShare: MetricValue; firstMentionAt: string | null; lastMentionAt: string | null }>;
  coMentions: Array<{ brandId: string; name: string; rate: MetricValue }>;
  sources: { citations: number; distinctHosts: number; topHosts: Array<{ host: string; observations: number }>; topSourceShare: MetricValue };
  consistency: MetricValue;
  trend: Array<{ period: string; answered: number; mentioned: number; rate: number | null }>;
}

export function computeGroupMetrics(key: GroupKey, facts: ObsFact[], brands: BrandRef[], targetId: string, minSample: number): GroupMetrics {
  const answered = facts.filter((f) => isAnswered(f.answerStatus));
  const withCitations = facts.filter((f) => f.citationCount > 0);
  const queriesAnswered = new Set(answered.map((f) => f.queryId));
  const mentionObs = (id: string) => answered.filter((f) => f.mentioned.includes(id));
  const citeObs = (id: string) => facts.filter((f) => f.citedBrands.includes(id));
  const totalMentions = brands.reduce((s, b) => s + mentionObs(b.id).length, 0);
  const totalCites = brands.reduce((s, b) => s + citeObs(b.id).length, 0);
  const times = facts.map((f) => f.observedAt.getTime());
  const targetMentions = mentionObs(targetId);
  const hostCounts = new Map<string, number>();
  for (const f of withCitations) for (const h of new Set(f.citedHosts)) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
  const topHosts = [...hostCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([host, observations]) => ({ host, observations }));
  const byQuery = new Map<string, boolean[]>();
  for (const f of answered) byQuery.set(f.queryId, [...(byQuery.get(f.queryId) ?? []), f.mentioned.includes(targetId)]);
  const repeated = [...byQuery.values()].filter((v) => v.length >= 2);
  const weeks = new Map<string, { answered: number; mentioned: number }>();
  for (const f of answered) {
    const w = isoWeek(f.observedAt);
    const cur = weeks.get(w) ?? { answered: 0, mentioned: 0 };
    cur.answered++;
    if (f.mentioned.includes(targetId)) cur.mentioned++;
    weeks.set(w, cur);
  }
  const iso = (ms: number[]) => (ms.length ? new Date(ms.reduce((a, b) => (b > a ? b : a))).toISOString() : null);
  const isoMin = (ms: number[]) => (ms.length ? new Date(ms.reduce((a, b) => (b < a ? b : a))).toISOString() : null);
  return {
    key,
    sample: {
      observations: facts.length,
      answered: answered.length,
      unanswered: facts.length - answered.length,
      queries: queriesAnswered.size,
      withCitations: withCitations.length,
      firstObservedAt: isoMin(times),
      lastObservedAt: iso(times),
      languages: [...new Set(facts.map((f) => f.language).filter((x): x is string => !!x))].sort(),
      countries: [...new Set(facts.map((f) => f.country).filter((x): x is string => !!x))].sort(),
    },
    brands: brands.map((b) => {
      const m = mentionObs(b.id);
      const c = citeObs(b.id);
      const ms = m.map((f) => f.observedAt.getTime());
      return {
        brandId: b.id,
        name: b.name,
        kind: b.kind,
        mentionRate: metric(m.length, answered.length, minSample),
        queryCoverage: metric(new Set(m.map((f) => f.queryId)).size, queriesAnswered.size, minSample),
        mentionShare: metric(m.length, totalMentions, minSample),
        citationRate: metric(c.length, withCitations.length, minSample),
        citationShare: metric(c.length, totalCites, minSample),
        firstMentionAt: isoMin(ms),
        lastMentionAt: iso(ms),
      };
    }),
    coMentions: brands.filter((b) => b.id !== targetId).map((b) => ({ brandId: b.id, name: b.name, rate: metric(targetMentions.filter((f) => f.mentioned.includes(b.id)).length, targetMentions.length, minSample) })),
    sources: {
      citations: withCitations.reduce((s, f) => s + f.citationCount, 0),
      distinctHosts: hostCounts.size,
      topHosts,
      topSourceShare: metric(topHosts[0]?.observations ?? 0, withCitations.length, minSample),
    },
    consistency: metric(repeated.filter((v) => v.every(Boolean) || v.every((x) => !x)).length, repeated.length, minSample),
    trend: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, ...v, rate: v.answered ? Math.round((v.mentioned / v.answered) * 10_000) / 10_000 : null })),
  };
}

export const computeMetrics = (facts: ObsFact[], brands: BrandRef[], targetId: string, minSample: number) =>
  groupFacts(facts).map((g) => computeGroupMetrics(g.key, g.facts, brands, targetId, minSample));

// ─── Competitor comparison ───────────────────────────────────────────────────

export interface QueryEvidence { queryId: string; observationIds: string[] }

export interface CompetitorComparison {
  key: GroupKey;
  sample: { answered: number; queries: number; languages: string[]; countries: string[]; firstObservedAt: string | null; lastObservedAt: string | null };
  competitors: Array<{
    brandId: string;
    name: string;
    target: { mentioned: number; rate: MetricValue; cited: number };
    competitor: { mentioned: number; rate: MetricValue; cited: number };
    competitorOnlyQueries: QueryEvidence[];
    targetOnlyQueries: QueryEvidence[];
    bothQueries: number;
    sharedSourceHosts: string[];
    history: { status: "ok" | "insufficient"; splitAt: string | null; earlier: { answered: number; targetRate: number | null; competitorRate: number | null } | null; later: { answered: number; targetRate: number | null; competitorRate: number | null } | null };
  }>;
}

export function compareCompetitors(facts: ObsFact[], target: BrandRef, competitors: BrandRef[], minSample: number): CompetitorComparison[] {
  return groupFacts(facts).map(({ key, facts: gf }) => {
    const answered = gf.filter((f) => isAnswered(f.answerStatus)).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const queries = [...new Set(answered.map((f) => f.queryId))];
    const times = answered.map((f) => f.observedAt.toISOString());
    const rate = (list: ObsFact[], id: string) => (list.length ? Math.round((list.filter((f) => f.mentioned.includes(id)).length / list.length) * 10_000) / 10_000 : null);
    return {
      key,
      sample: { answered: answered.length, queries: queries.length, languages: [...new Set(answered.map((f) => f.language).filter((x): x is string => !!x))], countries: [...new Set(answered.map((f) => f.country).filter((x): x is string => !!x))], firstObservedAt: times[0] ?? null, lastObservedAt: times[times.length - 1] ?? null },
      competitors: competitors.map((c) => {
        const compOnly: QueryEvidence[] = [];
        const targetOnly: QueryEvidence[] = [];
        let both = 0;
        for (const q of queries) {
          const qf = answered.filter((f) => f.queryId === q);
          const t = qf.filter((f) => f.mentioned.includes(target.id));
          const k = qf.filter((f) => f.mentioned.includes(c.id));
          if (k.length && !t.length) compOnly.push({ queryId: q, observationIds: k.slice(0, 10).map((f) => f.id) });
          else if (t.length && !k.length) targetOnly.push({ queryId: q, observationIds: t.slice(0, 10).map((f) => f.id) });
          else if (t.length && k.length) both++;
        }
        const hosts = (id: string) => new Set(gf.filter((f) => f.mentioned.includes(id)).flatMap((f) => f.citedHosts));
        const th = hosts(target.id);
        const shared = [...hosts(c.id)].filter((h) => th.has(h)).sort().slice(0, 20);
        const half = Math.floor(answered.length / 2);
        const earlier = answered.slice(0, half);
        const later = answered.slice(half);
        const enough = earlier.length >= minSample && later.length >= minSample;
        const tm = answered.filter((f) => f.mentioned.includes(target.id)).length;
        const cm = answered.filter((f) => f.mentioned.includes(c.id)).length;
        return {
          brandId: c.id,
          name: c.name,
          target: { mentioned: tm, rate: metric(tm, answered.length, minSample), cited: gf.filter((f) => f.citedBrands.includes(target.id)).length },
          competitor: { mentioned: cm, rate: metric(cm, answered.length, minSample), cited: gf.filter((f) => f.citedBrands.includes(c.id)).length },
          competitorOnlyQueries: compOnly,
          targetOnlyQueries: targetOnly,
          bothQueries: both,
          sharedSourceHosts: shared,
          history: enough
            ? { status: "ok" as const, splitAt: later[0].observedAt.toISOString(), earlier: { answered: earlier.length, targetRate: rate(earlier, target.id), competitorRate: rate(earlier, c.id) }, later: { answered: later.length, targetRate: rate(later, target.id), competitorRate: rate(later, c.id) } }
            : { status: "insufficient" as const, splitAt: null, earlier: null, later: null },
        };
      }),
    };
  });
}

// ─── Opportunities ───────────────────────────────────────────────────────────

export type OpportunityKind = "frequently_cited_source" | "mentioned_not_cited" | "competitor_only_queries" | "insufficient_data" | "unreachable_cited_source";

export interface OpportunityCandidate {
  kind: OpportunityKind;
  fingerprint: string;
  title: string;
  explanation: string;
  action: string;
  evidence: { observationIds: string[]; queryIds: string[]; brandIds: string[]; hosts: string[]; urls: string[]; counts: Record<string, number> };
  limitations: string[];
  factors: Factor[];
  priority: number;
  confidence: "high" | "medium" | "low";
}

export const PRIORITY_FORMULA = "priority = round(100 × Σ(weight × value) ÷ Σ(weight)) over the factors that have data; each value is between 0 and 1.";
const CITATION_LIMITATION = "A citation shows the answer referenced the page; it does not prove the page supports the answer. Pages are not fetched unless you verify them.";
const SAMPLE_LIMITATION = "Based only on the queries you monitor and the observations collected; it is not a measure of all AI search traffic.";
const confidenceFor = (n: number): OpportunityCandidate["confidence"] => (n >= 10 ? "high" : n >= 5 ? "medium" : "low");
const cap = (x: number) => Math.max(0, Math.min(1, x));

export interface OpportunityInput {
  facts: ObsFact[];
  target: BrandRef & { domains: string[] };
  competitors: Array<BrandRef & { domains: string[] }>;
  queries: Array<{ id: string; text: string; status: string }>;
  sources: Array<{ id: string; host: string; normalizedUrl: string; verificationStatus: string; observationIds: string[] }>;
  minSample: number;
}

export function findVisibilityOpportunities(input: OpportunityInput): OpportunityCandidate[] {
  const { facts, target, competitors } = input;
  const out: OpportunityCandidate[] = [];
  const answered = facts.filter((f) => isAnswered(f.answerStatus));
  const withCitations = facts.filter((f) => f.citationCount > 0);
  const monitoredDomains = [target, ...competitors].flatMap((b) => b.domains);
  const isMonitored = (host: string) => monitoredDomains.some((d) => hostMatchesDomain(host, d));
  const queryCount = new Set(answered.map((f) => f.queryId)).size;
  const push = (c: Omit<OpportunityCandidate, "priority">) => out.push({ ...c, priority: prioritize(c.factors) });

  // 1. A non-monitored host cited repeatedly across queries.
  const byHost = new Map<string, ObsFact[]>();
  for (const f of withCitations) for (const h of new Set(f.citedHosts)) if (!isMonitored(h)) byHost.set(h, [...(byHost.get(h) ?? []), f]);
  for (const [host, list] of byHost) {
    const qs = new Set(list.map((f) => f.queryId));
    if (list.length < 3 || qs.size < 2) continue;
    const withoutTarget = list.filter((f) => !f.mentioned.includes(target.id)).length;
    push({
      kind: "frequently_cited_source",
      fingerprint: sha(`frequently_cited_source|${host}`),
      title: `${host} is cited in ${list.length} answers to ${qs.size} monitored queries`,
      explanation: `${host} appears as a source in ${list.length} of ${withCitations.length} observations that cite anything. ${withoutTarget} of those answers do not mention ${target.name}.`,
      action: `Read what ${host} says about these topics. If it describes ${target.name} inaccurately or not at all, ask the publisher for a correction or offer accurate, verifiable information; keep your own public pages on these topics clear and current. Do not pay for placements or post undisclosed promotional content.`,
      evidence: { observationIds: list.slice(0, 50).map((f) => f.id), queryIds: [...qs].slice(0, 50), brandIds: [target.id], hosts: [host], urls: [], counts: { observations: list.length, queries: qs.size, withoutTarget } },
      limitations: [CITATION_LIMITATION, SAMPLE_LIMITATION],
      factors: [
        { name: "citation_frequency", weight: 0.4, value: cap(list.length / Math.max(1, withCitations.length)), explanation: `${list.length} of ${withCitations.length} citing observations.` },
        { name: "query_spread", weight: 0.3, value: cap(qs.size / Math.max(1, queryCount)), explanation: `${qs.size} of ${queryCount} queries with answers.` },
        { name: "target_absent", weight: 0.3, value: cap(withoutTarget / list.length), explanation: `${withoutTarget} of ${list.length} answers do not mention ${target.name}.` },
      ],
      confidence: confidenceFor(list.length),
    });
  }

  // 2. The target is named in answers that cite sources, but never its own domain.
  if (target.domains.length) {
    const list = answered.filter((f) => f.citationCount > 0 && f.mentioned.includes(target.id) && !f.citedBrands.includes(target.id));
    const mentionedCiting = answered.filter((f) => f.citationCount > 0 && f.mentioned.includes(target.id));
    if (list.length >= 2) {
      push({
        kind: "mentioned_not_cited",
        fingerprint: sha("mentioned_not_cited"),
        title: `${target.name} is mentioned but its own site is not cited in ${list.length} answers`,
        explanation: `In ${list.length} of ${mentionedCiting.length} answers that mention ${target.name} and cite sources, none of the cited URLs is on ${target.domains.join(", ")}.`,
        action: `Make sure the official pages that answer these questions are public, crawlable and specific (product facts, pricing pages, documentation), with accurate Organization/Product structured data where it applies.`,
        evidence: { observationIds: list.slice(0, 50).map((f) => f.id), queryIds: [...new Set(list.map((f) => f.queryId))].slice(0, 50), brandIds: [target.id], hosts: [], urls: [], counts: { observations: list.length, mentionedWithCitations: mentionedCiting.length } },
        limitations: [CITATION_LIMITATION, SAMPLE_LIMITATION, "Which sources a model cites depends on the provider; this is not a ranking factor analysis."],
        factors: [
          { name: "uncited_share", weight: 0.6, value: cap(list.length / Math.max(1, mentionedCiting.length)), explanation: `${list.length} of ${mentionedCiting.length} mentioning answers with citations.` },
          { name: "sample_size", weight: 0.4, value: cap(list.length / 20), explanation: `${list.length} observations (20 or more counts as full).` },
        ],
        confidence: confidenceFor(list.length),
      });
    }
  }

  // 3. Competitors named for queries where the target never is (within comparable groups).
  for (const c of competitors) {
    const evidence: QueryEvidence[] = [];
    for (const g of compareCompetitors(facts, target, [c], input.minSample)) {
      for (const q of g.competitors[0].competitorOnlyQueries) {
        const qAnswered = answered.filter((f) => f.queryId === q.queryId && keyString(groupKeyOf(f)) === keyString(g.key)).length;
        if (qAnswered >= 2) evidence.push(q);
      }
    }
    if (!evidence.length) continue;
    const obs = evidence.flatMap((e) => e.observationIds);
    const qids = [...new Set(evidence.map((e) => e.queryId))];
    push({
      kind: "competitor_only_queries",
      fingerprint: sha(`competitor_only_queries|${c.id}`),
      title: `${c.name} is mentioned and ${target.name} is not for ${qids.length} monitored ${qids.length === 1 ? "query" : "queries"}`,
      explanation: `For ${qids.length} queries with at least two comparable answers (same provider, surface and model), ${c.name} was mentioned and ${target.name} never was.`,
      action: `Review whether your public information clearly covers what these questions ask (capabilities, use cases, availability). Improve accurate documentation and original, useful content; do not create pages that only target the question wording.`,
      evidence: { observationIds: obs.slice(0, 50), queryIds: qids.slice(0, 50), brandIds: [target.id, c.id], hosts: [], urls: [], counts: { queries: qids.length, observations: obs.length } },
      limitations: [SAMPLE_LIMITATION, "Observed differences do not show why a model chose one brand; they are not proof of a ranking factor."],
      factors: [
        { name: "query_share", weight: 0.6, value: cap(qids.length / Math.max(1, queryCount)), explanation: `${qids.length} of ${queryCount} queries with answers.` },
        { name: "evidence_volume", weight: 0.4, value: cap(obs.length / 20), explanation: `${obs.length} supporting observations (20 or more counts as full).` },
      ],
      confidence: confidenceFor(obs.length),
    });
  }

  // 4. Active queries without enough answered observations for a conclusion.
  const thin = input.queries.filter((q) => q.status === "active").map((q) => ({ q, n: answered.filter((f) => f.queryId === q.id).length })).filter((x) => x.n < 3);
  if (thin.length) {
    push({
      kind: "insufficient_data",
      fingerprint: sha("insufficient_data"),
      title: `${thin.length} active ${thin.length === 1 ? "query has" : "queries have"} fewer than 3 answered observations`,
      explanation: `Conclusions about these queries are not reliable yet: ${thin.slice(0, 5).map((x) => `"${x.q.text.slice(0, 60)}" (${x.n})`).join(", ")}${thin.length > 5 ? ", …" : ""}.`,
      action: "Collect more observations for these queries (repeat runs with a configured provider, or import answers you observed) before acting on their results.",
      evidence: { observationIds: [], queryIds: thin.slice(0, 50).map((x) => x.q.id), brandIds: [target.id], hosts: [], urls: [], counts: { queries: thin.length } },
      limitations: ["This is a data-coverage notice, not a visibility finding."],
      factors: [{ name: "coverage_gap", weight: 1, value: cap(thin.length / Math.max(1, input.queries.filter((q) => q.status === "active").length)) * 0.5, explanation: "Half weight: coverage gaps are lower priority than evidence-backed findings." }],
      confidence: "high",
    });
  }

  // 5. A cited source that a user verified as unreachable.
  for (const s of input.sources) {
    if (s.verificationStatus !== "unreachable" || s.observationIds.length < 2) continue;
    const own = target.domains.some((d) => hostMatchesDomain(s.host, d));
    push({
      kind: "unreachable_cited_source",
      fingerprint: sha(`unreachable_cited_source|${s.id}`),
      title: `A cited page could not be reached: ${s.normalizedUrl.slice(0, 120)}`,
      explanation: `This URL is cited in ${s.observationIds.length} observations, and the last verification could not load it.`,
      action: own ? "Restore the page or redirect it to its current equivalent, then re-verify." : "Answers may be relying on an outdated source. Make sure accurate, current information is available on your own pages; if the publisher moved the page, consider asking them to fix the link.",
      evidence: { observationIds: s.observationIds.slice(0, 50), queryIds: [], brandIds: [target.id], hosts: [s.host], urls: [s.normalizedUrl], counts: { observations: s.observationIds.length } },
      limitations: ["Reachability was checked once when you verified it; the page may be temporarily unavailable.", CITATION_LIMITATION],
      factors: [
        { name: "citations", weight: 0.5, value: cap(s.observationIds.length / 10), explanation: `${s.observationIds.length} citing observations (10 or more counts as full).` },
        { name: "own_page", weight: 0.5, value: own ? 1 : 0.3, explanation: own ? "The page is on your official domain." : "The page is on another site." },
      ],
      confidence: confidenceFor(s.observationIds.length),
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

// ─── AI-assisted analysis ────────────────────────────────────────────────────

export const SOURCE_CATEGORIES = ["official_site", "competitor_site", "review_site", "news_media", "forum_community", "reference_wiki", "directory_marketplace", "blog", "documentation", "social", "other"] as const;

export const AiSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1_200),
  patterns: z.array(z.object({ statement: z.string().trim().min(1).max(400), observationIds: z.array(z.string()).min(1).max(10) }).strict()).max(8),
  sourceCategories: z.array(z.object({ host: z.string().trim().min(1).max(253), category: z.enum(SOURCE_CATEGORIES) }).strict()).max(20),
  caveats: z.array(z.string().trim().min(1).max(300)).max(6),
}).strict();
export type AiSummary = z.infer<typeof AiSummarySchema>;

/**
 * Validates model output against the schema and the evidence it was given:
 * patterns must cite only observation ids that were provided, categories
 * only hosts that were provided. Anything else is dropped, never trusted.
 */
export function validateAiSummary(raw: unknown, allowedObservationIds: Set<string>, allowedHosts: Set<string>): { summary: AiSummary; dropped: number } | null {
  const parsed = AiSummarySchema.safeParse(raw);
  if (!parsed.success) return null;
  let dropped = 0;
  const patterns = parsed.data.patterns
    .map((p) => ({ ...p, observationIds: p.observationIds.filter((id) => allowedObservationIds.has(id)) }))
    .filter((p) => (p.observationIds.length ? true : (dropped++, false)));
  const sourceCategories = parsed.data.sourceCategories.filter((s) => (allowedHosts.has(s.host.toLowerCase()) ? true : (dropped++, false)));
  return { summary: { ...parsed.data, patterns, sourceCategories }, dropped };
}
