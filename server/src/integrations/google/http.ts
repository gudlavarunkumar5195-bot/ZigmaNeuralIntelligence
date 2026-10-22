/**
 * The only place that talks to Google over the network. Fixed Google hosts,
 * TLS verification as Node ships it (never disabled), a hard timeout. Tests
 * replace this module; ordinary CI never needs live Google credentials.
 */

export interface GoogleResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export class GoogleNetworkError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = "GoogleNetworkError";
  }
}

export const GOOGLE_HOSTS = new Set(["accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "www.googleapis.com", "searchconsole.googleapis.com"]);

export async function googleRequest(url: string, init: RequestInit & { timeoutMs: number }): Promise<GoogleResponse> {
  const host = new URL(url).hostname;
  if (!GOOGLE_HOSTS.has(host) || !url.startsWith("https://")) throw new Error(`Refusing non-Google URL ${host}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new GoogleNetworkError(timedOut ? `Google request timed out after ${init.timeoutMs}ms` : `Google request failed: ${(err as Error).message}`, timedOut);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, headers: res.headers, body };
}
