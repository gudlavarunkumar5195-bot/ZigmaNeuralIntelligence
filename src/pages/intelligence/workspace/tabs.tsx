import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../../components/ui/DataState";
import {
  apiWsActionHistory,
  apiWsActions,
  apiWsAiSummary,
  apiWsDownload,
  apiWsInsight,
  apiWsInsights,
  apiWsIntegrations,
  apiWsOverview,
  apiWsRefreshInsights,
  apiWsReport,
  apiWsUpdateAction,
  apiWsUpdateInsight,
  IntegrationRequired,
  type WsAction,
  type WsHealth,
  type WsInsight,
  type WsInsightsMeta,
  type WsOverview,
  type WsRangeParams,
  type WsReport,
  type WsSection,
} from "../../../services/api";
import { downloadBlob } from "../../search/research/shared";
import { btn, btnPrimary, card, CATEGORY_LABEL, errorMessage, fmt, fmtDay, FreshnessText, HEALTH_STATE, input, MODULE_LABEL, num, pct, Pill, SECTION_STATUS, signedPct } from "./ui";

const rangeKey = (r: WsRangeParams) => `${r.preset}|${r.from}|${r.to}|${r.compare}`;

// ─── Overview ────────────────────────────────────────────────────────────────

function SectionCard<T>({ title, section, children }: { title: string; section: WsSection<T>; children: (data: T) => ReactNode }) {
  const st = SECTION_STATUS[section.status];
  return (
    <section aria-label={title} className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-800 text-slate-900">{title} <Pill text={st.label} style={st.style} /></h3>
        <span className="flex flex-col items-end gap-0.5"><FreshnessText f={section.freshness} /><Link to={section.link} className="text-[11px] underline">Open module</Link></span>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">{section.range.note}</p>
      {section.data ? <div className="mt-2">{children(section.data)}</div> : null}
      {section.notes.length ? <ul className="mt-2 list-inside list-disc text-[11px] text-slate-600">{section.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </section>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-lg border border-slate-200 p-3"><p className="text-[11px] font-700 text-slate-600">{label}</p><p className="mt-1 text-xl font-800 tabular-nums">{value}</p>{sub ? <p className="text-[11px] text-slate-500">{sub}</p> : null}</div>;
}

export function OverviewTab({ websiteId, range }: { websiteId: string; range: WsRangeParams }) {
  const [data, setData] = useState<WsOverview | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const r = await apiWsOverview(websiteId, range);
      if (r.error || !r.data) throw new Error(r.error?.message ?? "Failed to load.");
      setData(r.data);
      setAiAvailable(!!r.meta?.ai?.available);
    } catch (e) {
      setError(e as Error);
    }
  }, [websiteId, rangeKey(range)]);
  useEffect(() => void load(), [load]);
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="SEO workspace" />;
  if (error) return <ErrorState title="Unable to load the workspace" message={error.message} onRetry={load} />;
  if (!data) return <LoadingState label="Collecting module data…" />;
  const { search, technical, rankings, backlinks, content, aiVisibility, keywords } = data.sections;
  return (
    <div className="space-y-4">
      <section aria-label="Executive summary" className={card}>
        <h3 className="text-sm font-800 text-slate-900">Summary · {fmtDay(data.range.from)} – {fmtDay(data.range.to)}{data.range.previous ? ` vs ${fmtDay(data.range.previous.from)} – ${fmtDay(data.range.previous.to)}` : ""}</h3>
        <p className="text-[11px] text-slate-500">Days follow Pacific Time, as Search Console reports them. Built only from measured values.</p>
        <ul className="mt-2 list-inside list-disc text-xs text-slate-800">{data.summary.map((s) => <li key={s}>{s}</li>)}</ul>
        {data.range.notes.length ? <p className="mt-1 text-[11px] text-amber-900">{data.range.notes.join(" ")}</p> : null}
        <AiSummary websiteId={websiteId} range={range} available={aiAvailable} />
      </section>

      <section aria-label="Data completeness" className="flex flex-wrap gap-2 text-xs">
        {Object.entries(data.completeness).map(([k, v]) => (
          <span key={k} className="rounded border border-slate-200 bg-white px-2 py-1">{MODULE_LABEL[k === "search" ? "search_console" : k === "aiVisibility" ? "ai_visibility" : k] ?? k} <Pill text={SECTION_STATUS[v.status].label} style={SECTION_STATUS[v.status].style} />{v.freshness === "stale" ? <span className="ml-1 text-amber-900">stale</span> : null}</span>
        ))}
      </section>

      <SectionCard title="Search performance" section={search}>{(s) => (
        <div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Clicks" value={num(s.current.clicks)} sub={s.comparison ? signedPct(s.comparison.clicks.changePct) : "no comparison"} />
            <Kpi label="Impressions" value={num(s.current.impressions)} sub={s.comparison ? signedPct(s.comparison.impressions.changePct) : "no comparison"} />
            <Kpi label="CTR" value={pct(s.current.ctr)} sub={s.comparison?.ctr.change !== null && s.comparison?.ctr.change !== undefined ? `${s.comparison.ctr.change >= 0 ? "+" : ""}${(s.comparison.ctr.change * 100).toFixed(2)} pts` : "no comparison"} />
            <Kpi label="Average position" value={s.current.position === null ? "No data" : s.current.position.toFixed(1)} sub={s.comparison?.position.change !== null && s.comparison?.position.change !== undefined ? `${s.comparison.position.change > 0 ? "+" : ""}${s.comparison.position.change.toFixed(1)} (lower is better)` : "no comparison"} />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">{s.coverage.current.daysWithData} of {s.coverage.current.days} days synced{s.coverage.current.daysFresh ? ` · ${s.coverage.current.daysFresh} provisional` : ""} · {s.siteUrl}</p>
          {s.series.some((p) => p.clicks !== null) ? (
            <div className="mt-2 h-48" role="img" aria-label="Daily clicks and impressions; gaps are days without synced data">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={s.series} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis yAxisId="c" tick={{ fontSize: 11 }} allowDecimals={false} width={44} />
                  <YAxis yAxisId="i" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} width={52} />
                  <Tooltip />
                  <Line yAxisId="c" type="monotone" dataKey="clicks" name="Clicks" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls={false} />
                  <Line yAxisId="i" type="monotone" dataKey="impressions" name="Impressions" stroke="#7c3aed" strokeWidth={2} dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <TopList title="Top pages" rows={s.topPages} />
            <TopList title="Top queries" rows={s.topQueries} />
          </div>
          {s.movers.length ? <div className="mt-2 text-xs"><p className="font-700">Largest click changes vs the previous period</p><ul className="mt-1 space-y-0.5">{s.movers.map((m) => <li key={`${m.dimension}-${m.key}`} className="break-all">{m.dimension}: {m.key} · {num(m.previousClicks)} → {num(m.clicks)} ({m.change !== null && m.change >= 0 ? "+" : ""}{m.change})</li>)}</ul></div> : null}
        </div>
      )}</SectionCard>

      <SectionCard title="Technical health" section={technical}>{(t) => (
        <div className="text-xs">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Pages crawled" value={num(t.latestCrawl.pagesCrawled)} sub={`${fmtDay(t.latestCrawl.crawledAt)}${t.latestCrawl.truncated ? " · stopped early" : ""}`} />
            <Kpi label="Open issues" value={num(Object.values(t.openBySeverity).reduce((a, b) => a + b, 0))} sub={["critical", "high", "medium"].map((k) => `${t.openBySeverity[k] ?? 0} ${k}`).join(" · ")} />
            <Kpi label="Indexable pages" value={`${t.indexability.indexable} / ${t.indexability.indexable + t.indexability.not_indexable + t.indexability.unknown}`} sub={`${t.indexability.not_indexable} not indexable`} />
            <Kpi label="In this range" value={`${t.inRange.detected} new · ${t.inRange.fixed} fixed`} sub={t.previousRange ? `previous: ${t.previousRange.detected} new · ${t.previousRange.fixed} fixed` : undefined} />
          </div>
          <p className="mt-2">Broken internal link targets: <span className="font-700">{t.brokenInternalLinks}</span> · Canonical issues: <span className="font-700">{t.canonicalIssues}</span> · HTTP status: {Object.entries(t.latestCrawl.statusCounts).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}</p>
          {t.topIssues.length ? <ul className="mt-2 space-y-0.5">{t.topIssues.map((i) => <li key={i.id} className="break-all"><Pill text={i.severity} style={i.severity === "critical" || i.severity === "high" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"} /> {i.title} · {i.url}</li>)}</ul> : <p className="mt-2 text-slate-600">No open issues.</p>}
          {t.history.length > 1 ? <p className="mt-2 text-[11px] text-slate-500">Open issues per crawl: {t.history.map((h) => `${fmtDay(h.crawledAt)} ${Object.values(h.issues ?? {}).reduce((a, b) => a + Number(b), 0)}`).join(" · ")}</p> : null}
        </div>
      )}</SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Keyword rankings" section={rankings}>{(r) => (
          <div className="text-xs">
            <p>{r.tracked} tracked keywords · {r.observedInRange} observed in the range · latest {fmtDay(r.latestObservedDate)}</p>
            <p className="mt-1">Improved {r.changes.improved ?? 0} · declined {r.changes.declined ?? 0} · entered {r.changes.entered ?? 0} · dropped out {r.changes.dropped_out ?? 0} · not comparable {r.changes.no_comparison ?? 0}</p>
            {r.movers.length ? <ul className="mt-1 space-y-0.5">{r.movers.slice(0, 5).map((m) => <li key={m.keyword}>{m.keyword}: {m.previousPosition ?? "not found"} → {m.position ?? "not found"} ({m.change.replace("_", " ")})</li>)}</ul> : null}
            {r.nearTop.length ? <p className="mt-1 text-slate-600">Positions 4–20 (observed): {r.nearTop.slice(0, 5).map((k) => `${k.keyword} #${k.position}`).join(", ")}</p> : null}
            {r.competitors.length ? <p className="mt-1 text-slate-600">Competitors ahead on same-day observations: {r.competitors.map((c) => `${c.domain} (${c.ahead})`).join(", ")}</p> : null}
            {Object.keys(r.serpFeatures).length ? <p className="mt-1 text-slate-600">SERP features seen: {Object.entries(r.serpFeatures).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</p> : null}
          </div>
        )}</SectionCard>
        <SectionCard title="Backlinks" section={backlinks}>{(b) => (
          <div className="text-xs">
            <p><span className="font-800">{b.referringDomains}</span> referring domains · {b.links} links in “{b.dataset.sourceLabel}” ({b.dataset.coverage} coverage, {fmtDay(b.dataset.exportedAt ?? b.dataset.retrievedAt)})</p>
            <p className="mt-1">In this range: {b.changesInRange.new} new · {b.changesInRange.lost} lost or possibly lost</p>
            {b.topLinkedPages.length ? <ul className="mt-1 space-y-0.5">{b.topLinkedPages.map((p) => <li key={p.target_url} className="break-all">{p.target_url} · {p.domains} domains</li>)}</ul> : null}
            {b.gap ? <p className="mt-1 text-slate-600">Link-gap opportunities: {b.gap.total}{b.gap.top.length ? ` (top: ${b.gap.top.map((g) => g.domain).join(", ")})` : ""}</p> : null}
          </div>
        )}</SectionCard>
        <SectionCard title="Content" section={content}>{(c) => (
          <div className="text-xs">
            <p>{c.inventory.total} pages · {c.possiblyStalePages} possibly stale · last analysis {c.lastAnalysis ? `${c.lastAnalysis.status} ${fmtDay(c.lastAnalysis.at)}` : "none"}</p>
            <p className="mt-1">Open findings: {Object.entries(c.findingsOpen).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"} · in this range {c.findingsInRange.detected} new, {c.findingsInRange.resolved} resolved</p>
            <p className="mt-1">Topic gaps: {c.topicGaps} · Briefs awaiting review: {c.briefs.in_review ?? 0} · drafts {c.briefs.draft ?? 0}</p>
            {c.topOpportunities.length ? <ul className="mt-1 space-y-0.5">{c.topOpportunities.slice(0, 3).map((o) => <li key={o.id}>{o.priority} · {o.title}</li>)}</ul> : null}
          </div>
        )}</SectionCard>
        <SectionCard title="AI visibility" section={aiVisibility}>{(a) => (
          <div className="text-xs">
            {a.brands.map((b) => (
              <div key={b.brandId} className="mb-2">
                <p className="font-700">{b.name}: {b.observations} observations · {b.openOpportunities} open recommendations</p>
                {b.groups.map((g) => <p key={`${g.key.method}-${g.key.provider}-${g.key.model}`} className="text-slate-600">{g.key.method === "manual_import" ? "Imported" : "API"} · {g.key.surface}: mentioned {g.mentionRate ? `${pct(g.mentionRate.value, 1)} (${g.mentionRate.numerator}/${g.mentionRate.denominator})` : "No data"}{g.mentionRate?.smallSample ? " · small sample" : ""}{g.topHosts.length ? ` · cited: ${g.topHosts.map((h) => h.host).join(", ")}` : ""}</p>)}
              </div>
            ))}
            <p className="text-[11px] text-slate-500">Sources: {a.providers.map((p) => `${p.name} (${p.status.replace(/_/g, " ")})`).join(", ")}</p>
          </div>
        )}</SectionCard>
      </div>

      <SectionCard title="Keyword research" section={keywords}>{(k) => <ul className="text-xs">{k.runs.map((r) => <li key={r.id}>{r.kind} · {r.status} · {fmt(r.finished_at)}</li>)}</ul>}</SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Top insights" className={card}>
          <h3 className="text-sm font-800 text-slate-900">Top insights ({data.insightsOpen} open)</h3>
          <p className="text-[11px] text-slate-500">{data.insightsEvaluatedAt ? `Evaluated ${fmt(data.insightsEvaluatedAt)}` : "Not evaluated yet."}</p>
          {data.topInsights.length ? <ul className="mt-2 space-y-1 text-xs">{data.topInsights.map((i) => <li key={i.id}><span className="font-800 tabular-nums">{i.priority}</span> · {i.title}</li>)}</ul> : <p className="mt-2 text-xs text-slate-600">None open.</p>}
          <Link to="/intelligence/workspace/insights" className="mt-2 inline-block text-xs underline">Insights explorer</Link>
        </section>
        <section aria-label="Top actions" className={card}>
          <h3 className="text-sm font-800 text-slate-900">Next actions ({data.actionsTotal} open)</h3>
          {data.topActions.length ? <ul className="mt-2 space-y-1 text-xs">{data.topActions.map((a) => <li key={a.key}><span className="font-800 tabular-nums">{a.priority}</span> · {a.title} <span className="text-slate-500">({CATEGORY_LABEL[a.category]})</span></li>)}</ul> : <p className="mt-2 text-xs text-slate-600">Nothing open.</p>}
          <Link to="/intelligence/workspace/actions" className="mt-2 inline-block text-xs underline">Action center</Link>
        </section>
      </div>

      <section aria-label="Recent jobs" className={card}>
        <h3 className="text-sm font-800 text-slate-900">Recent jobs</h3>
        {data.jobs.length ? (
          <ul className="mt-2 divide-y divide-slate-100 text-xs">{data.jobs.map((j) => <li key={`${j.module}-${j.id}`} className="py-1">{fmt(j.created_at)} · {j.module.replace(/_/g, " ")} · <span className={j.status === "failed" ? "font-700 text-red-700" : "font-700"}>{j.status}</span>{j.error ? <span className="text-slate-500"> — {j.error}</span> : null}</li>)}</ul>
        ) : <p className="mt-1 text-xs text-slate-600">No jobs yet.</p>}
      </section>
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: Array<{ key: string; clicks: number; impressions: number; ctr: number | null; position: number | null }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs"><caption className="text-left text-xs font-700 text-slate-900">{title}</caption>
        <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Item</th><th scope="col" className="py-1 pr-2">Clicks</th><th scope="col" className="py-1 pr-2">Impr.</th><th scope="col" className="py-1">CTR</th></tr></thead>
        <tbody>{rows.length ? rows.map((r) => <tr key={r.key} className="border-t border-slate-100"><td className="max-w-[16rem] break-all py-1 pr-2">{r.key}</td><td className="py-1 pr-2 tabular-nums">{r.clicks}</td><td className="py-1 pr-2 tabular-nums">{r.impressions}</td><td className="py-1 tabular-nums">{pct(r.ctr, 1)}</td></tr>) : <tr><td colSpan={4} className="py-1 text-slate-500">No rows in the range.</td></tr>}</tbody>
      </table>
    </div>
  );
}

function AiSummary({ websiteId, range, available }: { websiteId: string; range: WsRangeParams; available: boolean }) {
  const [state, setState] = useState<{ busy: boolean; text: string | null; points: Array<{ statement: string; sources: string[] }>; gaps: string[]; error: string | null; model: string | null }>({ busy: false, text: null, points: [], gaps: [], error: null, model: null });
  if (!available) return <p className="mt-2 text-[11px] text-slate-500">AI explanations are not configured; the summary above is complete without them.</p>;
  const run = async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    const r = await apiWsAiSummary(websiteId, range);
    if (r.error || !r.data) return setState((s) => ({ ...s, busy: false, error: r.error ? errorMessage(r.error) : "Failed." }));
    setState({ busy: false, text: r.data.ai.summary, points: r.data.ai.points, gaps: r.data.ai.insufficientEvidence, error: null, model: r.data.model });
  };
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <button type="button" className={btn} disabled={state.busy} onClick={() => void run()}>{state.busy ? "Explaining…" : "Explain in plain language (AI)"}</button>
      {state.error ? <p role="alert" className="mt-1 text-xs text-red-700">{state.error}</p> : null}
      {state.text ? (
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <p className="text-[11px] text-slate-500">AI interpretation ({state.model}) of the facts above — not a measurement.</p>
          <p className="mt-1">{state.text}</p>
          {state.points.length ? <ul className="mt-1 list-inside list-disc">{state.points.map((p) => <li key={p.statement}>{p.statement} <span className="text-slate-500">[{p.sources.join(", ")}]</span></li>)}</ul> : null}
          {state.gaps.length ? <p className="mt-1 text-slate-600">Insufficient evidence: {state.gaps.join(" ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Insights ────────────────────────────────────────────────────────────────

export function InsightsTab({ websiteId, range }: { websiteId: string; range: WsRangeParams }) {
  const [rows, setRows] = useState<WsInsight[] | null>(null);
  const [meta, setMeta] = useState<WsInsightsMeta | null>(null);
  const [filters, setFilters] = useState({ status: "", module: "", search: "", offset: 0 });
  const [searchInput, setSearchInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const PAGE = 25;
  useEffect(() => {
    setRows(null);
    apiWsInsights(websiteId, { status: filters.status || undefined, module: filters.module || undefined, search: filters.search || undefined, offset: filters.offset, limit: PAGE })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setMeta(r.meta ?? null); })
      .catch((e: Error) => setError(e.message));
  }, [websiteId, filters, reload]);
  const refresh = async () => {
    setMessage("Evaluating rules…");
    const r = await apiWsRefreshInsights(websiteId, range);
    setMessage(r.error ? errorMessage(r.error) : `${r.data!.detected} insights supported by current evidence${r.data!.skipped.length ? `; ${r.data!.skipped.length} rules skipped (missing data)` : ""}.`);
    setReload((n) => n + 1);
  };
  if (error) return <ErrorState title="Unable to load insights" message={error} />;
  const set = (k: "status" | "module", v: string) => setFilters((f) => ({ ...f, [k]: v, offset: 0 }));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <form role="search" aria-label="Search insights" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setFilters((f) => ({ ...f, search: searchInput.trim(), offset: 0 })); }}>
          <label className="text-xs text-slate-700">Page, keyword or topic<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className={input} /></label>
          <button type="submit" className={btn}>Search</button>
        </form>
        <label className="text-xs text-slate-700">Module<select value={filters.module} onChange={(e) => set("module", e.target.value)} className={input}><option value="">Any</option>{Object.entries(MODULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="text-xs text-slate-700">Status<select value={filters.status} onChange={(e) => set("status", e.target.value)} className={input}><option value="">Open and in progress</option>{["open", "in_progress", "resolved", "dismissed", "obsolete"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        <button type="button" className={btnPrimary} onClick={() => void refresh()}>Re-evaluate for this range</button>
      </div>
      {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      {meta?.lastRun ? <p className="mt-2 text-[11px] text-slate-500">Last evaluated {fmt(meta.lastRun.evaluated_at)} for {fmtDay(meta.lastRun.window_from)} – {fmtDay(meta.lastRun.window_to)}.{meta.lastRun.skipped_rules.length ? ` Skipped: ${meta.lastRun.skipped_rules.map((s) => `${meta.rules[s.ruleId]?.title ?? s.ruleId} (${s.reason})`).join("; ")}` : ""}</p> : <p className="mt-2 text-[11px] text-slate-500">Not evaluated yet for this website.</p>}
      <p className="mt-1 text-[11px] text-slate-500">Insights link observations across modules. They are correlations, not proof of cause. Priority: {meta?.formula}</p>
      {!rows ? <LoadingState label="Loading insights…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">{filters.status || filters.module || filters.search ? "No insights match these filters." : "No open insights. Re-evaluate after new data arrives."}</p> : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((i) => (
            <li key={i.id} className="py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1"><span className="font-800 tabular-nums">{i.priority}</span> · <span className="font-700">{i.title}</span> <span className="text-slate-500">({i.modules.map((m) => MODULE_LABEL[m] ?? m).join(" + ")} · {i.confidence} confidence · {i.status.replace("_", " ")})</span></span>
                <button type="button" className={btn} onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>{open === i.id ? "Hide" : "Evidence"}</button>
              </div>
              {open === i.id ? <InsightDetail websiteId={websiteId} id={i.id} onChanged={() => setReload((n) => n + 1)} /> : null}
            </li>
          ))}
        </ul>
      )}
      {meta && meta.total > PAGE ? (
        <div className="mt-2 flex items-center gap-2 text-xs"><span>{meta.total} insights</span>
          <button type="button" className={btn} disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE) }))}>Previous</button>
          <button type="button" className={btn} disabled={filters.offset + PAGE >= meta.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE }))}>Next</button>
        </div>
      ) : null}
    </div>
  );
}

function InsightDetail({ websiteId, id, onChanged }: { websiteId: string; id: string; onChanged: () => void }) {
  const [i, setI] = useState<(WsInsight & { formula: string }) | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiWsInsight(websiteId, id);
    if (r.data) setI(r.data);
  }, [websiteId, id]);
  useEffect(() => void load(), [load]);
  const update = async (status?: string) => {
    const r = await apiWsUpdateInsight(websiteId, id, { ...(status ? { status } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    setMessage(r.error ? errorMessage(r.error) : "Saved.");
    if (!r.error) { setNote(""); void load(); onChanged(); }
  };
  if (!i) return <LoadingState label="Loading evidence…" />;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
      <p>{i.explanation}</p>
      <p><span className="font-700">Suggested action: </span>{i.action}</p>
      <div><p className="font-700">Evidence{i.observed_from || i.observed_to ? ` (${fmtDay(i.observed_from)} – ${fmtDay(i.observed_to)})` : ""}</p>
        <ul className="list-inside list-disc">{i.evidence.map((e, n) => <li key={`${e.kind}-${e.id ?? e.url}-${n}`} className="break-all">{MODULE_LABEL[e.module] ?? e.module}: {e.label}{e.url ? ` — ${e.url}` : ""}{e.observedAt ? ` (${fmtDay(e.observedAt)})` : ""}{e.link ? <> · <Link className="underline" to={e.link}>source</Link></> : null}</li>)}</ul>
      </div>
      <div><p className="font-700">Limitations</p><ul className="list-inside list-disc">{i.limitations.map((l) => <li key={l}>{l}</li>)}</ul></div>
      <div><p className="font-700">Priority {i.priority}</p><ul className="list-inside list-disc">{i.priority_factors.map((f) => <li key={f.name}>{f.name.replace(/_/g, " ")} — weight {f.weight}, value {f.value === null ? "no data" : f.value.toFixed(2)}: {f.explanation}</li>)}</ul></div>
      {i.events?.length ? <p className="text-slate-600">History: {i.events.map((e) => `${e.event.replace(/_/g, " ")}${e.to_status ? ` → ${e.to_status}` : ""}${e.note ? ` (“${e.note}”)` : ""} ${fmtDay(e.created_at)}`).join(" · ")}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Note<input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={input} /></label>
        {i.status !== "in_progress" ? <button type="button" className={btn} onClick={() => void update("in_progress")}>Start</button> : null}
        {i.status !== "resolved" ? <button type="button" className={btn} onClick={() => void update("resolved")}>Resolved</button> : null}
        {i.status !== "dismissed" ? <button type="button" className={btn} onClick={() => void update("dismissed")}>Dismiss</button> : null}
        <button type="button" className={btn} disabled={!note.trim()} onClick={() => void update()}>Add note</button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </div>
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export function ActionsTab({ websiteId }: { websiteId: string }) {
  const [rows, setRows] = useState<WsAction[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; openByCategory: Record<string, number>; effortNote: string } | null>(null);
  const [filters, setFilters] = useState({ status: "active", category: "", offset: 0 });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const PAGE = 25;
  useEffect(() => {
    setRows(null);
    apiWsActions(websiteId, { status: filters.status, category: filters.category || undefined, offset: filters.offset, limit: PAGE })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setMeta(r.meta ?? null); })
      .catch((e: Error) => setError(e.message));
  }, [websiteId, filters, reload]);
  if (error) return <ErrorState title="Unable to load actions" message={error} />;
  const set = (k: "status" | "category", v: string) => setFilters((f) => ({ ...f, [k]: v, offset: 0 }));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Status<select value={filters.status} onChange={(e) => set("status", e.target.value)} className={input}><option value="active">Open and in progress</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select></label>
        <label className="text-xs text-slate-700">Category<select value={filters.category} onChange={(e) => set("category", e.target.value)} className={input}><option value="">All</option>{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}{meta?.openByCategory[k] ? ` (${meta.openByCategory[k]})` : ""}</option>)}</select></label>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Actions come from the modules' own findings and are never copied: when the source is fixed, the action disappears. Your status, owner, due date and notes are kept. {meta?.effortNote}</p>
      {!rows ? <LoadingState label="Loading actions…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No actions with these filters.</p> : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((a) => (
            <li key={a.key} className="py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1"><span className="font-800 tabular-nums">{a.priority}</span> · <span className="font-700">{a.title}</span> <span className="text-slate-500">({CATEGORY_LABEL[a.category]} · effort {a.effort} (heuristic) · {a.state.status.replace("_", " ")}{a.state.dueDate ? ` · due ${fmtDay(a.state.dueDate)}` : ""})</span>
                  <span className="block break-all text-slate-600">{a.detail}</span></span>
                <span className="inline-flex gap-1">
                  <Link to={a.link} className={btn}>Open source</Link>
                  <button type="button" className={btn} onClick={() => setOpen(open === a.key ? null : a.key)} aria-expanded={open === a.key}>{open === a.key ? "Hide" : "Manage"}</button>
                </span>
              </div>
              {open === a.key ? <ActionEditor websiteId={websiteId} action={a} onChanged={() => setReload((n) => n + 1)} /> : null}
            </li>
          ))}
        </ul>
      )}
      {meta && meta.total > PAGE ? (
        <div className="mt-2 flex items-center gap-2 text-xs"><span>{meta.total} actions</span>
          <button type="button" className={btn} disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE) }))}>Previous</button>
          <button type="button" className={btn} disabled={filters.offset + PAGE >= meta.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE }))}>Next</button>
        </div>
      ) : null}
    </div>
  );
}

