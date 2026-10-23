import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { useApiQuery } from "../../../lib/useApiQuery";
import type { ApiResponse } from "../../../types";
import {
  apiRankAcknowledge,
  apiRankAddCompetitor,
  apiRankAddKeywords,
  apiRankAlertRules,
  apiRankAlerts,
  apiRankCompetitorComparison,
  apiRankCompetitors,
  apiRankCreateAlertRule,
  apiRankDashboard,
  apiRankExport,
  apiRankHistory,
  apiRankImportKeywords,
  apiRankImportObservations,
  apiRankImports,
  apiRankJobs,
  apiRankKeywords,
  apiRankPreviewObservations,
  apiRankRankings,
  apiRankRefresh,
  apiRankRemoveCompetitor,
  apiRankRemoveKeyword,
  apiRankSerpFeatures,
  apiRankUpdateAlertRule,
  apiRankUpdateKeyword,
  type RankAlertEvent,
  type RankAlertRule,
  type RankCompetitorComparison,
  type RankDashboard,
  type RankImportPreview,
  type RankKeyword,
  type RankObservation,
  type RankProject,
  type RankRow,
  type RankSources,
} from "../../../services/api";
import { downloadBlob } from "../research/shared";
import { btn, btnPrimary, input } from "./ui";

export const CHANGE_LABEL: Record<string, string> = {
  improved: "Improved",
  declined: "Declined",
  unchanged: "Unchanged",
  entered: "Entered results",
  dropped_out: "Dropped out",
  unavailable: "No comparison",
};
const CHANGE_STYLE: Record<string, string> = {
  improved: "bg-emerald-50 text-emerald-800",
  declined: "bg-red-50 text-red-800",
  entered: "bg-emerald-50 text-emerald-800",
  dropped_out: "bg-red-50 text-red-800",
  unchanged: "bg-slate-100 text-slate-700",
  unavailable: "bg-slate-50 text-slate-500",
};
const FEATURE_LABEL = (f: string) => (f.startsWith("other:") ? f.slice(6) : f.replace(/_/g, " "));

/** How an observation reads: a position only when one was observed. */
export function positionText(o: RankObservation | null): string {
  if (!o) return "No observation";
  if (o.status === "ranked") return String(o.position);
  if (o.status === "not_in_results") return o.result_depth ? `Not in top ${o.result_depth}` : "Not found";
  if (o.status === "failed") return "Collection failed";
  return "No data";
}

function useExport(project: RankProject) {
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (kind: "rankings" | "history" | "keywords") => {
    const out = await apiRankExport(project.id, kind);
    if ("error" in out) return setNotice(out.error);
    downloadBlob(out.blob, out.filename);
    setNotice("Export downloaded.");
  };
  return { run, notice };
}

