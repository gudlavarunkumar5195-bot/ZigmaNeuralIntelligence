/**
 * Deterministic local fixture website for crawler tests: a real HTTP server on
 * 127.0.0.1 with every case the technical audit must handle. Routes are
 * mutable so a test can "fix" the site between scans. Every request is
 * logged, so tests can assert what the crawler did and did not fetch.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureRoute {
  status: number;
  body?: string;
  type?: string;
  location?: string;
  headers?: Record<string, string>;
  /** Send headers, then hold the body this long (exercises the body timeout). */
  delayBodyMs?: number;
}

export interface FixtureSite {
  origin: string;
  port: number;
  routes: Record<string, FixtureRoute>;
  requests: string[];
  close(): Promise<void>;
}

export const fixturePage = (o: { title?: string | null; description?: string | null; canonical?: string | null; h1?: number; links?: string[]; extraHead?: string; extraBody?: string }) =>
  `<!doctype html><html><head>${o.title === null || o.title === undefined ? "" : `<title>${o.title}</title>`}` +
  `${o.description ? `<meta name="description" content="${o.description}">` : ""}` +
  `${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}${o.extraHead ?? ""}</head><body>` +
  `${"<h1>Heading</h1>".repeat(o.h1 ?? 1)}${(o.links ?? []).map((l) => `<a href="${l}">link</a>`).join("")}${o.extraBody ?? ""}</body></html>`;

/** The standard fixture: one route per audit case. Paths are relative to the origin. */
export function standardRoutes(origin: string): Record<string, FixtureRoute> {
  const ok = (path: string, o: Parameters<typeof fixturePage>[0] = {}): FixtureRoute => ({
    status: 200,
    body: fixturePage({ title: `Page ${path}`, description: `About ${path}`, canonical: `${origin}${path}`, ...o }),
  });
  return {
    "/robots.txt": { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n` },
    "/sitemap.xml": {
      status: 200,
      type: "application/xml",
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about", "/gone", "/moved", "/private/secret"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`,
    },
    "/": ok("/", {
      title: "Home",
      links: [
        "/about", "/about#team", "/about?utm_source=newsletter", "/dup-a", "/dup-b", "/no-title", "/broken", "/hop1", "/loop1",
        "/canon-bad", "/no-alt", "/slow", "/private/secret", "/offsite", "/ssrf", "/report.pdf", "/report",
      ],
    }),
    "/about": ok("/about"),
    "/dup-a": ok("/dup-a", { title: "Same Title", description: "Same description" }),
    "/dup-b": ok("/dup-b", { title: "Same Title", description: "Same description" }),
    "/no-title": ok("/no-title", { title: null, description: null }),
    "/broken": { status: 404, body: "not found" },
    "/gone": { status: 404, body: "gone" },
    "/hop1": { status: 301, location: "/hop2" },
    "/hop2": { status: 302, location: "/hop3" },
    "/hop3": ok("/hop3"),
    "/loop1": { status: 301, location: "/loop2" },
    "/loop2": { status: 301, location: "/loop1" },
    "/canon-bad": ok("/canon-bad", { canonical: `${origin}/moved` }),
    "/moved": { status: 301, location: "/" },
    "/no-alt": ok("/no-alt", { extraBody: `<img src="/a.png"><img src="/b.png" alt="">` }),
    "/slow": { ...ok("/slow"), delayBodyMs: 3_000 },
    "/private/secret": ok("/private/secret"),
    "/offsite": { status: 302, location: "https://partner.example/landing" },
    // Same host, another port: in crawl scope by host, so only the SSRF check stops it.
    "/ssrf": { status: 302, location: "http://127.0.0.1:1/admin" },
    "/report": { status: 200, type: "application/pdf", body: "%PDF-1.4" },
  };
}

export async function startFixtureSite(routes?: (origin: string) => Record<string, FixtureRoute>): Promise<FixtureSite> {
  const requests: string[] = [];
  const site: FixtureSite = { origin: "", port: 0, routes: {}, requests, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    const route = site.routes[path] ?? { status: 404, body: "not found" };
    const headers: Record<string, string> = { "content-type": route.type ?? "text/html; charset=utf-8", ...(route.headers ?? {}) };
    if (route.location) headers.location = route.location;
    res.writeHead(route.status, headers);
    if (route.delayBodyMs) {
      res.write("<!doctype html><html><head>");
      const t = setTimeout(() => res.end(route.body ?? ""), route.delayBodyMs);
      res.on("close", () => clearTimeout(t));
      return;
    }
    res.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.port = (server.address() as AddressInfo).port;
  site.origin = `http://127.0.0.1:${site.port}`;
  site.routes = (routes ?? standardRoutes)(site.origin);
  site.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return site;
}
