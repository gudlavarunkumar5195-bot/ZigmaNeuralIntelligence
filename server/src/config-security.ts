/**
 * Strict environment boolean parser. Unlike z.coerce.boolean() (which uses
 * Boolean(value) and therefore turns the string "false" into true), only
 * explicit true/false spellings are accepted. Unset or empty yields undefined
 * so schema defaults apply; anything else throws.
 */
export function parseEnvBoolean(value: unknown, name = "value"): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new Error(`${name} must be "true" or "false"`);
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "false" || normalized === "0";
}

export function validateProductionSecurityConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") return;

  // Fail closed: any value other than unset/false (e.g. "true", "TRUE", "1", "yes", typos) is rejected.
  if (!isExplicitlyDisabled(env.QA_VERIFICATION_BYPASS_ENABLED) || !isExplicitlyDisabled(env.QA_ALLOW_PRODUCTION_BYPASS)) {
    throw new Error("Production cannot enable QA verification bypass");
  }

  if (env.DB_SSL_REJECT_UNAUTHORIZED !== "true") {
    throw new Error("Production requires DB_SSL_REJECT_UNAUTHORIZED=true");
  }

  for (const name of ["JWT_SECRET", "COOKIE_SECRET"] as const) {
    const value = env[name] ?? "";
    if (/replace_with|changeme|change_me|example|password|secret_here/i.test(value)) {
      throw new Error(`Production ${name} looks like a placeholder value`);
    }
    if (new Set(value).size < 8) throw new Error(`Production ${name} has too little entropy`);
  }
  if (env.JWT_SECRET === env.COOKIE_SECRET) {
    throw new Error("Production JWT_SECRET and COOKIE_SECRET must differ");
  }
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN.trim() === "" || /localhost|127\.0\.0\.1/.test(env.CORS_ORIGIN)) {
    throw new Error("Production requires an explicit non-localhost CORS_ORIGIN");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strictly parses PLATFORM_ADMIN_USER_IDS (comma-separated user UUIDs).
 * Unset or empty yields an empty list (no platform admins: fail closed).
 * Entries are trimmed, lower-cased and de-duplicated; any entry that is not a
 * UUID (including an empty segment such as a trailing comma) throws, so a typo
 * fails startup instead of silently granting or dropping access.
 */
export function parsePlatformAdminUserIds(value: unknown, name = "PLATFORM_ADMIN_USER_IDS"): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") throw new Error(`${name} must be a comma-separated list of user UUIDs`);
  if (value.trim() === "") return [];
  const ids = new Set<string>();
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`${name} contains an entry that is not a valid user UUID (emails are not accepted)`);
    }
    ids.add(id.toLowerCase());
  }
  return [...ids];
}
