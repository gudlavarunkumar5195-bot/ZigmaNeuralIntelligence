import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, ArrowRight, Bot, CircleDashed, Globe2, Play, ShieldCheck, Sparkles } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGetDashboard, ApiCallError, DashboardData, IntegrationRequired } from "../services/api";
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
  const load = async () => { setLoading(true); setError(null); try { const result = await apiGetDashboard(websiteId); if (result.error) throw new ApiCallError(0, result.error.code, result.error.message); setData(result.data); } catch (cause) { setError(cause as Error); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [websiteId]);
  const trend = useMemo(() => data?.history.map((point) => ({ date: new Date(point.captured_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }), score: point.overall_score })) ?? [], [data]);
  if (loading) return <LoadingState label="Loading website intelligence…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Dashboard" description="Connect the production API to load authenticated tenant intelligence." />;
  if (error) return <ErrorState title="Unable to load website intelligence" message={error.message} onRetry={load} />;
  if (!data?.selectedWebsite) return <div className="p-6 max-w-6xl mx-auto"><EmptyState title="No websites connected" description="Add a verified website to begin collecting intelligence." action={<button onClick={() => navigate("/websites/add")} className="rounded-md bg-primary px-4 py-2 text-sm font-700 text-white">Add Website</button>} /></div>;
  const site = data.selectedWebsite;
  const scoreMap = new Map(data.scores.map((score) => [score.category, score]));
  const score = site.overall_score;
  return <div className="mx-auto max-w-6xl p-5 md:p-8 animate-slide-in">
    <header className="mb-10 flex flex-col justify-between gap-5 border-b border-slate-200 pb-7 sm:flex-row sm:items-end">
      <div><p className="font-mono text-[11px] uppercase tracking-[0.18em] text-blue-700">Website intelligence / live record</p><h2 className="mt-2 flex items-center gap-2 text-2xl font-800 tracking-tight text-slate-950"><Globe2 size={21} className="text-blue-600" />{site.domain}</h2><p className="mt-1 text-sm text-slate-500">{site.completed_at ? `Last analyzed ${new Date(site.completed_at).toLocaleString()}` : "No completed analysis yet"}</p></div>
      <button onClick={() => navigate(`/websites/scan/${site.id}`)} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-700 text-white transition hover:bg-blue-700"><Play size={14} />New scan</button>
    </header>
    <section className="grid gap-8 border-b border-slate-200 pb-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
      <div className="relative overflow-hidden rounded-sm bg-slate-950 px-7 py-8 text-white"><div className="absolute right-0 top-0 h-32 w-32 border-l border-b border-blue-400/30" /><p className="font-mono text-[10px] uppercase tracking-[.2em] text-blue-200">Executive health</p><div className="mt-5 flex items-end gap-3"><strong className="text-7xl font-800 tracking-tighter">{score ?? "—"}</strong>{score !== null && <span className="mb-3 text-sm text-blue-100">/ 100</span>}</div><p className="mt-4 text-sm text-slate-300">{score === null ? "Score unavailable — run a completed scan to generate it." : `${site.finding_count} recorded finding${site.finding_count === 1 ? "" : "s"} from the latest scan.`}</p></div>
      <div><div className="mb-4 flex items-center gap-2"><Sparkles size={16} className="text-blue-600" /><h3 className="text-sm font-800 text-slate-900">Intelligence dimensions</h3></div><div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">{dimensions.map(([key, label, path]) => { const item = scoreMap.get(key); return <button key={key} onClick={() => navigate(path)} className="group border-b border-slate-200 pb-3 text-left hover:border-blue-600"><span className="block text-xs font-600 text-slate-500">{label}</span><strong className={`mt-1 block text-2xl font-800 ${scoreTone(item?.score ?? null)}`}>{item?.score ?? "—"}</strong><span className="text-[11px] text-slate-400">{item?.status === "scored" ? `${item.finding_count} findings` : "Not available"}</span></button>; })}</div></div>
    </section>
    <section className="grid gap-8 py-10 lg:grid-cols-[1.25fr_.75fr]"><div><div className="mb-4 flex items-center justify-between"><h3 className="text-base font-800 text-slate-900">Priority actions</h3><button onClick={() => navigate("/reports")} className="text-xs font-700 text-blue-700">View all <ArrowRight className="inline" size={13} /></button></div>{data.findings.length ? <div className="divide-y divide-slate-200 border-y border-slate-200">{data.findings.map((finding) => <div key={finding.id} className="py-4"><div className="flex gap-3"><AlertTriangle size={16} className={finding.severity === "critical" ? "mt-0.5 text-red-600" : "mt-0.5 text-amber-600"} /><div><p className="text-sm font-700 text-slate-900">{finding.title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{finding.recommendation || finding.description}</p><span className="mt-2 inline-block font-mono text-[10px] uppercase tracking-wide text-slate-400">{finding.severity} · {finding.module_name}</span></div></div></div>)}</div> : <EmptyState title="No findings from the latest scan" description="Run a scan to identify actions for this website." />}</div>
      <div className="border-l-0 border-slate-200 lg:border-l lg:pl-8"><div className="mb-4 flex items-center gap-2"><Bot size={16} className="text-blue-600" /><h3 className="text-base font-800 text-slate-900">AI activity</h3></div>{data.executions.length ? <div className="space-y-3">{data.executions.map((execution) => <div key={execution.id} className="flex items-start gap-3"><CircleDashed size={15} className="mt-0.5 text-slate-400" /><div><p className="text-sm font-700 text-slate-800">{execution.agent_type}</p><p className="text-xs text-slate-500">{execution.status}{execution.model_id ? ` · ${execution.model_id}` : ""}</p></div></div>)}</div> : <EmptyState title="No agent activity yet" description="Agent activity appears once an execution is created." />}</div></section>
    <section className="border-t border-slate-200 pt-8"><div className="mb-4 flex items-center gap-2"><ShieldCheck size={16} className="text-blue-600" /><h3 className="text-base font-800 text-slate-900">Score history</h3></div>{trend.length ? <div className="h-52"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}><XAxis dataKey="date" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis domain={[0, 100]} hide /><Tooltip /><Line type="monotone" dataKey="score" stroke="#155eef" strokeWidth={3} dot={{ r: 3 }} connectNulls={false} /></LineChart></ResponsiveContainer></div> : <EmptyState title="No score history yet" description="Run your first scan to start tracking intelligence over time." />}</section>
  </div>;
}
