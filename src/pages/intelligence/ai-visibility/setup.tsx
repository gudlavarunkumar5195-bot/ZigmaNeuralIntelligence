import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "../../../components/ui/DataState";
import {
  apiAivAddCompetitor,
  apiAivAddQueries,
  apiAivCancelRun,
  apiAivCompetitors,
  apiAivCreateBrand,
  apiAivImport,
  apiAivImports,
  apiAivPreviewImport,
  apiAivPreviewRun,
  apiAivQueries,
  apiAivQueryVersions,
  apiAivRun,
  apiAivRuns,
  apiAivSetSchedule,
  apiAivStartRun,
  apiAivUpdateBrand,
  apiAivUpdateCompetitor,
  apiAivUpdateQuery,
  type AivBrand,
  type AivBrandInput,
  type AivImportPreview,
  type AivImportRecord,
  type AivProviders,
  type AivQuery,
  type AivRun,
  type AivRunDetail,
  type AivRunPreview,
} from "../../../services/api";
import { btn, btnPrimary, card, errorMessage, fmt, fmtDay, input, PROVIDER_STATUS, toList } from "./ui";

// ─── Brand form ──────────────────────────────────────────────────────────────

const listText = (l: string[] | undefined) => (l ?? []).join(", ");

/** Create or edit a monitored brand (or, with `competitorOf`, a competitor). */
export function BrandForm({ brand, competitorOf, submitLabel, onSaved, onCancel }: { brand?: AivBrand; competitorOf?: string; submitLabel: string; onSaved: (b: AivBrand) => void; onCancel?: () => void }) {
  const [f, setF] = useState({
    name: brand?.name ?? "",
    domains: listText(brand?.domains),
    aliases: listText(brand?.aliases),
    products: listText(brand?.products),
    excludeTerms: listText(brand?.exclude_terms),
    disambiguation: brand?.disambiguation ?? "",
    topics: listText(brand?.topics),
    language: brand?.language ?? "",
    country: brand?.country ?? "",
  });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const competitor = !!competitorOf || brand?.kind === "competitor";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return setMessage("A name is required.");
    setBusy(true);
    setMessage(null);
    const body: AivBrandInput & { name: string } = {
      name: f.name.trim(), domains: toList(f.domains), aliases: toList(f.aliases), products: toList(f.products), excludeTerms: toList(f.excludeTerms),
      disambiguation: f.disambiguation.trim() || null,
      ...(competitor ? {} : { topics: toList(f.topics), language: f.language.trim() || null, country: f.country.trim() || null }),
    };
    const r = brand
      ? brand.kind === "competitor" ? await apiAivUpdateCompetitor(brand.parent_id!, brand.id, body) : await apiAivUpdateBrand(brand.id, body)
      : competitorOf ? await apiAivAddCompetitor(competitorOf, body) : await apiAivCreateBrand(body);
    setBusy(false);
    if (r.error || !r.data) return setMessage(r.error ? errorMessage(r.error) : "Saving failed.");
    setMessage(brand ? "Saved. Past answers with retained text were re-matched against the new terms." : null);
    onSaved(r.data);
  };
  const id = (k: string) => `aiv-${brand?.id ?? competitorOf ?? "new"}-${k}`;
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2" aria-label={competitor ? "Competitor" : "Brand"}>
      <label htmlFor={id("name")} className="text-xs text-slate-700">Name<input id={id("name")} required maxLength={120} value={f.name} onChange={(e) => set("name", e.target.value)} className={`${input} w-full`} /></label>
      <label htmlFor={id("domains")} className="text-xs text-slate-700">Official domains (comma-separated)<input id={id("domains")} value={f.domains} placeholder="example.com" onChange={(e) => set("domains", e.target.value)} className={`${input} w-full`} /></label>
      <label htmlFor={id("aliases")} className="text-xs text-slate-700">Aliases and other names<input id={id("aliases")} value={f.aliases} onChange={(e) => set("aliases", e.target.value)} className={`${input} w-full`} /></label>
      <label htmlFor={id("products")} className="text-xs text-slate-700">Product and service names<input id={id("products")} value={f.products} onChange={(e) => set("products", e.target.value)} className={`${input} w-full`} /></label>
      <label htmlFor={id("exclude")} className="text-xs text-slate-700">Phrases that are not this brand (disambiguation)<input id={id("exclude")} value={f.excludeTerms} placeholder="e.g. apple pie" onChange={(e) => set("excludeTerms", e.target.value)} className={`${input} w-full`} /></label>
      <label htmlFor={id("notes")} className="text-xs text-slate-700">Disambiguation notes<input id={id("notes")} maxLength={1000} value={f.disambiguation} onChange={(e) => set("disambiguation", e.target.value)} className={`${input} w-full`} /></label>
      {!competitor ? (
        <>
          <label htmlFor={id("topics")} className="text-xs text-slate-700">Monitoring topics<input id={id("topics")} value={f.topics} onChange={(e) => set("topics", e.target.value)} className={`${input} w-full`} /></label>
          <div className="flex gap-3">
            <label htmlFor={id("lang")} className="text-xs text-slate-700">Language (optional)<input id={id("lang")} value={f.language} maxLength={12} placeholder="en" onChange={(e) => set("language", e.target.value)} className={`${input} w-24`} /></label>
            <label htmlFor={id("country")} className="text-xs text-slate-700">Country (optional)<input id={id("country")} value={f.country} maxLength={2} placeholder="us" onChange={(e) => set("country", e.target.value)} className={`${input} w-20`} /></label>
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" className={btnPrimary} disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        {onCancel ? <button type="button" className={btn} onClick={onCancel}>Cancel</button> : null}
        {message ? <span role="status" className="text-xs text-slate-700">{message}</span> : null}
      </div>
      <p className="text-[11px] text-slate-500 sm:col-span-2">Names match whole words, case-insensitively; short all-caps names (such as “HP”) match exactly. Domains match the domain and its subdomains.</p>
    </form>
  );
}

