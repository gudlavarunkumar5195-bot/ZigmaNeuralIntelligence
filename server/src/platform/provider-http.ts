/**
 * Network access for platform credential validation. Fixed provider hosts,
 * TLS verification as Node ships it (never disabled), no redirects, a hard
 * timeout. Tests replace this module; CI never calls a provider.
 */

export interface ProviderResponse {
  status: number;
  body: unknown;
}

export class ProviderNetworkError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

const HOSTS = new Set(["openrouter.ai"]);

export async function providerRequest(url: string, init: RequestInit & { timeoutMs: number }): Promise<ProviderResponse> {
  const host = new URL(url).hostname;
  if (!HOSTS.has(host) || !url.startsWith("https://")) throw new Error(`Refusing non-provider URL ${host}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    // The message never includes request headers (the credential).
    throw new ProviderNetworkError(timedOut ? `Request timed out after ${init.timeoutMs}ms` : "Network error reaching the provider", timedOut);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