function NoObservations() {
  return (
    <EmptyState
      title="No ranking observations yet"
      description="Import a ranking report from a tool you are authorized to use. With an approved SERP provider, projects can also be refreshed and tracked on a schedule."
      action={<Link to="/search/rankings/import" className={btnPrimary}>Import rankings</Link>}
    />
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function OverviewTab({ project, providerAvailable, onChanged }: { project: RankProject; providerAvailable: boolean; onChanged: () => void }) {
  const [data, setData] = useState<RankDashboard | null>(null);
  const [rows, setRows] = useState<RankRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const groupsQ = useApiQuery(() => apiRankKeywordsGroups(project.id), [project.id]);
  const groups = groupsQ.data ?? [];
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    setData(null);
    const [d, r] = await Promise.all([apiRankDashboard(project.id, { group: group || undefined }), apiRankRankings(project.id, { group: group || undefined, sort: "position", limit: 200 })]);
    if (mine !== seq.current) return; // a newer group/project request owns the screen
    if (d.error || !d.data) return setError(d.error?.message ?? "Failed to load.");
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load rankings.");
    setData(d.data);
    setRows(r.data);
  }, [project.id, group]);
  useEffect(() => void load(), [load]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await apiRankRefresh(project.id);
      setMessage(r.error ? r.error.message : r.data?.deduplicated ? "A collection for this project is already running." : `Collecting ${r.data?.job.keywords_total} keyword(s).`);
      if (!r.error) onChanged();
    } finally {
      setRefreshing(false);
    }
  };

  if (error) return <ErrorState title="Unable to load rankings" message={error} onRetry={load} />;
  if (!data || !rows) return <LoadingState label="Loading rankings…" />;
  if (!data.keywords.withObservations) return (
    <div>
      <p className="text-xs text-slate-600">{data.keywords.tracked} keyword(s) tracked. <Link className="underline" to="/search/rankings/keywords">Manage keywords</Link></p>
      <NoObservations />
    </div>
  );
  const trend = data.top10Trend.filter((t) => t.share !== null);
  const sources = [...new Set(trend.map((t) => t.source))];
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        {groups.length ? (
          <label className="text-xs text-slate-700">Keyword group
            <select value={group} onChange={(e) => setGroup(e.target.value)} className={input}><option value="">All</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select>
          </label>
        ) : null}
        <button type="button" className={btn} disabled={refreshing || !providerAvailable || project.status !== "active"} title={providerAvailable ? undefined : "Needs a configured SERP provider"} onClick={() => void refresh()}>{refreshing ? "Starting…" : "Refresh now"}</button>
        {groupsQ.error ? <InlineError what="keyword groups" error={groupsQ.error} onRetry={groupsQ.reload} /> : null}
        {message ? <span role="status" className="text-xs text-slate-700">{message}</span> : null}
      </div>
      <section aria-label="Ranking changes" className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(["improved", "declined", "entered", "dropped_out", "unchanged", "unavailable"] as const).map((k) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] font-700 text-slate-600">{CHANGE_LABEL[k]}</p>
            <p className="mt-1 text-xl font-800 tabular-nums text-slate-950">{data.changes[k]}</p>
          </div>
        ))}
      </section>
      <p className="mt-1 text-[11px] text-slate-500">Changes compare each keyword's latest observation with its previous one from the same source. A failed or empty collection is “No comparison”, never a decline.</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="dist-h" className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
          <h3 id="dist-h" className="text-sm font-700 text-slate-900">Latest position distribution</h3>
          <dl className="mt-2 grid grid-cols-4 gap-2">
            {Object.entries(data.distribution).map(([b, n]) => <div key={b}><dt className="text-slate-500">{b === "not_in_results" ? "Not found" : b === "unavailable" ? "No data" : b}</dt><dd className="font-800 tabular-nums">{n}</dd></div>)}
          </dl>
        </section>
        <section aria-labelledby="trend-h" className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
          <h3 id="trend-h" className="text-sm font-700 text-slate-900">Top-10 share</h3>
          <p className="text-[11px] text-slate-500">Keywords observed in positions 1–10 ÷ keywords with a conclusive observation that day. No traffic or volume is involved.</p>
          {trend.length < 2 ? <p className="mt-2 text-slate-600">{trend.length ? `${trend[0].share}% on ${trend[0].day}. A trend needs two or more observation days.` : "No conclusive observations in this period."}</p> : (
            <div className="mt-2 h-40" aria-label="Top-10 share over time" role="img">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" fontSize={10} />
                  <YAxis domain={[0, 100]} fontSize={10} unit="%" />
                  <Tooltip />
                  {sources.map((s) => <Line key={s} type="monotone" dataKey={(t: { source: string; share: number | null }) => (t.source === s ? t.share : null)} name={s} stroke="#2563eb" dot connectNulls />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="pages-h" className="mt-4">
        <h3 id="pages-h" className="text-sm font-700 text-slate-900">Top ranking pages</h3>
        {data.topPages.length === 0 ? <p className="mt-1 text-xs text-slate-600">No ranking URL in the latest observations.</p> : (
          <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Top ranking pages</caption>
            <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Page</th><th scope="col" className="py-1 pr-2">Keywords</th><th scope="col" className="py-1 pr-2">Average position</th><th scope="col" className="py-1">Best</th></tr></thead>
            <tbody>{data.topPages.map((p) => <tr key={p.url} className="border-t border-slate-100"><td className="break-all py-1.5 pr-2">{p.url}</td><td className="py-1.5 pr-2 tabular-nums">{p.keywords}</td><td className="py-1.5 pr-2 tabular-nums">{p.averagePosition}</td><td className="py-1.5 tabular-nums">{p.bestPosition}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <RankingTable rows={rows} />
      <p className="mt-4 text-[11px] text-slate-500">
        Activity: last import {data.activity.lastImport ? `${new Date(data.activity.lastImport.created_at).toLocaleString()} (${data.activity.lastImport.source_label}, ${data.activity.lastImport.rows_accepted} rows)` : "none"} ·
        last collection {data.activity.lastJob ? `${data.activity.lastJob.status}, ${data.activity.lastJob.keywords_done}/${data.activity.lastJob.keywords_total}${data.activity.lastJob.error ? ` — ${data.activity.lastJob.error}` : ""}` : "none"} ·
        provider requests today {data.activity.usageToday.used}/{data.activity.usageToday.limit}
      </p>
    </div>
  );
}

/** The project's keyword groups (returned as listing metadata). */
async function apiRankKeywordsGroups(projectId: string): Promise<ApiResponse<string[]>> {
  const r = await apiRankKeywords(projectId, { limit: 1 });
  return r.error ? { data: null, error: r.error } : { data: r.meta?.groups ?? [], error: null };
}

function RankingTable({ rows }: { rows: RankRow[] }) {
  return (
    <section aria-labelledby="latest-h" className="mt-4">
      <h3 id="latest-h" className="text-sm font-700 text-slate-900">Latest positions</h3>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Latest positions</caption>
          <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Keyword</th><th scope="col" className="py-1 pr-2">Position</th><th scope="col" className="py-1 pr-2">Previous</th><th scope="col" className="py-1 pr-2">Change</th><th scope="col" className="py-1 pr-2">URL</th><th scope="col" className="py-1">Observed</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.keywordId} className="border-t border-slate-100 align-top">
                <td className="py-1.5 pr-2 font-600">{r.keyword}{r.group ? <span className="block text-[10px] text-slate-500">{r.group}</span> : null}</td>
                <td className="py-1.5 pr-2 tabular-nums">{positionText(r.latest)}</td>
                <td className="py-1.5 pr-2 tabular-nums">{r.previous ? `${positionText(r.previous)} (${r.previous.observed_date})` : "—"}</td>
                <td className="py-1.5 pr-2"><span title={r.change.reason} className={`rounded px-1.5 py-0.5 font-700 ${CHANGE_STYLE[r.change.kind]}`}>{CHANGE_LABEL[r.change.kind]}{r.change.delta ? ` ${r.change.delta > 0 ? "+" : ""}${r.change.delta}` : ""}</span></td>
                <td className="max-w-[240px] break-all py-1.5 pr-2">{r.latest?.ranking_url ?? "—"}</td>
                <td className="py-1.5 whitespace-nowrap">{r.latest ? `${r.latest.observed_date} · ${r.latest.source_label}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Keywords ────────────────────────────────────────────────────────────────

export function KeywordsTab({ project, sources }: { project: RankProject; sources: RankSources }) {
  const [rows, setRows] = useState<RankKeyword[] | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: "", group: "", status: "" });
  const [searchInput, setSearchInput] = useState("");
  const [text, setText] = useState("");
  const [group, setGroup] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<RankKeyword | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exp = useExport(project);
  const seq = useRef(0);
  const load = useCallback(async (more?: string | null) => {
    const mine = ++seq.current;
    const r = await apiRankKeywords(project.id, { search: filters.search || undefined, group: filters.group || undefined, status: filters.status || undefined, cursor: more ?? undefined });
    if (mine !== seq.current) return; // filters changed while this was loading
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load keywords.");
    setError(null);
    setRows((prev) => (more ? [...(prev ?? []), ...r.data!] : r.data!));
    setCursor(r.meta?.nextCursor ?? null);
    setGroups(r.meta?.groups ?? []);
  }, [project.id, filters]);
  useEffect(() => { setRows(null); void load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const items = text.split(/\r?\n/).map((k) => k.trim()).filter(Boolean).map((keyword) => ({ keyword, group: group.trim() || null }));
    if (!items.length || busy) return;
    await mutate(async () => {
      const r = await apiRankAddKeywords(project.id, items);
      if (r.error || !r.data) return setMessage({ ok: false, text: r.error?.message ?? "Could not add keywords." });
      setMessage({ ok: true, text: `Added ${r.data.added}, restored ${r.data.restored}, already tracked ${r.data.alreadyTracked}${r.data.invalid.length ? `, ${r.data.invalid.length} invalid` : ""}.${r.data.warnings.length ? ` ${r.data.warnings.join(" ")}` : ""}` });
      setText(""); // only cleared once the server accepted the keywords
    });
  };
  // One mutation at a time; reload the list afterwards whatever the outcome.
  const mutate = async (op: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await op();
    } catch (cause) {
      setMessage({ ok: false, text: (cause as Error).message });
    } finally {
      setBusy(false);
      void load();
    }
  };
  const importFile = async (f: File | undefined) => {
    if (!f || busy) return;
    await mutate(async () => {
      const r = await apiRankImportKeywords(project.id, await f.text());
      setMessage(r.error || !r.data ? { ok: false, text: r.error?.message ?? "Import failed." } : { ok: true, text: `Imported: ${r.data.added} added, ${r.data.restored} restored, ${r.data.alreadyTracked} already tracked, ${r.data.invalid.length} invalid.` });
    });
  };
  const toggle = (k: RankKeyword) => mutate(async () => {
    const r = await apiRankUpdateKeyword(project.id, k.id, { status: k.status === "active" ? "paused" : "active" });
    if (r.error) setMessage({ ok: false, text: r.error.message });
  });
  const remove = (k: RankKeyword) => {
    setConfirm(null);
    return mutate(async () => {
      const r = await apiRankRemoveKeyword(project.id, k.id);
      setMessage(r.error ? { ok: false, text: r.error.message } : { ok: true, text: `“${k.keyword}” removed; its history is kept and returns if you add it again.` });
    });
  };

  if (error) return <ErrorState title="Unable to load keywords" message={error} onRetry={() => void load()} />;
  return (
    <div>
      <form onSubmit={add} aria-label="Add keywords" className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">Keywords (one per line)<textarea rows={3} value={text} maxLength={40_000} onChange={(e) => setText(e.target.value)} className={`${input} w-72`} /></label>
          <label className="text-xs text-slate-700">Group<input value={group} maxLength={80} onChange={(e) => setGroup(e.target.value)} className={input} /></label>
          <button type="submit" className={btnPrimary} disabled={busy || !text.trim()}>{busy ? "Saving…" : "Add"}</button>
          <label className="text-xs text-slate-700">…or import CSV (keyword, group, landing page)<input type="file" accept=".csv,text/csv,.txt" disabled={busy} onChange={(e) => void importFile(e.target.files?.[0])} className="mt-1 block text-xs" /></label>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Up to {sources.limits.keywordsPerProject} keywords per project. Keywords are matched case- and spacing-insensitively within this project only.</p>
        {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-slate-700" : "text-red-800"}`}>{message.text}</p> : null}
      </form>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <form role="search" aria-label="Search keywords" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setFilters((f) => ({ ...f, search: searchInput.trim() })); }}>
          <label className="text-xs text-slate-700">Keyword contains<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className={input} /></label>
          <button type="submit" className={btn}>Search</button>
        </form>
        <label className="text-xs text-slate-700">Group<select value={filters.group} onChange={(e) => setFilters((f) => ({ ...f, group: e.target.value }))} className={input}><option value="">All</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
        <label className="text-xs text-slate-700">Status<select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className={input}><option value="">All</option><option value="active">Active</option><option value="paused">Paused</option></select></label>
        <button type="button" className={btn} onClick={() => void exp.run("keywords")}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {confirm ? (
        <div role="alertdialog" aria-label="Confirm removal" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
          Stop tracking “{confirm.keyword}”? Its history is kept.
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void remove(confirm)}>Remove</button>
          <button type="button" className={btn} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      ) : null}
      {!rows ? <LoadingState label="Loading keywords…" /> : rows.length === 0 ? <p className="mt-4 text-sm text-slate-500">No keywords yet.</p> : (
        <table className="mt-3 w-full text-left text-xs"><caption className="sr-only">Tracked keywords</caption>
          <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Keyword</th><th scope="col" className="py-1 pr-2">Group</th><th scope="col" className="py-1 pr-2">Landing page</th><th scope="col" className="py-1 pr-2">Source</th><th scope="col" className="py-1 pr-2">Status</th><th scope="col" className="py-1">Actions</th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id} className="border-t border-slate-100">
                <td className="py-1.5 pr-2 font-600">{k.keyword}</td><td className="py-1.5 pr-2">{k.group_name ?? "—"}</td><td className="max-w-[200px] break-all py-1.5 pr-2">{k.landing_page ?? "—"}</td>
                <td className="py-1.5 pr-2">{k.source}</td><td className="py-1.5 pr-2">{k.status}</td>
                <td className="py-1.5"><button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => void toggle(k)}>{k.status === "active" ? "Pause" : "Resume"}</button> · <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => setConfirm(k)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor ? <button type="button" className={`${btn} mt-3`} onClick={() => void load(cursor)}>Load more</button> : null}
    </div>
  );
}


