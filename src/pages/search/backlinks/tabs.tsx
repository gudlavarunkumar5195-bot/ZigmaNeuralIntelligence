import { useCallback, useEffect, useRef, useState } from "react";
import { btn, btnPrimary, input } from "../../../components/ui/styles";
import { Link } from "react-router";
import { EmptyState, ErrorState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { useApiQuery } from "../../../lib/useApiQuery";
import {
  apiBacklinkChanges,
  apiBacklinkDatasets,
  apiBacklinkExport,
  apiBacklinkGap,
  apiBacklinkImport,
  apiBacklinkLinks,
  apiBacklinkOpportunities,
  apiBacklinkPreview,
  apiBacklinkReferringDomains,
  apiBacklinkSources,
  apiBacklinkVerification,
  apiBacklinkVerify,
  type BacklinkChange,
  type BacklinkDataset,
  type BacklinkGap,
  type BacklinkImportPreview,
  type BacklinkLink,
  type BacklinkOpportunities,
  type BacklinkReferringDomain,
  type BacklinkSource,
  type BacklinkSummary,
} from "../../../services/api";
import { downloadBlob } from "../research/shared";


export const STATE_LABEL: Record<string, string> = {
  verified_live: "Verified live",
  lost_verified: "Lost (verified twice)",
  provider_reported_lost: "Reported lost by source",
  verification_missing_once: "Not found once",
  unverified_check_failed: "Check failed",
  unverified: "Unverified (imported)",
};
const CHANGE_LABEL: Record<string, string> = {
  new: "New",
  lost: "Lost",
  potentially_lost: "Potentially lost",
  anchor_changed: "Anchor changed",
  target_changed: "Target changed",
  attributes_changed: "Attributes changed",
};

function NoOwnData() {
  return (
    <EmptyState
      title="No backlink data for this website yet"
      description="Import an authorized backlink export (Google Search Console, Ahrefs, Semrush, Majestic or any CSV with a source URL column). No licensed backlink provider is connected."
      action={<Link to="/search/backlinks/imports" className={btnPrimary}>Import backlinks</Link>}
    />
  );
}

function useExport(websiteId: string) {
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (kind: "links" | "referring_domains" | "opportunities" | "changes", params: { subject?: string; competitors?: string } = {}) => {
    const out = await apiBacklinkExport(websiteId, kind, params);
    if ("error" in out) return setNotice(out.error);
    downloadBlob(out.blob, out.filename);
    setNotice("Export downloaded.");
  };
  return { run, notice };
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function OverviewTab({ websiteId, summary, onChanged }: { websiteId: string; summary: BacklinkSummary; onChanged: () => void }) {
  const [job, setJob] = useState(summary.latestVerification);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const poll = useCallback(async (id: string) => {
    const r = await apiBacklinkVerification(websiteId, id);
    if (!r.data) return;
    setJob({ ...r.data });
    if (r.data.status === "queued" || r.data.status === "running") timer.current = setTimeout(() => void poll(id), 4000);
    else onChanged();
  }, [websiteId, onChanged]);

  if (!summary.own) return <NoOwnData />;
  const own = summary.own;
  const states = own.states;
  const verify = async () => {
    const r = await apiBacklinkVerify(websiteId, own.dataset.id);
    if (r.error || !r.data) return setMessage(r.error?.message ?? "Could not start the check.");
    setMessage(r.data.deduplicated ? "A check of this dataset is already running." : `Checking ${r.data.job.links_total} link(s)${r.data.capped ? " (the first ones of this dataset; the per-run limit applies)" : ""}.`);
    void poll(r.data.job.id);
  };
  const tiles: Array<[string, string | number, string]> = [
    ["Backlinks", own.links, "in the latest snapshot"],
    ["Referring domains", own.referringDomains, "distinct linking hosts"],
    ["Verified live", states.verified_live ?? 0, "found by our own check"],
    ["Lost (verified)", states.lost_verified ?? 0, "missing in two consecutive checks"],
    ["Unverified", (states.unverified ?? 0) + (states.verification_missing_once ?? 0) + (states.unverified_check_failed ?? 0), "imported, not confirmed live"],
  ];
  return (
    <div>
      <section aria-label="Backlink overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-700 text-slate-600">{label}</p>
            <p className="mt-1 text-2xl font-800 tabular-nums text-slate-950">{value}</p>
            <p className="text-[11px] text-slate-500">{hint}</p>
          </div>
        ))}
      </section>
      <section aria-labelledby="types-h" className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-xs">
        <h3 id="types-h" className="text-sm font-700 text-slate-900">Link attributes (as supplied by the export)</h3>
        <p className="mt-1 text-slate-700">{Object.entries(own.linkTypes).map(([t, n]) => `${t === "unknown" ? "not stated" : t}: ${n}`).join(" · ")}</p>
        <h3 className="mt-3 text-sm font-700 text-slate-900">Changes in the last 90 days</h3>
        <p className="mt-1 text-slate-700">{Object.keys(summary.changesLast90Days).length ? Object.entries(summary.changesLast90Days).map(([t, n]) => `${CHANGE_LABEL[t] ?? t}: ${n}`).join(" · ") : "None detected (needs at least two snapshots)."} <Link className="underline" to="/search/backlinks/changes">Details</Link></p>
      </section>
      <section aria-labelledby="verify-h" className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-xs">
        <h3 id="verify-h" className="text-sm font-700 text-slate-900">Live check</h3>
        <p className="mt-1 text-slate-700">Fetches each linking page (robots.txt honoured, private networks refused) to confirm the link is there now. Imported links are not claimed live until checked.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary} disabled={job?.status === "queued" || job?.status === "running"} onClick={() => void verify()}>Check links now</button>
          {job ? <span role="status">Last check: {job.status} · {job.links_checked}/{job.links_total} checked{job.error ? ` · ${job.error}` : ""}</span> : <span>Never checked.</span>}
        </div>
        {message ? <p className="mt-2 text-slate-700">{message}</p> : null}
      </section>
      <p className="mt-4 text-xs text-slate-600">Competitor datasets: {summary.competitors.length ? summary.competitors.map((c) => `${c.dataset.subject_domain}${c.dataset.stale ? " (stale)" : ""}`).join(", ") : "none imported"}.</p>
    </div>
  );
}

