import { useEffect, useState } from "react";
import { FileBarChart, ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { apiGetDashboard, apiGetReport, ApiCallError, IntegrationRequired } from "../../services/api";

type Report = {
	scan: { id: string; domain: string; status: string; completed_at: string | null };
	scores: Array<{ category: string; score: number | null; status: string; finding_count: number; critical_count: number }>;
	findings: Array<{ id: string; title: string; severity: string; recommendation: string; module_name: string }>;
};

export function ReportsPage() {
	const [report, setReport] = useState<Report | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(true);

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const dashboard = await apiGetDashboard();
			if (dashboard.error) throw new ApiCallError(0, dashboard.error.code, dashboard.error.message);
			const scanId = dashboard.data?.selectedWebsite?.latest_scan_id;
			if (!scanId) { setReport(null); return; }
			const result = await apiGetReport(scanId);
			if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
			setReport(result.data as Report);
		} catch (cause) { setError(cause as Error); }
		finally { setLoading(false); }
	};

	useEffect(() => { void load(); }, []);
	if (loading) return <LoadingState label="Loading report…" />;
	if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Reports" />;
	if (error) return <ErrorState title="Unable to load report" message={error.message} onRetry={load} />;
	if (!report) return <div className="p-6"><EmptyState title="No completed scan report" description="Run a scan to generate a report for your selected website." /></div>;

	return <div className="mx-auto max-w-6xl animate-slide-in">
		<header className="hero-shell mb-6 rounded-[28px] border border-blue-100 p-6 md:p-8">
			<div className="brand-chip w-fit"><FileBarChart size={12} /> Latest intelligence report</div>
			<h2 className="mt-4 text-3xl font-800 tracking-[-0.05em] text-slate-950">{report.scan.domain}</h2>
			<p className="mt-2 text-sm text-slate-600">{report.scan.status} · {report.scan.completed_at ? new Date(report.scan.completed_at).toLocaleString() : "In progress"}</p>
		</header>
		<section className="data-grid">
			{report.scores.map((score) => <div key={score.category} className="card-panel col-span-6 p-5 sm:col-span-3"><span className="text-xs font-700 uppercase tracking-[0.12em] text-slate-500">{score.category}</span><strong className="mt-2 block text-3xl font-800 text-blue-600">{score.score ?? "—"}</strong><span className="text-xs text-slate-500">{score.finding_count} findings</span></div>)}
		</section>
		<section className="card-panel mt-6 p-5 md:p-6"><div className="mb-4 flex items-center gap-2"><ShieldCheck size={16} className="text-blue-600" /><h3 className="font-800 text-slate-900">Findings and recommendations</h3></div>{report.findings.length ? <div className="space-y-3">{report.findings.map((finding) => <article key={finding.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-700 text-slate-900">{finding.title}</h4><span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-700 uppercase text-blue-700">{finding.severity}</span></div><p className="mt-2 text-xs leading-5 text-slate-600">{finding.recommendation || "Review this finding and apply the recommended remediation."}</p><span className="mt-2 block font-mono text-[10px] uppercase text-slate-400">{finding.module_name}</span></article>)}</div> : <EmptyState title="No findings" description="This scan did not produce any findings." />}</section>
	</div>;
}
