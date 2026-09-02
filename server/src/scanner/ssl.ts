import * as tls from "node:tls";
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
}

function inspectCertificate(hostname: string, port = 443): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate(true);
        socket.destroy();

        if (!cert || !cert.subject) {
          resolve(null);
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
          sans.some((san) => {
            if (san.startsWith("*.")) {
              return hostname.endsWith(san.slice(1));
            }
            return san === hostname;
          }) ||
          cert.subject?.CN === hostname;

        resolve({
          issuer: (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O) ?? (Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN) ?? "Unknown",
          subject: (Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN) ?? hostname,
          validFrom,
          validTo,
          daysRemaining,
          sans,
          hostnameMatch,
          expired,
        });
      }
    );

    socket.on("error", () => resolve(null));
    socket.setTimeout(10_000, () => { socket.destroy(); resolve(null); });
  });
}

export async function runSSLScanner(url: string): Promise<ModuleResult> {
  const start = Date.now();
  const findings: NewFinding[] = [];

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
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

  const cert = await inspectCertificate(hostname);

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