// ─── Backlinks ───────────────────────────────────────────────────────────────

export function LinksTab({ websiteId, summary }: { websiteId: string; summary: BacklinkSummary }) {
  const [links, setLinks] = useState<BacklinkLink[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ linkType: "", state: "", search: "", sort: "source_domain", order: "asc" as "asc" | "desc" });
  const [searchInput, setSearchInput] = useState("");
  const exp = useExport(websiteId);

  const load = useCallback(async (more?: string | null) => {
    setError(null);
    const r = await apiBacklinkLinks(websiteId, { linkType: filters.linkType || undefined, state: filters.state || undefined, search: filters.search || undefined, sort: filters.sort, order: filters.order, cursor: more ?? undefined });
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load backlinks.");
    setLinks((prev) => (more ? [...(prev ?? []), ...r.data!.links] : r.data!.links));
    setCursor(r.meta?.nextCursor ?? null);
  }, [websiteId, filters]);
  useEffect(() => { setLinks(null); void load(); }, [load]);

  if (!summary.own) return <NoOwnData />;
  const sortBy = (sort: string) => setFilters((f) => ({ ...f, sort, order: f.sort === sort ? (f.order === "asc" ? "desc" : "asc") : sort === "source_domain" ? "asc" : "desc" }));
  const ariaSort = (s: string) => (filters.sort === s ? (filters.order === "asc" ? "ascending" : "descending") : "none");

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Attribute
          <select value={filters.linkType} onChange={(e) => setFilters((f) => ({ ...f, linkType: e.target.value }))} className={input}>
            <option value="">Any</option>{["follow", "nofollow", "sponsored", "ugc"].map((t) => <option key={t} value={t}>{t}</option>)}<option value="unknown">not stated</option>
          </select>
        </label>
        <label className="text-xs text-slate-700">Status
          <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))} className={input}>
            <option value="">Any</option>{Object.entries(STATE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <form role="search" aria-label="Search backlinks" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setFilters((f) => ({ ...f, search: searchInput.trim() })); }}>
          <label className="text-xs text-slate-700">URL or anchor contains<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className={input} /></label>
          <button type="submit" className={btn}>Search</button>
        </form>
        <button type="button" className={btn} onClick={() => void exp.run("links")}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {error ? <ErrorState title="Unable to load backlinks" message={error} onRetry={() => void load()} /> : !links ? <LoadingState label="Loading backlinks…" /> : links.length === 0 ? (
        <p className="mt-6 text-center text-sm text-slate-500">No backlinks match these filters.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Backlinks of the latest snapshot</caption>
            <thead className="text-slate-500">
              <tr>
                <th scope="col" aria-sort={ariaSort("source_domain")} className="py-2 pr-3"><button type="button" className="font-600 hover:underline" onClick={() => sortBy("source_domain")}>Source</button></th>
                <th scope="col" className="py-2 pr-3">Target</th>
                <th scope="col" className="py-2 pr-3">Anchor</th>
                <th scope="col" className="py-2 pr-3">Attribute</th>
                <th scope="col" aria-sort={ariaSort("first_seen")} className="py-2 pr-3"><button type="button" className="font-600 hover:underline" onClick={() => sortBy("first_seen")}>First seen</button></th>
                <th scope="col" aria-sort={ariaSort("last_seen")} className="py-2 pr-3"><button type="button" className="font-600 hover:underline" onClick={() => sortBy("last_seen")}>Last seen</button></th>
                <th scope="col" className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 align-top">
                  <td className="max-w-[260px] break-all py-2 pr-3">{l.source_url}</td>
                  <td className="max-w-[200px] break-all py-2 pr-3">{l.target_url ?? <span className="text-slate-400">not supplied</span>}</td>
                  <td className="max-w-[180px] break-words py-2 pr-3">{l.anchor ?? <span className="text-slate-400">—</span>}</td>
                  <td className="py-2 pr-3">{l.link_type ?? <span className="text-slate-400">not stated</span>}{l.observed_link_type && l.observed_link_type !== l.link_type ? <span className="block text-[10px] text-slate-500">live: {l.observed_link_type}</span> : null}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{l.first_seen ?? "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{l.last_seen ?? "—"}</td>
                  <td className="py-2">{STATE_LABEL[l.state]}{l.checked_at ? <span className="block text-[10px] text-slate-500">checked {new Date(l.checked_at).toLocaleDateString()}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? <button type="button" className={`${btn} mt-3`} onClick={() => void load(cursor)}>Load more</button> : null}
        </div>
      )}
    </div>
  );
}

