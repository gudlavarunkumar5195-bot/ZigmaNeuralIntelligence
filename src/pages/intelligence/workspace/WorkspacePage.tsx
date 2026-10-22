import { useState } from "react";
import { NavLink, useLocation, useParams } from "react-router";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/DataState";
import { setSelectedWebsiteId } from "../../../lib/selectedWebsite";
import type { WsRangeParams } from "../../../services/api";
import { useWebsites } from "../../search/research/shared";
import { ActionsTab, IntegrationsTab, InsightsTab, OverviewTab, ReportTab } from "./tabs";
import { btn, input, useRange } from "./ui";

export const WORKSPACE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "insights", label: "Insights" },
  { id: "actions", label: "Action center" },
  { id: "integrations", label: "Integration health" },
  { id: "report", label: "Report" },
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]["id"];

function RangeControls({ range, onChange }: { range: WsRangeParams; onChange: (r: WsRangeParams) => void }) {
  const [custom, setCustom] = useState({ from: range.from ?? "", to: range.to ?? "" });
  const [error, setError] = useState<string | null>(null);
  const applyCustom = () => {
    if (!custom.from || !custom.to) return setError("Choose both dates.");
    if (custom.from > custom.to) return setError("The start date is after the end date.");
    setError(null);
    onChange({ ...range, preset: "custom", from: custom.from, to: custom.to });
  };
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Date range">
      <label className="text-xs text-slate-700">Range
        <select value={range.preset} onChange={(e) => { const p = e.target.value as WsRangeParams["preset"]; if (p !== "custom") onChange({ ...range, preset: p }); else onChange({ ...range, preset: "custom", from: custom.from || undefined, to: custom.to || undefined }); }} className={input}>
          <option value="7d">Last 7 days</option><option value="28d">Last 28 days</option><option value="90d">Last 90 days</option><option value="custom">Custom</option>
        </select>
      </label>
      {range.preset === "custom" ? (
        <>
          <label className="text-xs text-slate-700">From<input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={input} /></label>
          <label className="text-xs text-slate-700">To<input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={input} /></label>
          <button type="button" className={btn} onClick={applyCustom}>Apply</button>
        </>
      ) : null}
      <label className="flex items-center gap-1 text-xs text-slate-700"><input type="checkbox" checked={range.compare === "previous"} onChange={(e) => onChange({ ...range, compare: e.target.checked ? "previous" : "none" })} /> Compare with previous period</label>
      {error ? <span role="alert" className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}

/**
 * Unified SEO workspace: one website, one date range, every module's real
 * data with its freshness, plus cross-module insights, an action center,
 * integration health and reports.
 */
export function WorkspacePage() {
  const { tab: rawTab } = useParams();
  const location = useLocation();
  const tab: WorkspaceTab = (WORKSPACE_TABS.find((t) => t.id === rawTab)?.id ?? "overview") as WorkspaceTab;
  const { websites, websiteId, setWebsiteId, error } = useWebsites();
  const [range, setRange] = useRange();
  if (error) return <ErrorState title="Unable to load websites" message={error} />;
  if (!websites) return <LoadingState label="Loading websites…" />;
  if (!websites.length) return <EmptyState title="No websites yet" description="Add and verify a website first; the workspace brings together the data collected for it." />;
  const site = websites.find((w) => w.id === websiteId);
  const qs = location.search;
  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Intelligence</p>
          <h2 className="mt-2 text-2xl font-800 text-slate-950">SEO workspace</h2>
          {site ? <p className="mt-1 text-xs text-slate-600">{site.domain} · {site.verified ? "ownership verified" : "ownership not verified"}</p> : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">Website
            <select value={websiteId} onChange={(e) => { setWebsiteId(e.target.value); setSelectedWebsiteId(e.target.value); }} className={input}>{websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}</select>
          </label>
          <RangeControls key={`${range.preset}-${range.from}-${range.to}`} range={range} onChange={setRange} />
        </div>
      </div>
      <nav aria-label="Workspace sections" className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {WORKSPACE_TABS.map((t) => (
          <NavLink key={t.id} to={`${t.id === "overview" ? "/intelligence/workspace" : `/intelligence/workspace/${t.id}`}${qs}`} end aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-xs font-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${tab === t.id ? "border-blue-600 text-blue-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-4" key={websiteId}>
        {tab === "overview" && <OverviewTab websiteId={websiteId} range={range} />}
        {tab === "insights" && <InsightsTab websiteId={websiteId} range={range} />}
        {tab === "actions" && <ActionsTab websiteId={websiteId} />}
        {tab === "integrations" && <IntegrationsTab websiteId={websiteId} />}
        {tab === "report" && <ReportTab websiteId={websiteId} range={range} />}
      </div>
    </div>
  );
}
