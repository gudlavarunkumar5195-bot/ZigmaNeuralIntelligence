import { useCallback, useEffect, useState } from "react";
import { useBusy } from "../../../lib/useBusy";
import { Link } from "react-router";
import { EmptyState, ErrorState, InlineError, LoadingState } from "../../../components/ui/DataState";
import {
  apiAivAiSummaries,
  apiAivComparison,
  apiAivCompetitors,
  apiAivCreateAiSummary,
  apiAivDomains,
  apiAivExport,
  apiAivObservation,
  apiAivObservations,
  apiAivOpportunities,
  apiAivOpportunity,
  apiAivOverview,
  apiAivQueries,
  apiAivSetExcluded,
  apiAivSources,
  apiAivUpdateOpportunity,
  apiAivVerifySource,
  type AivAiSummary,
  type AivBrand,
  type AivComparison,
  type AivDomains,
  type AivObservation,
  type AivObservationRow,
  type AivOpportunity,
  type AivOpportunityDetail,
  type AivOverview,
  type AivProviders,
  type AivQuery,
  type AivSource,
} from "../../../services/api";
import { downloadBlob } from "../../search/research/shared";
import { btn, btnPrimary, card, CITATION_KIND_LABEL, errorMessage, fmt, fmtDay, groupLabel, groupSource, input, MethodPill, MetricValue, OPPORTUNITY_KIND_LABEL, pct, PROVIDER_STATUS, StatusPill, VERIFICATION_LABEL } from "./ui";

function useExport(brandId: string) {
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (kind: "observations" | "sources" | "metrics") => {
    const out = await apiAivExport(brandId, kind);
    if ("error" in out) return setNotice(out.error);
    downloadBlob(out.blob, out.filename);
    setNotice("Export downloaded.");
  };
  return { run, notice };
}

