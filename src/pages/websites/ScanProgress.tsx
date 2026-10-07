import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Activity, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { apiCancelScan, apiGetScan, ApiCallError, IntegrationRequired } from "../../services/api";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";

interface ScanRecord {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  modules: string[];
  scores: Array<{ category: string; score: number | null; status: string }>;
}

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;

const RESULT_LINKS: Array<[module: string, label: string, path: string]> = [
  ["seo", "SEO findings", "/intelligence/seo"],
  ["security", "Security findings", "/intelligence/security"],
  ["performance", "Performance findings", "/intelligence/performance"],
  ["ssl", "SSL findings", "/infrastructure/ssl"],
];

/** Only network failures and 5xx responses are worth retrying; 4xx (404/403/...) will not fix themselves. */
function isTransient(cause: unknown): boolean {
  if (cause instanceof IntegrationRequired) return false;
  const code = (cause as { code?: string }).code ?? "";
  return code === "NETWORK_ERROR" || /^5\d\d$/.test(code);
}

export function ScanProgress() {
  const { id = "" } = useParams();
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: number | undefined;
    let delay = POLL_MS;
    const run = async () => {
      let next: number | null = null;
      try {
        const result = await apiGetScan(id);
        if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
        if (cancelled) return;
        const record = result.data as ScanRecord;
        setScan(record);
        setError(null);
        delay = POLL_MS;
        if (ACTIVE_STATUSES.has(record.status)) next = delay;
      } catch (cause) {
        if (cancelled) return;
        setError(cause as Error);
        if (isTransient(cause)) {
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
          next = delay;
        }
      }
      if (next !== null && !cancelled) timer = window.setTimeout(() => void run(), next);
    };
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, attempt]);

  const retry = () => {
    setError(null);
    setAttempt((value) => value + 1);
  };

  const cancelScan = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await apiCancelScan(id);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      retry();
    } catch (cause) {
      setCancelError((cause as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (!scan && !error) return <LoadingState label="Loading scan execution…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Scan progress" />;
  if (!scan && error) return <ErrorState title="Unable to load scan execution" message={error.message} onRetry={retry} />;

  const icon = scan?.status === "completed"
    ? <CheckCircle2 className="text-emerald-600" />
    : scan?.status === "failed"
      ? <XCircle className="text-red-600" />
      : <Clock3 className="text-blue-600" />;
  const active = !!scan && ACTIVE_STATUSES.has(scan.status);
  const finished = scan?.status === "completed" || scan?.status === "partial";
  const links = RESULT_LINKS.filter(([module]) => !scan?.modules?.length || scan.modules.includes(module));

  return <div className="mx-auto max-w-4xl p-5 md:p-10">
    <div className="flex items-center gap-3 border-b border-slate-200 pb-6">
      {icon}
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Live execution</p>
        <h2 className="mt-1 text-2xl font-800 text-slate-950">Scan {scan?.status}</h2>
      </div>
      {active && <button onClick={() => void cancelScan()} disabled={cancelling} className="ml-auto rounded-md border border-red-200 px-3 py-2 text-sm font-700 text-red-700 disabled:opacity-60">{cancelling ? "Cancelling…" : "Cancel scan"}</button>}
    </div>
    {cancelError && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm text-red-800">{cancelError}</p>}
    {error && <p role="alert" className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-900">Could not refresh scan status: {error.message}{isTransient(error) ? " Retrying…" : ""} <button onClick={retry} className="font-700 underline">Retry</button></p>}
    {scan?.error && <p className="mt-6 rounded bg-red-50 p-3 text-sm text-red-800">{scan.error}</p>}
    <section className="mt-8">
      <h3 className="flex items-center gap-2 text-sm font-800 text-slate-900"><Activity size={16} />Measured dimensions</h3>
      {scan?.scores.length ? <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">{scan.scores.map((score) => <div key={score.category} className="border-b border-slate-200 py-3"><p className="text-xs font-600 text-slate-500">{score.category}</p><strong className="mt-1 text-2xl text-slate-900">{score.score ?? "—"}</strong><p className="text-[11px] text-slate-400">{score.status}</p></div>)}</div> : <p className="mt-4 text-sm text-slate-500">No measured scores are available for this scan yet.</p>}
    </section>
    {finished && <nav aria-label="Scan results" className="mt-8 flex flex-wrap gap-2">
      {links.map(([module, label, path]) => <Link key={module} to={path} className="rounded-md border border-slate-200 px-3 py-2 text-sm font-700 text-slate-700 hover:bg-slate-50">{label}</Link>)}
      <Link to="/reports" className="rounded-md bg-slate-950 px-3 py-2 text-sm font-700 text-white">View report</Link>
    </nav>}
  </div>;
}