// ─── Brand, competitors and schedule ─────────────────────────────────────────

/** Repeated answers per query (the API accepts 1–5); repeats measure answer consistency. */
const REPEAT_OPTIONS = [1, 2, 3, 4, 5];

function StatusActions({ status, onChange, label }: { status: AivBrand["status"]; onChange: (s: AivBrand["status"]) => Promise<void>; label: string }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {status !== "active" ? <button type="button" className={btn} onClick={() => void onChange("active")}>Activate {label}</button> : null}
      {status === "active" ? <button type="button" className={btn} onClick={() => void onChange("disabled")}>Disable {label}</button> : null}
      {status !== "archived" ? (
        confirming
          ? <><button type="button" className={btn} onClick={() => { setConfirming(false); void onChange("archived"); }}>Confirm archive</button><button type="button" className={btn} onClick={() => setConfirming(false)}>Keep</button></>
          : <button type="button" className={btn} onClick={() => setConfirming(true)}>Archive {label}</button>
      ) : null}
    </span>
  );
}

export function BrandTab({ brand, providers, onChanged }: { brand: AivBrand; providers: AivProviders; onChanged: () => void }) {
  const [competitors, setCompetitors] = useState<AivBrand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const loadCompetitors = useCallback(async () => {
    const r = await apiAivCompetitors(brand.id, true);
    if (r.error) return setError(r.error.message);
    setCompetitors(r.data ?? []);
  }, [brand.id]);
  useEffect(() => void loadCompetitors(), [loadCompetitors]);
  const setStatus = async (s: AivBrand["status"]) => {
    const r = await apiAivUpdateBrand(brand.id, { status: s });
    setMessage(r.error ? errorMessage(r.error) : s === "archived" ? "Brand archived. Its history is kept." : `Brand ${s === "active" ? "activated" : "disabled"}.`);
    onChanged();
  };
  const setCompetitorStatus = async (c: AivBrand, s: AivBrand["status"]) => {
    const r = await apiAivUpdateCompetitor(brand.id, c.id, { status: s });
    setMessage(r.error ? errorMessage(r.error) : `${c.name}: ${s}.`);
    void loadCompetitors();
  };
  return (
    <div className="space-y-4">
      <section aria-labelledby="aiv-brand" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="aiv-brand" className="text-sm font-800 text-slate-900">{brand.name} <span className="text-xs font-600 text-slate-500">({brand.status})</span></h3>
          <StatusActions status={brand.status} onChange={setStatus} label="brand" />
        </div>
        <BrandForm brand={brand} submitLabel="Save brand" onSaved={() => onChanged()} />
        {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      </section>

      <section aria-labelledby="aiv-competitors" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="aiv-competitors" className="text-sm font-800 text-slate-900">Competitors</h3>
          {!adding ? <button type="button" className={btn} onClick={() => setAdding(true)}>Add competitor</button> : null}
        </div>
        <p className="mt-1 text-xs text-slate-600">Only competitors you add are compared. Up to {providers.limits.competitors}.</p>
        {adding ? <BrandForm competitorOf={brand.id} submitLabel="Add competitor" onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void loadCompetitors(); }} /> : null}
        {error ? <ErrorState title="Unable to load competitors" message={error} onRetry={loadCompetitors} /> : !competitors ? <LoadingState label="Loading competitors…" /> : competitors.length === 0 ? <p className="mt-3 text-xs text-slate-600">No competitors yet.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {competitors.map((c) => (
              <li key={c.id} className="py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-700">{c.name}</span> <span className="text-slate-500">{c.domains.join(", ") || "no domains"}{c.aliases.length ? ` · aliases: ${c.aliases.join(", ")}` : ""} · {c.status}</span></span>
                  <span className="inline-flex gap-1">
                    <button type="button" className={btn} onClick={() => setEditing(editing === c.id ? null : c.id)} aria-expanded={editing === c.id}>Edit</button>
                    <StatusActions status={c.status} onChange={(s) => setCompetitorStatus(c, s)} label="" />
                  </span>
                </div>
                {editing === c.id ? <BrandForm brand={c} submitLabel="Save competitor" onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void loadCompetitors(); }} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ScheduleSection brand={brand} providers={providers} onChanged={onChanged} />
    </div>
  );
}

function ScheduleSection({ brand, providers, onChanged }: { brand: AivBrand; providers: AivProviders; onChanged: () => void }) {
  const api = providers.providers.filter((p) => p.collection === "provider_api");
  const available = api.filter((p) => p.status === "available");
  const [provider, setProvider] = useState(available[0]?.id ?? "");
  const [repeats, setRepeats] = useState(1);
  const [maxRequests, setMaxRequests] = useState(20);
  const [preview, setPreview] = useState<AivRunPreview | null>(null);
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const check = async () => {
    setApproved(false);
    const r = await apiAivPreviewRun(brand.id, { provider, repeats });
    if (r.error) return setMessage(errorMessage(r.error));
    setPreview(r.data);
  };
  const enable = async () => {
    const r = await apiAivSetSchedule(brand.id, { schedule: "weekly", provider, repeats, maxRequests, confirm: true });
    setMessage(r.error ? errorMessage(r.error) : "Weekly collection enabled.");
    if (!r.error) onChanged();
  };
  const disable = async () => {
    const r = await apiAivSetSchedule(brand.id, { schedule: "off" });
    setMessage(r.error ? errorMessage(r.error) : "Weekly collection turned off.");
    if (!r.error) onChanged();
  };
  return (
    <section aria-labelledby="aiv-schedule" className={card}>
      <h3 id="aiv-schedule" className="text-sm font-800 text-slate-900">Recurring collection</h3>
      {brand.schedule === "weekly" ? (
        <div className="mt-2 text-xs text-slate-700">
          <p>Weekly with {brand.schedule_provider}, {brand.schedule_repeats} answer(s) per query, at most {brand.schedule_max_requests} requests per run. Approved {fmt(brand.schedule_approved_at)}.</p>
          <button type="button" className={`${btn} mt-2`} onClick={() => void disable()}>Turn off</button>
        </div>
      ) : !available.length ? (
        <p className="mt-2 text-xs text-slate-600">Off. Scheduling needs an available answer provider: {api.map((p) => `${p.name} — ${PROVIDER_STATUS[p.status].label}`).join("; ")}.</p>
      ) : (
        <div className="mt-2 text-xs text-slate-700">
          <p>Off. Recurring collection sends requests every week until you turn it off, so it needs your explicit approval of the limits.</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="text-xs">Provider<select value={provider} onChange={(e) => { setProvider(e.target.value); setPreview(null); }} className={input}>{available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="text-xs">Answers per query<select value={repeats} onChange={(e) => { setRepeats(Number(e.target.value)); setPreview(null); }} className={input}>{REPEAT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <label className="text-xs">Max requests per run<input type="number" min={1} max={providers.limits.requestsPerRun} value={maxRequests} onChange={(e) => setMaxRequests(Math.max(1, Number(e.target.value) || 1))} className={`${input} w-24`} /></label>
            <button type="button" className={btn} onClick={() => void check()}>Check limits</button>
          </div>
          {preview ? (
            <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
              <p>Each weekly run needs {preview.requests} requests ({preview.queries} active queries × {preview.repeats}). {preview.costEstimate}</p>
              {preview.requests > maxRequests ? <p className="text-red-700">That is above your limit of {maxRequests}; raise the limit or reduce queries.</p> : null}
              <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> I approve up to {maxRequests} requests per week to {preview.provider.name}.</label>
              <button type="button" className={`${btnPrimary} mt-2`} disabled={!approved || preview.requests > maxRequests} onClick={() => void enable()}>Enable weekly collection</button>
            </div>
          ) : null}
        </div>
      )}
      {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
    </section>
  );
}

// ─── Queries and runs ────────────────────────────────────────────────────────

export function QueriesTab({ brand, providers }: { brand: AivBrand; providers: AivProviders }) {
  const [rows, setRows] = useState<AivQuery[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; topics: string[] } | null>(null);
  const [filters, setFilters] = useState({ search: "", status: "", topic: "", offset: 0 });
  const [searchInput, setSearchInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [versions, setVersions] = useState<{ id: string; list: Array<{ version: number; text: string; created_at: string }> } | null>(null);
  const [reload, setReload] = useState(0);
  const PAGE = 50;
  useEffect(() => {
    setRows(null);
    apiAivQueries(brand.id, { search: filters.search || undefined, status: filters.status || undefined, topic: filters.topic || undefined, offset: filters.offset, limit: PAGE })
      .then((r) => { if (r.error || !r.data) return setError(r.error?.message ?? "Failed to load."); setRows(r.data); setMeta({ total: r.meta?.total ?? 0, topics: r.meta?.topics ?? [] }); })
      .catch((e: Error) => setError(e.message));
  }, [brand.id, filters, reload]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const lines = newText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const r = await apiAivAddQueries(brand.id, lines.map((text) => ({ text, topic: newTopic.trim() || null })));
    if (r.error || !r.data) return setMessage(r.error ? errorMessage(r.error) : "Failed.");
    setMessage(`${r.data.added} added${r.data.alreadyExists ? `, ${r.data.alreadyExists} already in the library` : ""}${r.data.invalid.length ? `, ${r.data.invalid.length} invalid (${r.data.invalid[0].reason})` : ""}.`);
    setNewText("");
    setReload((n) => n + 1);
  };
  const update = async (q: AivQuery, patch: Parameters<typeof apiAivUpdateQuery>[2]) => {
    const r = await apiAivUpdateQuery(brand.id, q.id, patch);
    setMessage(r.error ? errorMessage(r.error) : r.data?.versionCreated ? `Saved as version ${r.data.version}; earlier observations keep the version they used.` : "Saved.");
    setEditing(null);
    setReload((n) => n + 1);
  };
  const showVersions = async (q: AivQuery) => {
    if (versions?.id === q.id) return setVersions(null);
    const r = await apiAivQueryVersions(brand.id, q.id);
    if (r.data) setVersions({ id: q.id, list: r.data });
  };
  if (error) return <ErrorState title="Unable to load queries" message={error} />;
  const set = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v, offset: 0 }));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="space-y-4">
      <section aria-labelledby="aiv-add-q" className={card}>
        <h3 id="aiv-add-q" className="text-sm font-800 text-slate-900">Add queries</h3>
        <form onSubmit={add} className="mt-2 flex flex-wrap items-end gap-3">
          <label className="min-w-[18rem] flex-1 text-xs text-slate-700">One question per line<textarea value={newText} rows={3} onChange={(e) => setNewText(e.target.value)} className={`${input} w-full`} placeholder="What are the best CRM tools for small agencies?" /></label>
          <label className="text-xs text-slate-700">Topic (optional)<input value={newTopic} maxLength={80} onChange={(e) => setNewTopic(e.target.value)} className={input} /></label>
          <button type="submit" className={btnPrimary}>Add</button>
        </form>
        <p className="mt-1 text-[11px] text-slate-500">Up to {providers.limits.queriesPerBrand} queries. Queries are only sent to a provider when you start a run or approve a schedule.</p>
      </section>

      <section aria-labelledby="aiv-lib">
        <h3 id="aiv-lib" className="text-sm font-800 text-slate-900">Query library</h3>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <form role="search" aria-label="Search queries" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); set("search", searchInput.trim()); }}>
            <label className="text-xs text-slate-700">Text<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className={input} /></label>
            <button type="submit" className={btn}>Search</button>
          </form>
          <label className="text-xs text-slate-700">Status<select value={filters.status} onChange={(e) => set("status", e.target.value)} className={input}><option value="">Active and paused</option><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select></label>
          <label className="text-xs text-slate-700">Topic<select value={filters.topic} onChange={(e) => set("topic", e.target.value)} className={input}><option value="">Any</option>{(meta?.topics ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        </div>
        {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
        {!rows || !meta ? <LoadingState label="Loading queries…" /> : rows.length === 0 ? <p className="mt-4 text-sm text-slate-600">{filters.search || filters.status || filters.topic ? "No queries match these filters." : "No queries yet. Add the questions you want to check above."}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs"><caption className="sr-only">Monitored queries</caption>
              <thead className="text-slate-500"><tr><th scope="col" className="py-1 pr-2"><span className="sr-only">Select</span></th><th scope="col" className="py-1 pr-2">Query</th><th scope="col" className="py-1 pr-2">Topic</th><th scope="col" className="py-1 pr-2">Status</th><th scope="col" className="py-1 pr-2">Answered / mentions brand</th><th scope="col" className="py-1 pr-2">Last observed</th><th scope="col" className="py-1">Actions</th></tr></thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} className="border-t border-slate-100 align-top">
                    <td className="py-1 pr-2"><input type="checkbox" aria-label={`Select ${q.text}`} checked={selected.has(q.id)} disabled={q.status !== "active"} onChange={() => toggle(q.id)} /></td>
                    <td className="py-1 pr-2">
                      {editing?.id === q.id ? (
                        <form onSubmit={(e) => { e.preventDefault(); void update(q, { text: editing.text }); }} className="flex gap-1">
                          <label className="sr-only" htmlFor={`edit-${q.id}`}>Query text</label>
                          <input id={`edit-${q.id}`} value={editing.text} maxLength={500} onChange={(e) => setEditing({ id: q.id, text: e.target.value })} className={`${input} mt-0 w-72`} />
                          <button type="submit" className={btn}>Save</button><button type="button" className={btn} onClick={() => setEditing(null)}>Cancel</button>
                        </form>
                      ) : <>{q.text} <span className="text-slate-400">v{q.version}{q.source === "import" ? " · from import" : ""}</span></>}
                      {versions?.id === q.id ? <ol className="mt-1 list-inside list-disc text-slate-500">{versions.list.map((v) => <li key={v.version}>v{v.version}: {v.text} ({fmtDay(v.created_at)})</li>)}</ol> : null}
                    </td>
                    <td className="py-1 pr-2">{q.topic ?? "—"}</td>
                    <td className="py-1 pr-2">{q.status}{q.providers.length ? <span className="block text-slate-400">only: {q.providers.join(", ")}</span> : null}</td>
                    <td className="py-1 pr-2 tabular-nums">{q.observations === 0 ? "Not collected" : `${q.answered} / ${q.mentioned}`}</td>
                    <td className="py-1 pr-2">{fmtDay(q.last_observed_at)}</td>
                    <td className="py-1">
                      <span className="inline-flex flex-wrap gap-1">
                        <button type="button" className={btn} onClick={() => setEditing({ id: q.id, text: q.text })}>Edit</button>
                        <button type="button" className={btn} onClick={() => void showVersions(q)} aria-expanded={versions?.id === q.id}>Versions</button>
                        {q.status === "active" ? <button type="button" className={btn} onClick={() => void update(q, { status: "paused" })}>Pause</button> : <button type="button" className={btn} onClick={() => void update(q, { status: "active" })}>Activate</button>}
                        {q.status !== "archived" ? <button type="button" className={btn} onClick={() => void update(q, { status: "archived" })}>Archive</button> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <span>{meta.total} queries</span>
              <button type="button" className={btn} disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE) }))}>Previous</button>
              <button type="button" className={btn} disabled={filters.offset + PAGE >= meta.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE }))}>Next</button>
            </div>
          </div>
        )}
      </section>

      <RunPanel brand={brand} providers={providers} selected={[...selected]} />
    </div>
  );
}

