import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { WsFreshness, WsRangeParams, WsRangePreset, WsSectionStatus } from "../../../services/api";

export const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-700 text-slate-800 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
export const btnPrimary = "rounded-md bg-slate-950 px-3 py-1.5 text-xs font-700 text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
export const input = "mt-1 block max-w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
export const card = "rounded-xl border border-slate-200 bg-white p-4";

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, { timeZone: iso.length === 10 ? "UTC" : undefined }) : "—");
/** Numbers: null/undefined is "No data", never 0. */
export const num = (v: number | null | undefined) => (v === null || v === undefined ? "No data" : v.toLocaleString());
export const pct = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "No data" : `${(v * 100).toFixed(digits)}%`);
export const signedPct = (v: number | null | undefined) => (v === null || v === undefined ? "no comparison" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export const SECTION_STATUS: Record<WsSectionStatus, { label: string; style: string }> = {
  ok: { label: "Up to date", style: "bg-emerald-50 text-emerald-800" },
  partial: { label: "Partial data", style: "bg-amber-50 text-amber-900" },
  no_data: { label: "No data yet", style: "bg-slate-100 text-slate-700" },
  not_configured: { label: "Not set up", style: "bg-slate-100 text-slate-700" },
  auth_expired: { label: "Reconnect needed", style: "bg-red-50 text-red-800" },
  error: { label: "Unavailable", style: "bg-red-50 text-red-800" },
  timeout: { label: "Timed out", style: "bg-red-50 text-red-800" },
};

export const HEALTH_STATE: Record<string, { label: string; style: string }> = {
  healthy: { label: "Connected and healthy", style: "bg-emerald-50 text-emerald-800" },
  stale: { label: "Connected but stale", style: "bg-amber-50 text-amber-900" },
  configuration_required: { label: "Configuration required", style: "bg-slate-100 text-slate-700" },
  auth_expired: { label: "Authentication expired", style: "bg-red-50 text-red-800" },
  provider_unavailable: { label: "Provider unavailable", style: "bg-red-50 text-red-800" },
  recent_job_failed: { label: "Recent job failed", style: "bg-red-50 text-red-800" },
  not_supported: { label: "Not supported", style: "bg-slate-100 text-slate-700" },
  unknown: { label: "Status unknown", style: "bg-slate-100 text-slate-700" },
};

export const CATEGORY_LABEL: Record<string, string> = {
  critical_technical: "Critical technical problems",
  page_improvement: "Page improvements",
  search_performance: "Search performance",
  keyword_ranking: "Keywords and rankings",
  content_gap: "Content gaps",
  backlink: "Backlinks",
  ai_visibility: "AI visibility",
  integration_data_quality: "Integrations and data quality",
};

export const MODULE_LABEL: Record<string, string> = {
  search_console: "Search Console", technical: "Technical", content: "Content", rankings: "Rankings", backlinks: "Backlinks", ai_visibility: "AI visibility", keywords: "Keyword research",
};

export function Pill({ text, style }: { text: string; style: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-700 ${style}`}>{text}</span>;
}

export function FreshnessText({ f }: { f: WsFreshness | null }) {
  if (!f) return null;
  if (f.state === "never") return <span className="text-[11px] text-slate-500">Never updated</span>;
  return <span className={`text-[11px] ${f.state === "stale" ? "text-amber-900" : "text-slate-500"}`}>Updated {fmt(f.lastUpdatedAt)}{f.state === "stale" ? " · stale" : ""}</span>;
}

/** Range in the URL so it survives navigation and reloads. */
export function useRange(): [WsRangeParams, (r: WsRangeParams) => void] {
  const [params, setParams] = useSearchParams();
  const range = useMemo<WsRangeParams>(() => {
    const preset = (["7d", "28d", "90d", "custom"].includes(params.get("preset") ?? "") ? params.get("preset") : "28d") as WsRangePreset;
    return { preset, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined, compare: params.get("compare") === "none" ? "none" : "previous" };
  }, [params]);
  const set = useCallback((r: WsRangeParams) => {
    const next = new URLSearchParams(params);
    next.set("preset", r.preset);
    next.set("compare", r.compare);
    if (r.preset === "custom" && r.from && r.to) { next.set("from", r.from); next.set("to", r.to); } else { next.delete("from"); next.delete("to"); }
    setParams(next, { replace: true });
  }, [params, setParams]);
  return [range, set];
}

/** Permission errors read as permission errors, not as failures. */
export const errorMessage = (e: { code: string; message: string }) =>
  e.code === "INSUFFICIENT_ROLE" || e.code === "FORBIDDEN" ? "Your role can view the SEO workspace but not change it." : e.message;
