import { useEffect, useState } from "react";
import { apiGetSearchTop, type SearchDimension, type SearchTopRow } from "../../../services/api";
import { ErrorState, LoadingState } from "../../../components/ui/DataState";

const TABS: Array<{ id: SearchDimension; label: string; column: string }> = [
  { id: "query", label: "Queries", column: "Query" },
  { id: "page", label: "Pages", column: "Page" },
  { id: "country", label: "Countries", column: "Country" },
  { id: "device", label: "Devices", column: "Device" },
  { id: "searchAppearance", label: "Search appearance", column: "Appearance" },
];
type Sort = "clicks" | "impressions" | "ctr" | "position";
const SORT_LABEL: Record<Sort, string> = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Position" };

/** Top queries, pages, countries, devices and search appearances for the range, sortable and searchable, cursor-paged. */
export function BreakdownTable({ websiteId, from, to }: { websiteId: string; from: string; to: string }) {
  const [tab, setTab] = useState<SearchDimension>("query");
  const [sort, setSort] = useState<Sort>("clicks");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<SearchTopRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ days: number; daysFetched: number; daysTruncated: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = (after: string | null) => apiGetSearchTop(websiteId, tab, { from, to, sort, order, search: search || undefined, cursor: after });
  const load = async () => {
    setRows(null);
    setError(null);
    const r = await fetchPage(null);
    if (r.error) {
      setError(r.error.message);
      return;
    }
    setRows(r.data ?? []);
    setCursor(r.meta?.nextCursor ?? null);
    setCoverage(r.meta?.coverage ?? null);
  };
  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    const r = await fetchPage(cursor);
    setLoadingMore(false);
    if (r.error) {
      setError(r.error.message);
      return;
    }
    setRows((prev) => [...(prev ?? []), ...(r.data ?? [])]);
    setCursor(r.meta?.nextCursor ?? null);
  };
  useEffect(() => {
    void load();
  }, [websiteId, tab, from, to, sort, order, search]);

  const sortBy = (key: Sort) => {
    if (key === sort) setOrder(order === "desc" ? "asc" : "desc");
    else {
      setSort(key);
      setOrder(key === "position" ? "asc" : "desc");
    }
  };
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <section aria-labelledby="breakdown-heading" className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
      <h3 id="breakdown-heading" className="text-sm font-700 text-slate-900">Breakdown</h3>
      <div role="tablist" aria-label="Breakdown dimension" className="mt-3 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="breakdown-panel"
            onClick={() => { setTab(t.id); setSearch(""); setSearchInput(""); }}
            className={`rounded-full border px-3 py-1 text-xs font-600 ${tab === t.id ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="breakdown-panel" role="tabpanel" aria-label={current.label}>
        <form role="search" aria-label={`Search ${current.label.toLowerCase()}`} className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}>
          <label className="text-xs text-slate-700">
            {current.column} contains
            <input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" />
          </label>
          <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Search</button>
        </form>
        {coverage && coverage.daysFetched < coverage.days ? (
          <p className="mt-2 text-xs text-amber-800">{coverage.days - coverage.daysFetched} of {coverage.days} days are not synced for this breakdown; totals cover synced days only.</p>
        ) : null}
        {coverage?.daysTruncated ? <p className="mt-1 text-xs text-amber-800">On {coverage.daysTruncated} day(s) Google's 50,000-row limit was reached; less common rows are missing.</p> : null}
        {error ? (
          <ErrorState title="Unable to load this breakdown" message={error} onRetry={load} />
        ) : !rows ? (
          <LoadingState label={`Loading ${current.label.toLowerCase()}…`} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">{search ? "No rows match this search." : `Google returned no ${current.label.toLowerCase()} for this range.`}</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">{current.label} sorted by {SORT_LABEL[sort]} {order === "desc" ? "descending" : "ascending"}</caption>
                <thead className="text-slate-500">
                  <tr>
                    <th scope="col" className="py-2 pr-3">{current.column}</th>
                    {(Object.keys(SORT_LABEL) as Sort[]).map((key) => (
                      <th key={key} scope="col" aria-sort={sort === key ? (order === "desc" ? "descending" : "ascending") : "none"} className="py-2 pr-3">
                        <button type="button" onClick={() => sortBy(key)} className="font-600 underline-offset-2 hover:underline">
                          {SORT_LABEL[key]}{sort === key ? (order === "desc" ? " ↓" : " ↑") : ""}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-slate-100 align-top">
                      <td className="break-all py-2 pr-3 font-mono">{r.key || "(not set)"}</td>
                      <td className="py-2 pr-3">{r.clicks.toLocaleString()}</td>
                      <td className="py-2 pr-3">{r.impressions.toLocaleString()}</td>
                      <td className="py-2 pr-3">{r.ctr === null ? "—" : `${(r.ctr * 100).toFixed(1)}%`}</td>
                      <td className="py-2 pr-3">{r.position === null ? "—" : r.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor ? (
              <button type="button" onClick={() => void more()} disabled={loadingMore} className="mt-3 rounded border border-slate-300 px-3 py-1 text-xs font-600 text-slate-700 disabled:opacity-50">
                {loadingMore ? "Loading…" : `Load more ${current.label.toLowerCase()}`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