function NoObservations() {
  return (
    <EmptyState
      title="No observations yet"
      description="Add the questions you want to check, then collect answers with a configured provider or import answers you observed. Until then there is nothing to measure."
      action={<span className="inline-flex gap-2"><Link className={btn} to="/intelligence/ai-visibility/queries">Queries</Link><Link className={btnPrimary} to="/intelligence/ai-visibility/import">Import answers</Link></span>}
    />
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function OverviewTab({ brand, providers }: { brand: AivBrand; providers: AivProviders }) {
  const [data, setData] = useState<AivOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exp = useExport(brand.id);
  const load = useCallback(async () => {
    setError(null);
    const r = await apiAivOverview(brand.id);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setData(r.data);
  }, [brand.id]);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorState title="Unable to load the overview" message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading overview…" />;
  const c = data.counts;
  const surfaces = data.metrics.surfaces;
  return (
    <div className="space-y-5">
      <section aria-label="Visibility summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={card}><p className="text-xs font-700 text-slate-600">Query coverage</p><p className="mt-1 text-2xl font-800 tabular-nums">{c.queries_observed} <span className="text-sm font-600 text-slate-500">of {c.active_queries} active</span></p><p className="text-[11px] text-slate-500">queries with at least one observation</p></div>
        <div className={card}><p className="text-xs font-700 text-slate-600">Observations</p><p className="mt-1 text-2xl font-800 tabular-nums">{c.observations}</p><p className="text-[11px] text-slate-500">{c.api_observations} via API · {c.imported_observations} imported{c.excluded_observations ? ` · ${c.excluded_observations} excluded` : ""}</p></div>
        <div className={card}><p className="text-xs font-700 text-slate-600">Last collected</p><p className="mt-1 text-sm font-700">{fmt(c.last_observed_at)}</p><p className="text-[11px] text-slate-500">{data.competitors} competitors monitored</p></div>
        <div className={card}><p className="text-xs font-700 text-slate-600">Provider requests today</p><p className="mt-1 text-sm font-700 tabular-nums">{data.usage.used} of {data.usage.limit}</p><p className="text-[11px] text-slate-500">daily limit for this organization</p></div>
      </section>

      <section aria-labelledby="aiv-coverage">
        <h3 id="aiv-coverage" className="text-sm font-800 text-slate-900">Sources and their status</h3>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {data.providers.map((p) => <li key={p.id} className="rounded border border-slate-200 bg-white px-2 py-1" title={p.detail}>{p.name} <StatusPill text={PROVIDER_STATUS[p.status].label} style={PROVIDER_STATUS[p.status].style} /></li>)}
        </ul>
      </section>

      {c.observations === 0 ? <NoObservations /> : (
        <section aria-labelledby="aiv-metrics">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="aiv-metrics" className="text-sm font-800 text-slate-900">Mentions and citations (since {fmtDay(data.metrics.window.from)})</h3>
            <span className="inline-flex gap-2"><button type="button" className={btn} onClick={() => void exp.run("metrics")}>Export metrics</button><button type="button" className={btn} onClick={() => void exp.run("observations")}>Export observations</button></span>
          </div>
          {exp.notice ? <p role="status" className="mt-1 text-xs text-slate-700">{exp.notice}</p> : null}
          <p className="mt-1 text-xs text-slate-600">{data.metrics.note} Values marked “small sample” rest on fewer than {data.metrics.minSample} eligible observations.</p>
          {data.metrics.staleMentions ? <p className="mt-1 text-xs text-amber-900">{data.metrics.staleMentions} observations were matched with older brand terms and could not be re-matched (their full text is not retained).</p> : null}
          {data.metrics.groups.length === 0 ? <p className="mt-2 text-xs text-slate-600">No observations in this window.</p> : data.metrics.groups.map((g) => (
            <div key={groupLabel(g.key, surfaces)} className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-800 text-slate-900"><MethodPill method={g.key.method} /> {groupSource(g.key, surfaces)}</p>
              <p className="text-[11px] text-slate-500">{g.sample.answered} answered of {g.sample.observations} observations · {g.sample.queries} queries · {g.sample.withCitations} with citations · {fmtDay(g.sample.firstObservedAt)} – {fmtDay(g.sample.lastObservedAt)}{g.sample.languages.length ? ` · ${g.sample.languages.join(", ")}` : ""}{g.sample.countries.length ? ` · ${g.sample.countries.join(", ").toUpperCase()}` : ""}</p>
              <table className="mt-2 w-full text-left text-xs"><caption className="sr-only">Metrics for {groupLabel(g.key, surfaces)}</caption>
                <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Brand</th><th scope="col" className="py-1 pr-2">Mention rate</th><th scope="col" className="py-1 pr-2">Query coverage</th><th scope="col" className="py-1 pr-2">Share of mentions</th><th scope="col" className="py-1 pr-2">Own-domain citation rate</th><th scope="col" className="py-1">Last mentioned</th></tr></thead>
                <tbody>{g.brands.map((b) => (
                  <tr key={b.brandId} className={`border-t border-slate-100 ${b.kind === "target" ? "font-700" : ""}`}>
                    <th scope="row" className="py-1 pr-2 text-left">{b.name}{b.kind === "target" ? "" : " (competitor)"}</th>
                    <td className="py-1 pr-2"><MetricValue m={b.mentionRate} /></td>
                    <td className="py-1 pr-2"><MetricValue m={b.queryCoverage} /></td>
                    <td className="py-1 pr-2"><MetricValue m={b.mentionShare} /></td>
                    <td className="py-1 pr-2"><MetricValue m={b.citationRate} /></td>
                    <td className="py-1">{fmtDay(b.lastMentionAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="mt-1 text-[11px] text-slate-500">Consistency across repeated answers: <MetricValue m={g.consistency} /> · {g.sources.distinctHosts} cited hosts{g.sources.topHosts[0] ? ` (most cited: ${g.sources.topHosts[0].host})` : ""}</p>
              {g.trend.length > 1 ? <p className="mt-1 text-[11px] text-slate-500">Weekly mention rate: {g.trend.map((t) => `${t.period} ${pct(t.rate)} (n=${t.answered})`).join(" · ")}</p> : null}
            </div>
          ))}
          <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer font-700">How these metrics are calculated</summary>
            <dl className="mt-1 grid gap-1">{Object.entries(data.metrics.definitions).map(([k, d]) => <div key={k}><dt className="font-700">{d.label}</dt><dd>{d.numerator} ÷ {d.denominator}. {d.missing}</dd></div>)}</dl>
          </details>
        </section>
      )}

      <section aria-labelledby="aiv-changes">
        <h3 id="aiv-changes" className="text-sm font-800 text-slate-900">Notable changes</h3>
        {data.changes.length === 0 ? <p className="mt-1 text-xs text-slate-600">No change of 20 points or more between the last two weeks that each have at least {data.metrics.minSample} answers.</p> : (
          <ul className="mt-1 text-xs">{data.changes.map((ch) => <li key={`${groupLabel(ch.key, surfaces)}-${ch.to.period}`}>{groupLabel(ch.key, surfaces)}: mention rate {pct(ch.from.rate)} ({ch.from.period}, n={ch.from.answered}) → {pct(ch.to.rate)} ({ch.to.period}, n={ch.to.answered})</li>)}</ul>
        )}
      </section>

      <section aria-labelledby="aiv-runs">
        <h3 id="aiv-runs" className="text-sm font-800 text-slate-900">Recent collection</h3>
        {data.runs.length === 0 ? <p className="mt-1 text-xs text-slate-600">No provider runs yet.</p> : (
          <ul className="mt-1 text-xs">{data.runs.map((r) => <li key={r.id}>{fmt(r.created_at)} · {r.provider} · {r.status} · {r.items_done}/{r.items_total} answered{r.items_failed ? `, ${r.items_failed} failed` : ""}</li>)}</ul>
        )}
      </section>

      <section aria-labelledby="aiv-top-opp">
        <h3 id="aiv-top-opp" className="text-sm font-800 text-slate-900">Top recommendations</h3>
        {data.topOpportunities.length === 0 ? <p className="mt-1 text-xs text-slate-600">None open.</p> : (
          <ul className="mt-1 space-y-1 text-xs">{data.topOpportunities.map((o) => <li key={o.id}><span className="font-800 tabular-nums">{o.priority}</span> · {o.title} <span className="text-slate-500">({o.confidence} confidence)</span></li>)}</ul>
        )}
        <Link to="/intelligence/ai-visibility/recommendations" className="mt-2 inline-block text-xs underline">All recommendations</Link>
      </section>

      <AiSummaries brand={brand} available={providers.ai.available} hasData={c.observations > 0} />
    </div>
  );
}

function AiSummaries({ brand, available, hasData }: { brand: AivBrand; available: boolean; hasData: boolean }) {
  const [list, setList] = useState<AivAiSummary[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await apiAivAiSummaries(brand.id);
    if (r.data) setList(r.data);
  }, [brand.id]);
  useEffect(() => void load(), [load]);
  const create = async () => {
    setBusy(true);
    const r = await apiAivCreateAiSummary(brand.id);
    setBusy(false);
    setMessage(r.error ? errorMessage(r.error) : r.data?.dropped ? `${r.data.dropped} unsupported references in the AI output were discarded.` : null);
    void load();
  };
  const latest = list?.[0];
  return (
    <section aria-labelledby="aiv-ai" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="aiv-ai" className="text-sm font-800 text-slate-900">AI interpretation</h3>
        <button type="button" className={btn} disabled={!available || !hasData || busy} onClick={() => void create()}>{busy ? "Analysing…" : "Summarise patterns"}</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{available ? "A model describes patterns in the measured data. It is an interpretation, not a measurement; every pattern links to the observations it cites." : "AI analysis is not configured. All measurements above work without it."}</p>
      {message ? <p role="status" className="mt-1 text-xs text-slate-700">{message}</p> : null}
      {latest ? (
        <div className="mt-2 text-xs text-slate-800">
          <p className="text-[11px] text-slate-500">Model {latest.model} · {fmt(latest.created_at)}</p>
          <p className="mt-1">{latest.body.summary}</p>
          {latest.body.patterns.length ? <ul className="mt-1 list-inside list-disc">{latest.body.patterns.map((p) => <li key={p.statement}>{p.statement} <span className="text-slate-500">(observations: {p.observationIds.length})</span></li>)}</ul> : null}
          {latest.body.sourceCategories.length ? <p className="mt-1 text-slate-600">Source types: {latest.body.sourceCategories.map((s) => `${s.host} — ${s.category.replace(/_/g, " ")}`).join("; ")}</p> : null}
          {latest.body.caveats.length ? <p className="mt-1 text-slate-500">Caveats: {latest.body.caveats.join(" ")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Observations ────────────────────────────────────────────────────────────

export function ObservationsTab({ brand, providers }: { brand: AivBrand; providers: AivProviders }) {
  const [rows, setRows] = useState<AivObservationRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queries, setQueries] = useState<AivQuery[]>([]);
  const [competitors, setCompetitors] = useState<AivBrand[]>([]);
  const [filterError, setFilterError] = useState<{ message: string; status?: number } | null>(null);
  const [f, setF] = useState({ queryId: "", method: "", surface: "", mentions: "", notMentioned: false, hasCitations: "", from: "", to: "", includeExcluded: false });
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFilterError(null);
    const fail = (e: { message: string; status?: number }) => { if (live) setFilterError(e); };
    apiAivQueries(brand.id, { limit: 200 }).then((r) => { if (!live) return; if (r.error) fail(r.error); else setQueries(r.data ?? []); }, (e: Error) => fail(e));
    apiAivCompetitors(brand.id).then((r) => { if (!live) return; if (r.error) fail(r.error); else setCompetitors(r.data ?? []); }, (e: Error) => fail(e));
    return () => { live = false; };
  }, [brand.id]);
  const params = useCallback((after?: string) => ({
    queryId: f.queryId || undefined, method: (f.method || undefined) as "provider_api" | "manual_import" | undefined, surface: f.surface || undefined, mentions: f.mentions || undefined,
    notMentioned: f.mentions ? f.notMentioned : undefined, hasCitations: f.hasCitations ? f.hasCitations === "true" : undefined, from: f.from || undefined, to: f.to || undefined, includeExcluded: f.includeExcluded, limit: 25, cursor: after,
  }), [f]);
  useEffect(() => {
    setRows(null);
    setError(null);
    apiAivObservations(brand.id, params())
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setCursor(r.meta?.nextCursor ?? null); })
      .catch((e: Error) => setError(e.message));
  }, [brand.id, params]);
  const more = async () => {
    if (!cursor) return;
    const r = await apiAivObservations(brand.id, params(cursor));
    if (r.data) { setRows((x) => [...(x ?? []), ...r.data!]); setCursor(r.meta?.nextCursor ?? null); }
  };
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const filtered = !!(f.queryId || f.method || f.surface || f.mentions || f.hasCitations || f.from || f.to);
  if (error) return <ErrorState title="Unable to load observations" message={error} />;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Query<select value={f.queryId} onChange={(e) => set("queryId", e.target.value)} className={`${input} max-w-xs`}><option value="">Any</option>{queries.map((q) => <option key={q.id} value={q.id}>{q.text.slice(0, 80)}</option>)}</select></label>
        <label className="text-xs text-slate-700">Collection<select value={f.method} onChange={(e) => set("method", e.target.value)} className={input}><option value="">Any</option><option value="provider_api">API</option><option value="manual_import">Imported</option></select></label>
        <label className="text-xs text-slate-700">Surface<select value={f.surface} onChange={(e) => set("surface", e.target.value)} className={input}><option value="">Any</option>{Object.entries(providers.surfaces).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="text-xs text-slate-700">Mentions brand<select value={f.mentions} onChange={(e) => set("mentions", e.target.value)} className={input}><option value="">Any</option><option value={brand.id}>{brand.name}</option>{competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {f.mentions ? <label className="text-xs text-slate-700">Mention<select value={f.notMentioned ? "no" : "yes"} onChange={(e) => set("notMentioned", e.target.value === "no")} className={input}><option value="yes">Mentioned</option><option value="no">Not mentioned</option></select></label> : null}
        <label className="text-xs text-slate-700">Citations<select value={f.hasCitations} onChange={(e) => set("hasCitations", e.target.value)} className={input}><option value="">Any</option><option value="true">With citations</option><option value="false">Without</option></select></label>
        <label className="text-xs text-slate-700">From<input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} className={input} /></label>
        <label className="text-xs text-slate-700">To<input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} className={input} /></label>
        <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={f.includeExcluded} onChange={(e) => set("includeExcluded", e.target.checked)} /> Include excluded</label>
      </div>
      {!rows ? <LoadingState label="Loading observations…" /> : rows.length === 0 ? (filtered ? <p className="mt-6 text-center text-sm text-slate-500">No observations match these filters.</p> : <NoObservations />) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((o) => (
            <li key={o.id} className="py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p><MethodPill method={o.collection_method} /> <span className="font-700">{providers.surfaces[o.surface] ?? o.surface}</span>{o.model ? ` · ${o.model}` : ""} · {fmt(o.observed_at)}{o.excluded_at ? <span className="ml-1 text-amber-900">· excluded</span> : null}</p>
                  <p className="mt-0.5 font-700 text-slate-900">{o.query_text}</p>
                  <p className="mt-0.5 text-slate-600">{o.answer_status !== "answered" ? `[${o.answer_status}] ` : ""}{o.excerpt ?? (o.response_retention === "none" ? "(answer text not retained)" : "")}</p>
                  <p className="mt-0.5 text-slate-500">Mentions: {o.mentions.length ? o.mentions.map((m) => m.name).join(", ") : "none of the monitored brands"} · {o.citations} citations</p>
                </div>
                <button type="button" className={btn} onClick={() => setDetail(detail === o.id ? null : o.id)} aria-expanded={detail === o.id}>{detail === o.id ? "Hide" : "View"}</button>
              </div>
              {detail === o.id ? <ObservationDetail brand={brand} id={o.id} providers={providers} onChanged={() => setF((x) => ({ ...x }))} /> : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? <button type="button" className={`${btn} mt-2`} onClick={() => void more()}>Load more</button> : null}
    </div>
  );
}

function ObservationDetail({ brand, id, providers, onChanged }: { brand: AivBrand; id: string; providers: AivProviders; onChanged: () => void }) {
  const [o, setO] = useState<AivObservation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiAivObservation(brand.id, id);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setO(r.data);
  }, [brand.id, id]);
  useEffect(() => void load(), [load]);
  const toggleExcluded = async () => {
    if (!o) return;
    const exclude = !o.excluded_at;
    if (exclude && reason.trim().length < 3) return setMessage("Give a reason (at least 3 characters).");
    const r = await apiAivSetExcluded(brand.id, id, exclude, reason.trim());
    setMessage(r.error ? errorMessage(r.error) : exclude ? "Excluded from metrics. The observation is kept." : "Included in metrics again.");
    void load();
    onChanged();
  };
  if (error) return <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>;
  if (!o) return <LoadingState label="Loading observation…" />;
  return (
    <div className="mt-2 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="inline font-700">Collection: </dt><dd className="inline">{o.collection_method === "manual_import" ? `Manually imported${o.import_label ? ` (“${o.import_label}”${o.import_filename ? `, ${o.import_filename}` : ""})` : ""} — not an API result` : `Provider API (${o.run_trigger ?? "run"})`}</dd></div>
        <div><dt className="inline font-700">Surface / provider: </dt><dd className="inline">{providers.surfaces[o.surface] ?? o.surface} / {o.provider}{o.model ? ` · ${o.model}` : ""}</dd></div>
        <div><dt className="inline font-700">Observed: </dt><dd className="inline">{fmt(o.observed_at)}{o.language ? ` · ${o.language}` : ""}{o.country ? ` · ${o.country.toUpperCase()}` : ""}</dd></div>
        <div><dt className="inline font-700">Query version: </dt><dd className="inline">v{o.query_version}{o.prompt_version ? ` · prompt ${o.prompt_version}` : ""}</dd></div>
        {o.provider_request_id ? <div><dt className="inline font-700">Provider request: </dt><dd className="inline font-mono">{o.provider_request_id}</dd></div> : null}
        <div><dt className="inline font-700">Web search: </dt><dd className="inline">{o.web_grounded === null ? "Unknown (imported)" : o.web_grounded ? "Yes" : "No"}</dd></div>
        {o.usage ? <div><dt className="inline font-700">Usage: </dt><dd className="inline">{Object.entries(o.usage).map(([k, v]) => `${k} ${v}`).join(", ")}</dd></div> : null}
        {o.notes ? <div><dt className="inline font-700">Notes: </dt><dd className="inline">{o.notes}</dd></div> : null}
      </dl>
      <div>
        <p className="font-700">Answer ({o.answer_status}{o.response_retention === "truncated" ? `, first part of ${o.response_chars} characters kept` : ""})</p>
        {o.response_text !== null ? <p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{o.response_text}</p> : <p className="mt-1 text-slate-500">The answer text is not retained (configured retention); only its hash, mentions and citations are stored.</p>}
      </div>
      <div>
        <p className="font-700">Brand mentions{!o.mentionsCurrent ? " (matched with older brand terms)" : ""}</p>
        {o.mentions.length === 0 ? <p className="text-slate-600">The answer names none of the monitored brands.</p> : (
          <ul className="mt-1 list-inside list-disc">{o.mentions.map((m) => <li key={m.brand_id}><span className="font-700">{m.name}</span> — {m.match_count}× via {m.matched_by.join(", ")} ({m.matched_terms.join(", ")}){m.excerpt ? <span className="block pl-4 text-slate-600">“{m.excerpt}”</span> : null}</li>)}</ul>
        )}
      </div>
      <div>
        <p className="font-700">Citations</p>
        {o.citations.length === 0 ? <p className="text-slate-600">No citations{o.collection_method === "provider_api" && !o.web_grounded ? " (answers without web search usually cite nothing)" : ""}.</p> : (
          <ol className="mt-1 list-inside list-decimal">{o.citations.map((c) => <li key={c.id} className="break-all">{c.normalized_url} <span className="text-slate-500">· {CITATION_KIND_LABEL[c.kind] ?? c.kind}{c.cited_brand ? ` · ${c.cited_brand}'s domain` : ""} · {VERIFICATION_LABEL[c.verification_status] ?? c.verification_status}{c.idn ? " · internationalized domain (check for look-alikes)" : ""}</span></li>)}</ol>
        )}
      </div>
      {o.events.length ? <p className="text-slate-600">History: {o.events.map((e) => `${e.event.replace(/_/g, " ")} ${fmt(e.created_at)}`).join(" · ")}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        {!o.excluded_at ? <label className="text-xs">Reason to exclude<input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} /></label> : <p>Excluded: {o.exclusion_reason}</p>}
        <button type="button" className={btn} onClick={() => void toggleExcluded()}>{o.excluded_at ? "Include in metrics" : "Exclude from metrics"}</button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </div>
  );
}

// ─── Citations ───────────────────────────────────────────────────────────────

export function CitationsTab({ brand }: { brand: AivBrand }) {
  const [domains, setDomains] = useState<AivDomains | null>(null);
  const [sources, setSources] = useState<AivSource[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ owner: "", verification: "", offset: 0 });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const exp = useExport(brand.id);
  const PAGE = 50;
  useEffect(() => {
    apiAivDomains(brand.id).then((r) => { if (r.error) return setError(r.error.message); setDomains(r.data); }).catch((e: Error) => setError(e.message));
  }, [brand.id, reload]);
  useEffect(() => {
    setSources(null);
    apiAivSources(brand.id, { owner: filters.owner || undefined, verification: filters.verification || undefined, offset: filters.offset, limit: PAGE })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setSources(r.data); setTotal(r.meta?.total ?? 0); })
      .catch((e: Error) => setError(e.message));
  }, [brand.id, filters, reload]);
  const verify = async (s: AivSource) => {
    setMessage(`Checking ${s.normalized_url}…`);
    const r = await apiAivVerifySource(brand.id, s.id);
    setMessage(r.error ? errorMessage(r.error) : `${s.normalized_url}: ${VERIFICATION_LABEL[r.data!.status] ?? r.data!.status}${r.data!.httpStatus ? ` (HTTP ${r.data!.httpStatus})` : ""}.`);
    setReload((n) => n + 1);
  };
  if (error) return <ErrorState title="Unable to load citations" message={error} />;
  const set = (k: "owner" | "verification", v: string) => setFilters((f) => ({ ...f, [k]: v, offset: 0 }));
  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-600">A citation shows that an answer referenced a URL; it does not prove the page supports the answer. Verification loads a page once (robots.txt honoured, private addresses refused) and only checks that it loads and names your brand.</p>
      <section aria-labelledby="aiv-domains">
        <h3 id="aiv-domains" className="text-sm font-800 text-slate-900">Cited domains{domains ? ` (since ${fmtDay(domains.window.from)})` : ""}</h3>
        {!domains ? <LoadingState label="Loading domains…" /> : domains.domains.length === 0 ? <p className="mt-1 text-xs text-slate-600">No citations in this window. Answers without web search rarely cite sources; imports can include cited URLs.</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs"><caption className="sr-only">Cited domains</caption>
              <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Host</th><th scope="col" className="py-1 pr-2">Belongs to</th><th scope="col" className="py-1 pr-2">Observations</th><th scope="col" className="py-1 pr-2">Queries</th><th scope="col" className="py-1 pr-2">URLs</th><th scope="col" className="py-1 pr-2">Imported</th><th scope="col" className="py-1">First – last seen</th></tr></thead>
              <tbody>{domains.domains.map((d) => (
                <tr key={d.host} className="border-t border-slate-100"><td className="py-1 pr-2 font-700">{d.host}</td><td className="py-1 pr-2">{d.cited_brand ? `${d.cited_brand}${d.cited_brand_kind === "competitor" ? " (competitor)" : ""}` : "—"}</td><td className="py-1 pr-2 tabular-nums">{d.observations}</td><td className="py-1 pr-2 tabular-nums">{d.queries}</td><td className="py-1 pr-2 tabular-nums">{d.urls}</td><td className="py-1 pr-2 tabular-nums">{d.imported_observations}</td><td className="py-1">{fmtDay(d.first_observed_at)} – {fmtDay(d.last_observed_at)}</td></tr>
              ))}</tbody>
            </table>
            {domains.diversity.length ? <p className="mt-1 text-[11px] text-slate-500">Distinct cited hosts per week: {domains.diversity.map((w) => `${w.week}: ${w.hosts} (${w.observations} obs.)`).join(" · ")}</p> : null}
          </div>
        )}
      </section>
      <section aria-labelledby="aiv-sources">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 id="aiv-sources" className="text-sm font-800 text-slate-900">Cited URLs</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-700">Belongs to<select value={filters.owner} onChange={(e) => set("owner", e.target.value)} className={input}><option value="">Anyone</option><option value="target">{brand.name}</option><option value="competitor">Competitors</option><option value="other">Other sites</option></select></label>
            <label className="text-xs text-slate-700">Verification<select value={filters.verification} onChange={(e) => set("verification", e.target.value)} className={input}><option value="">Any</option>{Object.entries(VERIFICATION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <button type="button" className={btn} onClick={() => void exp.run("sources")}>Export CSV</button>
          </div>
        </div>
        {message ? <p role="status" className="mt-1 text-xs text-slate-700">{message}</p> : null}
        {exp.notice ? <p role="status" className="mt-1 text-xs text-slate-700">{exp.notice}</p> : null}
        {!sources ? <LoadingState label="Loading cited URLs…" /> : sources.length === 0 ? <p className="mt-2 text-xs text-slate-600">No cited URLs match.</p> : (
          <ul className="mt-2 divide-y divide-slate-100 text-xs">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
                <span className="min-w-0 flex-1 break-all"><span className="font-700">{s.normalized_url}</span>{s.title ? ` — ${s.title}` : ""}<span className="block text-slate-500">{s.observations} observations · {s.queries} queries · {s.kinds.map((k) => CITATION_KIND_LABEL[k] ?? k).join(", ")} · {fmtDay(s.first_observed_at)} – {fmtDay(s.last_observed_at)}{s.cited_brand ? ` · ${s.cited_brand}'s domain` : ""}{s.idn ? " · internationalized domain" : ""} · {VERIFICATION_LABEL[s.verification_status] ?? s.verification_status}{s.verified_at ? ` (${fmtDay(s.verified_at)})` : ""}</span></span>
                <button type="button" className={btn} onClick={() => void verify(s)}>Verify</button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <span>{total} URLs</span>
          <button type="button" className={btn} disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE) }))}>Previous</button>
          <button type="button" className={btn} disabled={filters.offset + PAGE >= total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE }))}>Next</button>
          <Link className="underline" to="/intelligence/ai-visibility/recommendations">Citation recommendations</Link>
        </div>
      </section>
    </div>
  );
}

