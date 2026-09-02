import * as cheerio from "cheerio";
import type { ModuleResult, NewFinding } from "../types.js";
import { safeFetch } from "./fetch.js";

const MODULE = "seo";

export async function runSEOScanner(url: string): Promise<ModuleResult> {
  const start = Date.now();
  const findings: NewFinding[] = [];

  const result = await safeFetch(url);

  if (!result.ok && result.status === 0) {
    return { moduleName: MODULE, status: "failed", durationMs: Date.now() - start, findings: [], error: result.error };
  }

  if (result.status >= 400) {
    findings.push({
      category: "seo",
      severity: result.status === 404 ? "critical" : "high",
      title: `Homepage returned HTTP ${result.status}`,
      description: `The page returned an HTTP error status, preventing indexing.`,
      recommendation: "Ensure the homepage is accessible and returns HTTP 200.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "http_status", url: result.finalUrl, observedValue: String(result.status), expectedValue: "200", tool: "seo_scanner" }],
    });
    return { moduleName: MODULE, status: "completed", durationMs: Date.now() - start, findings };
  }

  const $ = cheerio.load(result.body);
  const pageUrl = result.finalUrl;

  // ─── Title ────────────────────────────────────────────────────────────────
  const title = $("title").first().text().trim();
  if (!title) {
    findings.push({
      category: "seo", severity: "critical", title: "Missing <title> tag",
      description: "The page has no title tag. Title is a primary ranking signal.",
      recommendation: "Add a descriptive <title> tag between 50–60 characters.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: "missing", rule: "TITLE_TAG", tool: "seo_scanner" }],
    });
  } else if (title.length < 20) {
    findings.push({
      category: "seo", severity: "medium", title: "Title tag is too short",
      description: `Title "${title}" is ${title.length} chars. Recommended: 50–60 chars.`,
      recommendation: "Expand the title to be more descriptive.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: title, rule: "TITLE_LENGTH", tool: "seo_scanner" }],
    });
  } else if (title.length > 60) {
    findings.push({
      category: "seo", severity: "low", title: "Title tag may be truncated in SERPs",
      description: `Title "${title.slice(0, 60)}…" is ${title.length} chars. Google typically shows up to 60.`,
      recommendation: "Shorten the title to under 60 characters.",
      affectedUrls: [pageUrl], confidence: 80, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: String(title.length), rule: "TITLE_LENGTH", tool: "seo_scanner" }],
    });
  }

  // ─── Meta description ──────────────────────────────────────────────────────
  const metaDesc = $("meta[name='description']").attr("content")?.trim() ?? "";
  if (!metaDesc) {
    findings.push({
      category: "seo", severity: "high", title: "Missing meta description",
      description: "No meta description found. Search engines may generate a less relevant snippet.",
      recommendation: "Add a meta description between 150–160 characters.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: "missing", rule: "META_DESCRIPTION", tool: "seo_scanner" }],
    });
  }

  // ─── H1 ────────────────────────────────────────────────────────────────────
  const h1Count = $("h1").length;
  if (h1Count === 0) {
    findings.push({
      category: "seo", severity: "high", title: "Missing H1 heading",
      description: "No H1 tag found. H1 signals the primary topic of the page.",
      recommendation: "Add exactly one H1 tag that describes the page content.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: "0", rule: "H1_MISSING", tool: "seo_scanner" }],
    });
  } else if (h1Count > 1) {
    findings.push({
      category: "seo", severity: "low", title: "Multiple H1 headings found",
      description: `Found ${h1Count} H1 tags. Best practice is exactly one H1 per page.`,
      recommendation: "Reduce to a single H1 tag that represents the main topic.",
      affectedUrls: [pageUrl], confidence: 90, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: String(h1Count), rule: "H1_MULTIPLE", tool: "seo_scanner" }],
    });
  }

  // ─── Canonical ────────────────────────────────────────────────────────────
  const canonical = $("link[rel='canonical']").attr("href")?.trim();
  if (!canonical) {
    findings.push({
      category: "seo", severity: "medium", title: "Missing canonical link tag",
      description: "No canonical URL specified. Duplicate content may dilute rankings.",
      recommendation: "Add <link rel='canonical' href='...'> to specify the preferred URL.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: "missing", rule: "CANONICAL", tool: "seo_scanner" }],
    });
  }

  // ─── Robots meta ──────────────────────────────────────────────────────────
  const robotsMeta = $("meta[name='robots']").attr("content")?.toLowerCase() ?? "";
  if (robotsMeta.includes("noindex")) {
    findings.push({
      category: "seo", severity: "critical", title: "Page is set to noindex",
      description: `The robots meta tag contains 'noindex': "${robotsMeta}". This page will not appear in search results.`,
      recommendation: "Remove the noindex directive if this page should be indexed.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: robotsMeta, rule: "NOINDEX", tool: "seo_scanner" }],
    });
  }

  // ─── Open Graph ────────────────────────────────────────────────────────────
  const ogTitle = $("meta[property='og:title']").attr("content");
  const ogDesc = $("meta[property='og:description']").attr("content");
  const ogImage = $("meta[property='og:image']").attr("content");

  if (!ogTitle || !ogDesc || !ogImage) {
    const missing = [
      !ogTitle ? "og:title" : null,
      !ogDesc ? "og:description" : null,
      !ogImage ? "og:image" : null,
    ].filter(Boolean).join(", ");
    findings.push({
      category: "seo", severity: "low", title: "Incomplete Open Graph tags",
      description: `Missing Open Graph properties: ${missing}. Social sharing may show poor previews.`,
      recommendation: "Add all required Open Graph tags: og:title, og:description, og:image.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: `missing: ${missing}`, rule: "OPEN_GRAPH", tool: "seo_scanner" }],
    });
  }

  // ─── Structured data ──────────────────────────────────────────────────────
  const jsonLdScripts = $("script[type='application/ld+json']").toArray();
  if (jsonLdScripts.length === 0) {
    findings.push({
      category: "seo", severity: "info", title: "No structured data (JSON-LD) found",
      description: "Structured data helps search engines understand page content and enables rich results.",
      recommendation: "Add JSON-LD structured data appropriate to your content (Organization, WebSite, Article, etc.).",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: "none", rule: "STRUCTURED_DATA", tool: "seo_scanner" }],
    });
  }

  // ─── Images without alt ──────────────────────────────────────────────────
  const imagesWithoutAlt = $("img:not([alt])").length;
  if (imagesWithoutAlt > 0) {
    findings.push({
      category: "seo", severity: "low", title: `${imagesWithoutAlt} image${imagesWithoutAlt > 1 ? "s" : ""} missing alt attribute`,
      description: "Images without alt text miss an opportunity to add descriptive keywords and harm accessibility.",
      recommendation: "Add descriptive alt attributes to all images.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: String(imagesWithoutAlt), rule: "IMG_ALT", tool: "seo_scanner" }],
    });
  }

  return { moduleName: MODULE, status: "completed", durationMs: Date.now() - start, findings };
}