const ACTIVE_RUN = new Set(["queued", "running"]);

function RunPanel({ brand, providers, selected }: { brand: AivBrand; providers: AivProviders; selected: string[] }) {
  const [provider, setProvider] = useState(providers.providers.find((p) => p.collection === "provider_api" && p.status === "available")?.id ?? providers.providers[0]?.id ?? "");
  const [repeats, setRepeats] = useState(1);
  const [onlySelected, setOnlySelected] = useState(false);
  const [preview, setPreview] = useState<AivRunPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [runs, setRuns] = useState<AivRun[] | null>(null);
  const [detail, setDetail] = useState<AivRunDetail | null>(null);
  const idempotencyKey = useMemo(() => `ui-${brand.id.slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, [brand.id, preview]);
  const loadRuns = useCallback(async () => {
    const r = await apiAivRuns(brand.id);
    if (r.data) setRuns(r.data);
  }, [brand.id]);
  useEffect(() => void loadRuns(), [loadRuns]);
  useEffect(() => {
    if (!runs?.some((r) => ACTIVE_RUN.has(r.status))) return;
    const t = setInterval(() => void loadRuns(), 5_000);
    return () => clearInterval(t);
  }, [runs, loadRuns]);
  const body = () => ({ provider, repeats, ...(onlySelected && selected.length ? { queryIds: selected } : {}) });
  const doPreview = async () => {
    setMessage(null);
    const r = await apiAivPreviewRun(brand.id, body());
    if (r.error) return setMessage(errorMessage(r.error));
    setPreview(r.data);
  };
  const start = async () => {
    const r = await apiAivStartRun(brand.id, { ...body(), idempotencyKey });
    setPreview(null);
    if (r.error || !r.data) return setMessage(r.error ? errorMessage(r.error) : "Failed.");
    setMessage(r.data.deduplicated ? "A run is already queued or running for this brand." : `Run queued: ${r.data.run.items_total} requests.`);
    void loadRuns();
  };
  const cancel = async (id: string) => {
    const r = await apiAivCancelRun(brand.id, id);
    setMessage(r.error ? errorMessage(r.error) : r.data?.cancelled ? "Run cancelled. Requests already answered are kept." : "The run had already finished.");
    void loadRuns();
  };
  const openRun = async (id: string) => {
    if (detail?.id === id) return setDetail(null);
    const r = await apiAivRun(brand.id, id);
    if (r.data) setDetail(r.data);
  };
  const p = providers.providers.find((x) => x.id === provider);
  return (
    <section aria-labelledby="aiv-run" className={card}>
      <h3 id="aiv-run" className="text-sm font-800 text-slate-900">Collect answers</h3>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="max-w-full text-xs text-slate-700">Source<select value={provider} onChange={(e) => { setProvider(e.target.value); setPreview(null); }} className={`${input} max-w-full`}>
          {providers.providers.map((x) => <option key={x.id} value={x.id}>{x.name} — {PROVIDER_STATUS[x.status].label}</option>)}
        </select></label>
        <label className="text-xs text-slate-700">Answers per query<select value={repeats} onChange={(e) => { setRepeats(Number(e.target.value)); setPreview(null); }} className={input}>{REPEAT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={onlySelected} disabled={!selected.length} onChange={(e) => { setOnlySelected(e.target.checked); setPreview(null); }} /> Only the {selected.length} selected queries</label>
        <button type="button" className={btn} onClick={() => void doPreview()}>Preview</button>
      </div>
      {p ? <p className="mt-2 text-[11px] text-slate-600">{p.explanation} {p.costNote}</p> : null}
      {preview ? (
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700" aria-label="Run preview">
          <p>{preview.queries} queries × {preview.repeats} = <span className="font-800">{preview.requests} requests</span> to {preview.provider.name}{preview.model ? ` (model ${preview.model})` : ""}. Today: {preview.usage.used} of {preview.usage.limit} requests used.</p>
          {preview.costEstimate ? <p>{preview.costEstimate}</p> : null}
          {preview.provider.limitations.length ? <ul className="mt-1 list-inside list-disc text-slate-600">{preview.provider.limitations.map((l) => <li key={l}>{l}</li>)}</ul> : null}
          {preview.blockers.length ? <ul className="mt-1 list-inside list-disc text-red-700">{preview.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
          <button type="button" className={`${btnPrimary} mt-2`} disabled={!preview.canRun} onClick={() => void start()}>Send {preview.requests} requests</button>
        </div>
      ) : null}
      {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
      <h4 className="mt-4 text-xs font-800 text-slate-900">Run history</h4>
      {!runs ? <LoadingState label="Loading runs…" /> : runs.length === 0 ? <p className="mt-1 text-xs text-slate-600">No runs yet.</p> : (
        <ul className="mt-1 divide-y divide-slate-100 text-xs">
          {runs.map((r) => (
            <li key={r.id} className="py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{fmt(r.created_at)} · {r.provider}{r.model ? ` (${r.model})` : ""} · {r.trigger} · <span className="font-700">{r.status}</span> · {r.items_done} answered, {r.items_failed} failed of {r.items_total}{r.error ? <span className="text-slate-500"> — {r.error}</span> : null}</span>
                <span className="inline-flex gap-1">
                  <button type="button" className={btn} onClick={() => void openRun(r.id)} aria-expanded={detail?.id === r.id}>Details</button>
                  {ACTIVE_RUN.has(r.status) ? <button type="button" className={btn} onClick={() => void cancel(r.id)}>Cancel</button> : null}
                </span>
              </div>
              {detail?.id === r.id ? (
                <ul className="mt-1 text-slate-600">{detail.items.map((i) => <li key={`${i.query_id}-${i.repeat_index}`}>{i.query_text} (#{i.repeat_index}) — {i.status}{i.error_code ? ` · ${i.error_code}` : ""}{i.attempts > 1 ? ` · ${i.attempts} attempts` : ""}</li>)}</ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-slate-500">Failed requests are listed here and never counted as “not mentioned”.</p>
    </section>
  );
}

// ─── Import ──────────────────────────────────────────────────────────────────

export function ImportTab({ brand, providers }: { brand: AivBrand; providers: AivProviders }) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [createMissing, setCreateMissing] = useState(true);
  const [preview, setPreview] = useState<AivImportPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<AivImportRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const loadHistory = useCallback(async () => {
    const r = await apiAivImports(brand.id);
    if (r.data) setHistory(r.data);
  }, [brand.id]);
  useEffect(() => void loadHistory(), [loadHistory]);
  const onFile = async (file: File | undefined) => {
    setPreview(null);
    if (!file) return;
    if (file.size > providers.limits.importBytes) return setMessage(`The file is larger than ${providers.limits.importBytes} bytes.`);
    setFilename(file.name);
    setContent(await file.text());
    setMessage(null);
  };
  const doPreview = async () => {
    setBusy(true);
    const r = await apiAivPreviewImport(brand.id, { content });
    setBusy(false);
    if (r.error) { setPreview(null); return setMessage(errorMessage(r.error)); }
    setMessage(null);
    setPreview(r.data);
  };
  const doImport = async () => {
    setBusy(true);
    const r = await apiAivImport(brand.id, { content, filename, sourceLabel: label.trim(), createMissingQueries: createMissing });
    setBusy(false);
    if (r.error || !r.data) return setMessage(r.error ? errorMessage(r.error) : "Import failed.");
    setMessage(r.data.duplicateImport ? "This exact file was already imported; nothing changed." : `Imported ${r.data.inserted} observations (${r.data.duplicates} duplicates skipped, ${r.data.rejected} rejected, ${r.data.queriesCreated} new queries).`);
    setPreview(null);
    void loadHistory();
  };
  return (
    <div className="space-y-4">
      <section aria-labelledby="aiv-import" className={card}>
        <h3 id="aiv-import" className="text-sm font-800 text-slate-900">Import observed AI answers</h3>
        <p className="mt-1 text-xs text-slate-600">
          Record answers you saw yourself in AI products that offer no monitoring API. Imported answers are labeled as manual observations and kept apart from API-collected data. Only import what you are entitled to record.
        </p>
        <details className="mt-2 text-xs text-slate-700">
          <summary className="cursor-pointer font-700">File format</summary>
          <p className="mt-1">CSV with a header row, or JSON (an array, or <code>{"{\"observations\": [...]}"}</code>). Fields:</p>
          <ul className="mt-1 list-inside list-disc">
            <li><code>query</code> (required) — the question asked</li>
            <li><code>observed_at</code> (required) — YYYY-MM-DD or an ISO date-time with time zone</li>
            <li><code>surface</code> (required) — one of: {providers.importSurfaces.map((s) => providers.surfaces[s] ?? s).join(", ")}</li>
            <li><code>response</code> (required) — the full answer text</li>
            <li><code>cited_urls</code> — URLs separated by spaces or <code>|</code> (CSV), or a list of URLs / {"{url, title}"} (JSON); only public http(s) URLs</li>
            <li><code>model</code>, <code>language</code>, <code>country</code>, <code>notes</code> — optional</li>
          </ul>
          <p className="mt-1">Up to {providers.limits.importRows} rows and {Math.round(providers.limits.importBytes / 1_000_000)} MB. Re-importing the same answer is detected as a duplicate.</p>
        </details>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">File<input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => void onFile(e.target.files?.[0])} className="mt-1 block text-xs" /></label>
          <label className="text-xs text-slate-700">Source label (required)<input value={label} maxLength={80} placeholder="e.g. Weekly manual check" onChange={(e) => setLabel(e.target.value)} className={input} /></label>
          <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} /> Add queries that are not in the library</label>
        </div>
        <label className="mt-3 block text-xs text-slate-700">Or paste CSV / JSON<textarea value={content} rows={5} onChange={(e) => { setContent(e.target.value); setFilename(undefined); setPreview(null); }} className={`${input} w-full font-mono text-[11px]`} /></label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={!content.trim() || busy} onClick={() => void doPreview()}>Preview</button>
          <button type="button" className={btnPrimary} disabled={!preview || !preview.accepted || !label.trim() || busy} onClick={() => void doImport()}>Import {preview?.accepted ?? 0} observations</button>
        </div>
        {message ? <p role="status" className="mt-2 text-xs text-slate-700">{message}</p> : null}
        {preview ? (
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700" aria-label="Import preview">
            <p>{preview.format.toUpperCase()}: {preview.rowsTotal} rows · <span className="font-800">{preview.accepted} new</span> · {preview.duplicatesExisting} already imported · {preview.duplicatesInFile} repeated in the file · {preview.rejected} rejected · {preview.newQueries} new queries{preview.truncated ? " · file truncated at the row limit" : ""}</p>
            {preview.rejectedSamples.length ? <ul className="mt-1 list-inside list-disc text-red-700">{preview.rejectedSamples.slice(0, 10).map((r) => <li key={`${r.line}-${r.reason}`}>Line {r.line}: {r.reason}</li>)}</ul> : null}
            {preview.sample.length ? <ul className="mt-1 list-inside list-disc">{preview.sample.map((s) => <li key={s.line}>{fmtDay(s.observedAt)} · {providers.surfaces[s.surface] ?? s.surface} · {s.query} · {s.citations} citations</li>)}</ul> : null}
            <p className="mt-1 text-slate-500">{preview.note}</p>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="aiv-imports">
        <h3 id="aiv-imports" className="text-sm font-800 text-slate-900">Previous imports</h3>
        {!history ? <LoadingState label="Loading imports…" /> : history.length === 0 ? <p className="mt-1 text-xs text-slate-600">None yet.</p> : (
          <ul className="mt-1 divide-y divide-slate-100 text-xs">{history.map((i) => <li key={i.id} className="py-1">{fmt(i.created_at)} · {i.source_label}{i.filename ? ` (${i.filename})` : ""} · {i.rows_accepted} imported, {i.rows_duplicate} duplicates, {i.rows_rejected} rejected of {i.rows_total}</li>)}</ul>
        )}
      </section>
    </div>
  );
}
