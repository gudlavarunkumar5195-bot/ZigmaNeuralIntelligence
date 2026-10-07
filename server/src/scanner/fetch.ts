import { checkUrlSafety } from "./ssrf.js";
import { config } from "../config.js";
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirectCount: number;
  durationMs: number;
  limited?: boolean;
  contentType?: string;
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

    const parsedCurrentUrl = new URL(currentUrl);
    if (parsedCurrentUrl.username || parsedCurrentUrl.password) {
      return { ok: false, status: 0, headers: {}, body: "", finalUrl: currentUrl, redirectCount, durationMs: Date.now() - start, error: "Userinfo in URL is not permitted" };
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
        res.destroy();
        return {
          ok: false, status: res.statusCode ?? 0, headers: headersToObject(res.headers),
          body: "", finalUrl: currentUrl, redirectCount,
          durationMs: Date.now() - start, error: "Redirect with no Location header",
        };
      }

      if (redirectCount >= config.SCANNER_MAX_REDIRECTS) {
        res.destroy();
        return {
          ok: false, status: 0, headers: {}, body: "", finalUrl: currentUrl,
          redirectCount, durationMs: Date.now() - start,
          error: `Too many redirects (max ${config.SCANNER_MAX_REDIRECTS})`,
        };
      }

      try {
        const redirectUrl = new URL(location, currentUrl);
        if (redirectUrl.username || redirectUrl.password) throw new Error("Userinfo in URL is not permitted");
        if (!new Set(["http:", "https:"]).has(redirectUrl.protocol)) throw new Error("Redirect scheme is not permitted");
        currentUrl = redirectUrl.href;
      } catch (error) {
        res.destroy();
        return { ok: false, status: res.statusCode ?? 0, headers: headersToObject(res.headers), body: "", finalUrl: currentUrl, redirectCount, durationMs: Date.now() - start, error: `Invalid redirect: ${(error as Error).message}` };
      }
      res.destroy();
      redirectCount++;
      continue;
    }

    // Read body with size limit and response timeout
    const responseTimer = setTimeout(
      () => controller.abort(),
      config.SCANNER_RESPONSE_TIMEOUT_MS
    );

    const chunks: Buffer[] = [];
    let limited = false;
    let readError: string | undefined;
    const stream = decodedStream(res);
    try {
      let bytesRead = 0;
      for await (const chunk of stream) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // Limit is applied to DECODED bytes, which also bounds decompression bombs.
        bytesRead += value.byteLength;
        if (bytesRead > config.SCANNER_MAX_RESPONSE_BYTES) {
          limited = true;
          stream.destroy();
          res.destroy();
          break;
        }
        chunks.push(value);
      }
    } catch (err) {
      // A truncated body must not be reported as a complete, successful page.
      readError = controller.signal.aborted
        ? `Response body not received within ${config.SCANNER_RESPONSE_TIMEOUT_MS}ms`
        : `Response body read failed: ${(err as Error).message}`;
    } finally {
      clearTimeout(responseTimer);
    }
    const body = Buffer.concat(chunks).toString("utf8");

    const headers = headersToObject(res.headers);
    const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();

    return {
      ok: !limited && !readError && (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
      // status 0 marks an incomplete read so scanners fail/retry instead of
      // reporting findings derived from a truncated page.
      status: readError ? 0 : res.statusCode ?? 0,
      headers,
      body,
      finalUrl: currentUrl,
      redirectCount,
      durationMs: Date.now() - start,
      limited,
      contentType,
      ...(limited ? { error: `Response exceeded ${config.SCANNER_MAX_RESPONSE_BYTES} bytes` } : readError ? { error: readError } : {}),
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

/**
 * DNS lookup that always answers with the already-validated address. Node >= 20
 * enables autoSelectFamily, which calls lookup with {all: true} and requires an
 * array result; the legacy (address, family) form would fail with
 * "Invalid IP address: undefined".
 */
export function pinnedLookup(address: string) {
  const family = address.includes(":") ? 6 : 4;
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    if (options && typeof options === "object" && options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function decodedStream(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  return res;
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
        "Accept-Encoding": "gzip, deflate, br",
      },
      ...(address ? { lookup: pinnedLookup(address) } : {}),
      ...(parsed.protocol === "https:" ? { servername: parsed.hostname } : {}),
    } as http.RequestOptions, resolve);
    const abort = () => request.destroy(new Error("Request aborted"));
    controller.signal.addEventListener("abort", abort, { once: true });
    request.setTimeout(config.SCANNER_CONNECT_TIMEOUT_MS, () => request.destroy(new Error("Request timed out")));
    request.once("error", reject);
    request.end();
  });
}
