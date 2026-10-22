import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { PageHeader } from "../../../components/ui/Card";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../../components/ui/DataState";
import { RouteTabs } from "../../../components/ui/Primitives";
import { input } from "../../../components/ui/styles";
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
    <div>
      <PageHeader eyebrow="SEO Research" title="Backlink intelligence" subtitle="Backlinks and referring domains from authorized imports, with live link checks, change history and competitor gaps. Coverage is never presented as internet-wide."
        action={<label className="text-xs font-600 text-slate-700">
          Website
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className={input}>
            {websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}
          </select>
        </label>} />
      <RouteTabs label="Backlink sections" current={tab} tabs={BACKLINK_TABS.map((t) => ({ id: t.id, label: t.label, to: t.id === "overview" ? "/search/backlinks" : `/search/backlinks/${t.id}` }))} />

      {error ? (
        <div className="mt-5"><ErrorState title="Unable to load backlink data" message={error.message} onRetry={load} /></div>
      ) : !summary ? (
        <LoadingState label="Loading backlink data…" />
      ) : (
        <div className="mt-5">
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
    <div className="mb-4 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 shadow-sm">
      Your backlink data: <strong>{d.source_label}</strong>, {d.exported_at ? `exported ${d.exported_at}` : `imported ${new Date(d.retrieved_at).toLocaleDateString()}`} · {d.coverage === "complete" ? "declared complete" : d.coverage === "partial" ? "partial (a sample)" : "coverage unknown"}
      {d.observed_from ? ` · links seen ${d.observed_from} – ${d.observed_to}` : ""}
      {d.stale ? <span role="status" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-700 text-amber-900">Older than {summary.staleAfterDays} days: import a fresh export</span> : null}
    </div>
  );
}
