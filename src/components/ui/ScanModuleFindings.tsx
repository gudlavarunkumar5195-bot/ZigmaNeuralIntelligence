import { useEffect, useState } from "react";
import { ApiCallError, apiGetDashboard, apiGetFindings, IntegrationRequired } from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { PageHeader } from "./Card";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "./DataState";
import { SeverityBadge } from "./StatusBadge";

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
    <div className="max-w-4xl">
      <PageHeader eyebrow="Latest scan findings" title={title} subtitle={domain ?? undefined} />
      {findings.length === 0 ? (
        <EmptyState
          title="No findings"
          description={domain ? "The latest scan recorded no findings for this module." : "Run a scan on a verified website to see results."}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
          {findings.map((finding) => (
            <li key={finding.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-600 text-slate-900">{finding.title}</h2>
                <SeverityBadge severity={finding.severity} />
              </div>
              {finding.description ? <p className="mt-2 text-xs leading-5 text-slate-600">{finding.description}</p> : null}
              {finding.recommendation ? <p className="mt-2 text-xs leading-5 text-slate-700">Recommendation: {finding.recommendation}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
