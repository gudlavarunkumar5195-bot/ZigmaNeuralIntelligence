import * as tls from "node:tls";
import { checkUrlSafety, isIpLiteral, type DnsResolver } from "./ssrf.js";
import type { ModuleResult, NewFinding } from "../types.js";

const MODULE = "ssl";

interface CertInfo {
  issuer: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
  daysRemaining: number;
  sans: string[];
  hostnameMatch: boolean;
  expired: boolean;
  /** undefined when the connection layer did not report chain verification. */
  trustError?: string;
}

export type TlsConnectFn = (
  options: tls.ConnectionOptions,
  listener?: () => void,
) => tls.TLSSocket;

export interface SSLScannerDeps {
  resolver?: DnsResolver;
  connect?: TlsConnectFn;
  /** Hard overall budget covering DNS + connect + handshake. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

type InspectOutcome =
  | { kind: "ok"; cert: CertInfo }
  | { kind: "no_cert" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

function inspectCertificate(
  hostname: string,
  ip: string,
  port: number,
  connect: TlsConnectFn,
  timeoutMs: number,
): Promise<InspectOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;
    const finish = (outcome: InspectOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, timeoutMs));

    try {
      // Connect to the already-validated IP (no second DNS resolution); SNI stays the hostname.
      socket = connect(
        {
          host: ip,
          port,
          ...(isIpLiteral(hostname) ? {} : { servername: hostname }),
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket!.getPeerCertificate(true);
          if (!cert || !cert.subject) {
            finish({ kind: "no_cert" });
            return;
          }

          const validFrom = new Date(cert.valid_from);
          const validTo = new Date(cert.valid_to);
          const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
          const expired = daysRemaining < 0;

          const sans: string[] = cert.subjectaltname
            ? cert.subjectaltname.split(", ").map((s: string) => s.replace(/^DNS:/, ""))
            : [];

          const hostnameMatch =
            sans.some((san) => sanMatchesHostname(san, hostname)) ||
            cert.subject?.CN === hostname;

          // Expiry and hostname problems are reported by their own findings; any
          // other verification failure means the chain is not publicly trusted.
          const authError = socket!.authorized === false
            ? String(socket!.authorizationError ?? "UNTRUSTED")
            : undefined;
          const dedicated = /EXPIRED|NOT_YET_VALID|ALTNAME|HOSTNAME/i.test(authError ?? "");
          finish({
            kind: "ok",
            cert: {
              ...(authError && !dedicated ? { trustError: authError } : {}),
              issuer: (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O) ?? (Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN) ?? "Unknown",
              subject: (Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN) ?? hostname,
              validFrom,
              validTo,
              daysRemaining,
              sans,
              hostnameMatch,
              expired,
            },
          });
        },
      );
      socket.on("error", (e) => finish({ kind: "error", message: e?.message ?? "tls error" }));
      if (settled) socket.destroy();
    } catch (e) {
      finish({ kind: "error", message: e instanceof Error ? e.message : "tls error" });
    }
  });
}

/** RFC 6125: a wildcard covers exactly one left-most label. */
export function sanMatchesHostname(san: string, hostname: string): boolean {
  const s = san.toLowerCase();
  const h = hostname.toLowerCase();
  if (s.startsWith("*.")) {
    const labels = h.split(".");
    return labels.length > 2 && labels.slice(1).join(".") === s.slice(2);
  }
  return s === h;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  const t = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), Math.max(1, ms)); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function runSSLScanner(url: string, deps: SSLScannerDeps = {}): Promise<ModuleResult> {
  const connect: TlsConnectFn = deps.connect ?? ((o, l) => tls.connect(o, l));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();
  const findings: NewFinding[] = [];

  let hostname: string;
  let port = 443;
  try {
    const u = new URL(url);
    hostname = u.hostname.replace(/^\[|\]$/g, "");
    if (u.port) port = Number(u.port);
  } catch {
    return { moduleName: MODULE, status: "failed", durationMs: 0, findings: [], error: "Invalid URL" };
  }

  if (!url.startsWith("https://")) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: "Site is not served over HTTPS",
      description: "No TLS/SSL is in use. Certificate data is unavailable.",
      recommendation: "Deploy a TLS certificate and redirect all HTTP to HTTPS.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "protocol", url, observedValue: "http", rule: "HTTPS_REQUIRED", tool: "ssl_scanner" }],
    });
    return { moduleName: MODULE, status: "completed", durationMs: Date.now() - start, findings };
  }

  // SSRF check + single DNS resolution; all resolved addresses must be safe.
  const safety = await withTimeout(checkUrlSafety(url, deps.resolver), deadline - Date.now());
  if (safety === "timeout") {
    return { moduleName: MODULE, status: "failed", durationMs: Date.now() - start, findings: [], error: "TLS inspection timed out during DNS resolution" };
  }
  if (!safety.safe || !safety.resolvedIPs?.length) {
    return { moduleName: MODULE, status: "failed", durationMs: Date.now() - start, findings: [], error: `Target blocked by SSRF protection: ${safety.reason ?? "no addresses"}` };
  }

  let cert: CertInfo | null = null;
  let transientFailure: string | null = null;
  for (const ip of safety.resolvedIPs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { transientFailure = "timeout"; break; }
    const outcome = await inspectCertificate(hostname, ip, port, connect, remaining);
    if (outcome.kind === "ok") { cert = outcome.cert; transientFailure = null; break; }
    if (outcome.kind === "timeout") { transientFailure = "timeout"; break; }
  }
  if (!cert && transientFailure) {
    return { moduleName: MODULE, status: "failed", durationMs: Date.now() - start, findings: [], error: "TLS inspection timed out" };
  }

  if (!cert) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: "TLS certificate could not be retrieved",
      description: "The TLS connection failed or the certificate could not be inspected.",
      recommendation: "Verify the TLS configuration and ensure the server is accessible.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "tls_connection", url, observedValue: "connection_failed", tool: "ssl_scanner" }],
    });
    return { moduleName: MODULE, status: "completed", durationMs: Date.now() - start, findings };
  }

  if (cert.expired) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: "TLS certificate has expired",
      description: `Certificate expired on ${cert.validTo.toISOString().split("T")[0]}. Browsers will block access.`,
      recommendation: "Renew the certificate immediately.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "certificate_expiry", url, observedValue: cert.validTo.toISOString(), rule: "CERT_EXPIRED", tool: "ssl_scanner" }],
    });
  } else if (cert.daysRemaining < 14) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: `Certificate expires in ${cert.daysRemaining} day${cert.daysRemaining === 1 ? "" : "s"}`,
      description: `Certificate expires on ${cert.validTo.toISOString().split("T")[0]}. Immediate renewal required.`,
      recommendation: "Renew the certificate immediately. Enable auto-renewal (e.g. Let's Encrypt ACME).",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "certificate_expiry", url, observedValue: String(cert.daysRemaining), rule: "CERT_EXPIRING_CRITICAL", tool: "ssl_scanner" }],
    });
  } else if (cert.daysRemaining < 30) {
    findings.push({
      category: "ssl",
      severity: "high",
      title: `Certificate expires in ${cert.daysRemaining} days`,
      description: `Certificate expires on ${cert.validTo.toISOString().split("T")[0]}.`,
      recommendation: "Renew the certificate soon. Enable auto-renewal.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "certificate_expiry", url, observedValue: String(cert.daysRemaining), rule: "CERT_EXPIRING_HIGH", tool: "ssl_scanner" }],
    });
  }

  if (cert.trustError) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: "TLS certificate is not trusted",
      description: `The certificate chain failed verification (${cert.trustError}). Browsers will show a security warning.`,
      recommendation: "Serve a certificate chain issued by a publicly trusted CA, including intermediates.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "certificate_chain", url, observedValue: cert.trustError, rule: "CERT_TRUSTED", tool: "ssl_scanner" }],
    });
  }

  if (!cert.hostnameMatch) {
    findings.push({
      category: "ssl",
      severity: "critical",
      title: "Certificate hostname mismatch",
      description: `The certificate is not valid for '${hostname}'. SANs: ${cert.sans.join(", ") || "none"}.`,
      recommendation: "Obtain a certificate that includes the correct hostname.",
      affectedUrls: [url],
      confidence: 100,
      provenance: "MEASURED",
      evidence: [{ type: "certificate_san", url, observedValue: cert.sans.join(", "), expectedValue: hostname, rule: "HOSTNAME_MATCH", tool: "ssl_scanner" }],
    });
  }

  return {
    moduleName: MODULE,
    status: "completed",
    durationMs: Date.now() - start,
    findings,
  };
}
