import { createHash } from "node:crypto";
import type { CheerioAPI } from "cheerio";

/**
 * Content features of one crawled HTML page, computed from the document the
 * crawler already fetched (robots.txt, SSRF protection and limits apply
 * upstream). Everything is bounded: at most 100 headings, 50 terms and a
 * 20,000-character excerpt are kept. The page text is data only.
 */

export interface ContentFeatures {
  h1s: string[];
  headings: Array<{ level: number; text: string }>;
  wordCount: number;
  language: string | null;
  internalLinks: number;
  externalLinks: number;
  structuredData: { types: string[]; blocks: number; invalidBlocks: number };
  modifiedAt: string | null;
  modifiedSource: string | null;
  contentHash: string | null;
  simhash: string | null;
  topTerms: Array<{ term: string; count: number }>;
  textExcerpt: string;
}

const MAX_HEADINGS = 100;
const MAX_HEADING_CHARS = 300;
const MAX_EXCERPT = 20_000;
const MAX_TEXT_FOR_ANALYSIS = 200_000;

export const STOPWORDS = new Set(
  ("a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing " +
    "down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my " +
    "myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them " +
    "themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you " +
    "your yours yourself yourselves also get got one two may might must would shall us via vs etc new use used using like").split(" "),
);

/** Lowercase word tokens (letters/digits, Unicode-aware). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

/** Content words: no stopwords, at least 3 characters, a light plural fold ("shoes" → "shoe"). */
export function contentTerms(text: string): string[] {
  return tokenize(text)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map((t) => (t.length > 4 && t.endsWith("ies") ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** 64-bit SimHash over word 3-shingles (hex); null for very short texts. */
export function simhash(words: string[]): string | null {
  if (words.length < 8) return null;
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 3 <= words.length; i++) {
    const h = createHash("sha256").update(words.slice(i, i + 3).join(" ")).digest();
    for (let bit = 0; bit < 64; bit++) v[bit] += (h[bit >> 3] >> (bit & 7)) & 1 ? 1 : -1;
  }
  let hex = "";
  for (let nib = 0; nib < 16; nib++) {
    let n = 0;
    for (let b = 0; b < 4; b++) if (v[nib * 4 + b] > 0) n |= 1 << b;
    hex += n.toString(16);
  }
  return hex;
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const BLOCK_ELEMENTS = "p, div, section, article, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, td, th, tr, table, blockquote, pre, figure, figcaption, hr, main";

function readDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > Date.now() + 86_400_000 || t < Date.parse("1995-01-01")) return null;
  return new Date(t).toISOString();
}

export function extractContentFeatures($: CheerioAPI, pageUrl: string, isInternal: (href: string) => boolean): ContentFeatures {
  // Structured data first (before scripts are removed): JSON-LD types and declared modification dates.
  const types = new Set<string>();
  let blocks = 0;
  let invalidBlocks = 0;
  let modifiedAt: string | null = null;
  let modifiedSource: string | null = null;
  for (const el of $('script[type="application/ld+json" i]').toArray().slice(0, 20)) {
    blocks++;
    try {
      const data = JSON.parse(($(el).text() || "").slice(0, 100_000));
      const nodes: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { "@graph"?: unknown[] })?.["@graph"]) ? (data as { "@graph": unknown[] })["@graph"] : [data];
      for (const n of nodes.slice(0, 50)) {
        if (!n || typeof n !== "object") continue;
        const t = (n as Record<string, unknown>)["@type"];
        for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x.length <= 60) types.add(x);
        const d = readDate((n as Record<string, unknown>).dateModified);
        if (d && (!modifiedAt || d > modifiedAt)) { modifiedAt = d; modifiedSource = "json-ld dateModified"; }
      }
    } catch {
      invalidBlocks++;
    }
  }
  if (!modifiedAt) {
    const meta = readDate($('meta[property="article:modified_time" i], meta[property="og:updated_time" i]').first().attr("content"));
    if (meta) { modifiedAt = meta; modifiedSource = "meta modified_time"; }
  }

  const headings = $("h1, h2, h3, h4, h5, h6").toArray().slice(0, MAX_HEADINGS)
    .map((el) => ({ level: Number(el.tagName.slice(1)), text: clean($(el).text()).slice(0, MAX_HEADING_CHARS) }))
    .filter((h) => h.text);
  const h1s = headings.filter((h) => h.level === 1).map((h) => h.text).slice(0, 5);

  let internalLinks = 0;
  let externalLinks = 0;
  for (const el of $("a[href]").toArray().slice(0, 5_000)) {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (isInternal(abs)) internalLinks++;
    else externalLinks++;
  }

  // Main content: <main>/<article> when present, otherwise the body without boilerplate.
  const root = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body").first();
  const copy = root.clone();
  copy.find("script, style, noscript, template, svg, nav, header, footer, aside, form, iframe").remove();
  // .text() concatenates adjacent block elements ("<h1>A</h1><p>B" → "AB"); separate them first.
  copy.find(BLOCK_ELEMENTS).after(" ");
  copy.find("br").replaceWith(" ");
  const text = clean(copy.text()).slice(0, MAX_TEXT_FOR_ANALYSIS);
  const words = tokenize(text);
  const terms = contentTerms(text);
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  const topTerms = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([term, count]) => ({ term, count }));
  const lang = ($("html").attr("lang") ?? "").trim().toLowerCase().slice(0, 20) || null;

  return {
    h1s,
    headings,
    wordCount: words.length,
    language: lang,
    internalLinks,
    externalLinks,
    structuredData: { types: [...types].sort(), blocks, invalidBlocks },
    modifiedAt,
    modifiedSource,
    contentHash: words.length ? createHash("sha256").update(words.join(" ")).digest("hex") : null,
    simhash: simhash(words),
    topTerms,
    textExcerpt: text.slice(0, MAX_EXCERPT),
  };
}
