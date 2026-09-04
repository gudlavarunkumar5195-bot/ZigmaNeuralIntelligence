import { useEffect, useState } from "react";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { apiListMonitoring, apiListMonitoringChanges, ApiCallError, IntegrationRequired, MonitoringChange } from "../../services/api";

export function ChangesPage() {
	const [items, setItems] = useState<MonitoringChange[] | null>(null); const [error, setError] = useState<Error | null>(null);
	const load = async () => { try { const configs = await apiListMonitoring(); if (configs.error) throw new ApiCallError(0, configs.error.code, configs.error.message); const config = configs.data?.[0]; if (!config) { setItems([]); return; } const result = await apiListMonitoringChanges(config.id); if (result.error) throw new ApiCallError(0, result.error.code, result.error.message); setItems(result.data ?? []); } catch (cause) { setError(cause as Error); } };
	useEffect(() => { void load(); }, []);
	if (!items && !error) return <LoadingState label="Loading changes..." />; if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Change detection" />; if (error) return <ErrorState title="Unable to load changes" message={error.message} onRetry={load} />;
	return <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8"><h2 className="mb-6 text-3xl font-800 tracking-[-0.05em] text-slate-950">Change detection</h2>{items?.length ? <section className="space-y-3">{items.map((item) => <article key={item.id} className="card-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-800 text-slate-900">{item.change_type.replaceAll("_", " ")}</h3><span className="text-xs font-700 uppercase text-blue-700">{item.severity} · {item.domain}</span></div><p className="mt-2 text-sm text-slate-600">{item.impact}</p><p className="mt-2 text-xs text-slate-500">{new Date(item.detected_at).toLocaleString()} · {item.affected_urls.join(", ") || "No URL-specific scope"}</p></article>)}</section> : <EmptyState title="No detected changes" description="Changes will appear after a valid monitoring baseline and a later completed scan." />}</div>;
}
