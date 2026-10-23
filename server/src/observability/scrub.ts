/**
 * Pure scrubbing helpers for everything that leaves the process for Sentry
 * (error events, transactions, breadcrumbs and Sentry Logs).
 *
 * No Sentry imports here on purpose: the functions operate on structural
 * types so they are trivially unit-testable and reusable.
 *
 * Policy:
 *  - Authorization / Cookie / Set-Cookie / API-key headers are removed.
 *  - Request bodies and cookies are removed entirely.
 *  - Query-string parameters whose name looks like a credential
 *    (token/key/secret/password/code/state/...) have their value redacted,
 *    in `request.query_string`, in URLs and in free text.
 *  - Any string value matching a known secret format (OpenRouter / OpenAI
 *    style keys, Bearer tokens, JWTs, URLs with embedded passwords, AWS
 *    access keys, ...) is masked wherever it appears.
 *  - Object keys that name a secret (password, apiKey, client_secret, ...)
 *    have their value replaced, regardless of the value's shape.
 *  - The Sentry `user` is reduced to an opaque id (no email/ip/username).
 */

export const REDACTED = "[REDACTED]";

/** Headers that are always dropped (compared lower-case). */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
]);

/** Query parameter names whose values are credentials or one-time secrets. */
const SENSITIVE_PARAM =
  /(token|key|secret|password|passwd|pwd|code|state|signature|^sig$|auth|credential|session|otp|nonce|verifier)/i;

/**
 * Object keys whose values are always redacted. Kept deliberately exact so
 * metrics such as `inputTokens` / `max_tokens` survive.
 */
const SENSITIVE_KEY_EXACT =
  /^(password|passwd|pwd|secret|token|access_token|refresh_token|id_token|accesstoken|refreshtoken|idtoken|api[-_]?key|apikey|x-api-key|authorization|proxy-authorization|cookie|cookies|set-cookie|credentials?|private[-_]?key|client[-_]?secret|session[-_]?id|sessionid|jwt|bearer|otp|code_verifier|connection[-_]?string|database[-_]?url|direct[-_]?database[-_]?url|dsn)$/i;
const SENSITIVE_KEY_SUFFIX =
  /(password|passwd|secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|private[-_]?key)$/i;

/** Keys whose values are request/response payloads and are dropped. */
const BODY_KEYS = new Set(["body", "requestbody", "responsebody", "rawbody", "payload"]);

interface SecretPattern {
  re: RegExp;
  replace: string | ((substring: string, ...args: string[]) => string);
}

/** Known secret formats. Order matters: specific formats before generic ones. */
const SECRET_PATTERNS: SecretPattern[] = [
  // scheme://user:password@host (postgres, postgresql, mysql, redis, clickhouse, https, ...)
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+@/gi, replace: `$1${REDACTED}@` },
  // OpenRouter keys: sk-or-v1-<hex>
  { re: /\bsk-or-(?:v\d+-)?[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // OpenAI / Anthropic / generic sk- keys
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // Bearer / Basic credentials in free text
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  // JWTs (header.payload.signature, base64url, header starts with eyJ)
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, replace: REDACTED },
  // AWS access key ids
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  // aws_secret_access_key=... / AWS_SECRET_ACCESS_KEY: ...
  { re: /(aws_?secret_?access_?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{20,}/gi, replace: `$1${REDACTED}` },
  // Google API keys
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  // Slack tokens
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  // Stripe-style keys
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  // PEM private keys
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  // key=value pairs for credential-named params inside free text / URLs
  {
    // (the name must END in the credential word, so `maxTokens=4000` survives)
    re: /([?&#;,(\s]|^)([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|code|state|signature|sig))=([^&#\s"',)]+)/gi,
    replace: (_m: string, sep: string, name: string) => `${sep}${name}=${REDACTED}`,
  },
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_EXACT.test(key) || SENSITIVE_KEY_SUFFIX.test(key);
}

export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAM.test(name);
}

/** Masks every known secret format inside an arbitrary string. */
export function scrubString(input: string): string {
  let out = input;
  for (const { re, replace } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replace as never);
  }
  return out;
}

/** Redacts credential-like query parameters in a raw query string (no leading "?"). */
export function scrubQueryString(query: string): string {
  if (!query) return query;
  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " "));
    } catch {
      /* keep raw */
    }
    if (eq !== -1 && isSensitiveParam(name)) return `${rawName}=${REDACTED}`;
    return pair;
  });
  return scrubString(parts.join("&"));
}

