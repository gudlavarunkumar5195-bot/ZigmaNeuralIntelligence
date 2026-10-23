/**
 * Browser-side scrubbing for Sentry events and breadcrumbs. Pure functions
 * (no Sentry import) so they are unit-testable.
 *
 * - Query strings / hash fragments that carry credentials (token, code,
 *   state, key, secret, password, ...) are removed from URLs entirely.
 * - Known secret formats (Bearer tokens, JWTs, sk-... keys) are masked.
 * - Request/response bodies, cookies and auth headers are never sent.
 * - The user is reduced to an opaque id.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_PARAM =
  /(token|key|secret|password|passwd|pwd|code|state|signature|auth|credential|session|otp|nonce|verifier)/i;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+@/gi, `$1${REDACTED}@`],
  [/\bsk-or-(?:v\d+-)?[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, REDACTED],
];

const SENSITIVE_KEY =
  /^(password|passwd|secret|token|access_token|refresh_token|id_token|api[-_]?key|apikey|authorization|cookie|cookies|set-cookie|credentials?|client[-_]?secret|request_body|response_body|body|data_body)$/i;

export function scrubString(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, rep);
  }
  return out;
}

function hasSensitiveParam(part: string): boolean {
  if (!part) return false;
  return part.split("&").some((pair) => {
    const name = pair.split("=", 1)[0] ?? "";
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      /* keep raw */
    }
    return pair.includes("=") && SENSITIVE_PARAM.test(decoded);
  });
}

/**
 * Drops the query string and/or hash fragment when they carry a credential
 * (e.g. /reset-password?token=..., /#access_token=..., OAuth ?code=&state=).
 */
export function scrubUrl(url: string): string {
  if (!url) return url;
  const hashIdx = url.indexOf("#");
  let hash = hashIdx === -1 ? "" : url.slice(hashIdx + 1);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf("?");
  const base = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  let query = qIdx === -1 ? "" : beforeHash.slice(qIdx + 1);
  if (hasSensitiveParam(query)) query = REDACTED;
  // Hash routes look like "#/path?x=y"; keep the route, drop a credential-bearing query.
  if (hash) {
    const qi = hash.indexOf("?");
    const route = qi === -1 ? "" : hash.slice(0, qi);
    const hashQuery = qi === -1 ? hash : hash.slice(qi + 1);
    if (hasSensitiveParam(hashQuery) || /eyJ[A-Za-z0-9_-]{5,}\./.test(hash)) hash = route ? `${route}?${REDACTED}` : REDACTED;
  }
  let out = scrubString(base);
  if (qIdx !== -1) out += `?${query === REDACTED ? REDACTED : scrubString(query)}`;
  if (hashIdx !== -1) out += `#${scrubString(hash)}`;
  return out;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function scrubValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= 10) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEY.test(k)) out[k] = REDACTED;
    else if (lower === "headers") out[k] = REDACTED;
    else if ((lower === "url" || lower === "from" || lower === "to" || lower === "href") && typeof v === "string") out[k] = scrubUrl(v);
    else out[k] = scrubValue(v, depth + 1, seen);
  }
  return out;
}

interface EventShape {
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: Record<string, string>; query_string?: unknown };
  user?: { id?: string | number };
  sdkProcessingMetadata?: unknown;
  [k: string]: unknown;
}

export function scrubBrowserEvent<T extends object>(input: T): T {
  const { request, user, sdkProcessingMetadata, ...rest } = input as EventShape;
  const out = scrubValue(rest) as EventShape;
  if (sdkProcessingMetadata !== undefined) out.sdkProcessingMetadata = sdkProcessingMetadata;
  if (request) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      if (/^(user-agent|referer|accept-language)$/i.test(k)) headers[k] = k.toLowerCase() === "referer" ? scrubUrl(v) : v;
    }
    out.request = { url: request.url ? scrubUrl(request.url) : undefined, headers };
  }
  if (user?.id !== undefined && user.id !== "") out.user = { id: user.id };
  return out as T;
}

export function scrubBrowserBreadcrumb<T extends object>(crumb: T): T {
  return scrubValue(crumb) as T;
}
