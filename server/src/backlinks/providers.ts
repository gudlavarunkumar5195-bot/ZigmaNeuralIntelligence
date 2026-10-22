import { capabilityAvailable } from "../platform/integrations.js";

/**
 * Backlink data sources. A source declares what it can supply; the
 * application shows only that. Licensed providers would plug in here and
 * take their credentials from the central integration registry
 * (server/src/platform), never from this module or from users.
 */

export type BacklinkCapability = "link_list" | "referring_domains" | "link_attributes" | "first_last_seen" | "history" | "competitor_data" | "live_verification";

export interface BacklinkSourceInfo {
  id: string;
  name: string;
  kind: "import" | "first_party" | "licensed" | "verification";
  status: "available" | "not_configured" | "not_supported";
  capabilities: BacklinkCapability[];
  explanation: string;
  setup: string | null;
  costNote: string;
}

export function backlinkSources(): BacklinkSourceInfo[] {
  return [
    {
      id: "csv_import",
      name: "CSV import of an authorized export",
      kind: "import",
      status: "available",
      capabilities: ["link_list", "referring_domains", "link_attributes", "first_last_seen", "history", "competitor_data"],
      explanation:
        "Upload a backlink export you are entitled to use: Google Search Console (Links → Latest links), Ahrefs, Semrush, Majestic or any CSV with a source URL column. Attributes and dates are kept only when the export contains them.",
      setup: null,
      costNote: "No cost.",
    },
    {
      id: "link_verification",
      name: "Live link check (ZigmaNeural)",
      kind: "verification",
      status: "available",
      capabilities: ["live_verification"],
      explanation: "Fetches the linking page (SSRF-protected, robots.txt honoured, bounded) to confirm the link is present now, and records its attributes and anchor.",
      setup: null,
      costNote: "No provider cost; it requests each linking page once per check.",
    },
    {
      id: "google_search_console",
      name: "Google Search Console API",
      kind: "first_party",
      status: "not_supported",
      capabilities: [],
      explanation: "The Search Console API has no links endpoint. Google's link data is only available as a CSV export from the Search Console interface, which can be imported.",
      setup: "In Search Console: Links → External links → Latest links → Export → CSV, then import it here.",
      costNote: "No cost.",
    },
    {
      id: "licensed_backlink_index",
      name: "Licensed backlink index (Ahrefs, Semrush, Majestic, DataForSEO…)",
      kind: "licensed",
      status: capabilityAvailable("backlink_index") ? "available" : "not_configured",
      capabilities: [],
      explanation: "No licensed backlink provider is integrated. Automatic refresh, competitor discovery and provider metrics (for example authority scores) require one; none are estimated.",
      setup: "Choose a provider and approve its cost; its key would then be entered once in Admin → Integrations & API Keys. See docs/BACKLINKS.md.",
      costNote: "Paid; requires explicit approval.",
    },
  ];
}