// ─── History ─────────────────────────────────────────────────────────────────

export function HistoryTab({ project }: { project: RankProject }) {
  const [keywordId, setKeywordId] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const exp = useExport(project);
  const rowsQ = useApiQuery(() => apiRankRankings(project.id, { limit: 200 }), [project.id]);
  const rows: RankRow[] | null = rowsQ.data;
  useEffect(() => { setKeywordId((k) => k || rowsQ.data?.[0]?.keywordId || ""); }, [rowsQ.data]);
  const obsQ = useApiQuery(() => apiRankHistory(project.id, keywordId, { from: range.from || undefined, to: range.to || undefined }), [project.id, keywordId, range.from, range.to], { enabled: !!keywordId });
  const obs: RankObservation[] | null = obsQ.data ? obsQ.data.observations : null;
  if (rowsQ.error) return <ErrorState title="Unable to load tracked keywords" message={rowsQ.error.message} onRetry={rowsQ.reload} />;
  if (!rows) return <LoadingState label="Loading keywords…" />;
  if (!rows.length) return <EmptyState title="No keywords tracked yet" />;
  const own = project.website_domain.replace(/^www\./, "");
  const series = obs?.filter((o) => o.subject_domain === own) ?? [];
  const chart = series.filter((o) => o.status === "ranked").map((o) => ({ day: o.observed_date, position: o.position }));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Keyword<select value={keywordId} onChange={(e) => setKeywordId(e.target.value)} className={input}>{rows.map((r) => <option key={r.keywordId} value={r.keywordId}>{r.keyword}</option>)}</select></label>
        <label className="text-xs text-slate-700">From<input type="date" value={range.from} onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))} className={input} /></label>
        <label className="text-xs text-slate-700">To<input type="date" value={range.to} onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))} className={input} /></label>
        <button type="button" className={btn} onClick={() => void exp.run("history")}>Export all history</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {obsQ.error ? <InlineError what="the history" error={obsQ.error} onRetry={obsQ.reload} /> : !obs ? <LoadingState label="Loading history…" /> : obs.length === 0 ? <p className="mt-4 text-sm text-slate-500">No observations in this period.</p> : (
        <>
          {chart.length >= 2 ? (
            <div className="mt-3 h-48" role="img" aria-label="Position over time (lower is better)">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" fontSize={10} /><YAxis reversed allowDecimals={false} domain={[1, "dataMax"]} fontSize={10} /><Tooltip /><Line type="monotone" dataKey="position" stroke="#2563eb" dot /></LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <p className="mt-1 text-[11px] text-slate-500">The chart shows observed positions only; “not found”, “no data” and failed collections are listed below and never plotted as a position.</p>
          <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Observation history</caption>
            <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Date</th><th scope="col" className="py-1 pr-2">Site</th><th scope="col" className="py-1 pr-2">Position</th><th scope="col" className="py-1 pr-2">URL</th><th scope="col" className="py-1 pr-2">SERP features (yours)</th><th scope="col" className="py-1">Source</th></tr></thead>
            <tbody>{obs.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="py-1.5 pr-2 whitespace-nowrap">{o.observed_date}</td><td className="py-1.5 pr-2">{o.subject_domain}</td><td className="py-1.5 pr-2">{positionText(o)}</td>
                <td className="max-w-[220px] break-all py-1.5 pr-2">{o.ranking_url ?? "—"}</td>
                <td className="py-1.5 pr-2">{o.serp_features.length ? o.serp_features.map((f) => `${FEATURE_LABEL(f)}${o.owned_features.includes(f) ? " ✓" : ""}`).join(", ") : "—"}</td>
                <td className="py-1.5">{o.source_label}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ─── Competitors ─────────────────────────────────────────────────────────────

export function CompetitorsTab({ project, sources }: { project: RankProject; sources: RankSources }) {
  const [list, setList] = useState<Array<{ domain: string }> | null>(null);
  const [cmp, setCmp] = useState<RankCompetitorComparison | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [l, c] = await Promise.all([apiRankCompetitors(project.id), apiRankCompetitorComparison(project.id)]);
    setListError(l.error ? l.error.message : null);
    setList(l.data ?? []);
    if (c.error) { setCmp(null); setCmpError(c.error.message); } else { setCmp(c.data); setCmpError(null); }
  }, [project.id]);
  useEffect(() => void load(), [load]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiRankAddCompetitor(project.id, domain);
      setMessage(r.error ? r.error.message : r.data?.added ? `Added ${r.data.domain}.` : `${r.data?.domain} is already a competitor.`);
      if (!r.error) setDomain("");
    } catch (cause) {
      setMessage((cause as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };
  const removeCompetitor = async (d: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiRankRemoveCompetitor(project.id, d);
      setMessage(r.error ? r.error.message : `Removed ${d}.`);
    } catch (cause) {
      setMessage((cause as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };
  if (!list) return <LoadingState label="Loading competitors…" />;
  return (
    <div>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2" aria-label="Add competitor">
        <label className="text-xs text-slate-700">Competitor domain<input value={domain} maxLength={253} onChange={(e) => setDomain(e.target.value)} className={input} /></label>
        <button type="submit" className={btnPrimary} disabled={busy || !domain.trim()}>Add</button>
        <span className="text-[11px] text-slate-500">Up to {sources.limits.competitorsPerProject}.</span>
      </form>
      {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      {listError ? <InlineError what="competitors" error={{ message: listError }} onRetry={() => void load()} /> : null}
      <ul className="mt-2 flex flex-wrap gap-2 text-xs">{list.map((c) => <li key={c.domain} className="rounded-full bg-slate-100 px-2 py-0.5">{c.domain} <button type="button" aria-label={`Remove ${c.domain}`} disabled={busy} className="ml-1 text-slate-500 disabled:opacity-50" onClick={() => void removeCompetitor(c.domain)}>×</button></li>)}</ul>
      {cmpError ? <p className="mt-4 text-sm text-slate-600">{cmpError}</p> : cmp ? (
        <div className="mt-4 space-y-6">
          <p className="text-[11px] text-slate-500">{cmp.note}</p>
          {cmp.competitors.map((c) => (
            <section key={c.competitor} aria-label={`Comparison with ${c.competitor}`}>
              <h3 className="text-sm font-700 text-slate-900">{c.competitor}</h3>
              <p className="mt-1 text-xs text-slate-700">Both ranked: {c.counts.both_ranked} (you ahead {c.counts.ownAhead}, they ahead {c.counts.competitorAhead}) · only you: {c.counts.own_only} · only them: {c.counts.competitor_only} · not comparable: {c.counts.not_comparable}</p>
              <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Keywords compared with {c.competitor}</caption>
                <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Keyword</th><th scope="col" className="py-1 pr-2">Date</th><th scope="col" className="py-1 pr-2">You</th><th scope="col" className="py-1 pr-2">Them</th><th scope="col" className="py-1 pr-2">Their movement</th><th scope="col" className="py-1">Note</th></tr></thead>
                <tbody>{c.keywords.map((k) => (
                  <tr key={k.keywordId} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 pr-2 font-600">{k.keyword}</td><td className="py-1.5 pr-2">{k.date ?? "—"}</td>
                    <td className="py-1.5 pr-2">{k.own ? (k.own.position ?? "not found") : "—"}{k.own?.url ? <span className="block break-all text-[10px] text-slate-500">{k.own.url}</span> : null}</td>
                    <td className="py-1.5 pr-2">{k.competitor ? (k.competitor.position ?? "not found") : "—"}{k.competitor?.url ? <span className="block break-all text-[10px] text-slate-500">{k.competitor.url}</span> : null}</td>
                    <td className="py-1.5 pr-2">{CHANGE_LABEL[k.competitorMovement.kind]}{k.competitorMovement.delta ? ` ${k.competitorMovement.delta > 0 ? "+" : ""}${k.competitorMovement.delta}` : ""}</td>
                    <td className="py-1.5">{k.reason}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          ))}
        </div>
      ) : <LoadingState label="Comparing…" />}
    </div>
  );
}

// ─── SERP features ───────────────────────────────────────────────────────────

export function FeaturesTab({ project }: { project: RankProject }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiRankSerpFeatures>>["data"]>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiRankSerpFeatures(project.id).then((r) => (r.error ? setError(r.error.message) : setData(r.data))); }, [project.id]);
  if (error) return <ErrorState title="Unable to load SERP features" message={error} />;
  if (!data) return <LoadingState label="Loading SERP features…" />;
  if (!data.keywordsObserved) return <NoObservations />;
  return (
    <div>
      <p className="text-xs text-slate-600">
        From the latest observation of each keyword. “Seen” means the feature appeared on the results page; “yours” only when the data source attributed it to your site. A feature on the page is not evidence that you hold it.
        {data.keywordsWithFeatureData < data.keywordsObserved ? ` ${data.keywordsObserved - data.keywordsWithFeatureData} observed keyword(s) have no feature data.` : ""}
      </p>
      {data.features.length === 0 ? <p className="mt-4 text-sm text-slate-500">No SERP features in the latest observations.</p> : (
        <table className="mt-3 w-full text-left text-xs"><caption className="sr-only">SERP features</caption>
          <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Feature</th><th scope="col" className="py-1 pr-2">Seen for</th><th scope="col" className="py-1 pr-2">Yours</th><th scope="col" className="py-1">Keywords</th></tr></thead>
          <tbody>{data.features.map((f) => (
            <tr key={f.feature} className="border-t border-slate-100 align-top">
              <td className="py-1.5 pr-2 font-600">{FEATURE_LABEL(f.feature)}</td><td className="py-1.5 pr-2 tabular-nums">{f.present}</td><td className="py-1.5 pr-2 tabular-nums">{f.owned}</td>
              <td className="py-1.5">{f.keywords.map((k) => `${k.keyword}${k.owned ? " (yours)" : ""}`).join(", ")}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

const RULE_LABEL: Record<RankAlertRule["rule_type"], string> = {
  threshold_cross: "Crosses a position threshold",
  position_change: "Moves by N positions",
  url_change: "Ranking URL changes",
  became_unavailable: "Not found in N consecutive checks",
  competitor_overtake: "A competitor overtakes you",
  collection_failures: "Collection fails N times in a row",
};

export function AlertsTab({ project }: { project: RankProject }) {
  const [rules, setRules] = useState<RankAlertRule[] | null>(null);
  const [events, setEvents] = useState<RankAlertEvent[] | null>(null);
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [form, setForm] = useState({ type: "position_change" as RankAlertRule["rule_type"], position: 10, direction: "into", positions: 5, consecutive: 2, competitor: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [r, e, c] = await Promise.all([apiRankAlertRules(project.id), apiRankAlerts(project.id), apiRankCompetitors(project.id)]);
    const failed = [r.error && `rules (${r.error.message})`, e.error && `alerts (${e.error.message})`, c.error && `competitors (${c.error.message})`].filter(Boolean);
    setLoadError(failed.length ? failed.join("; ") : null);
    setRules(r.data ?? []);
    setEvents(e.data ?? []);
    setCompetitors((c.data ?? []).map((x) => x.domain));
  }, [project.id]);
  const run = async (op: () => Promise<{ error: { message: string } | null }>, ok?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await op();
      setMessage(r.error ? r.error.message : ok ?? null);
    } catch (cause) {
      setMessage((cause as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };
  useEffect(() => void load(), [load]);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, unknown> =
      form.type === "threshold_cross" ? { position: form.position, direction: form.direction } :
      form.type === "position_change" ? { positions: form.positions } :
      form.type === "became_unavailable" || form.type === "collection_failures" ? { consecutive: form.consecutive } :
      form.type === "competitor_overtake" ? { competitor: form.competitor } : {};
    await run(() => apiRankCreateAlertRule(project.id, { type: form.type, params }), "Rule added. It is checked against stored observations after every import or collection.");
  };
  if (!rules || !events) return <LoadingState label="Loading alerts…" />;
  return (
    <div>
      <form onSubmit={create} aria-label="New alert rule" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="text-xs text-slate-700">When<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as RankAlertRule["rule_type"] })} className={input}>{Object.entries(RULE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {form.type === "threshold_cross" ? <>
          <label className="text-xs text-slate-700">Top<input type="number" min={1} max={100} value={form.position} onChange={(e) => setForm({ ...form, position: Number(e.target.value) })} className={`${input} w-20`} /></label>
          <label className="text-xs text-slate-700">Direction<select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} className={input}><option value="into">Enters</option><option value="out_of">Leaves</option></select></label>
        </> : null}
        {form.type === "position_change" ? <label className="text-xs text-slate-700">Positions<input type="number" min={1} max={100} value={form.positions} onChange={(e) => setForm({ ...form, positions: Number(e.target.value) })} className={`${input} w-20`} /></label> : null}
        {form.type === "became_unavailable" || form.type === "collection_failures" ? <label className="text-xs text-slate-700">Consecutive checks<input type="number" min={1} max={10} value={form.consecutive} onChange={(e) => setForm({ ...form, consecutive: Number(e.target.value) })} className={`${input} w-20`} /></label> : null}
        {form.type === "competitor_overtake" ? <label className="text-xs text-slate-700">Competitor<select value={form.competitor} onChange={(e) => setForm({ ...form, competitor: e.target.value })} className={input}><option value="">Choose…</option>{competitors.map((c) => <option key={c} value={c}>{c}</option>)}</select></label> : null}
        <button type="submit" className={btnPrimary} disabled={busy || (form.type === "competitor_overtake" && !form.competitor)}>Add rule</button>
      </form>
      {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      {loadError ? <InlineError what={loadError} error={{ message: "showing what could be read" }} onRetry={() => void load()} /> : null}
      <p className="mt-2 text-[11px] text-slate-500">Alerts appear here (in-app). Each fires once per triggering observation; a failed collection only ever triggers the “collection fails” rule. Email delivery is not configured on this installation.</p>
      <h3 className="mt-4 text-sm font-700 text-slate-900">Rules</h3>
      {rules.length === 0 ? <p className="text-xs text-slate-600">No rules.</p> : (
        <ul className="mt-1 space-y-1 text-xs">{rules.map((r) => (
          <li key={r.id}>{RULE_LABEL[r.rule_type]} {Object.keys(r.params).length ? `(${Object.entries(r.params).map(([k, v]) => `${k} ${String(v)}`).join(", ")})` : ""} · {r.enabled ? "on" : "off"}
            <button type="button" className="ml-2 underline disabled:opacity-50" disabled={busy} onClick={() => void run(() => apiRankUpdateAlertRule(project.id, r.id, { enabled: !r.enabled }))}>{r.enabled ? "Turn off" : "Turn on"}</button></li>
        ))}</ul>
      )}
      <h3 className="mt-4 text-sm font-700 text-slate-900">Alerts</h3>
      {events.length === 0 ? <p className="text-xs text-slate-600">No alerts.</p> : (
        <ul className="mt-1 space-y-2 text-xs">{events.map((e) => (
          <li key={e.id} className={`rounded-lg border p-3 ${e.acknowledged_at ? "border-slate-100 text-slate-500" : "border-slate-200 bg-white"}`}>
            {e.message} <span className="text-slate-500">· {new Date(e.created_at).toLocaleString()}</span>
            {!e.acknowledged_at ? <button type="button" className="ml-2 underline disabled:opacity-50" disabled={busy} onClick={() => void run(() => apiRankAcknowledge(project.id, e.id))}>Acknowledge</button> : null}
          </li>
        ))}</ul>
      )}
    </div>
  );
}

// ─── Import ──────────────────────────────────────────────────────────────────

export function ImportTab({ project, sources, onImported }: { project: RankProject; sources: RankSources; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [label, setLabel] = useState("");
  const [createMissing, setCreateMissing] = useState(true);
  const [preview, setPreview] = useState<RankImportPreview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const historyQ = useApiQuery(() => apiRankImports(project.id), [project.id]);
  const jobsQ = useApiQuery(() => apiRankJobs(project.id), [project.id]);
  const history = historyQ.data;
  const jobs = jobsQ.data;
  const loadHistory = useCallback(() => {
    historyQ.reload();
    jobsQ.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload functions are stable per render
  }, [historyQ.reload, jobsQ.reload]);
  const onFile = async (f: File | undefined) => {
    setPreview(null);
    setMessage(null);
    if (!f) return setFile(null);
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) return setMessage({ ok: false, text: "Choose a .csv file." });
    if (f.size > sources.limits.importBytes) return setMessage({ ok: false, text: `The file is larger than ${Math.round(sources.limits.importBytes / 1_000_000)} MB.` });
    setFile({ name: f.name, text: await f.text() });
  };
  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await apiRankPreviewObservations(project.id, file.text);
      if (r.error || !r.data) return setMessage({ ok: false, text: r.error?.message ?? "Preview failed." });
      setPreview(r.data);
    } finally {
      setBusy(false);
    }
  };
  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await apiRankImportObservations(project.id, { csv: file.text, filename: file.name, sourceLabel: label.trim(), createMissingKeywords: createMissing });
      if (r.error || !r.data) return setMessage({ ok: false, text: r.error?.message ?? "Import failed." });
      setMessage({ ok: true, text: r.data.duplicateImport ? "This file was already imported; nothing changed." : `Imported ${r.data.inserted} observation(s); ${r.data.alreadyObserved} already present, ${r.data.rejected} rejected, ${r.data.duplicates} duplicate; ${r.data.keywordsCreated} keyword(s) added; ${r.data.alertsCreated} alert(s).` });
      setFile(null);
      setPreview(null);
      loadHistory();
      onImported();
    } finally {
      setBusy(false);
    }
  };
  const canImport = !!preview && !preview.missingRequired.length && !preview.rowLimitExceeded && preview.rows.accepted > 0 && label.trim().length > 0;
  return (
    <div>
      <section aria-labelledby="imp-h" className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 id="imp-h" className="text-sm font-700 text-slate-900">Import a ranking report</h3>
        <p className="mt-1 text-xs text-slate-600">CSV with keyword, date and position columns; optional URL, domain (your site or a project competitor), device, country, language, result depth, SERP features and owned features. “&gt;100”, “not in top 50” or “-” are stored as “not found”, never as a position. Rows for another device, country, language or engine are rejected.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">File<input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} className="mt-1 block text-xs" /></label>
          <label className="text-xs text-slate-700">Source of the report<input value={label} maxLength={80} placeholder="e.g. AccuRanker export" onChange={(e) => setLabel(e.target.value)} className={input} /></label>
          <label className="flex items-center gap-1 text-xs text-slate-700"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />Track keywords that are not in the project yet</label>
          <button type="button" className={btn} disabled={!file || busy} onClick={() => void runPreview()}>Preview</button>
          <button type="button" className={btnPrimary} disabled={!canImport || busy} onClick={() => void runImport()}>Import</button>
        </div>
        {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 rounded px-3 py-2 text-xs ${message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}>{message.text}</p> : null}
        {preview ? (
          <div role="region" aria-label="Import preview" className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            <p><strong>{preview.rows.accepted}</strong> observation(s) will be imported · {preview.rows.rejected} rejected · {preview.rows.duplicate} duplicate · {preview.rows.skipped} blank (of {preview.rows.total} rows) · {preview.newKeywords} new keyword(s)</p>
            <p className="mt-1">Statuses: {Object.entries(preview.statuses).map(([s, n]) => `${s.replace(/_/g, " ")} ${n}`).join(" · ") || "none"}</p>
            {preview.missingRequired.length ? <p role="alert" className="mt-1 text-red-800">Required columns not found: {preview.missingRequired.join(", ")}. Columns found: {preview.unmappedColumns.join(", ")}.</p> : null}
            {preview.rowLimitExceeded ? <p role="alert" className="mt-1 text-red-800">Too many rows; split the file.</p> : null}
            <p className="mt-1">Columns used: {Object.entries(preview.columns).map(([f, h]) => `${f.replace("_", " ")} ← “${h}”`).join(" · ")}</p>
            {preview.warnings.map((w, i) => <p key={i} className="mt-1 text-amber-900">⚠ {w}</p>)}
            {preview.rejectedSamples.length ? <p className="mt-1">Rejected: {preview.rejectedSamples.slice(0, 5).map((r) => `row ${r.row}: ${r.reason}`).join("; ")}</p> : null}
          </div>
        ) : null}
      </section>
      <section aria-labelledby="imph-h" className="mt-6">
        <h3 id="imph-h" className="text-sm font-700 text-slate-900">Import history</h3>
        {historyQ.error ? <InlineError what="import history" error={historyQ.error} onRetry={historyQ.reload} /> : !history ? <LoadingState label="Loading…" /> : history.length === 0 ? <p className="text-xs text-slate-600">No imports yet.</p> : (
          <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Ranking imports</caption>
            <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Imported</th><th scope="col" className="py-1 pr-2">Source</th><th scope="col" className="py-1 pr-2">Accepted</th><th scope="col" className="py-1">Rejected / duplicate / skipped</th></tr></thead>
            <tbody>{history.map((h) => <tr key={h.id} className="border-t border-slate-100"><td className="py-1.5 pr-2">{new Date(h.created_at).toLocaleString()}{h.filename ? <span className="block text-slate-500">{h.filename}</span> : null}</td><td className="py-1.5 pr-2">{h.source_label}</td><td className="py-1.5 pr-2 tabular-nums">{h.rows_accepted}</td><td className="py-1.5 tabular-nums">{h.rows_rejected} / {h.rows_duplicate} / {h.rows_skipped}</td></tr>)}</tbody>
          </table>
        )}
        {jobsQ.error ? <InlineError what="provider collections" error={jobsQ.error} onRetry={jobsQ.reload} /> : null}
        {jobs && jobs.length ? <p className="mt-3 text-xs text-slate-600">Provider collections: {jobs.slice(0, 5).map((j) => `${j.observed_date} ${j.status} (${j.keywords_done}/${j.keywords_total})`).join(" · ")}</p> : null}
      </section>
    </div>
  );
}

// ─── Data sources ────────────────────────────────────────────────────────────

export function SourcesTab({ sources }: { sources: RankSources }) {
  return (
    <div>
      <ul className="space-y-3">
        {sources.sources.map((s) => (
          <li key={s.id} aria-label={s.name} className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">{s.name}</strong>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-700 uppercase ${s.status === "available" ? "bg-emerald-50 text-emerald-800" : s.status === "not_configured" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700"}`}>{s.status.replace("_", " ")}</span>
            </div>
            <p className="mt-1 text-slate-700">{s.explanation}</p>
            {s.setup ? <p className="mt-1 text-slate-600">Next step: {s.setup}</p> : null}
            <p className="mt-1 text-slate-500">{s.costNote}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-600">Provider requests today: {sources.usage.used} of {sources.usage.limit}. Limits: {sources.limits.keywordsPerProject} keywords and {sources.limits.competitorsPerProject} competitors per project.</p>
    </div>
  );
}
