import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/DataState";
import {
  apiContentBrief,
  apiContentBriefAi,
  apiContentBriefs,
  apiContentBriefStatus,
  apiContentCreateBrief,
  apiContentExport,
  apiContentFindingHistory,
  apiContentFindings,
  apiContentOpportunities,
  apiContentOpportunity,
  apiContentOverview,
  apiContentPage,
  apiContentPages,
  apiContentRenameTopic,
  apiContentSaveBrief,
  apiContentStartRun,
  apiContentTopic,
  apiContentTopicMember,
  apiContentTopics,
  apiContentUpdateFinding,
  apiContentUpdateOpportunity,
  type ContentBrief,
  type ContentBriefBody,
  type ContentFinding,
  type ContentOpportunity,
  type ContentOverview,
  type ContentPageRow,
  type ContentTopic,
} from "../../../services/api";
import { downloadBlob } from "../../search/research/shared";
import { btn, btnPrimary, CRAWL_STATE_LABEL, errorMessage, input, SEVERITY_STYLE } from "./ui";

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

function useExport(websiteId: string) {
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (kind: "pages" | "findings" | "opportunities", params: { status?: string; severity?: string } = {}) => {
    const out = await apiContentExport(websiteId, kind, params);
    if ("error" in out) return setNotice(out.error);
    downloadBlob(out.blob, out.filename);
    setNotice("Export downloaded.");
  };
  return { run, notice };
}

function NoInventory() {
  return <EmptyState title="No crawled pages yet" description="Run a scan with the crawl module on this website. The content inventory is built from that crawl (robots.txt and the crawl limits apply)." action={<Link className={btnPrimary} to="/websites">Go to websites</Link>} />;
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function OverviewTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<ContentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await apiContentOverview(websiteId);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setData(r.data);
  }, [websiteId]);
  useEffect(() => void load(), [load]);
  const analyse = async () => {
    const r = await apiContentStartRun(websiteId);
    setMessage(r.error ? errorMessage(r.error) : r.data?.deduplicated ? "An analysis is already queued or running." : "Analysis queued. Results appear when it completes.");
    void load();
  };
  if (error) return <ErrorState title="Unable to load content intelligence" message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading content intelligence…" />;
  if (!data.inventory.total) return <NoInventory />;
  const last = data.runs[0];
  return (
    <div>
      <section aria-label="Content summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-700 text-slate-600">Pages in inventory</p><p className="mt-1 text-2xl font-800 tabular-nums">{data.inventory.total}</p><p className="text-[11px] text-slate-500">{data.coverage.pagesAnalyzable} crawled as HTML · last crawl {fmt(data.inventory.lastCrawledAt)}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-700 text-slate-600">Open findings</p><p className="mt-1 text-2xl font-800 tabular-nums">{Object.values(data.findingsOpen).reduce((s, n) => s + (n ?? 0), 0)}</p><p className="text-[11px] text-slate-500">{(["high", "medium", "low", "info"] as const).map((s) => `${s} ${data.findingsOpen[s] ?? 0}`).join(" · ")}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-700 text-slate-600">Search Console data</p><p className="mt-1 text-sm font-700">{data.coverage.searchConsole ? `${data.coverage.pagesWithSearchMetrics} of ${data.coverage.pagesAnalyzable} pages have rows` : "Not connected"}</p><p className="text-[11px] text-slate-500">{data.coverage.searchConsole ? "Last 28 synced days." : <Link className="underline" to="/settings/integrations">Connect Search Console</Link>}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-700 text-slate-600">Last analysis</p><p className="mt-1 text-sm font-700">{last ? last.status : "None yet"}</p><p className="text-[11px] text-slate-500">{last ? `${fmt(last.finished_at ?? last.created_at)} · rules ${last.rules_version}${last.error ? ` · ${last.error}` : ""}` : "Runs after each completed crawl."}</p></div>
      </section>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => void analyse()}>Analyse now</button>
        {message ? <span role="status" className="text-xs text-slate-700">{message}</span> : null}
        <span className="text-[11px] text-slate-500">AI brief suggestions: {data.ai.available ? "available" : "not configured (everything else works without AI)"}</span>
      </div>
      {Object.keys(data.inventory.byState).some((s) => s !== "ok") ? (
        <p className="mt-3 text-xs text-slate-600">Crawl status: {Object.entries(data.inventory.byState).map(([s, n]) => `${CRAWL_STATE_LABEL[s] ?? s} ${n}`).join(" · ")}. Crawl failures are reported here, not as content findings.</p>
      ) : null}
      <section aria-labelledby="top-opp" className="mt-5">
        <h3 id="top-opp" className="text-sm font-700 text-slate-900">Top opportunities</h3>
        {data.topOpportunities.length === 0 ? <p className="mt-1 text-xs text-slate-600">None open.</p> : (
          <ul className="mt-2 space-y-1 text-xs">{data.topOpportunities.map((o) => <li key={o.id}><span className="tabular-nums font-800">{o.priority}</span> · {o.title} <span className="text-slate-500">({o.confidence} confidence, {o.effort} effort, heuristic)</span></li>)}</ul>
        )}
        <Link to="/intelligence/content/opportunities" className="mt-2 inline-block text-xs underline">All opportunities</Link>
      </section>
    </div>
  );
}