function ActionEditor({ websiteId, action, onChanged }: { websiteId: string; action: WsAction; onChanged: () => void }) {
  const [status, setStatus] = useState(action.state.status);
  const [due, setDue] = useState(action.state.dueDate ?? "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ event: string; from_value: string | null; to_value: string | null; note: string | null; created_at: string }> | null>(null);
  useEffect(() => { void apiWsActionHistory(websiteId, action.source, action.sourceRef).then((r) => setHistory(r.data ?? [])); }, [websiteId, action.source, action.sourceRef]);
  const save = async () => {
    const r = await apiWsUpdateAction(websiteId, { source: action.source, sourceRef: action.sourceRef, ...(status !== action.state.status ? { status } : {}), ...(due !== (action.state.dueDate ?? "") ? { dueDate: due || null } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    setMessage(r.error ? errorMessage(r.error) : "Saved.");
    if (!r.error) onChanged();
  };
  const changed = status !== action.state.status || due !== (action.state.dueDate ?? "") || !!note.trim();
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
      <p><span className="font-700">Recommended next step: </span>{action.recommendedAction}</p>
      <p className="text-slate-600">Source: {action.source.replace(/_/g, " ")} ({action.sourceStatus}) · priority basis: {action.priorityBasis}{action.detectedAt ? ` · detected ${fmtDay(action.detectedAt)}` : ""}</p>
      {action.state.note ? <p className="text-slate-600">Latest note: {action.state.note}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Set status<select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={input}><option value="open">Open</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select></label>
        <label className="text-xs">Due date<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={input} /></label>
        <label className="text-xs">Note<input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={input} /></label>
        <button type="button" className={btnPrimary} disabled={!changed} onClick={() => void save()}>Save</button>
        {message ? <span role="status">{message}</span> : null}
      </div>
      {history?.length ? <p className="text-slate-600">History: {history.map((h) => `${h.event.replace(/_/g, " ")}${h.to_value ? ` → ${h.to_value}` : ""}${h.note ? ` (“${h.note}”)` : ""} ${fmtDay(h.created_at)}`).join(" · ")}</p> : null}
    </div>
  );
}

// ─── Integration health ──────────────────────────────────────────────────────

export function IntegrationsTab({ websiteId }: { websiteId: string }) {
  const [rows, setRows] = useState<WsHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await apiWsIntegrations(websiteId);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setRows(r.data);
  }, [websiteId]);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorState title="Unable to load integration health" message={error} onRetry={load} />;
  if (!rows) return <LoadingState label="Checking integrations…" />;
  return (
    <div>
      <p className="text-[11px] text-slate-500">States come from job timestamps and recorded statuses. Nothing here calls an external provider, and stored credentials alone never count as healthy.</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {rows.map((h) => (
          <li key={h.id} className={card}>
            <p className="text-sm font-800 text-slate-900">{h.name} <Pill text={HEALTH_STATE[h.state].label} style={HEALTH_STATE[h.state].style} /></p>
            <p className="mt-1 text-xs text-slate-700">{h.detail}</p>
            <p className="mt-1 text-[11px] text-slate-500">Last success: {fmt(h.lastSuccessAt)}{h.lastFailureAt ? ` · last failure: ${fmt(h.lastFailureAt)}` : ""}</p>
            <Link to={h.link} className="mt-1 inline-block text-xs underline">Open</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

const REPORT_SECTIONS: Array<[string, string]> = [["summary", "Executive summary"], ["search", "Search performance"], ["technical", "Technical health"], ["rankings", "Rankings"], ["backlinks", "Backlinks"], ["content", "Content"], ["ai_visibility", "AI visibility"], ["actions", "Priority actions"], ["sources", "Data sources"]];
const EXPORTS: Array<[string, string]> = [["actions", "Actions"], ["insights", "Insights"], ["search_pages", "Search pages"], ["search_queries", "Search queries"], ["issues", "Open technical issues"], ["rankings", "Rankings"]];

export function ReportTab({ websiteId, range }: { websiteId: string; range: WsRangeParams }) {
  const [sections, setSections] = useState<string[]>(REPORT_SECTIONS.map(([k]) => k));
  const [report, setReport] = useState<WsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const preview = async () => {
    setBusy(true);
    setMessage(null);
    const r = await apiWsReport(websiteId, range, sections);
    setBusy(false);
    if (r.error || !r.data) return setMessage(r.error ? errorMessage(r.error) : "Failed.");
    setReport(r.data);
  };
  const download = async (kind: { dataset: string } | { report: string[] }) => {
    setMessage("Preparing download…");
    const out = await apiWsDownload(websiteId, kind, range);
    if ("error" in out) return setMessage(out.error);
    downloadBlob(out.blob, out.filename);
    setMessage("Downloaded.");
  };
  const toggle = (k: string) => setSections((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  return (
    <div className="space-y-4">
      <section aria-label="Report options" className={card}>
        <fieldset><legend className="text-sm font-800 text-slate-900">Sections</legend>
          <div className="mt-2 flex flex-wrap gap-3">{REPORT_SECTIONS.map(([k, l]) => <label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={sections.includes(k)} onChange={() => toggle(k)} /> {l}</label>)}</div>
        </fieldset>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} disabled={!sections.length || busy} onClick={() => void preview()}>{busy ? "Building…" : "Preview report"}</button>
          <button type="button" className={btn} disabled={!sections.length} onClick={() => void download({ report: sections })}>Download report (Markdown)</button>
        </div>
        <div className="mt-3"><p className="text-xs font-700 text-slate-900">CSV exports for the selected range</p>
          <div className="mt-1 flex flex-wrap gap-2">{EXPORTS.map(([k, l]) => <button key={k} type="button" className={btn} onClick={() => void download({ dataset: k })}>{l}</button>)}</div>
        </div>
        {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      </section>
      {report ? (
        <article aria-label="Report preview" className={card}>
          <h3 className="text-base font-800 text-slate-900">{report.title}</h3>
          <p className="text-[11px] text-slate-500">{fmtDay(report.range.from)} – {fmtDay(report.range.to)} · generated {fmt(report.generatedAt)}</p>
          {report.sections.includes("summary") ? <ul className="mt-2 list-inside list-disc text-xs">{report.summary.map((s) => <li key={s}>{s}</li>)}</ul> : null}
          <h4 className="mt-3 text-xs font-800">Data completeness</h4>
          <ul className="text-xs">{Object.entries(report.completeness).map(([k, v]) => <li key={k}>{k}: {SECTION_STATUS[v.status].label}{v.lastUpdatedAt ? ` (updated ${fmt(v.lastUpdatedAt)})` : ""}</li>)}</ul>
          {report.actions ? <><h4 className="mt-3 text-xs font-800">Priority actions</h4><ol className="list-inside list-decimal text-xs">{report.actions.slice(0, 10).map((a) => <li key={a.key}>{a.title} ({CATEGORY_LABEL[a.category]})</li>)}</ol></> : null}
          {report.sources ? <><h4 className="mt-3 text-xs font-800">Data sources</h4><ul className="text-xs">{report.sources.map((s) => <li key={s.id}>{s.name}: {HEALTH_STATE[s.state].label}</li>)}</ul></> : null}
          <h4 className="mt-3 text-xs font-800">Definitions</h4><ul className="list-inside list-disc text-[11px] text-slate-600">{report.definitions.map((d) => <li key={d}>{d}</li>)}</ul>
          <h4 className="mt-3 text-xs font-800">Limitations</h4><ul className="list-inside list-disc text-[11px] text-slate-600">{report.limitations.map((d) => <li key={d}>{d}</li>)}</ul>
        </article>
      ) : null}
    </div>
  );
}
