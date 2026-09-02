import type { ModuleResult, NewFinding } from "../types.js";
import { safeFetch } from "./fetch.js";

const MODULE = "security";

export async function runSecurityScanner(url: string): Promise<ModuleResult> {
  const start = Date.now();
  const findings: NewFinding[] = [];

  const result = await safeFetch(url);

  if (!result.ok && result.status === 0) {
    return {
      moduleName: MODULE,
      status: "failed",
      durationMs: Date.now() - start,
      findings: [],
      error: result.error,
    };
  }

  const h = result.headers;

  // ─── HTTPS ──────────────────────────────────────────────────────────────────
  if (!url.startsWith("https://")) {
    findings.push({
      category: "security",
      severity: "critical",
      title: "Site does not use HTTPS",
      description: "The website is served over plain HTTP. All data is transmitted unencrypted.",
      recommendation: "Redirect all HTTP traffic to HTTPS and obtain a valid TLS certificate.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "protocol", url, observedValue: "http", expectedValue: "https", tool: "security_scanner" }],
    });
  }

  // ─── HSTS ────────────────────────────────────────────────────────────────────
  const hsts = h["strict-transport-security"];
  if (!hsts) {
    findings.push({
      category: "security",
      severity: "high",
      title: "Missing Strict-Transport-Security header",
      description: "HSTS instructs browsers to always use HTTPS. Without it, downgrade attacks are possible.",
      recommendation: "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "HSTS", tool: "security_scanner" }],
    });
  } else {
    const maxAge = parseInt(hsts.match(/max-age=(\d+)/)?.[1] ?? "0", 10);
    if (maxAge < 31536000) {
      findings.push({
        category: "security",
        severity: "medium",
        title: "HSTS max-age is too short",
        description: `HSTS max-age is ${maxAge}s. Recommended minimum is 31536000 (1 year).`,
        recommendation: "Set max-age to at least 31536000.",
        affectedUrls: [result.finalUrl],
        confidence: 100,
        provenance: "MEASURED",
        evidence: [{ type: "response_header", url: result.finalUrl, observedValue: hsts, rule: "HSTS_MAX_AGE", tool: "security_scanner" }],
      });
    }
  }

  // ─── CSP ─────────────────────────────────────────────────────────────────────
  if (!h["content-security-policy"]) {
    findings.push({
      category: "security",
      severity: "high",
      title: "Missing Content-Security-Policy header",
      description: "Without CSP, the site is vulnerable to XSS attacks injecting arbitrary scripts.",
      recommendation: "Implement a restrictive Content-Security-Policy header.",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "CSP", tool: "security_scanner" }],
    });
  }

  // ─── X-Frame-Options ─────────────────────────────────────────────────────────
  if (!h["x-frame-options"] && !h["content-security-policy"]?.includes("frame-ancestors")) {
    findings.push({
      category: "security",
      severity: "medium",
      title: "Missing clickjacking protection",
      description: "No X-Frame-Options or CSP frame-ancestors directive. The page may be embedded in iframes.",
      recommendation: "Add X-Frame-Options: DENY or a CSP frame-ancestors directive.",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "CLICKJACKING", tool: "security_scanner" }],
    });
  }

  // ─── X-Content-Type-Options ──────────────────────────────────────────────────
  if (!h["x-content-type-options"]) {
    findings.push({
      category: "security",
      severity: "low",
      title: "Missing X-Content-Type-Options header",
      description: "Browsers may MIME-sniff content, potentially interpreting text/plain as JavaScript.",
      recommendation: "Add X-Content-Type-Options: nosniff",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "CONTENT_TYPE_OPTIONS", tool: "security_scanner" }],
    });
  }

  // ─── Referrer-Policy ─────────────────────────────────────────────────────────
  if (!h["referrer-policy"]) {
    findings.push({
      category: "security",
      severity: "low",
      title: "Missing Referrer-Policy header",
      description: "Without a Referrer-Policy, full URLs including sensitive parameters may leak to external sites.",
      recommendation: "Add Referrer-Policy: strict-origin-when-cross-origin",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "REFERRER_POLICY", tool: "security_scanner" }],
    });
  }

  // ─── Permissions-Policy ──────────────────────────────────────────────────────
  if (!h["permissions-policy"]) {
    findings.push({
      category: "security",
      severity: "info",
      title: "Missing Permissions-Policy header",
      description: "Permissions-Policy controls browser features (camera, microphone, geolocation).",
      recommendation: "Add a Permissions-Policy header restricting unused browser features.",
      affectedUrls: [result.finalUrl],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: "missing", rule: "PERMISSIONS_POLICY", tool: "security_scanner" }],
    });
  }

  // ─── Server header disclosure ─────────────────────────────────────────────
  const serverHeader = h["server"] ?? h["x-powered-by"];
  if (serverHeader && /[0-9]/.test(serverHeader)) {
    findings.push({
      category: "security",
      severity: "low",
      title: "Server version disclosed in response header",
      description: `The response reveals server version information: '${serverHeader}'. This aids attackers in targeting known vulnerabilities.`,
      recommendation: "Remove or genericize the Server/X-Powered-By header.",
      affectedUrls: [result.finalUrl],
      confidence: 90,
      provenance: "MEASURED",
      evidence: [{ type: "response_header", url: result.finalUrl, observedValue: serverHeader, rule: "SERVER_DISCLOSURE", tool: "security_scanner" }],
    });
  }

  return {
    moduleName: MODULE,
    status: "completed",
    durationMs: Date.now() - start,
    findings,
  };
}
