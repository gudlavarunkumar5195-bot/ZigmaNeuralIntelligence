import { useEffect, useState } from "react";
import { apiListCrawlPages, type CrawlOutcome, type CrawlPageRow } from "../../../services/api";
import { ErrorState, LoadingState } from "../../../components/ui/DataState";
import { INDEXABILITY_REASON, OUTCOME_LABEL } from "./labels";

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "2xx", label: "2xx OK" },
  { value: "3xx", label: "3xx Redirect" },
  { value: "4xx", label: "4xx Client error" },
  { value: "5xx", label: "5xx Server error" },
  { value: "error", label: "Fetch error" },
  { value: "blocked", label: "Blocked by robots.txt" },
];

/** URL inventory of the latest crawl: status, depth, outcome and indexability signals, filtered and cursor-paged. */
export function CrawlInventory({ websiteId, scanId }: { websiteId: string; scanId: string }) {
  const [status, setStatus] = useState("");
  const [outcome, setOutcome] = useState("");
  const [indexable, setIndexable] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState<CrawlPageRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = async (after: string | null) => {
    const r = await apiListCrawlPages(websiteId, {
      status: status || undefined,
      outcome: outcome || undefined,
      indexable: indexable === "" ? undefined : indexable === "yes",
      url: url || undefined,
      cursor: after,
    });
    if (r.error) throw new Error(r.error.message);
    return { data: r.data ?? [], next: r.meta?.nextCursor ?? null };
  };
  const load = async () => {
    setRows(null);
    setError(null);
    try {
      const { data, next } = await fetchPage(null);
      setRows(data);
      setCursor(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const { data, next } = await fetchPage(cursor);
      setRows((prev) => [...(prev ?? []), ...data]);
      setCursor(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  useEffect(() => {
    void load();
  }, [websiteId, scanId, status, outcome, indexable, url]);

  return (
    <section aria-labelledby="pages-heading" className="mt-8">
      <h3 id="pages-heading" className="text-sm font-700 text-slate-900">Crawled URLs</h3>
      <form
        role="search"
        aria-label="Filter crawled URLs"
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); setUrl(urlInput.trim()); }}
      >
        <label className="text-xs text-slate-700">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
            {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
            <option value="">Any outcome</option>
            {(Object.keys(OUTCOME_LABEL) as CrawlOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          Indexing signals
          <select value={indexable} onChange={(e) => setIndexable(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
            <option value="">Any</option>
            <option value="yes">Eligible</option>
            <option value="no">Not eligible</option>
          </select>
        </label>
        <label className="text-xs text-slate-700">
          URL contains
          <input value={urlInput} maxLength={200} onChange={(e) => setUrlInput(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Apply</button>
      </form>

      {error ? (
        <ErrorState title="Unable to load crawled URLs" message={error} onRetry={load} />
      ) : !rows ? (
        <LoadingState label="Loading crawled URLs…" />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">No crawled URLs match these filters.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">URLs from the latest crawl, sorted by URL</caption>
              <thead className="text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-3">URL</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Outcome</th>
                  <th scope="col" className="py-2 pr-3">Depth</th>
                  <th scope="col" className="py-2 pr-3">Indexing signals</th>
                  <th scope="col" className="py-2">Inlinks</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.url} className="border-t border-slate-100 align-top">
                    <td className="break-all py-2 pr-3 font-mono">
                      {p.url}
                      {p.title ? <div className="font-sans text-slate-500">{p.title}</div> : null}
                    </td>
                    <td className="py-2 pr-3 font-mono">
                      {p.status_code === 0 ? "—" : p.status_code}
                      {p.redirect_chain.length > 0 ? ` → ${p.final_status_code || "error"} (${p.redirect_chain.length} hop${p.redirect_chain.length > 1 ? "s" : ""})` : ""}
                    </td>
                    <td className="py-2 pr-3">
                      {p.outcome ? OUTCOME_LABEL[p.outcome] : "—"}
                      {p.redirect_target ? <div className="break-all font-mono text-slate-500">→ {p.redirect_target}</div> : null}
                      {p.fetch_error ? <div className="text-red-700">{p.fetch_error}</div> : null}
                    </td>
                    <td className="py-2 pr-3">{p.depth ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {p.indexable ? "Eligible" : (p.indexability_reasons ?? []).map((r) => INDEXABILITY_REASON[r] ?? r).join(", ") || "Not eligible"}
                      {p.in_sitemap ? <div className="text-slate-500">In sitemap</div> : null}
                    </td>
                    <td className="py-2">{p.inlinks ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor ? (
            <button type="button" onClick={() => void more()} disabled={loadingMore} className="mt-3 rounded border border-slate-300 px-3 py-1 text-xs font-600 text-slate-700 disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load more URLs"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
