import * as cheerio from "cheerio";

/**
 * XML sitemap parsing (sitemaps.org protocol): `<urlset><url><loc>` lists and
 * `<sitemapindex><sitemap><loc>` indexes. Parsed with cheerio in XML mode
 * (no DTD/entity expansion, so no XXE). Gzipped sitemaps are not decoded here
 * and are reported as unsupported rather than guessed at.
 */

export interface ParsedSitemap {
  kind: "urlset" | "index" | "invalid";
  urls: string[];
  sitemaps: string[];
}

const MAX_LOCS = 50_000; // protocol limit per file

export function parseSitemapXml(xml: string): ParsedSitemap {
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<")) return { kind: "invalid", urls: [], sitemaps: [] };
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(trimmed, { xml: true });
  } catch {
    return { kind: "invalid", urls: [], sitemaps: [] };
  }
  const locs = (selector: string) =>
    $(selector)
      .toArray()
      .slice(0, MAX_LOCS)
      .map((el) => $(el).text().trim())
      .filter(Boolean);
  if ($("sitemapindex").length > 0) return { kind: "index", urls: [], sitemaps: locs("sitemapindex > sitemap > loc") };
  if ($("urlset").length > 0) return { kind: "urlset", urls: locs("urlset > url > loc"), sitemaps: [] };
  return { kind: "invalid", urls: [], sitemaps: [] };
}
