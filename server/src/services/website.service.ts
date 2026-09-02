import { randomBytes } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { checkUrlSafety } from "../scanner/ssrf.js";
import type { WebsiteRow } from "../types.js";

// ─── Add Website ──────────────────────────────────────────────────────────────

export interface AddWebsiteInput {
  orgId: string;
  userId: string;
  url: string;
  verificationMethod?: "html" | "dns" | "file";
}

export async function addWebsite(input: AddWebsiteInput): Promise<WebsiteRow> {
  // Server-side SSRF check (mirrors client validation + DNS resolution)
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
         (org_id, url, domain, verification_method, verification_token, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.orgId, normalizedUrl, domain, input.verificationMethod ?? "html", verificationToken, input.userId]
    );
    return result.rows[0];
  });
}

// ─── List Websites ────────────────────────────────────────────────────────────

export async function listWebsites(orgId: string): Promise<WebsiteRow[]> {
  const { rows } = await query<WebsiteRow>(
    "SELECT * FROM websites WHERE org_id = $1 AND active = TRUE ORDER BY created_at DESC",
    [orgId]
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

// ─── Ownership Verification ────────────────────────────────────────────────────

export async function verifyOwnership(websiteId: string, orgId: string): Promise<boolean> {
  const website = await getWebsite(websiteId, orgId);
  if (!website) {
    throw Object.assign(new Error("Website not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  if (website.verified) return true;

  // In production: perform actual HTTP/DNS check against verification_token.
  // The implementation depends on the verification_method:
  //   html: GET ${website.url} and look for <meta name="zignaneural-site-verification" content="${token}">
  //   dns:  TXT lookup for _zignaneural-verify.${domain}
  //   file: GET ${website.url}/zignaneural-verify.txt
  //
  // This is intentionally left as TODO — the scaffold accepts the verification_method
  // but the actual HTTP check requires network access from the server.
  throw Object.assign(
    new Error("Ownership verification backend not yet implemented. Connect real HTTP verification logic."),
    { statusCode: 501, code: "NOT_IMPLEMENTED" }
  );
}

export async function markVerified(websiteId: string): Promise<void> {
  await query(
    "UPDATE websites SET verified = TRUE, updated_at = NOW() WHERE id = $1",
    [websiteId]
  );
}
