import { useEffect, useState } from "react";
import { ApiCallError, apiGetDashboard, apiGetFindings, IntegrationRequired } from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "./DataState";

type Finding = {
  id: string;
  title: string;
  severity: string;
  description?: string;
  recommendation?: string;
  module_name: string;
};

/** Lists real findings for one scan module from the latest scan of the selected website. */
export function ScanModuleFindings({ title, moduleName }: { title: string; moduleName: string }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const selectedId = useSelectedWebsiteId();

  const load = async () => {
    setError(null);
    setFindings(null);
    try {
      const dashboard = await apiGetDashboard(selectedId);
      if (dashboard.error) throw new ApiCallError(0, dashboard.error.code, dashboard.error.message);
      const site = dashboard.data?.selectedWebsite;
      if (!site?.latest_scan_id) {
        setFindings([]);
        setDomain(null);
        return;
      }
      setDomain(site.domain);
      const result = await apiGetFindings(site.latest_scan_id);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      const all = (result.data ?? []) as Finding[];
      setFindings(all.filter((finding) => finding.module_name === moduleName));
    } catch (cause) {
      setError(cause as Error);
    }
  };
  useEffect(() => {
    void load();
  }, [selectedId]);

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature={title} />;
  if (error) return <ErrorState title={`Unable to load ${title.toLowerCase()}`} message={error.message} onRetry={load} />;
  if (!findings) return <LoadingState label={`Loading ${title.toLowerCase()}...`} />;

  return (
    <div className="mx-auto max-w-4xl p-6 md:p-10">
      <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">{title}</p>
      {domain ? <h2 className="mt-2 text-2xl font-800 text-slate-950">{domain}</h2> : null}
      {findings.length === 0 ? (
        <EmptyState
          title="No findings"
          description={domain ? "The latest scan recorded no findings for this module." : "Run a scan on a verified website to see results."}
        />
      ) : (
        <div className="mt-6 space-y-3">
          {findings.map((finding) => (
            <article key={finding.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-700 text-slate-900">{finding.title}</h3>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-700 uppercase text-blue-700">{finding.severity}</span>
              </div>
              {finding.description ? <p className="mt-2 text-xs leading-5 text-slate-600">{finding.description}</p> : null}
              {finding.recommendation ? <p className="mt-2 text-xs leading-5 text-slate-700">Recommendation: {finding.recommendation}</p> : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
