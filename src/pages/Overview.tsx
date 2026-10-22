import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, ArrowRight, Bot, CircleDashed, Globe2, Play, Sparkles } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiCreateScan, apiGetDashboard, ApiCallError, DashboardData, IntegrationRequired, isAuthenticated } from "../services/api";
import { useSelectedWebsiteId } from "../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../components/ui/DataState";
import { PageHeader } from "../components/ui/Card";
import { KpiCard } from "../components/ui/Kpi";
import { Badge, ChartFrame, Notice } from "../components/ui/Primitives";
import { SeverityBadge } from "../components/ui/StatusBadge";
import { buttonClass, card } from "../components/ui/styles";

const dimensions: Array<[string, string, string]> = [["seo", "SEO", "/intelligence/seo"], ["ai-visibility", "AI visibility", "/intelligence/ai-visibility"], ["security", "Security", "/intelligence/security"], ["performance", "Performance", "/intelligence/performance"], ["accessibility", "Accessibility", "/intelligence/accessibility"], ["technical-health", "Technical health", "/intelligence/technical-health"], ["ssl", "SSL", "/infrastructure/ssl"], ["qa", "Quality", "/testing/results"]];

function scoreTone(value: number | null) { return value === null ? "text-slate-400" : value >= 90 ? "text-emerald-600" : value >= 75 ? "text-blue-600" : value >= 60 ? "text-amber-600" : "text-red-600"; }

