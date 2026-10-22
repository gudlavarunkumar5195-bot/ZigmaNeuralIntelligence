import { useCallback, useEffect, useState } from "react";
import { NavLink, useParams } from "react-router";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../../components/ui/DataState";
import { apiBacklinkSummary, IntegrationRequired, type BacklinkSummary } from "../../../services/api";
import { useWebsites } from "../research/shared";
import { ChangesTab, DomainsTab, GapTab, ImportsTab, LinksTab, OpportunitiesTab, OverviewTab, SourcesTab } from "./tabs";

export const BACKLINK_TABS = [
  { id: "overview", label: "Overview" },
  { id: "links", label: "Backlinks" },
  { id: "domains", label: "Referring domains" },
  { id: "gap", label: "Competitor gap" },
  { id: "changes", label: "New & lost" },
  { id: "opportunities", label: "Opportunities" },
  { id: "imports", label: "Imports" },
  { id: "sources", label: "Data sources" },
] as const;
export type BacklinkTab = (typeof BACKLINK_TABS)[number]["id"];

/**
 * Backlink intelligence: imported, authorized datasets and our own live link
 * checks. Every figure names its dataset; nothing is estimated.
 */
export function BacklinkIntelligencePage() {
  const { tab: rawTab } = useParams();
  const tab: BacklinkTab = (BACKLINK_TABS.find((t) => t.id === rawTab)?.id ?? "overview") as BacklinkTab;
  const { websites, websiteId, setWebsiteId, error: siteError } = useWebsites();
  const [summary, setSummary] = useState<BacklinkSummary | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!websiteId) return;
    setError(null);
    setSummary(null);
    try {
      const r = await apiBacklinkSummary(websiteId);
      if (r.error) throw new Error(r.error.message);
      setSummary(r.data);
    } catch (e) {
      setError(e as Error);
    }
  }, [websiteId]);
  useEffect(() => void load(), [load]);

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Backlink intelligence" />;
  if (siteError) return <ErrorState title="Unable to load websites" message={siteError} />;
  if (!websites) return <LoadingState label="Loading websites…" />;
  if (websites.length === 0) return <EmptyState title="No websites yet" description="Add and verify a website to analyse its backlinks." />;

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Search data</p>
          <h2 className="mt-2 text-2xl font-800 text-slate-950">Backlink intelligence</h2>
        </div>
        <label className="text-xs text-slate-700">
          Website
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm">
            {websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}
          </select>
        </label>
      </div>

      <nav aria-label="Backlink sections" className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {BACKLINK_TABS.map((t) => (
          <NavLink
            key={t.id}
            to={t.id === "overview" ? "/search/backlinks" : `/search/backlinks/${t.id}`}
            end
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-xs font-700 ${tab === t.id ? "border-blue-600 text-blue-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      {error ? (
        <ErrorState title="Unable to load backlink data" message={error.message} onRetry={load} />
      ) : !summary ? (
        <LoadingState label="Loading backlink data…" />
      ) : (
        <div className="mt-4">
          {tab !== "imports" && tab !== "sources" && summary.own?.dataset ? <DatasetBanner summary={summary} /> : null}
          {tab === "overview" && <OverviewTab websiteId={websiteId} summary={summary} onChanged={load} />}
          {tab === "links" && <LinksTab websiteId={websiteId} summary={summary} />}
          {tab === "domains" && <DomainsTab websiteId={websiteId} summary={summary} />}
          {tab === "gap" && <GapTab websiteId={websiteId} summary={summary} />}
          {tab === "changes" && <ChangesTab websiteId={websiteId} summary={summary} />}
          {tab === "opportunities" && <OpportunitiesTab websiteId={websiteId} summary={summary} />}
          {tab === "imports" && <ImportsTab websiteId={websiteId} summary={summary} onImported={load} />}
          {tab === "sources" && <SourcesTab websiteId={websiteId} />}
        </div>
      )}
    </div>
  );
}

function DatasetBanner({ summary }: { summary: BacklinkSummary }) {
  const d = summary.own!.dataset;
  return (
    <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
      Your backlink data: <strong>{d.source_label}</strong>, {d.exported_at ? `exported ${d.exported_at}` : `imported ${new Date(d.retrieved_at).toLocaleDateString()}`} · {d.coverage === "complete" ? "declared complete" : d.coverage === "partial" ? "partial (a sample)" : "coverage unknown"}
      {d.observed_from ? ` · links seen ${d.observed_from} – ${d.observed_to}` : ""}
      {d.stale ? <span role="status" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-700 text-amber-900">Older than {summary.staleAfterDays} days: import a fresh export</span> : null}
    </div>
  );
}
