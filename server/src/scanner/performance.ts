import * as cheerio from "cheerio";
import type { ModuleResult, NewFinding } from "../types.js";
import { safeFetch } from "./fetch.js";

const MODULE = "performance";

export async function runPerformanceScanner(url: string): Promise<ModuleResult> {
  const start = Date.now();
  const findings: NewFinding[] = [];

  const result = await safeFetch(url);

  if (!result.ok && result.status === 0) {
    return { moduleName: MODULE, status: "failed", durationMs: Date.now() - start, findings: [], error: result.error };
  }

  const h = result.headers;
  const pageUrl = result.finalUrl;

  // ─── TTFB ─────────────────────────────────────────────────────────────────
  // The time until first byte is approximated by the total connection duration
  // since safeFetch does not expose network timing. Real TTFB requires a
  // browser agent or puppeteer. Mark separately.
  const ttfbApprox = result.durationMs;

  // ─── Compression ──────────────────────────────────────────────────────────
  const encoding = h["content-encoding"] ?? "";
  if (!encoding.includes("gzip") && !encoding.includes("br") && !encoding.includes("zstd")) {
    const bodyBytes = new TextEncoder().encode(result.body).byteLength;
    if (bodyBytes > 10_000) {
      findings.push({
        category: "performance", severity: "medium", title: "HTTP response is not compressed",
        description: `The response (${Math.round(bodyBytes / 1024)} KB) is served without gzip/brotli compression.`,
        recommendation: "Enable gzip or brotli compression on the server.",
        affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
        evidence: [{ type: "response_header", url: pageUrl, observedValue: encoding || "none", rule: "COMPRESSION", tool: "performance_scanner" }],
      });
    }
  }

  // ─── Caching ──────────────────────────────────────────────────────────────
  const cacheControl = h["cache-control"] ?? "";
  const etag = h["etag"];
  const lastModified = h["last-modified"];
  if (!cacheControl && !etag && !lastModified) {
    findings.push({
      category: "performance", severity: "medium", title: "No caching headers on homepage",
      description: "The homepage has no Cache-Control, ETag, or Last-Modified headers. Browsers cannot cache the response.",
      recommendation: "Add appropriate Cache-Control headers or ETag/Last-Modified for browser caching.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "response_header", url: pageUrl, observedValue: "none", rule: "CACHING", tool: "performance_scanner" }],
    });
  }

  // ─── Render-blocking resources ────────────────────────────────────────────
  const $ = cheerio.load(result.body);
  const blockingScripts = $("head script:not([async]):not([defer]):not([type='module'])").length;
  if (blockingScripts > 0) {
    findings.push({
      category: "performance", severity: "medium", title: `${blockingScripts} render-blocking script${blockingScripts > 1 ? "s" : ""} in <head>`,
      description: "Synchronous scripts in <head> block HTML parsing and delay the first paint.",
      recommendation: "Add defer or async to scripts in <head>, or move them before </body>.",
      affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: String(blockingScripts), rule: "RENDER_BLOCKING_SCRIPTS", tool: "performance_scanner" }],
    });
  }

  // ─── Large inline scripts ─────────────────────────────────────────────────
  let inlineScriptBytes = 0;
  $("script:not([src])").each((_, el) => {
    inlineScriptBytes += ($(el).html() ?? "").length;
  });
  if (inlineScriptBytes > 50_000) {
    findings.push({
      category: "performance", severity: "low", title: "Large inline JavaScript",
      description: `${Math.round(inlineScriptBytes / 1024)} KB of JavaScript is inlined in the HTML. This inflates the initial document size.`,
      recommendation: "Move large scripts to external files that can be cached independently.",
      affectedUrls: [pageUrl], confidence: 90, provenance: "MEASURED",
      evidence: [{ type: "html_element", url: pageUrl, observedValue: `${Math.round(inlineScriptBytes / 1024)}KB`, rule: "INLINE_SCRIPT_SIZE", tool: "performance_scanner" }],
    });
  }

  // ─── NOT_MEASURED: Core Web Vitals ────────────────────────────────────────
  // LCP, CLS, INP require real browser execution (Lighthouse/Chrome DevTools Protocol).
  // These are intentionally NOT_MEASURED — do not fabricate values.
  findings.push({
    category: "performance", severity: "info", title: "Core Web Vitals require browser-based measurement",
    description: "LCP, CLS, and INP cannot be measured without executing JavaScript in a real browser context. A Lighthouse integration is required.",
    recommendation: "Connect a Lighthouse/PageSpeed Insights integration for Core Web Vitals data.",
    affectedUrls: [pageUrl], confidence: 100, provenance: "MEASURED",
    evidence: [{ type: "measurement_gap", url: pageUrl, observedValue: "NOT_MEASURED", rule: "CORE_WEB_VITALS", tool: "performance_scanner" }],
  });

  return { moduleName: MODULE, status: "completed", durationMs: Date.now() - start, findings };
}