// ─── Referring domains ───────────────────────────────────────────────────────

export function DomainsTab({ websiteId, summary }: { websiteId: string; summary: BacklinkSummary }) {
  const [rows, setRows] = useState<BacklinkReferringDomain[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("links");
  const [error, setError] = useState<string | null>(null);
  const exp = useExport(websiteId);
  const PAGE = 50;
  useEffect(() => {
    setRows(null);
    apiBacklinkReferringDomains(websiteId, { sort, offset, limit: PAGE }).then((r) => {
      if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load.");
      setRows(r.data.domains);
      setTotal(r.meta?.total ?? 0);
    }).catch((e: Error) => setError(e.message));
  }, [websiteId, sort, offset]);
  if (!summary.own) return <NoOwnData />;
  if (error) return <ErrorState title="Unable to load referring domains" message={error} />;
  if (!rows) return <LoadingState label="Loading referring domains…" />;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Sort by
          <select value={sort} onChange={(e) => { setOffset(0); setSort(e.target.value); }} className={input}>
            <option value="links">Most links</option><option value="last_seen">Most recently seen</option><option value="domain">Domain</option>
          </select>
        </label>
        <button type="button" className={btn} onClick={() => void exp.run("referring_domains")}>Export CSV</button>
        <span className="text-xs text-slate-600">{total} referring domain(s)</span>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      <table className="mt-3 w-full text-left text-xs">
        <caption className="sr-only">Referring domains</caption>
        <thead className="text-slate-500"><tr><th scope="col" className="py-2 pr-3">Domain</th><th scope="col" className="py-2 pr-3">Links</th><th scope="col" className="py-2 pr-3">Follow</th><th scope="col" className="py-2 pr-3">Nofollow / sponsored / UGC</th><th scope="col" className="py-2 pr-3">Not stated</th><th scope="col" className="py-2 pr-3">Last seen</th><th scope="col" className="py-2">Verified live</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.source_domain} className="border-t border-slate-100">
              <td className="py-2 pr-3 font-600">{d.source_domain}</td><td className="py-2 pr-3 tabular-nums">{d.links}</td><td className="py-2 pr-3 tabular-nums">{d.follow}</td>
              <td className="py-2 pr-3 tabular-nums">{d.not_followed}</td><td className="py-2 pr-3 tabular-nums">{d.attributes_unknown}</td><td className="py-2 pr-3">{d.last_seen ?? "—"}</td><td className="py-2 tabular-nums">{d.verified_live}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex gap-2">
        <button type="button" className={btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button type="button" className={btn} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </div>
  );
}

// ─── Competitor gap ──────────────────────────────────────────────────────────

