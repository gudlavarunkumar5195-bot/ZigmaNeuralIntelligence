import { useEffect, useState } from "react";
import {
  apiAddToKeywordList,
  apiCompareResearchRuns,
  apiCreateKeywordList,
  apiExportResearchCsv,
  apiGetResearchRun,
  apiListKeywordLists,
  apiListResearchRuns,
  apiResearchInsights,
  type KeywordListSummary,
  type ResearchInsight,
  type ResearchProviderInfo,
  type ResearchResult,
  type ResearchRun,
} from "../../../services/api";
import { ErrorState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { downloadBlob, errorText, ResultsTable, RunProvenance, type SortState } from "./shared";

/**
 * One research run: provenance, filterable/sortable/paged results, selection
 * into saved lists, CSV export, comparison with the previous run of the same
 * kind, and optional AI prioritization (clearly labelled).
 */
export function RunView({ runId, provider, reused, gap }: { runId: string; provider: ResearchProviderInfo | null; reused?: string | null; gap?: boolean }) {
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [rows, setRows] = useState<ResearchResult[] | null>(null);
  const [insight, setInsight] = useState<ResearchInsight | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ sort: "seq", order: "asc" });
  const [intent, setIntent] = useState("");
  const [gapFilter, setGapFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lists, setLists] = useState<KeywordListSummary[]>([]);
  const [listsError, setListsError] = useState<{ message: string; status?: number } | null>(null);
  const [listId, setListId] = useState("");
  const [newList, setNewList] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<string | null>(null);

  const params = () => ({ sort: sort.sort, order: sort.order, intent: intent || undefined, gap: gapFilter || undefined, search: search || undefined });
  const load = async () => {
    setRows(null);
    setError(null);
    const r = await apiGetResearchRun(runId, params());
    if (r.error || !r.data) {
      setError(r.error?.message ?? "Run not found");
      return;
    }
    setRun(r.data.run);
    setRows(r.data.results);
    setInsight(r.data.insight);
    setCursor(r.meta?.nextCursor ?? null);
  };
  const more = async () => {
    if (!cursor) return;
    const r = await apiGetResearchRun(runId, { ...params(), cursor });
    if (r.error || !r.data) return setError(r.error?.message ?? "Could not load more");
    setRows((prev) => [...(prev ?? []), ...r.data!.results]);
    setCursor(r.meta?.nextCursor ?? null);
  };
  useEffect(() => {
    void load();
  }, [runId, sort.sort, sort.order, intent, gapFilter, search]);
  useEffect(() => {
    setListsError(null);
    apiListKeywordLists()
      .then((r) => (r.error ? setListsError(r.error) : setLists(r.data ?? [])))
      .catch((e: Error) => setListsError({ message: e.message }));
    setSelected(new Set());
    setComparison(null);
  }, [runId]);

  const toggle = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const saveSelection = async () => {
    setNotice(null);
    let target = listId;
    if (!target && newList.trim()) {
      const created = await apiCreateKeywordList(newList.trim());
      if (created.error || !created.data) return setNotice(created.error?.message ?? "Could not create the list.");
      target = created.data.id;
      setLists((l) => [{ ...created.data!, items: 0 }, ...l]);
      setListId(target);
      setNewList("");
    }
    if (!target) return setNotice("Choose a list or name a new one.");
    const keywords = (rows ?? []).filter((r) => selected.has(r.keyword_key)).map((r) => r.keyword);
    const r = await apiAddToKeywordList(target, runId, keywords);
    if (r.error) return setNotice(errorText(r.error));
    setNotice(`Added ${r.data?.added ?? 0} keyword(s) to the list${(r.data?.added ?? 0) < keywords.length ? " (the rest were already in it)" : ""}.`);
    setSelected(new Set());
  };

  const exportCsv = async () => {
    const out = await apiExportResearchCsv(runId);
    if ("error" in out) return setNotice(out.error);
    downloadBlob(out.blob, out.filename);
    setNotice("Export downloaded.");
  };

  const analyse = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const r = await apiResearchInsights(runId);
      if (r.error) return setAiError(r.error.code === "AI_UNAVAILABLE" ? "AI analysis is not configured on this server. Everything else works without it." : errorText(r.error));
      setInsight(r.data);
    } finally {
      setAiBusy(false);
    }
  };

  const compare = async () => {
    if (!run) return;
    const history = await apiListResearchRuns({ websiteId: run.website_id, kind: run.kind, limit: 10 });
    const previous = (history.data ?? []).find((h) => h.id !== run.id && new Date(h.created_at) < new Date(run.created_at) && h.status !== "failed");
    if (!previous) return setComparison("No earlier run of this kind for this website to compare with.");
    const d = await apiCompareResearchRuns(run.id, previous.id);
    if (d.error || !d.data) return setComparison(d.error?.message ?? "Comparison failed.");
    setComparison(`Compared with ${new Date(d.data.older.createdAt).toLocaleString()}: ${d.data.added.length} new, ${d.data.removed.length} no longer returned, ${d.data.changed.length} with changed metrics.${d.data.added.length ? ` New: ${d.data.added.slice(0, 10).join(", ")}${d.data.added.length > 10 ? "…" : ""}.` : ""}`);
  };

  if (error) return <ErrorState title="Unable to load this research run" message={error} onRetry={load} />;
  if (!run || !rows) return <LoadingState label="Loading results…" />;
  const metrics = provider?.metrics ?? [];
  const counts = run.summary.counts;

  return (
    <section aria-label="Research results" className="mt-4">
      <RunProvenance run={run} reused={reused} />
      {gap && counts ? (
        <div role="group" aria-label="Gap category" className="mt-3 flex flex-wrap gap-2">
          {(["", "shared", "missing", "unique"] as const).map((g) => (
            <button key={g || "all"} type="button" aria-pressed={gapFilter === g} onClick={() => setGapFilter(g)} className={`rounded-full border px-3 py-1 text-xs font-600 ${gapFilter === g ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}>
              {g === "" ? `All (${counts.shared + counts.missing + counts.unique})` : `${g[0].toUpperCase()}${g.slice(1)} (${counts[g]})`}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">
          Intent
          <select value={intent} onChange={(e) => setIntent(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
            <option value="">Any</option>
            {["informational", "navigational", "commercial", "transactional", "unclassified"].map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <form role="search" aria-label="Search results" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}>
          <label className="text-xs text-slate-700">Keyword contains<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" /></label>
          <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Search</button>
        </form>
        <button type="button" onClick={() => void exportCsv()} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Export CSV</button>
        <button type="button" onClick={() => void compare()} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Compare with previous run</button>
      </div>
      {comparison ? <p role="status" className="mt-2 text-xs text-slate-700">{comparison}</p> : null}

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">{run.status === "failed" ? "This run failed; no results were stored." : "The data source returned no keywords for this request."}</p>
      ) : (
        <>
          <ResultsTable rows={rows} metrics={metrics} sort={sort} onSort={setSort} selected={selected} onToggle={toggle} caption={`Results of this ${run.kind} run`} gap={gap} />
          {cursor ? <button type="button" onClick={() => void more()} className="mt-3 rounded border border-slate-300 px-3 py-1 text-xs font-600 text-slate-700">Load more keywords</button> : null}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3" role="group" aria-label="Save selected keywords">
        <span className="text-xs text-slate-700">{selected.size} selected</span>
        <label className="text-xs text-slate-700">
          Saved list
          <select value={listId} onChange={(e) => setListId(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
            <option value="">New list…</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.items})</option>)}
          </select>
        </label>
        {listsError ? <InlineError what="your saved lists (you can still create a new one)" error={listsError} /> : null}
        {!listId ? <label className="text-xs text-slate-700">New list name<input value={newList} maxLength={100} onChange={(e) => setNewList(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" /></label> : null}
        <button type="button" disabled={selected.size === 0} onClick={() => void saveSelection()} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 text-white shadow-sm hover:bg-blue-700 font-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 h-8 px-3 text-xs">Add to list</button>
      </div>
      <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-700">{notice}</p>

      <section aria-labelledby="ai-heading" className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="ai-heading" className="text-sm font-700 text-slate-900">AI prioritization <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-700 uppercase text-violet-800">AI-generated</span></h3>
          <button type="button" disabled={aiBusy || rows.length === 0} onClick={() => void analyse()} className="rounded border border-violet-300 px-2 py-1 text-xs font-600 text-violet-900 disabled:opacity-50">
            {aiBusy ? "Analysing…" : insight ? "Re-analyse" : "Analyse with AI"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-600">Optional. Uses only the rows above; it cannot add search volumes, difficulty or rankings the data source did not provide.</p>
        {aiError ? <p role="alert" className="mt-2 text-xs text-red-800">{aiError}</p> : null}
        {insight ? (
          insight.status === "failed" ? (
            <p className="mt-2 text-xs text-red-800">{insight.error}</p>
          ) : (
            <div className="mt-2 text-xs text-slate-800">
              {insight.summary ? <p>{insight.summary}</p> : null}
              <ul className="mt-2 space-y-2">
                {insight.items.map((i) => (
                  <li key={i.keywordKey}>
                    <strong>{i.keyword}</strong> · priority {i.priority} — {i.rationale}
                    {i.evidence.length ? <span className="block text-slate-500">Based on: {i.evidence.join(", ")}</span> : null}
                    {i.missingData.length ? <span className="block text-slate-500">Missing data: {i.missingData.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-500">Model: {insight.model ?? "unknown"} · {new Date(insight.created_at).toLocaleString()}</p>
            </div>
          )
        ) : null}
      </section>
    </section>
  );
}
