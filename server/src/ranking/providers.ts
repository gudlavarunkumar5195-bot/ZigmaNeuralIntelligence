/**
 * SERP data providers for rank tracking. A provider declares exactly what it
 * supports (engines, targeting, devices, depth, features, history, limits,
 * cost); projects and refreshes are only allowed within that declaration.
 * Credentials come from the central integration registry
 * (server/src/platform), never from users or this module.
 *
 * No licensed SERP provider is implemented: each is paid and needs explicit
 * approval, and none can be verified without an account. Until one is added,
 * rankings come from authorized ranking-report imports.
 */

export interface SerpQuery {
  keyword: string;
  searchEngine: "google" | "bing";
  country: string | null;
  language: string | null;
  device: "desktop" | "mobile" | null;
  location: string | null;
  depth: number;
}

export interface SerpResultItem {
  position: number;
  url: string;
  type: string;
}

export interface SerpResponse {
  /** Organic results down to `depth`. */
  results: SerpResultItem[];
  depth: number;
  /** Canonical feature ids present on the page (see ranking/core.ts parseFeatures). */
  features: string[];
  /** Feature id → result URLs the provider attributes to that feature (only when it says so). */
  featureUrls: Record<string, string[]>;
  observedAt: Date;
}

export interface SerpProviderInfo {
  id: string;
  name: string;
  searchEngines: Array<"google" | "bing">;
  targeting: { countries: boolean; languages: boolean; locations: boolean; devices: Array<"desktop" | "mobile"> };
  maxDepth: number;
  features: string[];
  historical: boolean;
  rateLimitPerMinute: number | null;
  costNote: string;
  attribution: string;
}

export interface SerpProvider {
  info: SerpProviderInfo;
  missingConfiguration(): string[];
  fetchSerp(query: SerpQuery, signal: AbortSignal): Promise<SerpResponse>;
}

export class RankProviderError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "RankProviderError";
  }
}

/** Implemented providers. Empty: see the module comment. */
export function rankProviders(): SerpProvider[] {
  return [];
}

/** The provider for refreshes, or a clear "not configured" error. */
export function resolveRankProvider(): SerpProvider {
  const provider = rankProviders()[0];
  if (!provider) {
    throw new RankProviderError(503, "PROVIDER_NOT_CONFIGURED", "No SERP data provider is configured. Import a ranking report from an authorized tool, or approve and configure a provider (docs/RANK_TRACKING.md).", false);
  }
  const missing = provider.missingConfiguration();
  if (missing.length) throw new RankProviderError(503, "PROVIDER_NOT_CONFIGURED", `The SERP provider is missing configuration: ${missing.join(", ")}.`, false);
  return provider;
}

export interface RankSourceInfo {
  id: string;
  name: string;
  status: "available" | "not_configured" | "not_supported";
  explanation: string;
  setup: string | null;
  costNote: string;
  provider?: SerpProviderInfo;
}

export function rankSources(): RankSourceInfo[] {
  const providers = rankProviders();
  return [
    {
      id: "csv_import",
      name: "Ranking report import",
      status: "available",
      explanation: "Import a ranking report you are entitled to use (for example from your rank-tracking tool): keyword, date and position, plus URL, competitor domain and SERP features when the report has them. Positions are stored as reported; 'not in top N' stays 'not found', never a number.",
      setup: null,
      costNote: "No cost.",
    },
    {
      id: "google_search_console",
      name: "Google Search Console",
      status: "not_supported",
      explanation: "Search Console reports an average position over all impressions, not the position on one results page for one location and device. It is shown under Search performance and is not used as a ranking observation.",
      setup: null,
      costNote: "No cost.",
    },
    ...(providers.length
      ? providers.map((p) => ({ id: p.info.id, name: p.info.name, status: (p.missingConfiguration().length ? "not_configured" : "available") as RankSourceInfo["status"], explanation: p.info.attribution, setup: null, costNote: p.info.costNote, provider: p.info }))
      : [{
          id: "licensed_serp_api",
          name: "Licensed SERP data API",
          status: "not_configured" as const,
          explanation: "No SERP data provider is integrated, so scheduled tracking and manual refresh are unavailable. Candidates (DataForSEO, SerpApi, Semrush, others) are paid and need approval.",
          setup: "Approve a provider and its cost; its key is then entered once in Admin → Integrations & API Keys and validated before use. See docs/RANK_TRACKING.md.",
          costNote: "Paid; requires explicit approval.",
        }]),
  ];
}
