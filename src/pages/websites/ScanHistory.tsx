import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { apiGetDashboard, ApiCallError, DashboardData, IntegrationRequired } from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { PageHeader } from "../../components/ui/Card";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { StatusBadge } from "../../components/ui/StatusBadge";

/** Latest scan per website (the dashboard read model); opens the scan's progress and results. */
export function ScanHistory() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const selectedId = useSelectedWebsiteId();
  const load = async () => {
    setError(null);
    try {
      const result = await apiGetDashboard(selectedId);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setData(result.data);
    } catch (cause) {
      setError(cause as Error);
    }
  };
  useEffect(() => { void load(); }, [selectedId]);
  if (!data && !error) return <LoadingState label="Loading scan history…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Scan history" />;
  if (error) return <ErrorState title="Unable to load scan history" message={error.message} onRetry={load} />;
  const activeId = data?.selectedWebsite?.id;
  const scans = data?.websites.filter((site) => site.latest_scan_id) ?? [];
  return (
    <div>
      <PageHeader eyebrow="Projects & Domains" title="Latest scans" subtitle="The most recent scan of each website. Open one to see its progress and results." />
      {!scans.length ? <EmptyState title="No scan results yet" description="Start a scan from a verified website to create history." /> : (
        <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {scans.map((scan) => (
            <li key={scan.id} className="border-b border-slate-100 last:border-b-0">
              <button onClick={() => navigate(`/websites/scan/${scan.latest_scan_id}`)} aria-current={scan.id === activeId ? "true" : undefined}
                className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${scan.id === activeId ? "bg-blue-50/60" : ""}`}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-600 text-slate-900">{scan.domain}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{scan.completed_at ? new Date(scan.completed_at).toLocaleString() : "In progress"}</span>
                </span>
                <span className="text-right">
                  <span className="block text-lg font-700 tabular-nums text-slate-900">{scan.overall_score ?? "—"}</span>
                  {scan.latest_scan_status ? <StatusBadge status={scan.latest_scan_status} /> : null}
                </span>
                <ChevronRight size={16} className="text-slate-400" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