export function Overview() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedWebsiteId = useSelectedWebsiteId();
  const websiteId = searchParams.get("websiteId") ?? selectedWebsiteId ?? undefined;
  const [scanError, setScanError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startScan = async (siteId: string) => {
    setScanError(null);
    setStarting(true);
    try {
      const result = await apiCreateScan(siteId, ["seo", "security", "performance", "ssl", "crawl"]);
      if (result.error) { setScanError(result.error.message); return; }
      if (result.data?.id) { navigate(`/websites/scan/${result.data.id}`); return; }
      setScanError("The scan was accepted but no scan id was returned.");
    } catch (cause) {
      setScanError((cause as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const load = async () => { setLoading(true); setError(null); try { if (!isAuthenticated()) { navigate("/login", { replace: true }); return; } const result = await apiGetDashboard(websiteId); if (result.error) throw new ApiCallError(0, result.error.code, result.error.message); setData(result.data); } catch (cause) { setError(cause as Error); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [navigate, websiteId]);
  const trend = useMemo(() => data?.history.map((point) => ({ date: new Date(point.captured_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }), score: point.overall_score })) ?? [], [data]);
  if (loading) return <LoadingState label="Loading website intelligence…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Dashboard" description="Connect the production API to load authenticated tenant intelligence." />;
  if (error) return <ErrorState title="Unable to load website intelligence" message={error.message} onRetry={load} />;
  if (!data?.selectedWebsite) return <EmptyState title="No websites connected" description="Add a verified website to begin collecting intelligence." action={<button onClick={() => navigate("/websites/add")} className={buttonClass("primary", "md")}>Add Website</button>} />;
  const site = data.selectedWebsite;
  const scoreMap = new Map(data.scores.map((score) => [score.category, score]));
  const score = site.overall_score;
  const measured = data.history.map((point) => point.overall_score).filter((v): v is number => v !== null);
  // Change and trend come from monitoring snapshots; show them only when the newest snapshot is this score.
  const trendMatchesScore = measured.length >= 2 && measured[measured.length - 1] === score;
  const healthDelta = trendMatchesScore ? measured[measured.length - 1] - measured[measured.length - 2] : null;
  // Count the dashboard dimensions only (scan_scores also has an "overall" row).
  const scored = dimensions.filter(([key]) => scoreMap.get(key)?.status === "scored").length;
  const lastScore = trend.length ? trend[trend.length - 1] : null;
  return <div className="animate-slide-in">
    <PageHeader eyebrow="Overview" title={<span className="inline-flex min-w-0 items-center gap-2.5"><span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Globe2 size={18} aria-hidden="true" /></span><span className="truncate">{site.domain}</span></span>}
      subtitle={<>{site.completed_at ? `Last analyzed ${new Date(site.completed_at).toLocaleString()}` : "No completed analysis yet"} · {site.verified ? <Badge tone="success" icon>Ownership verified</Badge> : <Badge tone="warning" icon>Ownership not verified</Badge>}</>}
      action={<>
        {site.latest_scan_id && <button onClick={() => navigate(`/websites/scan/${site.latest_scan_id}`)} className={buttonClass("secondary", "md")}>Open latest scan</button>}
        <button disabled={!site.verified || starting} onClick={() => void startScan(site.id)} className={buttonClass("primary", "md")}><Play size={14} aria-hidden="true" />{starting ? "Starting…" : "New scan"}</button>
      </>} />
    {!site.verified && <div className="mb-4"><Notice tone="warning" action={<button onClick={() => navigate("/websites")} className={buttonClass("secondary", "sm")}>Go to websites</button>}>Verify ownership of this website before scanning.</Notice></div>}
    {scanError && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{scanError}</p>}

    <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard label="Health score" value={score === null ? "—" : <>{score}<span className="ml-1 text-sm font-500 text-slate-400">/ 100</span></>}
        delta={healthDelta === null ? undefined : { value: healthDelta, format: "abs", better: "up", digits: 0 }} sparkline={trendMatchesScore ? data.history.map((point) => point.overall_score) : undefined}
        period={healthDelta === null ? undefined : "points vs previous snapshot"} source="Latest completed scan"
        footer={score === null ? "Score unavailable — run a completed scan to generate it." : undefined} />
      <KpiCard label="Findings" value={site.finding_count} source="Latest scan" />
      <KpiCard label="Critical findings" value={site.critical_count} source="Latest scan" />
      <KpiCard label="Dimensions measured" value={<>{scored}<span className="ml-1 text-sm font-500 text-slate-400">/ {dimensions.length}</span></>} source="Latest scan" footer="Unmeasured dimensions are shown as such below." />
    </section>

    <section className={`${card} mt-5`} aria-labelledby="dimensions-heading">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={16} className="text-blue-600" aria-hidden="true" />
        <h2 id="dimensions-heading" className="text-section-title text-slate-900">Intelligence dimensions</h2>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {dimensions.map(([key, label, path]) => {
          const item = scoreMap.get(key);
          return (
            <button key={key} onClick={() => navigate(path)} className="group rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <span className="block text-[11px] font-600 uppercase tracking-[0.1em] text-slate-500">{label}</span>
              {key === "accessibility"
                ? <><strong className="mt-1.5 block text-sm font-700 text-slate-500">Not measured</strong><span className="mt-1 block text-[11px] text-slate-500">No accessibility scan module</span></>
                : <><strong className={`mt-1.5 block text-2xl font-700 tabular-nums ${scoreTone(item?.score ?? null)}`}>{item?.score ?? "—"}</strong>
              <span className="mt-0.5 block text-[11px] text-slate-500">{item?.status === "scored" ? `${item.finding_count} findings` : "Not available"}</span></>}
            </button>
          );
        })}
      </div>
    </section>

    <section className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_0.8fr]">
      <div className={card}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-section-title text-slate-900">Priority actions</h2>
          <button onClick={() => navigate("/reports")} className={buttonClass("ghost", "sm")}>View all <ArrowRight size={12} aria-hidden="true" /></button>
        </div>
        {data.findings.length ? (
          <ul className="divide-y divide-slate-100">
            {data.findings.map((finding) => (
              <li key={finding.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <AlertTriangle size={16} aria-hidden="true" className={finding.severity === "critical" ? "mt-0.5 flex-shrink-0 text-red-600" : "mt-0.5 flex-shrink-0 text-amber-600"} />
                <div className="min-w-0">
                  <p className="text-sm font-600 text-slate-900">{finding.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600">{finding.recommendation || finding.description}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5"><SeverityBadge severity={finding.severity} /><Badge>{finding.module_name}</Badge></div>
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No findings from the latest scan" description="Run a scan to identify actions for this website." />}
      </div>

      <div className={card}>
        <div className="mb-3 flex items-center gap-2">
          <Bot size={16} className="text-blue-600" aria-hidden="true" />
          <h2 className="text-section-title text-slate-900">AI activity</h2>
        </div>
        {data.executions.length ? (
          <ul className="divide-y divide-slate-100">
            {data.executions.map((execution) => (
              <li key={execution.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <CircleDashed size={15} className="mt-0.5 text-slate-400" aria-hidden="true" />
                <div>
                  <p className="text-sm font-600 text-slate-800">{execution.agent_type}</p>
                  <p className="text-xs text-slate-500">{execution.status}{execution.model_id ? ` · ${execution.model_id}` : ""}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No agent activity yet" description="Agent activity appears once an execution is created." />}
      </div>
    </section>

    <section className={`${card} mt-5`}>
      {trend.length ? (
        <ChartFrame title="Score history" description="Overall health score per monitoring snapshot (0–100)."
          summary={`${trend.length} snapshot${trend.length === 1 ? "" : "s"}${lastScore ? `; latest ${lastScore.date}: ${lastScore.score ?? "not measured"}` : ""}.`} height={224}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="var(--zn-chart-grid)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--zn-text-muted)" }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "var(--zn-text-muted)" }} axisLine={false} tickLine={false} width={40} />
              <Tooltip />
              <Line type="monotone" dataKey="score" name="Health score" stroke="var(--zn-chart-1)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      ) : <><h2 className="mb-3 text-section-title text-slate-900">Score history</h2><EmptyState title="No score history yet" description="Run your first scan to start tracking intelligence over time." /></>}
    </section>
  </div>;
}
