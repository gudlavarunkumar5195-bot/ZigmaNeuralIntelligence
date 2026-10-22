/**
 * Query parameters that must never reach logs (OAuth codes and state, tokens,
 * idempotency keys, and keyword-research search inputs, which can reveal a
 * customer's plans). The request logger records URLs through this.
 */
const SENSITIVE_PARAMS = /^(code|state|token|access_token|refresh_token|id_token|code_verifier|client_secret|key|signature|sig|search|keyword|seed|q)$/i;

export function sanitizeLoggedUrl(url: string | undefined): string | undefined {
  if (!url || !url.includes("?")) return url;
  const [path, query] = url.split("?", 2);
  const params = new URLSearchParams(query);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (SENSITIVE_PARAMS.test(name)) {
      params.set(name, "[REDACTED]");
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : url;
}
