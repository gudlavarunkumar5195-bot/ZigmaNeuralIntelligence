import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  apiCancelSearchConsoleSync,
  apiGetDashboard,
  apiGetSearchConsoleStatus,
  apiGetSearchPerformance,
  apiStartSearchConsoleSync,
  IntegrationRequired,
  type GscLinkStatus,
  type SearchMetrics,
  type SearchPerformance,
} from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { BreakdownTable } from "./performance/BreakdownTable";

const PRESETS = [7, 28, 90] as const;
const ACTIVE = new Set(["queued", "running"]);
const ROLE_CODES = new Set(["FORBIDDEN", "INSUFFICIENT_ROLE"]);

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const fmtInt = (n: number | null) => (n === null ? "—" : n.toLocaleString());
const fmtPct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const fmtPos = (n: number | null) => (n === null ? "—" : n.toFixed(1));
const yesterdayLocal = () => addDays(new Date().toISOString().slice(0, 10), -1);

/** Search performance from Google Search Console: persisted, synced data only. */
export function SearchPerformancePage() {
  const selectedId = useSelectedWebsiteId();
  const [site, setSite] = useState<{ id: string; domain: string } | null | undefined>(undefined);
  const [status, setStatus] = useState<GscLinkStatus | null | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [preset, setPreset] = useState<number | "custom">(28);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<SearchPerformance | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showTable, setShowTable] = useState(false);

  const loadStatus = async (websiteId: string) => {
    const r = await apiGetSearchConsoleStatus(websiteId);
    if (r.error) throw new Error(r.error.message);
    setStatus(r.data ?? null);
    return r.data ?? null;
  };

  const loadSite = async () => {
    setError(null);
    setSite(undefined);
    setStatus(undefined);
    try {
      const dashboard = await apiGetDashboard(selectedId);
      if (dashboard.error) throw new Error(dashboard.error.message);
      const chosen = dashboard.data?.selectedWebsite;
      if (!chosen) {
        setSite(null);
        return;
      }
      setSite({ id: chosen.id, domain: chosen.domain });
      await loadStatus(chosen.id);
    } catch (cause) {
      setError(cause as Error);
    }
  };
  useEffect(() => {
    void loadSite();
  }, [selectedId]);

  const end = status?.freshness.latestDay ?? yesterdayLocal();
  const range = useMemo(() => {
    if (preset === "custom" && customFrom && customTo && customFrom <= customTo) return { from: customFrom, to: customTo };
    const days = preset === "custom" ? 28 : preset;
    return { from: addDays(end, -(days - 1)), to: end };
  }, [preset, customFrom, customTo, end]);
  const previous = useMemo(() => {
    const days = span(range.from, range.to);
    return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
  }, [range]);

  const loadData = async () => {
    if (!site || !status) return;
    setData(null);
    setDataError(null);
    const r = await apiGetSearchPerformance(site.id, { ...range, ...(compare ? { compareFrom: previous.from, compareTo: previous.to } : {}) });
    if (r.error) {
      setDataError(r.error.message);
      return;
    }
    setData(r.data);
  };
  useEffect(() => {
    void loadData();
  }, [site?.id, status?.property.id, range.from, range.to, compare]);

  // Poll an active sync and announce its progress; reload when it finishes.
  const activeJob = status?.activeJob ?? null;
  useEffect(() => {
    if (!site || !activeJob || !ACTIVE.has(activeJob.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await loadStatus(site.id);
        if (next && !next.activeJob) {
          const job = next.recentJobs[0];
          setNotice(job ? `Sync ${job.status}: ${job.units_done} of ${job.units_total} day/dimension fetches done${job.units_failed ? `, ${job.units_failed} failed` : ""}.` : "Sync finished.");
          void loadData();
        }
      } catch {
        /* keep the last known status; the next render retries */
      }
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [site?.id, activeJob?.id, activeJob?.units_done, activeJob?.status]);

  const syncNow = async () => {
    if (!site) return;
    setSyncing(true);
    setNotice(null);
    try {
      const r = await apiStartSearchConsoleSync(site.id);
      if (r.error) {
        setNotice(ROLE_CODES.has(r.error.code) ? "Your role cannot start a sync." : r.error.message);
        return;
      }
      setNotice(r.meta?.deduplicated ? "A sync is already running; showing its progress." : `Sync queued for ${r.data?.date_from} to ${r.data?.date_to}.`);
      await loadStatus(site.id);
    } finally {
      setSyncing(false);
    }
  };
  const cancel = async () => {
    if (!site || !activeJob) return;
    const r = await apiCancelSearchConsoleSync(site.id, activeJob.id);
    setNotice(r.error ? r.error.message : "Sync cancelled. Days already fetched are kept.");
    await loadStatus(site.id);
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Search performance" />;
  if (error) return <ErrorState title="Unable to load search performance" message={error.message} onRetry={loadSite} />;
  if (site === undefined || status === undefined) return <LoadingState label="Loading search performance…" />;
  if (site === null) return <EmptyState title="No website selected" description="Add and verify a website first." />;
  if (status === null) {
    return (
      <div className="mx-auto max-w-5xl p-6 md:p-10">
        <Header domain={site.domain} />
        <EmptyState
          title="Search Console is not connected for this website"
          description="Connect a Google account and link a Search Console property to see real clicks, impressions, CTR and positions."
          action={<Link to="/settings/integrations" className="rounded-md bg-slate-950 px-3 py-2 text-sm font-700 text-white">Go to Integrations</Link>}
        />
      </div>
    );
  }

  const integrationOk = status.integration?.status === "active";
  const propertyOk = status.property.status === "active";
  const cur = data?.current ?? null;
  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <Header domain={site.domain} />
      <p className="mt-1 text-xs text-slate-600">
        Source: Google Search Console · property <span className="font-mono">{status.property.site_url}</span> ({status.property.property_type === "domain" ? "Domain" : "URL prefix"}) · web search · account {status.integration?.account_email ?? "unknown"}
      </p>

      {!integrationOk ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Google access for this property was revoked or expired. Syncing is paused; stored data is still shown. <Link to="/settings/integrations" className="font-700 underline">Reconnect the Google account</Link>
        </p>
      ) : null}
      {!propertyOk ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {status.property.status_reason ?? "The connected Google account lost access to this property."} Ask the property owner to restore access, then relink it in <Link to="/settings/integrations" className="font-700 underline">Integrations</Link>.
        </p>
      ) : null}

      <section aria-labelledby="freshness-heading" className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h3 id="freshness-heading" className="sr-only">Data freshness and sync</h3>
        <p className="text-slate-800">
          {status.freshness.latestFinalDay ? <>Final data through <strong>{status.freshness.latestFinalDay}</strong> (Pacific Time). </> : <>No finalized data stored yet. </>}
          {status.freshness.firstIncompleteDate ? <>Days from <strong>{status.freshness.firstIncompleteDate}</strong> are preliminary and may still change. </> : null}
          Google usually publishes data with a 2–3 day delay.
        </p>
        <p className="mt-1 text-xs text-slate-600">
          Last successful sync: {status.property.last_sync_success_at ? new Date(status.property.last_sync_success_at).toLocaleString() : "never"}
          {status.property.next_sync_at ? ` · next scheduled: ${new Date(status.property.next_sync_at).toLocaleString()}` : ""}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void syncNow()} disabled={syncing || !!activeJob || !integrationOk || !propertyOk} className="rounded-md bg-slate-950 px-3 py-1.5 text-xs font-700 text-white disabled:opacity-50">
            {activeJob ? "Sync in progress" : syncing ? "Starting…" : "Sync now"}
          </button>
          {activeJob ? (
            <>
              <span className="text-xs text-slate-700">
                {activeJob.status === "queued" && activeJob.run_after && Date.parse(activeJob.run_after) > Date.now()
                  ? `Paused by Google's API quota; resumes after ${new Date(activeJob.run_after).toLocaleTimeString()}.`
                  : `${activeJob.units_done} of ${activeJob.units_total} fetches done (${activeJob.date_from} to ${activeJob.date_to}).`}
              </span>
              <progress max={activeJob.units_total || 1} value={activeJob.units_done} aria-label="Sync progress" className="h-2 w-40" />
              <button type="button" onClick={() => void cancel()} className="text-xs font-600 text-red-700 underline">Cancel sync</button>
            </>
          ) : null}
        </div>
        <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-700">{notice}</p>
        {status.recentJobs.length ? (
          <details className="mt-1 text-xs text-slate-700">
            <summary className="cursor-pointer font-600">Sync history</summary>
            <ul className="mt-2 space-y-1">
              {status.recentJobs.map((j) => (
                <li key={j.id}>
                  {new Date(j.created_at).toLocaleString()} · {j.kind} · <strong>{j.status}</strong> · {j.date_from} → {j.date_to} · {j.units_done}/{j.units_total}
                  {j.units_failed ? ` · ${j.units_failed} failed` : ""}
                  {j.error ? <span className="text-red-700"> · {j.error}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="range-heading" className="mt-6">
        <h3 id="range-heading" className="sr-only">Date range</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label="Date range" className="flex gap-1">
            {PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={preset === p} onClick={() => setPreset(p)} className={`rounded-full border px-3 py-1 text-xs font-600 ${preset === p ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}>
                Last {p} days
              </button>
            ))}
            <button type="button" aria-pressed={preset === "custom"} onClick={() => setPreset("custom")} className={`rounded-full border px-3 py-1 text-xs font-600 ${preset === "custom" ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}>
              Custom
            </button>
          </div>
          {preset === "custom" ? (
            <>
              <label className="text-xs text-slate-700">From<input type="date" value={customFrom} max={end} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" /></label>
              <label className="text-xs text-slate-700">To<input type="date" value={customTo} max={end} onChange={(e) => setCustomTo(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" /></label>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            Compare with the previous {span(range.from, range.to)} days ({previous.from} – {previous.to})
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-600">Showing {range.from} – {range.to} (Pacific Time).</p>
      </section>

      {dataError ? (
        <ErrorState title="Unable to load search performance" message={dataError} onRetry={loadData} />
      ) : !data || !cur ? (
        <LoadingState label="Loading metrics…" />
      ) : cur.coverage.daysWithData === 0 ? (
        <EmptyState
          title="No synced data for this range"
          description={cur.coverage.daysMissing ? "These days have not been fetched from Google yet. Run a sync, or pick a range that has been synced." : "Google reported no search activity for this property in this range."}
        />
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Totals for the selected range">
            <Kpi label="Clicks" value={fmtInt(cur.totals.clicks)} metric="clicks" data={data} format={fmtInt} />
            <Kpi label="Impressions" value={fmtInt(cur.totals.impressions)} metric="impressions" data={data} format={fmtInt} />
            <Kpi label="Average CTR" value={fmtPct(cur.totals.ctr)} metric="ctr" data={data} format={(n) => `${n !== null && n > 0 ? "+" : ""}${n === null ? "—" : (n * 100).toFixed(1)} pts`} />
            <Kpi label="Average position" value={fmtPos(cur.totals.position)} metric="position" data={data} format={(n) => `${n !== null && n > 0 ? "+" : ""}${n === null ? "—" : n.toFixed(1)} (lower is better)`} />
          </dl>
          {cur.coverage.daysMissing || cur.coverage.daysFresh ? (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {cur.coverage.daysMissing ? `${cur.coverage.daysMissing} of ${cur.coverage.days} days are not synced yet and are excluded (not counted as zero). ` : ""}
              {cur.coverage.daysFresh ? `${cur.coverage.daysFresh} day(s) are preliminary.` : ""}
            </p>
          ) : null}
          {data.previous && data.previous.coverage.daysWithData === 0 ? (
            <p className="mt-2 text-xs text-slate-600">The comparison period has no synced data, so no change is shown.</p>
          ) : null}

          <section aria-labelledby="trend-heading" className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="trend-heading" className="text-sm font-700 text-slate-900">Clicks and impressions per day</h3>
              <button type="button" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)} className="text-xs font-600 text-blue-700 underline">
                {showTable ? "Hide" : "Show"} daily data table
              </button>
            </div>
            <div className="mt-3 h-56 text-slate-400" role="img" aria-label={`Daily clicks and impressions from ${range.from} to ${range.to}; missing days are gaps. Use the data table for exact values.`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={cur.series} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.15} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis yAxisId="c" tick={{ fontSize: 11 }} allowDecimals={false} width={44} />
                  <YAxis yAxisId="i" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} width={52} />
                  <Tooltip />
                  <Line yAxisId="c" type="monotone" dataKey="clicks" name="Clicks" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls={false} />
                  <Line yAxisId="i" type="monotone" dataKey="impressions" name="Impressions" stroke="#7c3aed" strokeWidth={2} dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {showTable ? (
              <div className="mt-3 max-h-80 overflow-auto">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Daily search performance</caption>
                  <thead className="sticky top-0 bg-white text-slate-500">
                    <tr><th scope="col" className="py-1 pr-3">Date</th><th scope="col" className="py-1 pr-3">Clicks</th><th scope="col" className="py-1 pr-3">Impressions</th><th scope="col" className="py-1 pr-3">CTR</th><th scope="col" className="py-1 pr-3">Position</th><th scope="col" className="py-1">Data</th></tr>
                  </thead>
                  <tbody>
                    {cur.series.map((d) => (
                      <tr key={d.date} className="border-t border-slate-100">
                        <td className="py-1 pr-3 font-mono">{d.date}</td>
                        <td className="py-1 pr-3">{fmtInt(d.clicks)}</td>
                        <td className="py-1 pr-3">{fmtInt(d.impressions)}</td>
                        <td className="py-1 pr-3">{fmtPct(d.ctr)}</td>
                        <td className="py-1 pr-3">{fmtPos(d.position)}</td>
                        <td className="py-1">{d.state === "missing" ? "Not synced" : d.state === "fresh" ? "Preliminary" : "Final"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <BreakdownTable websiteId={site.id} from={range.from} to={range.to} />
          <p className="mt-4 text-xs text-slate-500">
            Google returns top rows only and omits rare and anonymized queries, so query and page totals can be lower than the property totals above. Range position is the impression-weighted average of daily positions.
          </p>
        </>
      )}
    </div>
  );
}

function Header({ domain }: { domain: string }) {
  return (
    <>
      <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Search performance</p>
      <h2 className="mt-2 text-2xl font-800 text-slate-950">{domain}</h2>
    </>
  );
}

function Kpi({ label, value, metric, data, format }: { label: string; value: string; metric: keyof SearchMetrics; data: SearchPerformance; format: (n: number | null) => string }) {
  const cmp = data.comparison?.[metric] ?? null;
  const pct = cmp?.changePct ?? null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="mt-1 text-xl font-800 text-slate-900">{value}</dd>
      {cmp && cmp.change !== null ? (
        <dd className="mt-0.5 text-[11px] text-slate-600">
          vs previous: {metric === "clicks" || metric === "impressions" ? `${cmp.change > 0 ? "+" : ""}${cmp.change.toLocaleString()}${pct !== null ? ` (${pct > 0 ? "+" : ""}${(pct * 100).toFixed(1)}%)` : ""}` : format(cmp.change)}
        </dd>
      ) : data.comparison ? (
        <dd className="mt-0.5 text-[11px] text-slate-500">No comparison data</dd>
      ) : null}
    </div>
  );
}
