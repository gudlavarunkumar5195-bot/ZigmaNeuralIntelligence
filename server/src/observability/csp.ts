/**
 * Optional Sentry ingest origin for the CSP connect-src directive.
 *
 * SENTRY_CSP_INGEST_HOST: bare hostname such as "o123456.ingest.us.sentry.io"
 * or "ingest.us.sentry.io" (no scheme/path). Anything else is ignored.
 * Note: today's connect-src already allows any https: origin, so this only
 * matters once connect-src is tightened to an allow-list.
 */
const HOST_RE = /^(?:[a-z0-9-]+\.)*ingest(?:\.[a-z]{2})?\.sentry\.io$/i;

export function sentryCspConnectSource(env: Record<string, string | undefined> = process.env): string {
  const host = env.SENTRY_CSP_INGEST_HOST?.trim();
  if (!host || !HOST_RE.test(host)) return "";
  return ` https://${host.toLowerCase()}`;
}
