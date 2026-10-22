import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { apiAdminDiagnostics, apiAdminExportDiagnostics, apiAdminRetryJob, IntegrationRequired, type AdminDiagnostics } from "../../services/api";
import { btn, btnPrimary, fmtTime, PageHeader, StatusPill } from "./adminShared";

/**
 * Admin → Control Center: overview and diagnostics. Every figure comes from
 * GET /api/v1/admin/diagnostics at the time shown; per-process values
 * (worker heartbeat, server errors) are labelled as such.
 */
export function ControlCenterPage() {
  const [data, setData] = useState<AdminDiagnostics | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiAdminDiagnostics();
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      setData(r.data);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const exportReport = async () => {
    const out = await apiAdminExportDiagnostics();
    if ("error" in out) return setNotice(out.error);
    const url = URL.createObjectURL(out.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = out.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice("Redacted diagnostic report downloaded.");
  };

  const retry = async (kind: "gsc_sync" | "analytics_outbox", id: string) => {
    setBusy(`${kind}:${id}`);
    try {
      const r = await apiAdminRetryJob(kind, id);
      setNotice(r.error ? `Not retried: ${r.error.message}` : kind === "gsc_sync" ? (r.data?.result.deduplicated ? "A sync for this property is already queued." : "A new sync was queued.") : "The event was returned to the dispatch queue.");
      if (!r.error) await load();
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${text}`);
    } catch {
      setNotice(`Reference: ${text}`);
    }
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Admin Control Center" />;
  if (error) return <ErrorState title={(error as { code?: string }).code === "PLATFORM_ADMIN_REQUIRED" ? "Platform administrators only" : "Unable to load diagnostics"} message={error.message} onRetry={load} />;
  if (loading && !data) return <LoadingState label="Running diagnostics…" />;
  if (!data) return null;

  const integrationsVerified = data.integrations.filter((i) => i.lastCheck?.status === "valid").length;
  const integrationsConfigured = data.integrations.filter((i) => i.configured).length;

  return (
    <div>
      <PageHeader eyebrow="Administration" title="Control Center">
        <button type="button" className={btn} onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Re-run checks"}</button>
        <button type="button" className={btnPrimary} onClick={() => void exportReport()}>Export redacted report</button>
      </PageHeader>
      <p className="mt-2 text-xs text-slate-600">Measured {fmtTime(data.generatedAt)}. Worker status and server errors describe the process that answered this request.</p>
      <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-700">{notice}</p>

      <section aria-label="Health" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile title="API" status="ok" label="Responding" detail={`Up ${Math.floor(data.process.uptimeSeconds / 3600)} h · ${data.process.environment} · ${data.process.node}`} />
        <Tile title="Database" status={data.database.status} label={data.database.status === "ok" ? "Connected" : "Failed"} detail={`${data.database.latencyMs} ms round trip${data.database.error ? ` · ${data.database.error}` : ""}`} />
        <Tile
          title="Migrations"
          status={data.migrations.status}
          label={data.migrations.status === "up_to_date" ? "Up to date" : data.migrations.status === "pending" ? `${data.migrations.pending?.length ?? 0} pending` : data.migrations.status.replace(/_/g, " ")}
          detail={`Applied ${data.migrations.currentVersion ?? "?"}, latest ${data.migrations.latestOnDisk ?? "?"}${data.migrations.checksumMismatches?.length ? ` · ${data.migrations.checksumMismatches.length} checksum mismatch(es)` : ""}`}
        />
        <Tile title="Background worker" status={data.worker.status} label={data.worker.status.replace(/_/g, " ")} detail={`Last tick ${fmtTime(data.worker.lastTickAt)}${data.worker.lastError ? ` · last error ${data.worker.lastError.errorClass}` : ""}`} />
        <Tile title="Integrations" status={integrationsVerified ? "ok" : "unknown"} label={`${integrationsVerified} verified / ${integrationsConfigured} configured`} detail={<Link className="underline" to="/admin/integrations">Integrations &amp; API keys</Link>} />
        <Tile title="Server errors (this process)" status={data.serverErrors.totalSinceStart ? "warning" : "ok"} label={`${data.serverErrors.totalSinceStart} since start`} detail={`Showing the last ${data.serverErrors.capacity} at most`} />
      </section>

      {data.configurationWarnings.length ? (
        <section aria-labelledby="warn-h" className="mt-6">
          <h3 id="warn-h" className="text-sm font-700 text-slate-900">Configuration</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {data.configurationWarnings.map((w, i) => (
              <li key={i} className={w.severity === "warning" ? "text-amber-900" : "text-slate-600"}>{w.severity === "warning" ? "⚠ " : "ℹ "}{w.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="jobs-h" className="mt-6">
        <h3 id="jobs-h" className="text-sm font-700 text-slate-900">Background jobs (last 7 days)</h3>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(data.jobs).filter(([k]) => k !== "window").map(([name, counts]) => (
            <div key={name} className="rounded-lg border border-slate-200 bg-white p-3">
              <dt className="font-700 text-slate-900">{name.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
              <dd className="mt-1 text-slate-700">
                {counts && typeof counts === "object" && Object.keys(counts).length
                  ? Object.entries(counts as Record<string, unknown>).map(([s, n]) => `${s.replace(/([A-Z])/g, " $1").toLowerCase()}: ${n ?? "—"}`).join(" · ")
                  : "none"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="failed-h" className="mt-6">
        <h3 id="failed-h" className="text-sm font-700 text-slate-900">Recent failed jobs</h3>
        {data.failedJobs.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">No failed jobs in the last 7 days.</p>
        ) : (
          <table className="mt-2 w-full text-left text-xs">
            <caption className="sr-only">Recent failed jobs</caption>
            <thead className="text-slate-500"><tr><th className="py-1 pr-2">When</th><th className="py-1 pr-2">Kind</th><th className="py-1 pr-2">Error (redacted)</th><th className="py-1">Action</th></tr></thead>
            <tbody>
              {data.failedJobs.map((j) => (
                <tr key={`${j.kind}:${j.id}`} className="border-t border-slate-100 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap">{fmtTime(j.at)}</td>
                  <td className="py-1.5 pr-2">{j.kind.replace(/_/g, " ")}</td>
                  <td className="py-1.5 pr-2 break-all">{j.error ?? "—"}</td>
                  <td className="py-1.5">
                    {j.retryable ? (
                      <button type="button" className={btn} disabled={busy === `${j.kind}:${j.id}`} onClick={() => void retry(j.kind as "gsc_sync" | "analytics_outbox", j.id)}>Retry</button>
                    ) : (
                      <span className="text-slate-500">{j.retryNote}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="errors-h" className="mt-6">
        <h3 id="errors-h" className="text-sm font-700 text-slate-900">Recent server errors (this process)</h3>
        {data.serverErrors.errors.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">No 5xx responses since this process started.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {data.serverErrors.errors.slice(0, 20).map((e) => (
              <li key={e.requestId}>
                {fmtTime(e.at)} · {e.method} {e.route} · {e.statusCode} {e.errorClass}{" "}
                <button type="button" className="underline" onClick={() => void copy(e.requestId)}>Copy reference</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="audit-h" className="mt-6">
        <h3 id="audit-h" className="text-sm font-700 text-slate-900">Recent administrative events</h3>
        {data.adminEvents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">None recorded.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {data.adminEvents.map((e, i) => (
              <li key={i}>{fmtTime(e.timestamp)} · {e.action.replace(/_/g, " ")} · <StatusPill status={e.result === "success" ? "ok" : "failed"} label={e.result} /></li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 text-xs text-slate-600">
        More: <Link className="underline" to="/admin/users">Users &amp; access</Link> · <Link className="underline" to="/admin/infrastructure/health">Infrastructure</Link> · <Link className="underline" to="/admin/infrastructure/migrations">Migration details</Link>
      </p>
    </div>
  );
}

function Tile({ title, status, label, detail }: { title: string; status: string; label: string; detail: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-700 text-slate-600">{title}</p>
      <div className="mt-2"><StatusPill status={status} label={label} /></div>
      <p className="mt-2 text-[11px] text-slate-600">{detail}</p>
    </div>
  );
}
