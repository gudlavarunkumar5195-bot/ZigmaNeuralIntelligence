import {
  Activity, BarChart3, Bot, Cog, FileBarChart, FlaskConical, Globe, LayoutDashboard, LineChart, Radar, ShieldCheck, type LucideIcon,
} from "lucide-react";

/**
 * The single source of navigation: sidebar, collapsed rail, breadcrumbs,
 * page titles and the command launcher all read from here. Only real routes
 * are listed; routes without a backend are marked `unavailable` so the UI
 * labels them honestly instead of hiding or faking them.
 */

export interface NavItem {
  label: string;
  path: string;
  /** Matches nested routes (tabs, detail pages). */
  prefix?: boolean;
  unavailable?: boolean;
  /** Extra words for the command launcher. */
  keywords?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
  /** Shown in the lower "settings" area of the sidebar. */
  secondary?: boolean;
  adminOnly?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { label: "Dashboard", path: "/", keywords: "home scores overview" },
      { label: "SEO Workspace", path: "/intelligence/workspace", prefix: true, keywords: "unified dashboard insights actions report" },
    ],
  },
  {
    id: "research",
    label: "SEO Research",
    icon: LineChart,
    items: [
      { label: "Search performance", path: "/search/performance", keywords: "search console clicks impressions ctr" },
      { label: "Keywords", path: "/search/keywords", keywords: "keyword research" },
      { label: "Competitors", path: "/search/competitors", keywords: "keyword gap" },
      { label: "Rank tracking", path: "/search/rankings", prefix: true, keywords: "serp positions rankings" },
      { label: "Backlinks", path: "/search/backlinks", prefix: true, keywords: "links referring domains" },
    ],
  },
  {
    id: "intelligence",
    label: "Website Intelligence",
    icon: Radar,
    items: [
      { label: "Technical health", path: "/intelligence/technical-health", keywords: "crawl audit issues" },
      { label: "Content", path: "/intelligence/content", prefix: true, keywords: "inventory briefs topics" },
      { label: "AI Visibility", path: "/intelligence/ai-visibility", prefix: true, keywords: "ai search citations mentions" },
      { label: "SEO findings", path: "/intelligence/seo", keywords: "scan seo" },
      { label: "Security", path: "/intelligence/security" },
      { label: "Performance", path: "/intelligence/performance" },
      { label: "Accessibility", path: "/intelligence/accessibility", unavailable: true },
    ],
  },
  {
    id: "websites",
    label: "Projects & Domains",
    icon: Globe,
    items: [
      { label: "My Websites", path: "/websites", keywords: "projects domains verification" },
      { label: "Add Website", path: "/websites/add", keywords: "new scan verify" },
      { label: "Scan History", path: "/websites/history" },
      { label: "SSL / HTTPS", path: "/infrastructure/ssl" },
      { label: "Certificates", path: "/infrastructure/certificates", unavailable: true },
      { label: "Domains", path: "/infrastructure/domains", unavailable: true },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: Activity,
    items: [
      { label: "Website Health", path: "/monitoring" },
      { label: "Changes", path: "/monitoring/changes" },
      { label: "Alerts", path: "/monitoring/alerts" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileBarChart,
    items: [
      { label: "Reports", path: "/reports" },
      { label: "Client Reports", path: "/reports/client", unavailable: true },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart3,
    items: [
      { label: "Overview", path: "/analytics/overview", keywords: "analytics" },
      { label: "AI Usage", path: "/analytics/ai" },
      { label: "Model Routing", path: "/analytics/routing" },
      { label: "Scans", path: "/analytics/scans" },
      { label: "Monitoring", path: "/analytics/monitoring" },
    ],
  },
  {
    id: "agents",
    label: "AI Agents",
    icon: Bot,
    items: [
      { label: "Control Center", path: "/agents/control-center", unavailable: true },
      { label: "Agent Registry", path: "/agents/agent-registry" },
      { label: "Model Router", path: "/agents/model-router" },
      { label: "Model Registry", path: "/agents/model-registry" },
      { label: "Model Benchmarks", path: "/agents/model-benchmarks", unavailable: true },
      { label: "Instructions", path: "/agents/instructions" },
      { label: "Evidence", path: "/agents/evidence" },
      { label: "Quality Control", path: "/agents/quality-control" },
    ],
  },
  {
    id: "testing",
    label: "Testing",
    icon: FlaskConical,
    items: [
      { label: "Browser Tests", path: "/testing/browser", unavailable: true },
      { label: "Regression", path: "/testing/regression", unavailable: true },
      { label: "Test Results", path: "/testing/results", unavailable: true },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Cog,
    secondary: true,
    items: [
      { label: "Workspace", path: "/settings/workspace" },
      { label: "Team", path: "/settings/team" },
      { label: "Security", path: "/settings/security" },
      { label: "API", path: "/settings/api" },
      { label: "Integrations", path: "/settings/integrations", keywords: "google search console connect" },
    ],
  },
  {
    // Platform-admin only; the backend enforces access on every request.
    id: "admin",
    label: "Administration",
    icon: ShieldCheck,
    secondary: true,
    adminOnly: true,
    items: [
      { label: "Control Center", path: "/admin/control-center", keywords: "diagnostics" },
      { label: "Integrations & API Keys", path: "/admin/integrations" },
      { label: "Users & Access", path: "/admin/users" },
      { label: "Infrastructure Health", path: "/admin/infrastructure/health" },
      { label: "PostgreSQL", path: "/admin/infrastructure/postgresql" },
      { label: "ClickHouse", path: "/admin/infrastructure/clickhouse" },
      { label: "Event Pipeline", path: "/admin/infrastructure/event-pipeline" },
      { label: "Migration Status", path: "/admin/infrastructure/migrations" },
      { label: "Configuration", path: "/admin/infrastructure/configuration" },
    ],
  },
];

/** Routes that are not in the menu but need a title and breadcrumb. */
const EXTRA: Array<{ match: (p: string) => boolean; group: string; label: string }> = [
  { match: (p) => p.startsWith("/websites/scan/"), group: "Projects & Domains", label: "Scan Progress" },
];

const matches = (item: NavItem, path: string) => (item.path === "/" ? path === "/" : path === item.path || (!!item.prefix && path.startsWith(`${item.path}/`)));

/** The menu entry for a path (longest match wins). */
export function findRoute(path: string): { group: NavGroup; item: NavItem } | null {
  let best: { group: NavGroup; item: NavItem } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (matches(item, path) && (!best || item.path.length > best.item.path.length)) best = { group, item };
    }
  }
  return best;
}

export function routeTitle(path: string): { group: string | null; title: string } {
  const r = findRoute(path);
  if (r) return { group: r.group.id === "overview" && r.item.path === "/" ? null : r.group.label, title: r.item.label };
  const extra = EXTRA.find((e) => e.match(path));
  if (extra) return { group: extra.group, title: extra.label };
  return { group: null, title: "ZigmaNeural" };
}

export function isGroupActive(group: NavGroup, path: string) {
  return group.items.some((i) => matches(i, path));
}
