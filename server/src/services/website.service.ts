import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import * as cheerio from "cheerio";
import { query, withTransaction } from "../db/client.js";
import { checkUrlSafety } from "../scanner/ssrf.js";
import { safeFetch } from "../scanner/fetch.js";
import { config } from "../config.js";
import type { WebsiteRow } from "../types.js";

// ─── Add Website ──────────────────────────────────────────────────────────────

export interface AddWebsiteInput {
  orgId: string;
  userId: string;
  url: string;
  verificationMethod?: "html" | "dns" | "file" | "qa_bypass";
}

export const QA_CANONICAL_DOMAIN = "www.zigmaneural.com";

export function canonicalizeQaDomain(value: string): string | null {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return hostname === "zigmaneural.com" ? QA_CANONICAL_DOMAIN : null;
  } catch {
    return null;
  }
}

export function isQaBypassAuthorized(email: string, role?: string): boolean {
  if (!config.QA_VERIFICATION_BYPASS_ENABLED) return false;
  if (config.NODE_ENV === "production" && !config.QA_ALLOW_PRODUCTION_BYPASS) return false;
  if (role !== "owner" && role !== "admin") return false;
  const authorizedEmails = config.QA_AUTHORIZED_EMAILS.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return authorizedEmails.includes(email.trim().toLowerCase());
}

export async function addWebsite(input: AddWebsiteInput): Promise<WebsiteRow> {
  // Server-side SSRF check (mirrors client validation + DNS resolution)
  const isQaBypass = input.verificationMethod === "qa_bypass";
  if (isQaBypass && canonicalizeQaDomain(input.url) !== QA_CANONICAL_DOMAIN) {
    throw Object.assign(new Error("QA verification is restricted to the approved test domain"), { statusCode: 422, code: "QA_DOMAIN_NOT_ALLOWED" });
  }

  const safety = await checkUrlSafety(input.url);
  if (!safety.safe) {
    throw Object.assign(
      new Error(`URL is not permitted: ${safety.reason}`),
      { statusCode: 422, code: "URL_BLOCKED" }
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { statusCode: 422, code: "INVALID_URL" });
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  const domain = parsed.hostname.toLowerCase();
  const verificationToken = randomBytes(16).toString("hex");

  return withTransaction(async (client) => {
    const existing = await client.query(
      "SELECT id FROM websites WHERE org_id = $1 AND url = $2",
      [input.orgId, normalizedUrl]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(
        new Error("This website has already been added to your organization"),
        { statusCode: 409, code: "WEBSITE_EXISTS" }
      );
    }

    const result = await client.query<WebsiteRow>(
      `INSERT INTO websites
         (org_id, url, domain, verification_method, verification_token, verification_environment, verified, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.orgId, normalizedUrl, domain, input.verificationMethod ?? "html", verificationToken, isQaBypass ? "qa" : null, isQaBypass, input.userId]
    );
    return result.rows[0];
  });
}

// ─── List Websites ────────────────────────────────────────────────────────────

export async function listWebsites(orgId: string, pageSize = 25, offset = 0): Promise<WebsiteRow[]> {
  const { rows } = await query<WebsiteRow>(
    "SELECT * FROM websites WHERE org_id = $1 AND active = TRUE ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3",
    [orgId, pageSize, offset]
  );
  return rows;
}

export async function getWebsite(id: string, orgId: string): Promise<WebsiteRow | null> {
  const { rows } = await query<WebsiteRow>(
    "SELECT * FROM websites WHERE id = $1 AND org_id = $2",
    [id, orgId]
  );
  return rows[0] ?? null;
}

export async function qaVerifyWebsite(websiteId: string, orgId: string): Promise<WebsiteRow | null> {
  const { rows } = await query<WebsiteRow>(
    `UPDATE websites
       SET verified = TRUE,
           verification_method = 'qa_bypass',
           verification_environment = 'qa',
           updated_at = NOW()
     WHERE id = $1 AND org_id = $2 AND domain IN ('zigmaneural.com', 'www.zigmaneural.com')
     RETURNING *`,
    [websiteId, orgId],
  );
  return rows[0] ?? null;
}

// ─── Ownership Verification ────────────────────────────────────────────────────

export async function verifyOwnership(websiteId: string, orgId: string): Promise<boolean> {
  const website = await getWebsite(websiteId, orgId);
  if (!website) {
    throw Object.assign(new Error("Website not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  if (website.verified) return true;

  const token = website.verification_token;
  if (!token) {
    throw Object.assign(new Error("Verification token is missing"), { statusCode: 422, code: "VERIFICATION_UNAVAILABLE" });
  }

  let verified = false;
  if (website.verification_method === "dns") {
    try {
      const records = await dns.resolveTxt(`_zignaneural-verify.${website.domain}`);
      verified = records.some((record) => record.join("").trim() === token);
    } catch {
      verified = false;
    }
  } else {
    // Both HTTP methods prove control of the ORIGIN (the crawl scope), so the
    // token is read from the origin root, never from a deeper path that a
    // shared host might let another tenant control.
    const origin = new URL(website.url).origin;
    const target = website.verification_method === "file"
      ? `${origin}/zignaneural-verify.txt`
      : `${origin}/`;
    const response = await safeFetch(target);
    // safeFetch follows redirects (each hop is SSRF-checked). The token only
    // counts if the document that carries it was served by the claimed host:
    // otherwise an open redirect on the victim's site would let an attacker
    // "verify" it with a token hosted elsewhere.
    if (response.ok && isClaimedHost(website.domain, response.finalUrl)) {
      if (website.verification_method === "file") {
        verified = response.body.trim() === token;
      } else {
        const document = cheerio.load(response.body);
        verified = document('meta[name="zignaneural-site-verification"]').toArray()
          .some((element) => document(element).attr("content")?.trim() === token);
      }
    }
  }

  if (!verified) {
    throw Object.assign(new Error("Ownership verification token was not found"), { statusCode: 422, code: "VERIFICATION_FAILED" });
  }

  await markVerified(websiteId, orgId);
  return true;
}

/**
 * True when `finalUrl` is served by the claimed domain itself or its www/apex
 * twin (example.com <-> www.example.com). Any other host, including other
 * subdomains, fails closed.
 */
export function isClaimedHost(claimedDomain: string, finalUrl: string): boolean {
  let host: string;
  try {
    host = new URL(finalUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  const claimed = claimedDomain.toLowerCase().replace(/\.$/, "");
  const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
  return host === claimed || bare(host) === bare(claimed);
}

export async function markVerified(websiteId: string, orgId: string): Promise<void> {
  await query(
    "UPDATE websites SET verified = TRUE, updated_at = NOW() WHERE id = $1 AND org_id = $2",
    [websiteId, orgId]
  );
}
