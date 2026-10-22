/**
 * Provider-neutral keyword research interface.
 *
 * A provider declares exactly what it can do (capabilities), which metrics it
 * supplies, which targeting it honours, and how its data may be cached. The
 * service rejects unsupported operations before calling a provider, and the
 * API reports every metric a provider does not supply as "not supported",
 * never as zero.
 */

export const CAPABILITIES = [
  "keyword_overview",
  "keyword_ideas",
  "related_keywords",
  "organic_keywords",
  "competitor_domains",
  "keyword_gap",
  "serp_results",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const METRICS = ["search_volume", "keyword_difficulty", "cpc", "competition", "clicks", "impressions", "ctr", "position"] as const;
export type MetricName = (typeof METRICS)[number];

export interface Targeting {
  country?: string;
  language?: string;
  device?: "desktop" | "mobile" | "tablet";
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** first_party: the customer's own data (e.g. Search Console); licensed: a third-party dataset. */
  kind: "first_party" | "licensed";
  capabilities: Capability[];
  /** Metrics the provider can return; anything else is "not supported". */
  metrics: MetricName[];
  /** What the metrics describe, shown to users (e.g. "your site's clicks", not "search volume"). */
  metricScope: string;
  targeting: { countries: string[] | "all"; languages: string[] | "all"; devices: Array<Targeting["device"]> | "all"; note?: string };
  /** Whether results may be stored and reused, and for how long. */
  caching: { allowed: boolean; maxAgeMinutes: number };
  attribution: string;
  costNote: string;
}

export interface KeywordRow {
  keyword: string;
  /** Only metrics the provider returned for this row; absent = not returned. */
  metrics: Partial<Record<MetricName, number>>;
  /** Free-form provider facts kept for provenance (bounded by the service). */
  extra?: Record<string, string | number | boolean | null>;
}

export interface ProviderResult {
  rows: KeywordRow[];
  /** True when the provider returned only a sample (top rows, limits, omitted rare queries). */
  sample: boolean;
  /** True when part of the request could not be served (some data unavailable). */
  partial: boolean;
  /** Latest date the data describes (YYYY-MM-DD), when known. */
  observedThrough: string | null;
  notes: string[];
}

export interface ProviderContext {
  orgId: string;
  /** The research project: a website of the organization. */
  websiteId: string;
  websiteDomain: string;
  targeting: Targeting;
  limit: number;
  signal?: AbortSignal;
}

export interface CompetitorRef {
  /** A domain the user named. */
  domain: string;
  /** Resolved by the service when the provider needs an internal reference. */
  websiteId?: string;
}

export interface KeywordResearchProvider {
  info: ProviderInfo;
  /** Names of missing settings (never values); empty when ready. */
  missingConfiguration(): string[];
  keywordOverview?(ctx: ProviderContext, keywords: string[]): Promise<ProviderResult>;
  keywordIdeas?(ctx: ProviderContext, seed: string): Promise<ProviderResult>;
  relatedKeywords?(ctx: ProviderContext, keyword: string): Promise<ProviderResult>;
  organicKeywords?(ctx: ProviderContext, target: CompetitorRef | null): Promise<ProviderResult>;
  competitorDomains?(ctx: ProviderContext): Promise<ProviderResult & { domains: Array<{ domain: string; sharedKeywords?: number }> }>;
  serpResults?(ctx: ProviderContext, keyword: string): Promise<ProviderResult>;
}

export type ResearchErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "CAPABILITY_UNSUPPORTED"
  | "TARGETING_UNSUPPORTED"
  | "DATA_SOURCE_UNAVAILABLE"
  | "COMPETITOR_DATA_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "AI_UNAVAILABLE"
  | "RUN_NOT_READY"
  | "LIST_CONFLICT"
  | "LIST_FULL";

export class ResearchError extends Error {
  constructor(readonly statusCode: number, readonly code: ResearchErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ResearchError";
  }
}
