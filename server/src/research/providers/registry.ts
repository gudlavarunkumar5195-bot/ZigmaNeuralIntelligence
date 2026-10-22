import { config } from "../../config.js";
import { searchConsoleProvider } from "./search-console.js";
import { CAPABILITIES, ResearchError, type Capability, type KeywordResearchProvider } from "./types.js";

/**
 * Registered keyword research providers. Only real, implemented adapters are
 * listed. Licensed providers (e.g. DataForSEO, Semrush, Ahrefs, Google Ads
 * Keyword Planner) are not implemented: they need a contract, credentials and
 * spending approval first (see docs/KEYWORD_RESEARCH.md).
 */
const ALL: Record<string, KeywordResearchProvider> = {
  [searchConsoleProvider.info.id]: searchConsoleProvider,
};

/** Providers enabled by KEYWORD_RESEARCH_PROVIDERS (comma list; default: Search Console). */
export function enabledProviders(env: { KEYWORD_RESEARCH_PROVIDERS?: string } = config): KeywordResearchProvider[] {
  const ids = (env.KEYWORD_RESEARCH_PROVIDERS ?? "google_search_console").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => ALL[id]).filter((p): p is KeywordResearchProvider => !!p);
}

export function unknownProviderIds(env: { KEYWORD_RESEARCH_PROVIDERS?: string } = config): string[] {
  return (env.KEYWORD_RESEARCH_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter((id) => id && !ALL[id]);
}

export function capabilityMatrix() {
  return enabledProviders().map((p) => ({
    ...p.info,
    configured: p.missingConfiguration().length === 0,
    missingConfiguration: p.missingConfiguration(),
    unsupported: CAPABILITIES.filter((c) => !p.info.capabilities.includes(c)),
  }));
}

/** The provider to use for a capability: the requested one, or the first enabled one that supports it. */
export function resolveProvider(capability: Capability, requested?: string): KeywordResearchProvider {
  const enabled = enabledProviders();
  if (enabled.length === 0) throw new ResearchError(503, "PROVIDER_NOT_CONFIGURED", "No keyword research provider is enabled on this server.");
  const candidates = requested ? enabled.filter((p) => p.info.id === requested) : enabled;
  if (requested && candidates.length === 0) throw new ResearchError(422, "CAPABILITY_UNSUPPORTED", `Provider ${requested} is not enabled on this server.`);
  const provider = candidates.find((p) => p.info.capabilities.includes(capability));
  if (!provider) {
    throw new ResearchError(422, "CAPABILITY_UNSUPPORTED", `${capability.replace(/_/g, " ")} is not supported by the enabled data source(s). It needs a licensed keyword data provider.`, {
      capability,
      providers: candidates.map((p) => p.info.id),
    });
  }
  const missing = provider.missingConfiguration();
  if (missing.length) throw new ResearchError(503, "PROVIDER_NOT_CONFIGURED", `${provider.info.name} is not configured (missing: ${missing.join(", ")}).`, { missing });
  return provider;
}