// ─── Competitor comparison ───────────────────────────────────────────────────

export function CompetitorsTab({ brand, providers }: { brand: AivBrand; providers: AivProviders }) {
  const [data, setData] = useState<AivComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await apiAivComparison(brand.id);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setData(r.data);
  }, [brand.id]);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorState title="Unable to load the comparison" message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading comparison…" />;
  if (!data.competitors.length) return <EmptyState title="No competitors configured" description="Add the competitors you want to compare against." action={<Link className={btnPrimary} to="/intelligence/ai-visibility/brand">Add competitors</Link>} />;
  if (!data.groups.length) return <NoObservations />;
  const qList = (list: AivComparison["groups"][number]["competitors"][number]["competitorOnlyQueries"]) =>
    list.length ? <ul className="list-inside list-disc">{list.map((q) => <li key={q.queryId}>{q.query ?? q.queryId} <span className="text-slate-500">({q.observationIds.length} answers)</span></li>)}</ul> : <p className="text-slate-500">None.</p>;
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-600">{data.note} Window: since {fmtDay(data.window.from)}.</p>
      {data.groups.map((g) => (
        <section key={groupLabel(g.key, providers.surfaces)} aria-label={groupLabel(g.key, providers.surfaces)} className={card}>
          <h3 className="text-sm font-800 text-slate-900"><MethodPill method={g.key.method} /> {groupSource(g.key, providers.surfaces)}</h3>
          <p className="text-[11px] text-slate-500">{g.sample.answered} answered observations · {g.sample.queries} queries · {fmtDay(g.sample.firstObservedAt)} – {fmtDay(g.sample.lastObservedAt)}{g.sample.languages.length ? ` · ${g.sample.languages.join(", ")}` : ""}{g.sample.countries.length ? ` · ${g.sample.countries.join(", ").toUpperCase()}` : ""}</p>
          {g.competitors.map((c) => (
            <div key={c.brandId} className="mt-3 border-t border-slate-100 pt-2 text-xs">
              <p className="font-800">{data.target.name} vs {c.name}</p>
              <p className="mt-0.5">Mention rate: {data.target.name} <MetricValue m={c.target.rate} /> · {c.name} <MetricValue m={c.competitor.rate} /></p>
              <p className="mt-0.5 text-slate-600">Answers citing their own domains: {data.target.name} {c.target.cited} · {c.name} {c.competitor.cited} · both mentioned in {c.bothQueries} queries{c.sharedSourceHosts.length ? ` · shared cited hosts: ${c.sharedSourceHosts.join(", ")}` : ""}</p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                <div><p className="font-700">{c.name} mentioned, {data.target.name} not</p>{qList(c.competitorOnlyQueries)}</div>
                <div><p className="font-700">{data.target.name} mentioned, {c.name} not</p>{qList(c.targetOnlyQueries)}</div>
              </div>
              <p className="mt-1 text-slate-600">{c.history.status === "ok" && c.history.earlier && c.history.later
                ? `Over time: before ${fmtDay(c.history.splitAt)} ${data.target.name} ${pct(c.history.earlier.targetRate)} vs ${c.name} ${pct(c.history.earlier.competitorRate)} (n=${c.history.earlier.answered}); after: ${pct(c.history.later.targetRate)} vs ${pct(c.history.later.competitorRate)} (n=${c.history.later.answered}).`
                : `Not enough history for a trend (needs ${data.minSample} answers in each half).`}</p>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ─── Recommendations ─────────────────────────────────────────────────────────

const OPP_STATUSES = ["open", "in_progress", "done", "dismissed", "obsolete"] as const;

export function RecommendationsTab({ brand }: { brand: AivBrand }) {
  const [rows, setRows] = useState<AivOpportunity[] | null>(null);
  const [formula, setFormula] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setRows(null);
    apiAivOpportunities(brand.id, { status: status || undefined })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setFormula(r.meta?.formula ?? ""); })
      .catch((e: Error) => setError(e.message));
  }, [brand.id, status, reload]);
  if (error) return <ErrorState title="Unable to load recommendations" message={error} />;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Status<select value={status} onChange={(e) => setStatus(e.target.value)} className={input}><option value="">Open and in progress</option>{OPP_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        <p className="text-[11px] text-slate-500">Priority is an internal heuristic: {formula}</p>
      </div>
      {!rows ? <LoadingState label="Loading recommendations…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">{status ? "None with this status." : "No open recommendations. They are derived from observations after each run or import."}</p> : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((o) => (
            <li key={o.id} className="py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1"><span className="font-800 tabular-nums">{o.priority}</span> · <span className="font-700">{o.title}</span> <span className="text-slate-500">({OPPORTUNITY_KIND_LABEL[o.kind] ?? o.kind} · {o.confidence} confidence · {o.status.replace("_", " ")})</span></span>
                <button type="button" className={btn} onClick={() => setOpen(open === o.id ? null : o.id)} aria-expanded={open === o.id}>{open === o.id ? "Hide" : "Details"}</button>
              </div>
              {open === o.id ? <OpportunityDetail brand={brand} id={o.id} onChanged={() => setReload((n) => n + 1)} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityDetail({ brand, id, onChanged }: { brand: AivBrand; id: string; onChanged: () => void }) {
  const { busy, guard } = useBusy();
  const [o, setO] = useState<AivOpportunityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiAivOpportunity(brand.id, id);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setO(r.data);
  }, [brand.id, id]);
  useEffect(() => void load(), [load]);
  const update = guard(async (status?: "open" | "in_progress" | "done" | "dismissed") => {
    if (!status && !note.trim()) return;
    const r = await apiAivUpdateOpportunity(brand.id, id, { ...(status ? { status } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    setMessage(r.error ? errorMessage(r.error) : "Saved.");
    if (!r.error) { setNote(""); void load(); onChanged(); }
  });
  if (error) return <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>;
  if (!o) return <LoadingState label="Loading recommendation…" />;
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
      <p>{o.explanation}</p>
      <p><span className="font-700">Recommended action: </span>{o.action}</p>
      {o.evidence.hosts.length || o.evidence.urls.length ? <p><span className="font-700">Sources: </span>{[...o.evidence.hosts, ...o.evidence.urls].join(", ")}</p> : null}
      {o.queries.length ? <div><p className="font-700">Queries</p><ul className="list-inside list-disc">{o.queries.map((q) => <li key={q.id}>{q.text}</li>)}</ul></div> : null}
      {o.observations.length ? <div><p className="font-700">Supporting observations ({o.observations.length})</p><ul className="list-inside list-disc">{o.observations.slice(0, 15).map((ob) => <li key={ob.id}>{fmtDay(ob.observed_at)} · {ob.collection_method === "manual_import" ? "imported" : "API"} · {ob.surface} · {ob.query_text}{ob.excluded_at ? " (since excluded)" : ""}</li>)}</ul></div> : null}
      <div><p className="font-700">Limitations</p><ul className="list-inside list-disc">{o.limitations.map((l) => <li key={l}>{l}</li>)}</ul></div>
      <div><p className="font-700">Priority {o.priority} (heuristic)</p>
        <ul className="list-inside list-disc">{o.priority_factors.map((f) => <li key={f.name}>{f.name.replace(/_/g, " ")} — weight {f.weight}, value {f.value === null ? "no data" : f.value.toFixed(2)}: {f.explanation}</li>)}</ul>
        <p className="text-slate-500">{o.formula}</p>
      </div>
      {o.events.length ? <p className="text-slate-600">History: {o.events.map((e) => `${e.event.replace(/_/g, " ")}${e.to_status ? ` → ${e.to_status}` : ""}${e.note ? ` (“${e.note}”)` : ""} ${fmtDay(e.created_at)}`).join(" · ")}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Note<input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={input} /></label>
        {o.status !== "in_progress" ? <button disabled={busy} type="button" className={btn} onClick={() => void update("in_progress")}>Start</button> : null}
        {o.status !== "done" ? <button disabled={busy} type="button" className={btn} onClick={() => void update("done")}>Mark done</button> : null}
        {o.status !== "dismissed" ? <button disabled={busy} type="button" className={btn} onClick={() => void update("dismissed")}>Dismiss</button> : null}
        {o.status === "done" || o.status === "dismissed" ? <button disabled={busy} type="button" className={btn} onClick={() => void update("open")}>Reopen</button> : null}
        <button type="button" className={btn} disabled={busy || (!note.trim())} onClick={() => void update()}>Add note</button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </div>
  );
}
