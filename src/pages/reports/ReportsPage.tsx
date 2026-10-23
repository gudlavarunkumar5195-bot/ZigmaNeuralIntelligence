import { useEffect, useState } from "react";
import { Printer, ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { PageHeader } from "../../components/ui/Card";
import { KpiCard } from "../../components/ui/Kpi";
import { Badge, Notice } from "../../components/ui/Primitives";
import { SeverityBadge, StatusBadge } from "../../components/ui/StatusBadge";
import { buttonClass, card } from "../../components/ui/styles";
import { setSelectedWebsiteId, useSelectedWebsiteId } from "../../lib/selectedWebsite";
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
	const selectedId = useSelectedWebsiteId();
	// The website shown instead of a selection that no longer exists (cleared once the user selects another).
	const [replacedTo, setReplacedTo] = useState<string | null>(null);

	const load = async () => {
		setLoading(true);
		setError(null);
		if (selectedId !== replacedTo) setReplacedTo(null);
		try {
			const dashboard = await apiGetDashboard(selectedId);
			if (dashboard.error) throw new ApiCallError(dashboard.error.status ?? 0, dashboard.error.code, dashboard.error.message);
			// An unknown id is answered with the newest site: make that the selection and say so.
			const shown = dashboard.data?.selectedWebsite?.id;
			if (selectedId && shown && shown !== selectedId) {
				setReplacedTo(shown);
				setSelectedWebsiteId(shown);
			}
			const scanId = dashboard.data?.selectedWebsite?.latest_scan_id;
			if (!scanId) { setReport(null); return; }
			const result = await apiGetReport(scanId);
			if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
			setReport(result.data as Report);
		} catch (cause) { setError(cause as Error); }
		finally { setLoading(false); }
	};

	useEffect(() => { void load(); }, [selectedId]);
	if (loading) return <LoadingState label="Loading report…" />;
	if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Reports" />;
	if (error) return <ErrorState title="Unable to load report" message={error.message} onRetry={load} />;
	if (!report) return <EmptyState title="No completed scan report" description="Run a scan to generate a report for your selected website." />;

	return <div className="animate-slide-in">
		{replacedTo && replacedTo === selectedId ? <div className="mb-4"><Notice tone="warning">The website you had selected is no longer available, so this report is for {report.scan.domain}.</Notice></div> : null}
		<PageHeader eyebrow="Latest intelligence report" title={report.scan.domain}
			subtitle={<><StatusBadge status={report.scan.status} /> · {report.scan.completed_at ? `Completed ${new Date(report.scan.completed_at).toLocaleString()}` : "In progress"}</>}
			action={<button type="button" onClick={() => window.print()} className={`${buttonClass("secondary", "md")} print:hidden`}><Printer size={14} aria-hidden="true" />Print</button>} />
		<section aria-label="Scores" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
			{report.scores.map((score) => <KpiCard key={score.category} label={score.category} value={score.score ?? "—"} footer={`${score.finding_count} findings${score.critical_count ? ` · ${score.critical_count} critical` : ""}`} />)}
		</section>
		<section className={`${card} mt-5`} aria-labelledby="report-findings">
			<div className="mb-3 flex items-center gap-2"><ShieldCheck size={16} className="text-blue-600" aria-hidden="true" /><h2 id="report-findings" className="text-section-title text-slate-900">Findings and recommendations</h2></div>
			{report.findings.length ? <ul className="divide-y divide-slate-100">{report.findings.map((finding) => <li key={finding.id} className="py-3 first:pt-0 last:pb-0"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-600 text-slate-900">{finding.title}</h3><SeverityBadge severity={finding.severity} /></div><p className="mt-1 text-xs leading-5 text-slate-600">{finding.recommendation || "Review this finding and apply the recommended remediation."}</p><span className="mt-1.5 inline-block"><Badge>{finding.module_name}</Badge></span></li>)}</ul> : <EmptyState title="No findings" description="This scan did not produce any findings." />}
		</section>
	</div>;
}