function DatasetsUsed({ datasets, warnings, missing }: { datasets: BacklinkGap["datasets"]; warnings: string[]; missing: string[] }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <p className="font-700">Compared datasets</p>
      <ul className="mt-1 list-disc pl-4">
        {datasets.map((d) => <li key={d.id}>{d.subject}: {d.sourceLabel}, {d.exportedAt ?? new Date(d.retrievedAt).toLocaleDateString()}, {d.links} links, coverage {d.coverage}{d.stale ? " (stale)" : ""}</li>)}
      </ul>
      {missing.length ? <p className="mt-1">No dataset for: {missing.join(", ")}.</p> : null}
      {warnings.map((w, i) => <p key={i} className="mt-1 text-amber-900">⚠ {w}</p>)}
    </div>
  );
}

function needsData(code: string | undefined) {
  return code === "OWN_DATASET_MISSING" || code === "COMPETITOR_DATASET_MISSING";
}

export function GapTab({ websiteId, summary }: { websiteId: string; summary: BacklinkSummary }) {
  const [gap, setGap] = useState<BacklinkGap | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [category, setCategory] = useState<"" | "shared" | "competitor_only" | "own_only">("competitor_only");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setGap(null);
    setError(null);
    apiBacklinkGap(websiteId, { competitors: selected.join(",") || undefined, category: category || undefined }).then((r) => {
      if (r.error || !r.data) return setError(r.error ?? { message: "Failed to compare." });
      setGap(r.data);
    }).catch((e: Error) => setError({ message: e.message }));
  }, [websiteId, category, selected]);
  const competitors = summary.competitors.map((c) => c.dataset.subject_domain);
  if (error && needsData(error.code)) return <EmptyState title="Not enough data to compare" description={`${error.message} Use an export of the same tool for every site, taken around the same date.`} action={<Link to="/search/backlinks/imports" className={btnPrimary}>Import backlinks</Link>} />;
  if (error) return <ErrorState title={error.code === "DATASETS_INCOMPATIBLE" ? "These datasets cannot be compared fairly" : "Unable to compare"} message={error.message} />;
  if (!gap) return <LoadingState label="Comparing referring domains…" />;
  return (
    <div>
      <fieldset className="flex flex-wrap gap-3 text-xs">
        <legend className="mb-1 font-700 text-slate-900">Competitors</legend>
        {competitors.map((c) => (
          <label key={c} className="flex items-center gap-1">
            <input type="checkbox" checked={selected.length === 0 || selected.includes(c)} onChange={(e) => setSelected((s) => { const base = s.length ? s : competitors; return e.target.checked ? [...new Set([...base, c])] : base.filter((x) => x !== c); })} />{c}
          </label>
        ))}
      </fieldset>
      <div className="mt-3"><DatasetsUsed datasets={gap.datasets} warnings={gap.warnings} missing={gap.missingCompetitors} /></div>
      <div role="group" aria-label="Gap category" className="mt-3 flex flex-wrap gap-2">
        {([["competitor_only", "Competitor only"], ["shared", "Shared"], ["own_only", "Yours only"], ["", "All"]] as const).map(([v, l]) => (
          <button key={v || "all"} type="button" aria-pressed={category === v} onClick={() => setCategory(v)} className={`rounded-full border px-3 py-1 text-xs font-600 ${category === v ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}>
            {l}{v ? ` (${gap.counts[v]})` : ""}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">"Competitor only" = seen linking to a competitor and not seen in your data. It is not proof that the domain does not link to you.</p>
      {gap.rows.length === 0 ? <p className="mt-4 text-sm text-slate-500">No domains in this category.</p> : (
        <table className="mt-3 w-full text-left text-xs">
          <caption className="sr-only">Referring-domain gap</caption>
          <thead className="text-slate-500"><tr><th scope="col" className="py-2 pr-3">Referring domain</th><th scope="col" className="py-2 pr-3">Category</th><th scope="col" className="py-2">Links to</th></tr></thead>
          <tbody>{gap.rows.map((r) => <tr key={r.domain} className="border-t border-slate-100"><td className="py-2 pr-3 font-600">{r.domain}</td><td className="py-2 pr-3">{r.category.replace("_", " ")}</td><td className="py-2">{r.competitors.join(", ") || "only you"}</td></tr>)}</tbody>
        </table>
      )}
      {gap.total > gap.rows.length ? <p className="mt-2 text-xs text-slate-600">Showing {gap.rows.length} of {gap.total}. Export opportunities for the full list.</p> : null}
      <h3 className="mt-6 text-sm font-700 text-slate-900">Shared anchor texts</h3>
      {gap.sharedAnchors.length === 0 ? <p className="mt-1 text-xs text-slate-600">No anchor text appears in links to both you and a competitor.</p> : (
        <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-2">{gap.sharedAnchors.map((a) => <li key={a.anchor}>“{a.anchor}”: {a.own} to you, {a.competitors} to competitors</li>)}</ul>
      )}
    </div>
  );
}

// ─── New & lost ──────────────────────────────────────────────────────────────

export function ChangesTab({ websiteId, summary }: { websiteId: string; summary: BacklinkSummary }) {
  const [rows, setRows] = useState<BacklinkChange[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);
  const exp = useExport(websiteId);
  const load = useCallback(async (more?: string | null) => {
    const r = await apiBacklinkChanges(websiteId, { type: type || undefined, cursor: more ?? undefined });
    if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load changes.");
    setRows((prev) => (more ? [...(prev ?? []), ...r.data!] : r.data!));
    setCursor(r.meta?.nextCursor ?? null);
  }, [websiteId, type]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  if (!summary.own) return <NoOwnData />;
  if (error) return <ErrorState title="Unable to load changes" message={error} onRetry={() => void load()} />;
  return (
    <div>
      <p className="text-xs text-slate-600">Changes are detected between consecutive snapshots of your site. A link absent from a snapshot that is not declared complete is only “potentially lost”; “lost” needs a complete snapshot, the source marking it lost, or two consecutive live checks that do not find it.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">Change
          <select value={type} onChange={(e) => setType(e.target.value)} className={input}><option value="">All</option>{Object.entries(CHANGE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <button type="button" className={btn} onClick={() => void exp.run("changes")}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      {!rows ? <LoadingState label="Loading changes…" /> : rows.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No changes yet. Import a newer export of your backlinks to compare snapshots.</p> : (
        <ul className="mt-3 space-y-2 text-xs">
          {rows.map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <span className={`rounded px-1.5 py-0.5 font-700 ${c.change_type === "lost" ? "bg-red-50 text-red-800" : c.change_type === "new" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{CHANGE_LABEL[c.change_type]}</span>
              <span className="ml-2 break-all">{c.source_url}</span>{c.target_url ? <span className="text-slate-500"> → {c.target_url}</span> : null}
              <span className="block text-slate-600">{c.evidence}{c.details.from !== undefined ? ` (${String(c.details.from)} → ${String(c.details.to)})` : ""} · {new Date(c.detected_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
      {cursor ? <button type="button" className={`${btn} mt-3`} onClick={() => void load(cursor)}>Load more</button> : null}
    </div>
  );
}

// ─── Opportunities ───────────────────────────────────────────────────────────

export function OpportunitiesTab({ websiteId }: { websiteId: string; summary: BacklinkSummary }) {
  const [data, setData] = useState<BacklinkOpportunities | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [topicsInput, setTopicsInput] = useState("");
  const [params, setParams] = useState({ topics: "", kind: "", follow: false, minScore: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const exp = useExport(websiteId);
  useEffect(() => {
    setData(null);
    setError(null);
    apiBacklinkOpportunities(websiteId, { topics: params.topics || undefined, kind: params.kind || undefined, linkType: params.follow ? "follow" : "any", minScore: params.minScore || undefined }).then((r) => {
      if (r.error || !r.data) return setError(r.error ?? { message: "Failed to load opportunities." });
      setData(r.data);
    }).catch((e: Error) => setError({ message: e.message }));
  }, [websiteId, params]);
  if (error && needsData(error.code)) return <EmptyState title="Not enough data for opportunities" description={error.message} action={<Link to="/search/backlinks/imports" className={btnPrimary}>Import backlinks</Link>} />;
  if (error) return <ErrorState title="Unable to load opportunities" message={error.message} />;
  if (!data) return <LoadingState label="Scoring opportunities…" />;
  return (
    <div>
      <p className="text-xs text-slate-600">
        A transparent priority score (0–100) built only from evidence in your datasets: share of competitors linked, topical match, followed links, freshness, live verification and an earlier link to you. Unavailable signals are left out and shown. It is a prioritization aid, not a search-engine ranking factor, and no authority or traffic figure is used.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setParams((p) => ({ ...p, topics: topicsInput.trim() })); }}>
          <label className="text-xs text-slate-700">Topics<input value={topicsInput} maxLength={500} placeholder={data.topics.source === "search_console" ? "from your Search Console queries" : "e.g. running shoes"} onChange={(e) => setTopicsInput(e.target.value)} className={`${input} w-56`} /></label>
          <button type="submit" className={btn}>Apply</button>
        </form>
        <label className="text-xs text-slate-700">Type
          <select value={params.kind} onChange={(e) => setParams((p) => ({ ...p, kind: e.target.value }))} className={input}><option value="">All</option><option value="competitor_only">Competitor links</option><option value="reclaim">Reclaim (linked to you before)</option></select>
        </label>
        <label className="text-xs text-slate-700">Minimum score<input type="number" min={0} max={100} value={params.minScore} onChange={(e) => setParams((p) => ({ ...p, minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))} className={`${input} w-20`} /></label>
        <label className="flex items-center gap-1 text-xs text-slate-700"><input type="checkbox" checked={params.follow} onChange={(e) => setParams((p) => ({ ...p, follow: e.target.checked }))} />Followed links only</label>
        <button type="button" className={btn} onClick={() => void exp.run("opportunities")}>Export CSV</button>
      </div>
      {exp.notice ? <p role="status" className="mt-2 text-xs text-slate-700">{exp.notice}</p> : null}
      <p className="mt-2 text-[11px] text-slate-500">Topic terms: {data.topics.terms.length ? `${data.topics.terms.join(", ")} (${data.topics.source === "search_console" ? "from your Search Console queries" : "entered"})` : "none, so topical relevance is unavailable"}.</p>
      <div className="mt-3"><DatasetsUsed datasets={data.datasets} warnings={data.warnings} missing={data.missingCompetitors} /></div>
      {data.opportunities.length === 0 ? <p className="mt-6 text-center text-sm text-slate-500">No opportunities match these filters.</p> : (
        <ul className="mt-3 space-y-2">
          {data.opportunities.map((o) => (
            <li key={o.domain} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><strong className="text-sm">{o.domain}</strong> <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-700 uppercase">{o.kind === "reclaim" ? "reclaim" : "competitor link"}</span></span>
                <span className="tabular-nums"><strong className="text-base">{o.score}</strong>/100 <span className="text-slate-500">· based on {Math.round(o.basis * 100)}% of signal weight</span></span>
              </div>
              <p className="mt-1 text-slate-700">{o.why}</p>
              <button type="button" aria-expanded={open === o.domain} className="mt-1 underline" onClick={() => setOpen(open === o.domain ? null : o.domain)}>{open === o.domain ? "Hide signals" : "Show signals"}</button>
              {open === o.domain ? (
                <table className="mt-2 w-full text-left">
                  <caption className="sr-only">Signals for {o.domain}</caption>
                  <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Signal</th><th scope="col" className="py-1 pr-2">Weight</th><th scope="col" className="py-1 pr-2">Value</th><th scope="col" className="py-1">Evidence</th></tr></thead>
                  <tbody>{o.signals.map((s) => <tr key={s.id} className="border-t border-slate-100"><td className="py-1 pr-2">{s.id.replace(/_/g, " ")}</td><td className="py-1 pr-2">{Math.round(s.weight * 100)}%</td><td className="py-1 pr-2">{s.value === null ? "unavailable" : s.value}</td><td className="py-1">{s.explanation}</td></tr>)}</tbody>
                </table>
              ) : null}
              {o.sampleUrls.length ? <p className="mt-1 break-all text-slate-500">Example: {o.sampleUrls[0]}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Imports ─────────────────────────────────────────────────────────────────

export function ImportsTab({ websiteId, summary, onImported }: { websiteId: string; summary: BacklinkSummary; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [form, setForm] = useState({ subject: "own" as "own" | "competitor", competitorDomain: "", sourceLabel: "", coverage: "partial" as "complete" | "partial" | "unknown", exportedAt: "" });
  const [preview, setPreview] = useState<BacklinkImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const datasetsQ = useApiQuery(() => apiBacklinkDatasets(websiteId), [websiteId]);
  const datasets: BacklinkDataset[] | null = datasetsQ.data;
  const loadDatasets = datasetsQ.reload;
  // Without the limits the size check is left to the server, which enforces it anyway.
  const sourcesQ = useApiQuery(() => apiBacklinkSources(websiteId), [websiteId]);
  const limits: { maxRows: number; maxBytes: number } | null = sourcesQ.data?.limits ?? null;

  const onFile = async (f: File | undefined) => {
    setPreview(null);
    setMessage(null);
    if (!f) return setFile(null);
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) return setMessage({ ok: false, text: "Choose a .csv file." });
    if (limits && f.size > limits.maxBytes) return setMessage({ ok: false, text: `The file is larger than ${Math.round(limits.maxBytes / 1_000_000)} MB. Split it first.` });
    setFile({ name: f.name, text: await f.text() });
  };

  const body = () => ({ csv: file!.text, subject: form.subject, competitorDomain: form.subject === "competitor" ? form.competitorDomain.trim() : undefined });

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiBacklinkPreview(websiteId, body());
      if (r.error || !r.data) return setMessage({ ok: false, text: r.error?.message ?? "Preview failed." });
      setPreview(r.data);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!file || !preview) return;
    setBusy(true);
    try {
      const r = await apiBacklinkImport(websiteId, { ...body(), filename: file.name, sourceLabel: form.sourceLabel.trim(), coverage: form.coverage, exportedAt: form.exportedAt || undefined });
      if (r.error || !r.data) return setMessage({ ok: false, text: r.error?.message ?? "Import failed." });
      const d = r.data.dataset;
      setMessage({ ok: true, text: r.data.duplicateImport ? "This file was already imported for this site; nothing changed." : `Imported ${d.rows_accepted} link(s) from ${d.referring_domains} domain(s): ${d.rows_rejected} rejected, ${d.rows_duplicate} duplicate, ${d.rows_skipped} blank. ${r.data.changes} change(s) detected.` });
      setFile(null);
      setPreview(null);
      loadDatasets();
      onImported();
    } finally {
      setBusy(false);
    }
  };

  const canImport = !!preview && preview.missingRequired.length === 0 && !preview.rowLimitExceeded && preview.rows.accepted > 0 && form.sourceLabel.trim().length > 0 && (form.subject === "own" || form.competitorDomain.trim().length > 2);

  return (
    <div>
      <section aria-labelledby="import-h" className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 id="import-h" className="text-sm font-700 text-slate-900">Import an authorized backlink export</h3>
        <p className="mt-1 text-xs text-slate-600">CSV with a source URL column (also read: target URL, anchor, rel / nofollow / sponsored / UGC, first and last seen, lost). Up to {limits ? `${limits.maxRows.toLocaleString()} rows and ${Math.round(limits.maxBytes / 1_000_000)} MB` : "the configured limits"}. Text is stored as text; nothing in the file is executed.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-slate-700">File<input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} className="mt-1 block text-xs" /></label>
          <label className="text-xs text-slate-700">Backlinks of
            <select value={form.subject} onChange={(e) => { setPreview(null); setForm((f) => ({ ...f, subject: e.target.value as "own" | "competitor" })); }} className={input}>
              <option value="own">This website ({summary.siteDomain})</option><option value="competitor">A competitor</option>
            </select>
          </label>
          {form.subject === "competitor" ? <label className="text-xs text-slate-700">Competitor domain<input value={form.competitorDomain} maxLength={253} onChange={(e) => { setPreview(null); setForm((f) => ({ ...f, competitorDomain: e.target.value })); }} className={input} /></label> : null}
          <label className="text-xs text-slate-700">Source of the export<input value={form.sourceLabel} maxLength={80} placeholder="e.g. Google Search Console" onChange={(e) => setForm((f) => ({ ...f, sourceLabel: e.target.value }))} className={input} /></label>
          <label className="text-xs text-slate-700">Coverage
            <select value={form.coverage} onChange={(e) => setForm((f) => ({ ...f, coverage: e.target.value as typeof f.coverage }))} className={input}>
              <option value="partial">Partial / sample (most exports)</option><option value="complete">Complete list of known links</option><option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="text-xs text-slate-700">Export date<input type="date" value={form.exportedAt} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm((f) => ({ ...f, exportedAt: e.target.value }))} className={input} /></label>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Only choose “complete” if the export lists every link the source knows: links missing from a complete export are reported as lost.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={btn} disabled={!file || busy} onClick={() => void runPreview()}>{busy && !preview ? "Checking…" : "Preview"}</button>
          <button type="button" className={btnPrimary} disabled={!canImport || busy} onClick={() => void runImport()}>{busy && preview ? "Importing…" : "Import"}</button>
        </div>
        {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 rounded px-3 py-2 text-xs ${message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}>{message.text}</p> : null}
        {preview ? (
          <div aria-label="Import preview" role="region" className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            <p><strong>{preview.rows.accepted}</strong> link(s) will be imported · {preview.rows.rejected} rejected · {preview.rows.duplicate} duplicate · {preview.rows.skipped} blank (of {preview.rows.total} rows)</p>
            {preview.missingRequired.length ? <p role="alert" className="mt-1 text-red-800">No source URL column was recognised. Columns found: {preview.unmappedColumns.join(", ")}.</p> : null}
            {preview.rowLimitExceeded ? <p role="alert" className="mt-1 text-red-800">The file has more rows than allowed. Split it before importing.</p> : null}
            <p className="mt-1">Columns used: {Object.entries(preview.columns).map(([f, h]) => `${f.replace("_", " ")} ← “${h}”`).join(" · ") || "none"}</p>
            {preview.unmappedColumns.length ? <p className="mt-1 text-slate-500">Ignored columns: {preview.unmappedColumns.join(", ")}</p> : null}
            {preview.warnings.map((w, i) => <p key={i} className="mt-1 text-amber-900">⚠ {w}</p>)}
            {preview.rejectedSamples.length ? <p className="mt-1">Rejected rows: {preview.rejectedSamples.slice(0, 5).map((r) => `row ${r.row}: ${r.reason}`).join("; ")}</p> : null}
            {preview.sample.length ? <ul className="mt-2 list-disc pl-4">{preview.sample.slice(0, 5).map((l, i) => <li key={i} className="break-all">{l.sourceUrl}{l.anchor ? ` — “${l.anchor}”` : ""}{l.linkType ? ` (${l.linkType})` : ""}</li>)}</ul> : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="history-h" className="mt-6">
        <h3 id="history-h" className="text-sm font-700 text-slate-900">Import history</h3>
        {sourcesQ.error ? <InlineError what="import limits (the server still checks the file)" error={sourcesQ.error} onRetry={sourcesQ.reload} /> : null}
        {datasetsQ.error ? <InlineError what="previous imports" error={datasetsQ.error} onRetry={datasetsQ.reload} /> : !datasets ? <LoadingState label="Loading imports…" /> : datasets.length === 0 ? <p className="mt-2 text-xs text-slate-600">No imports yet.</p> : (
          <table className="mt-2 w-full text-left text-xs">
            <caption className="sr-only">Imported datasets</caption>
            <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2">Imported</th><th scope="col" className="py-1 pr-2">Backlinks of</th><th scope="col" className="py-1 pr-2">Source</th><th scope="col" className="py-1 pr-2">Coverage</th><th scope="col" className="py-1 pr-2">Accepted</th><th scope="col" className="py-1 pr-2">Rejected / duplicate / blank</th><th scope="col" className="py-1">Freshness</th></tr></thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(d.retrieved_at).toLocaleString()}{d.filename ? <span className="block text-slate-500">{d.filename}</span> : null}</td>
                  <td className="py-1.5 pr-2">{d.subject_domain}{d.subject_kind === "competitor" ? " (competitor)" : ""}</td>
                  <td className="py-1.5 pr-2">{d.source_label}</td>
                  <td className="py-1.5 pr-2">{d.coverage}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{d.rows_accepted}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{d.rows_rejected} / {d.rows_duplicate} / {d.rows_skipped}</td>
                  <td className="py-1.5">{d.exported_at ? `exported ${d.exported_at}` : "export date unknown"}{d.stale ? <span className="ml-1 rounded bg-amber-100 px-1 font-700 text-amber-900">stale</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ─── Data sources ────────────────────────────────────────────────────────────

export function SourcesTab({ websiteId }: { websiteId: string }) {
  const [sources, setSources] = useState<BacklinkSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiBacklinkSources(websiteId).then((r) => (r.error || !r.data ? setError(r.error?.message ?? "Failed to load.") : setSources(r.data.sources))).catch((e: Error) => setError(e.message));
  }, [websiteId]);
  if (error) return <ErrorState title="Unable to load data sources" message={error} />;
  if (!sources) return <LoadingState label="Loading data sources…" />;
  return (
    <ul className="space-y-3">
      {sources.map((s) => (
        <li key={s.id} aria-label={s.name} className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm text-slate-950">{s.name}</strong>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-700 uppercase ${s.status === "available" ? "bg-emerald-50 text-emerald-800" : s.status === "not_configured" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700"}`}>{s.status.replace("_", " ")}</span>
          </div>
          <p className="mt-1 text-slate-700">{s.explanation}</p>
          {s.capabilities.length ? <p className="mt-1 text-slate-600">Supplies: {s.capabilities.join(", ").replace(/_/g, " ")}</p> : null}
          {s.setup ? <p className="mt-1 text-slate-600">Next step: {s.setup}</p> : null}
          <p className="mt-1 text-slate-500">{s.costNote}</p>
        </li>
      ))}
    </ul>
  );
}
