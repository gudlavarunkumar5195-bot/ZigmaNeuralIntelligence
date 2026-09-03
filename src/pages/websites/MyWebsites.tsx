import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ExternalLink, Globe2, Plus, ScanLine } from "lucide-react";
import {
  apiCreateScan,
  apiQaVerifyWebsite,
  apiGetDashboard,
  ApiCallError,
  DashboardData,
  IntegrationRequired,
  isAuthenticated,
} from "../../services/api";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { ScoreRing } from "../../components/ui/ScoreRing";
import { StatusBadge } from "../../components/ui/StatusBadge";

export function MyWebsites() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = async () => {
    setError(null);
    try {
      if (!isAuthenticated()) {
        navigate("/login", { replace: true });
        return;
      }
      const result = await apiGetDashboard();
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setData(result.data);
    } catch (cause) {
      setError(cause as Error);
    }
  };

  useEffect(() => {
    void load();
  }, [navigate]);

  const startScan = async (siteId: string) => {
    try {
      const result = await apiCreateScan(siteId, ["seo", "security", "performance", "ssl"]);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      if (result.data?.id) {
        navigate(`/websites/scan/${result.data.id}`);
        return;
      }
      navigate("/websites/history");
    } catch (cause) {
      setError(cause as Error);
    }
  };

  const qaVerify = async (siteId: string) => {
    try {
      const result = await apiQaVerifyWebsite(siteId);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      await load();
    } catch (cause) {
      setError(cause as Error);
    }
  };

  if (!data && !error) return <LoadingState label="Loading your websites…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Websites" />;
  if (error) return <ErrorState title="Unable to load websites" message={error.message} onRetry={load} />;

  return (
    <div className="mx-auto max-w-6xl p-5 md:p-8 animate-slide-in">
      <header className="mb-8 flex items-end justify-between border-b border-slate-200 pb-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Tenant inventory</p>
          <h2 className="mt-2 text-2xl font-800 text-slate-950">Websites</h2>
        </div>
        <button onClick={() => navigate("/websites/add")} className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-700 text-white">
          <Plus size={15} />
          Add website
        </button>
      </header>

      {!data?.websites.length ? (
        <EmptyState
          title="No websites connected"
          description="Add a verified website to begin collecting intelligence."
          action={
            <button onClick={() => navigate("/websites/add")} className="rounded bg-primary px-3 py-2 text-sm font-700 text-white">
              Add Website
            </button>
          }
        />
      ) : (
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          {data.websites.map((site) => (
            <article key={site.id} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                <div>
                  {site.overall_score === null ? (
                    <div className="grid h-14 w-14 place-items-center rounded-full border-4 border-slate-100 text-xl text-slate-400">—</div>
                  ) : (
                    <ScoreRing score={site.overall_score} size={56} strokeWidth={4} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Globe2 size={15} className="text-blue-600" />
                    <h3 className="font-800 text-slate-900">{site.domain}</h3>
                    <a href={site.url} target="_blank" rel="noreferrer" aria-label={`Open ${site.domain}`}>
                      <ExternalLink size={13} className="text-slate-400" />
                    </a>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {site.latest_scan_status
                      ? `${site.latest_scan_status} · ${site.finding_count} findings · ${site.critical_count} critical`
                      : "No scan results yet"}
                  </p>
                </div>
              </div>

              <div className="sm:ml-auto">
                <StatusBadge status={site.latest_scan_status ?? (site.verified ? "verified" : "unverified")} />
              </div>

              <button
                onClick={() => {
                  if (!site.latest_scan_id) {
                    void startScan(site.id);
                    return;
                  }
                  navigate(`/websites/scan/${site.latest_scan_id}`);
                }}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-700 text-slate-700 shadow-sm hover:bg-slate-50"
              >
                <ScanLine size={14} />
                {site.latest_scan_id ? "Open scan" : "Start scan"}
              </button>
              {!site.verified && (
                <button
                  onClick={() => void qaVerify(site.id)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-700 text-amber-800 shadow-sm hover:bg-amber-100"
                >
                  QA verify
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