/**
 * Redacts credential-like query parameters and hash fragments in a URL
 * (absolute or path-only). Unparseable input still gets pattern scrubbing.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;
  const hashIdx = url.indexOf("#");
  let hash = hashIdx === -1 ? "" : url.slice(hashIdx + 1);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf("?");
  const base = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : beforeHash.slice(qIdx + 1);
  // Fragments such as #access_token=...&state=... (implicit OAuth flows).
  if (hash.includes("=")) hash = scrubQueryString(hash);
  let out = scrubString(base);
  if (qIdx !== -1) out += `?${scrubQueryString(query)}`;
  if (hashIdx !== -1) out += `#${scrubString(hash)}`;
  return out;
}

type Headers = Record<string, unknown>;

export function scrubHeaders<T extends Headers | undefined>(headers: T): T {
  if (!headers || typeof headers !== "object") return headers;
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase()) || isSensitiveKey(k)) continue;
    out[k] = typeof v === "string" ? scrubString(v) : scrubValue(v);
  }
  return out as T;
}

const MAX_DEPTH = 12;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-scrubs any JSON-like value: masks secret-format strings, redacts
 * secret-named keys and drops body payloads. Cycles and very deep values are
 * cut off. Returns a new value; the input is not mutated.
 */
export function scrubValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value; // class instances (Date, Scope, ...) untouched
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (BODY_KEYS.has(lower)) {
      out[k] = REDACTED;
    } else if (lower === "headers" && v && typeof v === "object") {
      out[k] = scrubHeaders(v as Headers);
    } else if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else if ((lower === "url" || lower === "href" || lower === "from" || lower === "to") && typeof v === "string") {
      out[k] = scrubUrl(v);
    } else if ((lower === "query_string" || lower === "querystring" || lower === "search") && typeof v === "string") {
      out[k] = scrubQueryString(v.replace(/^\?/, ""));
    } else {
      out[k] = scrubValue(v, depth + 1, seen);
    }
  }
  return out;
}

// ─── Structural Sentry shapes (subset) ─────────────────────────────────────────

export interface ScrubbableRequest {
  url?: string;
  method?: string;
  data?: unknown;
  query_string?: string | Record<string, string> | [string, string][];
  cookies?: Record<string, string>;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ScrubbableEvent {
  request?: ScrubbableRequest;
  user?: { id?: string | number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ScrubbableLog {
  message: unknown;
  attributes?: Record<string, unknown>;
  [k: string]: unknown;
}

function scrubRequest(req: ScrubbableRequest): ScrubbableRequest {
  const out: ScrubbableRequest = { ...req };
  delete out.data; // request bodies are never sent
  delete out.cookies;
  delete out.env;
  if (out.headers) out.headers = scrubHeaders(out.headers);
  if (typeof out.url === "string") out.url = scrubUrl(out.url);
  const qs = out.query_string;
  if (typeof qs === "string") {
    out.query_string = scrubQueryString(qs.replace(/^\?/, ""));
  } else if (Array.isArray(qs)) {
    out.query_string = qs.map(([k, v]) => [k, isSensitiveParam(k) ? REDACTED : scrubString(String(v))] as [string, string]);
  } else if (qs && typeof qs === "object") {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(qs)) o[k] = isSensitiveParam(k) ? REDACTED : scrubString(String(v));
    out.query_string = o;
  }
  return out;
}

/** Scrubs an error or transaction event. Returns a new object. */
export function scrubEvent<T extends object>(input: T): T {
  // sdkProcessingMetadata is SDK-internal (scopes, spans); it is never sent as-is.
  const { request, user, sdkProcessingMetadata, ...rest } = input as ScrubbableEvent;
  const out = scrubValue(rest) as ScrubbableEvent;
  if (sdkProcessingMetadata !== undefined) out.sdkProcessingMetadata = sdkProcessingMetadata;
  if (request) out.request = scrubRequest(request);
  if (user && user.id !== undefined && user.id !== null && user.id !== "") {
    // Only an opaque id: never email, username, or IP address.
    out.user = { id: user.id };
  }
  return out as T;
}

export function scrubBreadcrumb<T extends object>(crumb: T): T {
  return scrubValue(crumb) as T;
}

export function scrubLog<T extends object>(log: T): T {
  const out = { ...(log as unknown as ScrubbableLog) };
  if (typeof out.message === "string") out.message = scrubString(out.message);
  if (out.attributes) out.attributes = scrubValue(out.attributes) as Record<string, unknown>;
  return out as unknown as T;
}
