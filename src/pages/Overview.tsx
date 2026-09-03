import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, ArrowRight, Bot, CircleDashed, Globe2, Play, ShieldCheck, Sparkles } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiCreateScan, apiGetDashboard, ApiCallError, DashboardData, IntegrationRequired, isAuthenticated } from "../services/api";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../components/ui/DataState";

const dimensions: Array<[string, string, string]> = [["seo", "SEO", "/intelligence/seo"], ["ai-visibility", "AI visibility", "/intelligence/ai-visibility"], ["security", "Security", "/intelligence/security"], ["performance", "Performance", "/intelligence/performance"], ["accessibility", "Accessibility", "/intelligence/accessibility"], ["technical-health", "Technical health", "/intelligence/technical-health"], ["ssl", "SSL", "/infrastructure/ssl"], ["qa", "Quality", "/testing/results"]];

function scoreTone(value: number | null) { return value === null ? "text-slate-400" : value >= 90 ? "text-emerald-600" : value >= 75 ? "text-blue-600" : value >= 60 ? "text-amber-600" : "text-red-600"; }

export function Overview() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const websiteId = searchParams.get("websiteId") ?? undefined;
  const load = async () => { setLoading(true); setError(null); try { if (!isAuthenticated()) { navigate("/login", { replace: true }); return; } const result = await apiGetDashboard(websiteId); if (result.error) throw new ApiCallError(0, result.error.code, result.error.message); setData(result.data); } catch (cause) { setError(cause as Error); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [navigate, websiteId]);
  const trend = useMemo(() => data?.history.map((point) => ({ date: new Date(point.captured_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }), score: point.overall_score })) ?? [], [data]);
  if (loading) return <LoadingState label="Loading website intelligence…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Dashboard" description="Connect the production API to load authenticated tenant intelligence." />;
  if (error) return <ErrorState title="Unable to load website intelligence" message={error.message} onRetry={load} />;
  if (!data?.selectedWebsite) return <div className="p-6 max-w-6xl mx-auto"><EmptyState title="No websites connected" description="Add a verified website to begin collecting intelligence." action={<button onClick={() => navigate("/websites/add")} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-700 text-white shadow-lg shadow-blue-500/15">Add Website</button>} /></div>;
  const site = data.selectedWebsite;
  const scoreMap = new Map(data.scores.map((score) => [score.category, score]));
  const score = site.overall_score;
  return <div className="mx-auto max-w-6xl animate-slide-in">
    <header className="hero-shell mb-8 rounded-[28px] border border-blue-100 p-6 md:p-8">
      <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="brand-chip w-fit">Website intelligence / live record</div>
          <h2 className="mt-4 flex items-center gap-2 text-2xl font-800 tracking-[-0.04em] text-slate-950 md:text-3xl">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/10 text-blue-600"><Globe2 size={20} /></div>
            {site.domain}
          </h2>
          <p className="mt-2 text-sm text-slate-600">{site.completed_at ? `Last analyzed ${new Date(site.completed_at).toLocaleString()}` : "No completed analysis yet"}</p>
        </div>
        <button onClick={async () => { if (!site.latest_scan_id) { const result = await apiCreateScan(site.id, ["seo", "security", "performance", "ssl"]); if (result.error) { setError(new ApiCallError(0, result.error.code, result.error.message)); return; } if (result.data?.id) { navigate(`/websites/scan/${result.data.id}`); return; } navigate("/websites/add"); return; } navigate(`/websites/scan/${site.latest_scan_id}`); }} className="primary-button inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-700 text-white"><Play size={14} />New scan</button>
      </div>
    </header>

    <section className="data-grid gap-5 pb-4">
      <div className="card-panel dark-surface col-span-12 p-6 md:col-span-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-blue-200">Executive health</p>
        <div className="mt-5 flex items-end gap-3">
          <strong className="text-5xl font-800 tracking-[-0.08em] text-white md:text-6xl">{score ?? "—"}</strong>
          {score !== null && <span className="mb-3 text-sm text-blue-100">/ 100</span>}
        </div>
        <p className="mt-4 text-sm text-slate-300">{score === null ? "Score unavailable — run a completed scan to generate it." : `${site.finding_count} recorded finding${site.finding_count === 1 ? "" : "s"} from the latest scan.`}</p>
      </div>

      <div className="card-panel col-span-12 p-4 md:col-span-8">
        <div className="mb-4 flex items-center gap-2 px-1">
          <Sparkles size={16} className="text-blue-600" />
          <h3 className="text-sm font-800 text-slate-900">Intelligence dimensions</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {dimensions.map(([key, label, path]) => {
            const item = scoreMap.get(key);
            return (
              <button key={key} onClick={() => navigate(path)} className="group rounded-2xl border border-slate-200 bg-slate-50/60 p-3 text-left transition-all hover:border-blue-200 hover:bg-blue-50/60">
                <span className="block text-[11px] font-700 uppercase tracking-[0.12em] text-slate-500">{label}</span>
                <strong className={`mt-2 block text-2xl font-800 ${scoreTone(item?.score ?? null)}`}>{item?.score ?? "—"}</strong>
                <span className="mt-1 block text-[11px] text-slate-500">{item?.status === "scored" ? `${item.finding_count} findings` : "Not available"}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>

    <section className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_0.8fr]">
      <div className="card-panel p-5 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-800 text-slate-900">Priority actions</h3>
          <button onClick={() => navigate("/reports")} className="pill-muted inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-700">View all <ArrowRight size={12} /></button>
        </div>
        {data.findings.length ? (
          <div className="space-y-3">
            {data.findings.map((finding) => (
              <div key={finding.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex gap-3">
                  <AlertTriangle size={16} className={finding.severity === "critical" ? "mt-0.5 text-red-600" : "mt-0.5 text-amber-600"} />
                  <div>
                    <p className="text-sm font-700 text-slate-900">{finding.title}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{finding.recommendation || finding.description}</p>
                    <span className="mt-2 inline-block rounded-full bg-slate-200 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">{finding.severity} · {finding.module_name}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No findings from the latest scan" description="Run a scan to identify actions for this website." />}
      </div>

      <div className="card-panel p-5 md:p-6">
        <div className="mb-4 flex items-center gap-2">
          <Bot size={16} className="text-blue-600" />
          <h3 className="text-base font-800 text-slate-900">AI activity</h3>
        </div>
        {data.executions.length ? (
          <div className="space-y-3">
            {data.executions.map((execution) => (
              <div key={execution.id} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
                <CircleDashed size={15} className="mt-0.5 text-slate-400" />
                <div>
                  <p className="text-sm font-700 text-slate-800">{execution.agent_type}</p>
                  <p className="text-xs text-slate-500">{execution.status}{execution.model_id ? ` · ${execution.model_id}` : ""}</p>
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No agent activity yet" description="Agent activity appears once an execution is created." />}
      </div>
    </section>

    <section className="card-panel mt-6 p-5 md:p-6">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={16} className="text-blue-600" />
        <h3 className="text-base font-800 text-slate-900">Score history</h3>
      </div>
      {trend.length ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} hide />
              <Tooltip />
              <Line type="monotone" dataKey="score" stroke="#2563eb" strokeWidth={3} dot={{ r: 3 }} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : <EmptyState title="No score history yet" description="Run your first scan to start tracking intelligence over time." />}
    </section>
  </div>;
}
