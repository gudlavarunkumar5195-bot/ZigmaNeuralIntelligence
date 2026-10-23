import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Activity, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { apiCancelScan, apiGetScan, ApiCallError, IntegrationRequired } from "../../services/api";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { PageHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { buttonClass, card } from "../../components/ui/styles";

interface ScanRecord {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  modules: string[];
  scores: Array<{ category: string; score: number | null; status: string }>;
  module_statuses?: Array<{ module_name: string; status: string; error: string | null }>;
  crawl_progress?: { pagesCrawled?: number; pagesDiscovered?: number; queued?: number } | null;
}

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;

const RESULT_LINKS: Array<[module: string, label: string, path: string]> = [
  ["seo", "SEO findings", "/intelligence/seo"],
  ["security", "Security findings", "/intelligence/security"],
  ["performance", "Performance findings", "/intelligence/performance"],
  ["ssl", "SSL findings", "/infrastructure/ssl"],
  ["crawl", "Technical health", "/intelligence/technical-health"],
];

/** Only network failures and 5xx responses are worth retrying; 4xx (404/403/...) will not fix themselves. */
function isTransient(cause: unknown): boolean {
  if (cause instanceof IntegrationRequired || !(cause instanceof ApiCallError)) return false;
  if (cause.code === "NETWORK_ERROR" || cause.code === "TIMEOUT") return true;
  return cause.status >= 500 || cause.status === 429;
}

export function ScanProgress() {
  const { id = "" } = useParams();
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: number | undefined;
    let delay = POLL_MS;
    const run = async () => {
      let next: number | null = null;
      try {
        const result = await apiGetScan(id);
        if (result.error) throw new ApiCallError(result.error.status ?? 0, result.error.code, result.error.message);
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
      if (result.error) throw new ApiCallError(result.error.status ?? 0, result.error.code, result.error.message);
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
    ? <CheckCircle2 className="text-emerald-600" aria-hidden="true" />
    : scan?.status === "failed"
      ? <XCircle className="text-red-600" aria-hidden="true" />
      : <Clock3 className="text-blue-600" aria-hidden="true" />;
  const active = !!scan && ACTIVE_STATUSES.has(scan.status);
  const finished = scan?.status === "completed" || scan?.status === "partial";
  const links = RESULT_LINKS.filter(([module]) => !scan?.modules?.length || scan.modules.includes(module));

  return <div className="mx-auto max-w-4xl">
    <PageHeader eyebrow="Live execution" title={<span className="inline-flex items-center gap-2.5">{icon}Scan {scan?.status}</span>}
      subtitle={scan?.started_at ? `Started ${new Date(scan.started_at).toLocaleString()}${scan.completed_at ? ` · finished ${new Date(scan.completed_at).toLocaleString()}` : ""}` : undefined}
      action={active ? <button onClick={() => setConfirmCancel(true)} disabled={cancelling} className={buttonClass("danger", "md")}>{cancelling ? "Cancelling…" : "Cancel scan"}</button> : undefined} />
    <ConfirmDialog open={confirmCancel && active} title="Cancel this scan?" description="Modules that have not finished will stop and their results will not be collected. Results already measured are kept." confirmLabel="Stop scan" tone="danger" busy={cancelling}
      onConfirm={() => { setConfirmCancel(false); void cancelScan(); }} onCancel={() => setConfirmCancel(false)} />
    {cancelError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{cancelError}</p>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Could not refresh scan status: {error.message}{isTransient(error) ? " Retrying…" : ""} <button onClick={retry} className="font-700 underline">Retry</button></p>}
    {scan?.error && <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{scan.error}</p>}
    <p role="status" aria-live="polite" className="mt-4 min-h-5 text-sm text-slate-700">
      {active && scan?.crawl_progress
        ? `Crawling: ${scan.crawl_progress.pagesCrawled ?? 0} pages fetched, ${scan.crawl_progress.pagesDiscovered ?? 0} URLs discovered.`
        : scan ? `Scan ${scan.status}.` : ""}
    </p>
    {scan?.module_statuses?.length ? <section className={`${card} mt-4`} aria-labelledby="modules-heading">
      <h3 id="modules-heading" className="text-card-title text-slate-900">Modules</h3>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {scan.module_statuses.map((m) => <li key={m.module_name} className="flex flex-wrap items-center gap-2 py-2"><span className="font-600 capitalize text-slate-800">{m.module_name}</span><span className="ml-auto"><StatusBadge status={m.status} /></span>{m.error ? <span className="basis-full text-xs text-red-700">{m.error}</span> : null}</li>)}
      </ul>
    </section> : null}
    <section className="mt-6">
      <h3 className="flex items-center gap-2 text-section-title text-slate-900"><Activity size={16} aria-hidden="true" />Measured dimensions</h3>
      {scan?.scores.length ? <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{scan.scores.map((score) => <div key={score.category} className={card}><p className="text-xs font-600 capitalize text-slate-500">{score.category}</p><strong className="mt-1 block text-kpi tabular-nums text-slate-900">{score.score ?? "—"}</strong><p className="text-[11px] text-slate-500">{score.status}</p></div>)}</div> : <p className="mt-4 text-sm text-slate-500">No measured scores are available for this scan yet.</p>}
    </section>
    {finished && <nav aria-label="Scan results" className="mt-8 flex flex-wrap gap-2">
      {links.map(([module, label, path]) => <Link key={module} to={path} className={buttonClass("secondary", "md")}>{label}</Link>)}
      <Link to="/reports" className={buttonClass("primary", "md")}>View report</Link>
    </nav>}
  </div>;
}
