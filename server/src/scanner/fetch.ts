import { checkUrlSafety } from "./ssrf.js";
import { config } from "../config.js";

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

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "ZigmaNeural-Scanner/1.0 (+https://zignaneural.com/scanner)",
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Encoding": "gzip, br",
        },
      });
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
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          ok: false, status: res.status, headers: headersToObject(res.headers),
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
      const reader = res.body?.getReader();
      if (reader) {
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (bytesRead > config.SCANNER_MAX_RESPONSE_BYTES) {
            reader.cancel();
            break;
          }
          body += new TextDecoder().decode(value);
        }
      }
    } catch {
      // Partial body is still useful
    } finally {
      clearTimeout(responseTimer);
    }

    const headers = headersToObject(res.headers);

    return {
      ok: res.ok,
      status: res.status,
      headers,
      body,
      finalUrl: currentUrl,
      redirectCount,
      durationMs: Date.now() - start,
    };
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}