// ─── Inventory ───────────────────────────────────────────────────────────────

export function InventoryTab({ websiteId }: { websiteId: string }) {
  const [rows, setRows] = useState<ContentPageRow[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; searchConsole: boolean } | null>(null);
  const [filters, setFilters] = useState({ search: "", state: "", indexable: "", severity: "", sort: "url", offset: 0 });
  const [searchInput, setSearchInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const exp = useExport(websiteId);
  const PAGE = 50;
  useEffect(() => {
    setRows(null);
    apiContentPages(websiteId, { search: filters.search || undefined, state: filters.state || undefined, indexable: (filters.indexable || undefined) as "true" | "false" | undefined, severity: filters.severity || undefined, sort: filters.sort, offset: filters.offset, limit: PAGE })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setMeta({ total: r.meta?.total ?? 0, searchConsole: !!r.meta?.searchConsole }); })
      .catch((e: Error) => setError(e.message));
  }, [websiteId, filters]);
  if (error) return <ErrorState title="Unable to load the inventory" message={error} />;
  const set = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v, offset: 0 }));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <form role="search" aria-label="Search pages" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); set("search", searchInput.trim()); }}>
          <label className="text-xs text-slate-700">URL or title<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className={input} /></label>
          <button type="submit" className={btn}>Search</button>
        </form>
        <label className="text-xs text-slate-700">Crawl status<select value={filters.state} onChange={(e) => set("state", e.target.value)} className={input}><option value="">Any</option>{Object.entries(CRAWL_STATE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="text-xs text-slate-700">Indexable<select value={filters.indexable} onChange={(e) => set("indexable", e.target.value)} className={input}><option value="">Any</option><option value="true">Yes</option><option value="false">No</option></select></label>
        <label className="text-xs text-slate-700">Open findings<select value={filters.severity} onChange={(e) => set("severity", e.target.value)} className={input}><option value="">Any</option>{["high", "medium", "low", "info"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label className="text-xs text-slate-700">Sort<select value={filters.sort} onChange={(e) => set("sort", e.target.value)} className={input}><option value="url">URL</option><option value="findings">Most findings</option><option value="word_count">Most words</option><option value="last_crawled">Recently crawled</option></select></label>
        <button type="button" className={btn} onClick={() => void exp.run("pages")}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {!rows || !meta ? <LoadingState label="Loading pages…" /> : meta.total === 0 && !filters.search && !filters.state && !filters.indexable && !filters.severity ? <NoInventory /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No pages match these filters.</p> : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs"><caption className="sr-only">Content inventory</caption>
              <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Page</th><th scope="col" className="py-1 pr-2">Status</th><th scope="col" className="py-1 pr-2">H1</th><th scope="col" className="py-1 pr-2">Words</th><th scope="col" className="py-1 pr-2">Findings</th><th scope="col" className="py-1 pr-2">Clicks / impressions (28 d)</th><th scope="col" className="py-1">Crawled</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="max-w-[280px] py-1.5 pr-2"><button type="button" className="break-all text-left font-600 text-slate-900 hover:underline" onClick={() => setDetail(p.id)}>{p.url}</button>{p.title ? <span className="block text-slate-500">{p.title}</span> : null}</td>
                  <td className="py-1.5 pr-2">{CRAWL_STATE_LABEL[p.crawl_state] ?? p.crawl_state}{p.indexable === false ? <span className="block text-[10px] text-slate-500">not indexable</span> : null}{p.crawl_error ? <span className="block text-[10px] text-red-700">{p.crawl_error}</span> : null}</td>
                  <td className="py-1.5 pr-2">{p.h1 ?? "—"}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{p.word_count ?? "—"}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{p.open_findings}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{p.search === null ? <span className="text-slate-400">no Search Console</span> : p.search.noRows ? <span className="text-slate-500">no rows (0 / 0)</span> : `${p.search.clicks} / ${p.search.impressions}`}</td>
                  <td className="py-1.5 whitespace-nowrap">{fmt(p.last_crawled_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <button type="button" className={btn} disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE) }))}>Previous</button>
            <button type="button" className={btn} disabled={filters.offset + PAGE >= meta.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE }))}>Next</button>
            <span className="text-slate-600">{filters.offset + 1}–{Math.min(meta.total, filters.offset + PAGE)} of {meta.total}</span>
          </div>
        </>
      )}
      {detail ? <PageDetail websiteId={websiteId} pageId={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

function PageDetail({ websiteId, pageId, onClose }: { websiteId: string; pageId: string; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiContentPage>>["data"]>(null);
  useEffect(() => { apiContentPage(websiteId, pageId).then((r) => setData(r.data)); }, [websiteId, pageId]);
  return (
    <section aria-label="Page detail" className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-xs">
      <div className="flex justify-between"><h3 className="break-all text-sm font-700">{data?.page.url ?? "Loading…"}</h3><button type="button" className={btn} onClick={onClose}>Close</button></div>
      {data ? (
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div>
            <p><strong>Title:</strong> {String(data.page.title ?? "—")}</p>
            <p><strong>Description:</strong> {String(data.page.meta_description ?? "—")}</p>
            <p><strong>Words:</strong> {String(data.page.word_count ?? "—")} · <strong>Language:</strong> {String(data.page.language ?? "not declared")} · <strong>Inlinks:</strong> {String(data.page.inlinks ?? "—")}</p>
            <p><strong>Last modified (declared):</strong> {data.page.modified_at ? `${fmt(String(data.page.modified_at))} (${String(data.page.modified_source)})` : "not declared"} · <strong>Content changed:</strong> {fmt(data.page.content_changed_at as string | null)}</p>
            <p className="mt-2 font-700">Headings</p>
            <ul className="mt-1 space-y-0.5">{data.page.headings.slice(0, 20).map((h, i) => <li key={i} style={{ paddingLeft: `${(h.level - 1) * 10}px` }}>h{h.level} · {h.text}</li>)}</ul>
          </div>
          <div>
            <p className="font-700">Findings</p>
            {data.findings.length ? <ul className="mt-1 space-y-1">{data.findings.map((f) => <li key={f.id}><span className={`rounded px-1 ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span> {f.rule_id.replace(/_/g, " ")} · {f.status}</li>)}</ul> : <p className="text-slate-600">None.</p>}
            <p className="mt-2 font-700">Topics</p>
            <p>{data.topics.map((t) => `${t.name}${t.assignment === "manual" ? " (manual)" : ""}`).join(", ") || "—"}</p>
            <p className="mt-2 font-700">Opportunities</p>
            <p>{data.opportunities.map((o) => `${o.title} (${o.priority})`).join("; ") || "—"}</p>
          </div>
        </div>
      ) : <LoadingState label="Loading page…" />}
    </section>
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export function AuditTab({ websiteId }: { websiteId: string }) {
  const [rows, setRows] = useState<ContentFinding[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ status: "open", severity: "", category: "" });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ignoring, setIgnoring] = useState<{ id: string; reason: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; events: Array<{ event: string; to_status: string | null; note: string | null; created_at: string }> } | null>(null);
  const exp = useExport(websiteId);
  const load = useCallback(async (more?: string | null) => {
    const r = await apiContentFindings(websiteId, { status: filters.status || undefined, severity: filters.severity || undefined, category: filters.category || undefined, cursor: more ?? undefined });
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load findings.");
    setRows((prev) => (more ? [...(prev ?? []), ...r.data!] : r.data!));
    setCursor(r.meta?.nextCursor ?? null);
  }, [websiteId, filters]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const update = async (f: ContentFinding, status: "open" | "in_progress" | "ignored", reason?: string) => {
    const r = await apiContentUpdateFinding(websiteId, f.id, { status, reason });
    setMessage(r.error ? { ok: false, text: errorMessage(r.error) } : { ok: true, text: `Finding marked ${status.replace("_", " ")}.` });
    setIgnoring(null);
    void load();
  };
  const showHistory = async (id: string) => {
    const r = await apiContentFindingHistory(websiteId, id);
    setHistory({ id, events: r.data ?? [] });
  };
  if (error) return <ErrorState title="Unable to load findings" message={error} onRetry={() => void load()} />;
  return (
    <div>
      <p className="text-xs text-slate-600">Content rules (rule set content-1). Missing or duplicate titles and descriptions, H1 count, canonicals, image alt text and broken links are checked by <Link className="underline" to="/intelligence/technical-health">Technical Health</Link> and not repeated here. Findings marked heuristic flag pages to review; they are not ranking rules.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Status<select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className={input}><option value="">All</option>{["open", "in_progress", "resolved", "ignored"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        <label className="text-xs text-slate-700">Severity<select value={filters.severity} onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))} className={input}><option value="">All</option>{["high", "medium", "low", "info"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label className="text-xs text-slate-700">Category<select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} className={input}><option value="">All</option>{["metadata", "headings", "content", "duplication", "links", "structured_data", "freshness"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        <button type="button" className={btn} onClick={() => void exp.run("findings", { status: filters.status || undefined, severity: filters.severity || undefined })}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-slate-700" : "text-red-800"}`}>{message.text}</p> : null}
      {!rows ? <LoadingState label="Loading findings…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No findings match these filters.</p> : (
        <ul className="mt-3 space-y-2">
          {rows.map((f) => (
            <li key={f.id} aria-label={`Finding ${f.ruleTitle ?? f.rule_id}`} className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 font-700 ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span>
                <strong>{f.ruleTitle ?? f.rule_id}</strong>
                {f.heuristic ? <span className="rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-600">heuristic</span> : null}
                <span className="text-slate-500">{f.status.replace("_", " ")}</span>
              </div>
              {f.url ? <p className="mt-1 break-all text-slate-600">{f.url}</p> : null}
              <p className="mt-1">{f.explanation}</p>
              <p className="mt-1"><strong>Next step:</strong> {f.recommendation}</p>
              <p className="mt-1 text-[11px] text-slate-500">Evidence: {JSON.stringify(f.evidence)} · rule {f.rule_id} v{f.rule_version} · first {fmt(f.first_detected_at)} · last {fmt(f.last_detected_at)}{f.resolved_at ? ` · resolved ${fmt(f.resolved_at)}` : ""}{f.ignore_reason ? ` · ignored: ${f.ignore_reason}` : ""}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {f.status !== "resolved" && f.status !== "in_progress" ? <button type="button" className={btn} onClick={() => void update(f, "in_progress")}>Start</button> : null}
                {f.status === "in_progress" || f.status === "ignored" ? <button type="button" className={btn} onClick={() => void update(f, "open")}>Reopen</button> : null}
                {f.status !== "resolved" && f.status !== "ignored" ? <button type="button" className={btn} onClick={() => setIgnoring({ id: f.id, reason: "" })}>Ignore…</button> : null}
                <button type="button" className={btn} onClick={() => void showHistory(f.id)}>History</button>
              </div>
              {ignoring?.id === f.id ? (
                <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void update(f, "ignored", ignoring.reason); }}>
                  <label className="text-xs text-slate-700">Reason<input value={ignoring.reason} maxLength={500} onChange={(e) => setIgnoring({ id: f.id, reason: e.target.value })} className={input} /></label>
                  <button type="submit" className={btnPrimary} disabled={!ignoring.reason.trim()}>Ignore</button>
                  <button type="button" className={btn} onClick={() => setIgnoring(null)}>Cancel</button>
                </form>
              ) : null}
              {history?.id === f.id ? <ol className="mt-2 list-decimal pl-4 text-[11px] text-slate-600">{history.events.map((e, i) => <li key={i}>{fmt(e.created_at)} · {e.event.replace("_", " ")}{e.to_status ? ` → ${e.to_status}` : ""}{e.note ? ` (${e.note})` : ""}</li>)}</ol> : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? <button type="button" className={`${btn} mt-3`} onClick={() => void load(cursor)}>Load more</button> : null}
    </div>
  );
}

// ─── Topics ──────────────────────────────────────────────────────────────────

export function TopicsTab({ websiteId }: { websiteId: string }) {
  const [topics, setTopics] = useState<ContentTopic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiContentTopics(websiteId);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load topics.");
    setTopics(r.data);
  }, [websiteId]);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorState title="Unable to load topics" message={error} onRetry={load} />;
  if (!topics) return <LoadingState label="Loading topics…" />;
  if (!topics.length) return <EmptyState title="No topics yet" description="Topics are built from crawled pages and Search Console queries when an analysis runs." />;
  return (
    <div>
      <p className="text-xs text-slate-600">Deterministic clusters of pages (titles and headings) and Search Console queries by shared terms. A page “covers” a topic when its title or headings contain the topic's main terms. Rename topics and move pages or queries; your changes are kept by later analyses. Nothing is merged or rewritten automatically.</p>
      <table className="mt-3 w-full text-left text-xs"><caption className="sr-only">Topics</caption>
        <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Topic</th><th scope="col" className="py-1 pr-2">Pages (covering)</th><th scope="col" className="py-1 pr-2">Queries</th><th scope="col" className="py-1 pr-2">Query impressions (90 d)</th><th scope="col" className="py-1">Competitor gaps</th></tr></thead>
        <tbody>{topics.map((t) => (
          <tr key={t.id} className={`border-t border-slate-100 ${selected === t.id ? "bg-blue-50/50" : ""}`}>
            <td className="py-1.5 pr-2"><button type="button" className="text-left font-600 hover:underline" onClick={() => setSelected(t.id)}>{t.name}</button>{t.nameLocked ? <span className="ml-1 text-[10px] text-slate-500">(named by you)</span> : null}</td>
            <td className="py-1.5 pr-2 tabular-nums">{t.pages} ({t.coveringPages}){t.coveringPages > 1 ? <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-900">overlap</span> : null}{t.queries > 0 && t.coveringPages === 0 ? <span className="ml-1 rounded bg-sky-50 px-1 text-[10px] text-sky-800">under-covered</span> : null}</td>
            <td className="py-1.5 pr-2 tabular-nums">{t.queries}</td><td className="py-1.5 pr-2 tabular-nums">{t.queryImpressions}</td><td className="py-1.5 tabular-nums">{t.competitorGaps}</td>
          </tr>
        ))}</tbody>
      </table>
      {selected ? <TopicDetail websiteId={websiteId} topicId={selected} topics={topics} onChanged={load} /> : null}
    </div>
  );
}

function TopicDetail({ websiteId, topicId, topics, onChanged }: { websiteId: string; topicId: string; topics: ContentTopic[]; onChanged: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiContentTopic>>["data"]>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiContentTopic(websiteId, topicId);
    setData(r.data);
    setName(r.data?.topic.name ?? "");
  }, [websiteId, topicId]);
  useEffect(() => void load(), [load]);
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await apiContentRenameTopic(websiteId, topicId, name.trim());
    setMessage(r.error ? errorMessage(r.error) : "Renamed.");
    onChanged();
  };
  const move = async (memberType: "page" | "query", memberKey: string, target: string) => {
    const r = await apiContentTopicMember(websiteId, target, { memberType, memberKey, action: "assign" });
    setMessage(r.error ? errorMessage(r.error) : "Moved.");
    void load();
    onChanged();
  };
  const exclude = async (memberType: "page" | "query", memberKey: string) => {
    const r = await apiContentTopicMember(websiteId, topicId, { memberType, memberKey, action: "exclude" });
    setMessage(r.error ? errorMessage(r.error) : "Removed from this topic.");
    void load();
    onChanged();
  };
  const brief = async () => {
    const r = await apiContentCreateBrief(websiteId, { topicId });
    setMessage(r.error ? errorMessage(r.error) : "Brief created; open the Briefs tab.");
  };
  if (!data) return <LoadingState label="Loading topic…" />;
  const others = topics.filter((t) => t.id !== topicId);
  const MoveSelect = ({ type, k }: { type: "page" | "query"; k: string }) => (
    <select aria-label={`Move ${type} to topic`} defaultValue="" className="ml-2 rounded border border-slate-300 px-1 text-[11px]" onChange={(e) => e.target.value && void move(type, k, e.target.value)}>
      <option value="">Move to…</option>{others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
  return (
    <section aria-label={`Topic ${data.topic.name}`} className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-xs">
      <form onSubmit={rename} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-700">Topic name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={input} /></label>
        <button type="submit" className={btn} disabled={!name.trim() || name === data.topic.name}>Rename</button>
        <button type="button" className={btnPrimary} onClick={() => void brief()}>Create brief</button>
      </form>
      {message ? <p role="status" className="mt-2 text-slate-700">{message}</p> : null}
      <p className="mt-2 text-slate-500">Terms: {data.topic.terms.join(", ")}</p>
      {data.overlap ? <p className="mt-2 rounded bg-amber-50 p-2 text-amber-900">{data.overlap.note} Pages: {data.overlap.pages.join(", ")}</p> : null}
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <p className="font-700">Pages</p>
          <ul className="mt-1 space-y-1">{(data.coverage?.pages ?? []).map((p) => <li key={p.pageId} className="break-all">{p.url}{p.covers ? " · covers" : ""}<MoveSelect type="page" k={p.pageId} /><button type="button" className="ml-2 underline" onClick={() => void exclude("page", p.pageId)}>Remove</button></li>)}</ul>
        </div>
        <div>
          <p className="font-700">Search Console queries (90 days)</p>
          <ul className="mt-1 space-y-1">{(data.coverage?.queries ?? []).map((q) => <li key={q.query}>{q.query} · {q.impressions} impressions<MoveSelect type="query" k={q.query} /><button type="button" className="ml-2 underline" onClick={() => void exclude("query", q.query)}>Remove</button></li>)}</ul>
          {data.coverage?.competitorGaps.length ? <><p className="mt-3 font-700">Competitor rankings where you were not found</p><ul className="mt-1">{data.coverage.competitorGaps.map((g, i) => <li key={i}>{g.keyword}: {g.competitor} at {g.position} ({g.date})</li>)}</ul></> : null}
        </div>
      </div>
    </section>
  );
}

// ─── Opportunities ───────────────────────────────────────────────────────────

export function OpportunitiesTab({ websiteId }: { websiteId: string }) {
  const [rows, setRows] = useState<ContentOpportunity[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const exp = useExport(websiteId);
  const load = useCallback(async () => {
    const r = await apiContentOpportunities(websiteId, { status: status || undefined, limit: 100 });
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
    setRows(r.data);
  }, [websiteId, status]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const update = async (o: ContentOpportunity, body: { status?: "open" | "in_progress" | "done" | "dismissed"; feedback?: "useful" | "not_useful" }) => {
    const r = await apiContentUpdateOpportunity(websiteId, o.id, body);
    setMessage(r.error ? { ok: false, text: errorMessage(r.error) } : { ok: true, text: body.feedback ? "Thanks for the feedback." : `Marked ${body.status?.replace("_", " ")}.${body.status === "done" ? " Search Console figures from before the change were recorded for comparison." : ""}` });
    void load();
  };
  const brief = async (o: ContentOpportunity) => {
    const r = await apiContentCreateBrief(websiteId, { opportunityId: o.id });
    setMessage(r.error ? { ok: false, text: errorMessage(r.error) } : { ok: true, text: "Brief created; open the Briefs tab." });
  };
  if (error) return <ErrorState title="Unable to load opportunities" message={error} onRetry={load} />;
  return (
    <div>
      <p className="text-xs text-slate-600">Recommendations from measured data (crawl, Search Console, rank tracking). Priority (0–100) is a weighted mean of the visible factors that have data; effort is a rough heuristic. No ranking or traffic change is promised.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Status<select value={status} onChange={(e) => setStatus(e.target.value)} className={input}><option value="">Open and in progress</option>{["open", "in_progress", "done", "dismissed", "obsolete"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        <button type="button" className={btn} onClick={() => void exp.run("opportunities", { status: status || undefined })}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-slate-700" : "text-red-800"}`}>{message.text}</p> : null}
      {!rows ? <LoadingState label="Loading opportunities…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No opportunities here. They appear after an analysis when the data supports them.</p> : (
        <ul className="mt-3 space-y-2">
          {rows.map((o) => (
            <li key={o.id} aria-label={o.title} className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">{o.title}</strong>
                <span className="tabular-nums"><strong className="text-base">{o.priority}</strong>/100 · {o.confidence} confidence · effort {o.effort} (heuristic) · {o.status}</span>
              </div>
              <p className="mt-1">{o.problem}</p>
              <p className="mt-1"><strong>Suggested action:</strong> {o.action}</p>
              <p className="mt-1 text-[11px] text-slate-500">Confidence: {o.confidence_basis}</p>
              {o.missing_data.length ? <p className="mt-1 text-[11px] text-amber-900">Missing data: {o.missing_data.join("; ")}</p> : null}
              <button type="button" aria-expanded={open === o.id} className="mt-1 underline" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? "Hide evidence" : "Show evidence and factors"}</button>
              {open === o.id ? (
                <div className="mt-2 rounded bg-slate-50 p-2">
                  <table className="w-full text-left"><caption className="sr-only">Priority factors</caption>
                    <thead className="text-slate-500"><tr><th scope="col" className="pr-2">Factor</th><th scope="col" className="pr-2">Weight</th><th scope="col" className="pr-2">Value</th><th scope="col">Evidence</th></tr></thead>
                    <tbody>{o.priority_factors.map((f) => <tr key={f.name}><td className="pr-2">{f.name.replace(/_/g, " ")}</td><td className="pr-2">{Math.round(f.weight * 100)}%</td><td className="pr-2">{f.value === null ? "unavailable" : Math.round(f.value * 100) / 100}</td><td>{f.explanation}</td></tr>)}</tbody>
                  </table>
                  <p className="mt-2 break-all text-[11px] text-slate-600">Evidence: {JSON.stringify(o.evidence)}</p>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {o.status === "open" ? <button type="button" className={btn} onClick={() => void update(o, { status: "in_progress" })}>Start</button> : null}
                {o.status === "open" || o.status === "in_progress" ? <button type="button" className={btn} onClick={() => void update(o, { status: "done" })}>Mark done</button> : null}
                {o.status === "open" || o.status === "in_progress" ? <button type="button" className={btn} onClick={() => void update(o, { status: "dismissed" })}>Dismiss</button> : null}
                <button type="button" className={btn} onClick={() => void brief(o)}>Create brief</button>
                <button type="button" className={btn} onClick={() => void update(o, { feedback: "useful" })}>Useful</button>
                <button type="button" className={btn} onClick={() => void update(o, { feedback: "not_useful" })}>Not useful</button>
              </div>
              {o.status === "done" ? <OpportunityOutcome websiteId={websiteId} id={o.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityOutcome({ websiteId, id }: { websiteId: string; id: string }) {
  const [outcome, setOutcome] = useState<Awaited<ReturnType<typeof apiContentOpportunity>>["data"]>(null);
  useEffect(() => { apiContentOpportunity(websiteId, id).then((r) => setOutcome(r.data)); }, [websiteId, id]);
  const o = outcome?.outcome;
  if (!o) return null;
  return <p className="mt-2 text-[11px] text-slate-600">Before: {JSON.stringify(o.baseline)} · Now: {o.latest ? JSON.stringify(o.latest) : "no data"}{o.enoughTimePassed ? "" : " · less than 28 days since completion"}. {o.note}</p>;
}

// ─── Briefs ──────────────────────────────────────────────────────────────────

export function BriefsTab({ websiteId }: { websiteId: string }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof apiContentBriefs>>["data"]>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiContentBriefs(websiteId);
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load briefs.");
    setList(r.data);
    setOpen((cur) => cur ?? r.data![0]?.id ?? null);
  }, [websiteId]);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorState title="Unable to load briefs" message={error} onRetry={load} />;
  if (!list) return <LoadingState label="Loading briefs…" />;
  if (!list.length) return <EmptyState title="No briefs yet" description="Create a brief from a topic or an opportunity. Briefs are built from your own data and need human approval." action={<Link className={btnPrimary} to="/intelligence/content/opportunities">See opportunities</Link>} />;
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <ul aria-label="Briefs" className="space-y-1 text-xs">
        {list.map((b) => <li key={b.id}><button type="button" aria-current={open === b.id ? "true" : undefined} className={`w-full rounded px-2 py-1 text-left hover:bg-slate-100 ${open === b.id ? "bg-slate-100 font-700" : ""}`} onClick={() => setOpen(b.id)}>{b.title}<span className="block text-[10px] text-slate-500">{b.status.replace("_", " ")} · rev {b.current_revision}</span></button></li>)}
      </ul>
      {open ? <BriefEditor key={open} websiteId={websiteId} briefId={open} onChanged={load} /> : null}
    </div>
  );
}

function BriefEditor({ websiteId, briefId, onChanged }: { websiteId: string; briefId: string; onChanged: () => void }) {
  const [data, setData] = useState<ContentBrief | null>(null);
  const [body, setBody] = useState<ContentBriefBody | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (r: { data: ContentBrief | null; error: { code: string; message: string } | null }, ok: string) => {
    if (r.error || !r.data) return setMessage({ ok: false, text: errorMessage(r.error ?? { code: "", message: "Failed." }) });
    setData(r.data);
    setBody(r.data.body);
    setMessage({ ok: true, text: ok });
    onChanged();
  };
  useEffect(() => { apiContentBrief(websiteId, briefId).then((r) => { setData(r.data); setBody(r.data?.body ?? null); }); }, [websiteId, briefId]);
  if (!data || !body) return <LoadingState label="Loading brief…" />;
  const save = async () => { setBusy(true); try { apply(await apiContentSaveBrief(websiteId, briefId, { baseRevision: data.brief.current_revision, body }), "Saved as a new revision."); } finally { setBusy(false); } };
  const status = async (s: "draft" | "in_review" | "approved") => apply(await apiContentBriefStatus(websiteId, briefId, s), `Status: ${s.replace("_", " ")}.`);
  const ai = async () => { setBusy(true); try { apply(await apiContentBriefAi(websiteId, briefId, data.brief.current_revision), "AI suggestions added as a new revision. Review them before use."); } finally { setBusy(false); } };
  const set = <K extends keyof ContentBriefBody>(k: K, v: ContentBriefBody[K]) => setBody({ ...body, [k]: v });
  const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <section aria-label={`Brief ${data.brief.title}`} className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-800">{data.brief.title}</h3>
        <span>{data.brief.status.replace("_", " ")} · revision {data.brief.current_revision}{data.source === "ai_suggestion" ? <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-700 uppercase text-violet-800">AI suggestion — review</span> : null}</span>
      </div>
      <p className="mt-1 text-slate-600">Topic: {body.targetTopic}{data.brief.page_url ? ` · page ${data.brief.page_url}` : ""} · intent: {body.intent.value ?? "unknown"} ({body.intent.note})</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-700">Suggested title<input value={body.suggestedTitle} maxLength={120} onChange={(e) => set("suggestedTitle", e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-slate-700">H1<input value={body.h1} maxLength={200} onChange={(e) => set("h1", e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-slate-700 md:col-span-2">Meta description<textarea rows={2} value={body.suggestedMetaDescription} maxLength={320} onChange={(e) => set("suggestedMetaDescription", e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-slate-700">Outline (one heading per line)<textarea rows={6} value={body.outline.map((o) => o.heading).join("\n")} onChange={(e) => set("outline", lines(e.target.value).map((heading) => ({ heading, points: body.outline.find((o) => o.heading === heading)?.points ?? [] })))} className={`${input} w-full`} /></label>
        <label className="text-xs text-slate-700">Questions to answer (one per line)<textarea rows={6} value={body.questions.join("\n")} onChange={(e) => set("questions", lines(e.target.value))} className={`${input} w-full`} /></label>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div><p className="font-700">Primary and related keywords (Search Console)</p><p>{[body.primaryKeyword, ...body.relatedKeywords].filter(Boolean).join(", ") || "None available"}</p></div>
        <div><p className="font-700">Suggested internal links (from your inventory)</p><ul>{body.internalLinks.map((l) => <li key={l.url} className="break-all">{l.url} — “{l.anchorHint}”</li>)}</ul>{body.internalLinks.length ? null : <p>None.</p>}</div>
        <div><p className="font-700">Missing evidence</p><ul className="list-disc pl-4">{body.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul></div>
        <div><p className="font-700">Research questions</p><ul className="list-disc pl-4">{body.researchQuestions.map((m) => <li key={m}>{m}</li>)}</ul><p className="mt-1 text-slate-500">Sources: {body.sources.length ? body.sources.map((s) => s.label).join("; ") : "none yet — add verified sources before publishing"}</p></div>
      </div>
      <fieldset className="mt-3">
        <legend className="font-700">Editorial checklist (needed for approval)</legend>
        {body.checklist.map((c, i) => (
          <label key={c.item} className="mt-1 flex items-center gap-2"><input type="checkbox" checked={c.done} onChange={(e) => set("checklist", body.checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />{c.item}</label>
        ))}
      </fieldset>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>Save revision</button>
        <button type="button" className={btn} disabled={busy} onClick={() => void ai()}>Suggest with AI</button>
        <button type="button" className={btn} onClick={() => void status("in_review")}>Send to review</button>
        <button type="button" className={btn} onClick={() => void status("approved")}>Approve</button>
      </div>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 ${message.ok ? "text-slate-700" : "text-red-800"}`}>{message.text}</p> : null}
      <details className="mt-3"><summary className="cursor-pointer font-700">Revision history ({data.revisions.length})</summary>
        <ol className="mt-1 space-y-0.5">{data.revisions.map((r) => <li key={r.revision}>#{r.revision} · {r.source.replace("_", " ")}{r.ai_model ? ` (${r.ai_model})` : ""} · {fmt(r.created_at)}{r.note ? ` · ${r.note}` : ""}</li>)}</ol>
      </details>
    </section>
  );
}
