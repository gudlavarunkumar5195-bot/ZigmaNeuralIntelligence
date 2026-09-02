import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { CalendarClock } from "lucide-react";
import { apiGetDashboard, ApiCallError, DashboardData, IntegrationRequired } from "../../services/api";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";

export function ScanHistory() {
  const navigate = useNavigate(); const [data, setData] = useState<DashboardData | null>(null); const [error, setError] = useState<Error | null>(null);
  const load = async () => { try { const result = await apiGetDashboard(); if (result.error) throw new ApiCallError(0, result.error.code, result.error.message); setData(result.data); } catch (cause) { setError(cause as Error); } };
  useEffect(() => { void load(); }, []); if (!data && !error) return <LoadingState label="Loading scan history…" />; if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Scan history" />; if (error) return <ErrorState title="Unable to load scan history" message={error.message} onRetry={load} />;
  const scans = data?.websites.filter((site) => site.latest_scan_id) ?? [];
  return <div className="mx-auto max-w-6xl p-5 md:p-8"><header className="mb-8 border-b border-slate-200 pb-6"><p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Tenant activity</p><h2 className="mt-2 flex items-center gap-2 text-2xl font-800 text-slate-950"><CalendarClock size={22} />Latest scans</h2></header>{!scans.length ? <EmptyState title="No scan results yet" description="Start a scan from a verified website to create history." /> : <div className="divide-y divide-slate-200 border-y border-slate-200">{scans.map((scan) => <button key={scan.id} onClick={() => navigate(`/websites/scan/${scan.latest_scan_id}`)} className="grid w-full grid-cols-[1fr_auto] gap-3 py-4 text-left hover:bg-slate-50"><div><p className="font-700 text-slate-900">{scan.domain}</p><p className="mt-1 text-xs text-slate-500">{scan.completed_at ? new Date(scan.completed_at).toLocaleString() : "In progress"}</p></div><div className="text-right"><strong className="text-lg text-slate-900">{scan.overall_score ?? "—"}</strong><p className="text-[10px] uppercase text-slate-400">{scan.latest_scan_status}</p></div></button>)}</div>}</div>;
}
