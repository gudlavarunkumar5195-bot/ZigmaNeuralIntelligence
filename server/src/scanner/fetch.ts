import { checkUrlSafety } from "./ssrf.js";
import { config } from "../config.js";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirectCount: number;
  durationMs: number;
  error?: string;
}

/**
 * SSRF-safe HTTP fetch.
 * - Validates URL before request
 * - Re-validates every redirect target
 * - Enforces connection timeout, response timeout, and max body size
 * - Limits redirect count
 */
export async function safeFetch(
  rawUrl: string,
  options: { method?: string } = {}
): Promise<SafeFetchResult> {
  const start = Date.now();
  let currentUrl = rawUrl;
  let redirectCount = 0;

  while (true) {
    const safety = await checkUrlSafety(currentUrl);
    if (!safety.safe) {
      return {
        ok: false, status: 0, headers: {}, body: "", finalUrl: currentUrl,
        redirectCount, durationMs: Date.now() - start,
        error: `SSRF: ${safety.reason}`,
      };
    }

    const controller = new AbortController();
    const connectTimer = setTimeout(
      () => controller.abort(),
      config.SCANNER_CONNECT_TIMEOUT_MS
    );

    let res: IncomingMessage;
    try {
      res = await requestPinned(currentUrl, safety.resolvedIPs?.[0], options.method ?? "GET", controller);
    } catch (err: unknown) {
      clearTimeout(connectTimer);
      return {
        ok: false, status: 0, headers: {}, body: "", finalUrl: currentUrl,
        redirectCount, durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
    clearTimeout(connectTimer);

    // Handle redirects manually so we can re-validate each target
    if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
      const location = res.headers.location;
      if (!location) {
        return {
          ok: false, status: res.statusCode ?? 0, headers: headersToObject(res.headers),
          body: "", finalUrl: currentUrl, redirectCount,
          durationMs: Date.now() - start, error: "Redirect with no Location header",
        };
      }

      if (redirectCount >= config.SCANNER_MAX_REDIRECTS) {
        return {
          ok: false, status: 0, headers: {}, body: "", finalUrl: currentUrl,
          redirectCount, durationMs: Date.now() - start,
          error: `Too many redirects (max ${config.SCANNER_MAX_REDIRECTS})`,
        };
      }

      currentUrl = new URL(location, currentUrl).href;
      redirectCount++;
      continue;
    }

    // Read body with size limit and response timeout
    const responseTimer = setTimeout(
      () => controller.abort(),
      config.SCANNER_RESPONSE_TIMEOUT_MS
    );

    let body = "";
    try {
      let bytesRead = 0;
      for await (const chunk of res) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += value.byteLength;
        if (bytesRead > config.SCANNER_MAX_RESPONSE_BYTES) {
          res.destroy();
          break;
        }
        body += value.toString("utf8");
      }
    } catch {
      // Partial body is still useful
    } finally {
      clearTimeout(responseTimer);
    }

    const headers = headersToObject(res.headers);

    return {
      ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
      status: res.statusCode ?? 0,
      headers,
      body,
      finalUrl: currentUrl,
      redirectCount,
      durationMs: Date.now() - start,
    };
  }
}

function headersToObject(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function requestPinned(url: string, address: string | undefined, method: string, controller: AbortController): Promise<IncomingMessage> {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        Host: parsed.host,
        "User-Agent": "ZigmaNeural-Scanner/1.0 (+https://zignaneural.com/scanner)",
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Encoding": "identity",
      },
      ...(address ? { lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => callback(null, address, address.includes(":") ? 6 : 4) } : {}),
      ...(parsed.protocol === "https:" ? { servername: parsed.hostname } : {}),
    } as http.RequestOptions, resolve);
    const abort = () => request.destroy(new Error("Request aborted"));
    controller.signal.addEventListener("abort", abort, { once: true });
    request.setTimeout(config.SCANNER_CONNECT_TIMEOUT_MS, () => request.destroy(new Error("Request timed out")));
    request.once("error", reject);
    request.end();
  });
}
