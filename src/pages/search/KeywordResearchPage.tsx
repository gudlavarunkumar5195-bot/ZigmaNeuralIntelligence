import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiListResearchRuns, apiResearchCapabilities, apiRunResearch, IntegrationRequired, type ResearchCapabilities, type ResearchKind, type ResearchRun } from "../../services/api";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { errorText, ProviderNotice, useWebsites } from "./research/shared";
import { RunView } from "./research/RunView";
import { PageHeader } from "../../components/ui/Card";

const MODES: Array<{ kind: Exclude<ResearchKind, "gap">; label: string; capability: string; input: "none" | "seed" | "keyword" | "keywords"; help: string }> = [
  { kind: "organic", label: "Your keywords", capability: "organic_keywords", input: "none", help: "Keywords your website already gets search impressions for." },
  { kind: "ideas", label: "Keyword ideas", capability: "keyword_ideas", input: "seed", help: "Keywords containing every word of the seed." },
  { kind: "related", label: "Related keywords", capability: "related_keywords", input: "keyword", help: "Keywords sharing at least one word with the keyword." },
  { kind: "overview", label: "Keyword overview", capability: "keyword_overview", input: "keywords", help: "Metrics for specific keywords (one per line, up to 100)." },
];

/** Keyword research: real data from the enabled provider, with provenance and explicit gaps. */
export function KeywordResearchPage() {
  const { websites, websiteId, setWebsiteId, error: siteError } = useWebsites();
  const [caps, setCaps] = useState<ResearchCapabilities | null>(null);
  const [capsError, setCapsError] = useState<Error | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number]>(MODES[0]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [active, setActive] = useState<{ id: string; reused: string | null } | null>(null);
  const [history, setHistory] = useState<ResearchRun[] | null>(null);

  const loadCaps = () => {
    setCapsError(null);
    apiResearchCapabilities()
      .then((r) => {
        if (r.error) throw new Error(r.error.message);
        setCaps(r.data);
      })
      .catch((e: Error) => setCapsError(e));
  };
  useEffect(loadCaps, []);
  const loadHistory = async () => {
    if (!websiteId) return;
    const r = await apiListResearchRuns({ websiteId, limit: 10 });
    setHistory((r.data ?? []).filter((x) => x.kind !== "gap"));
  };
  useEffect(() => {
    setActive(null);
    void loadHistory();
  }, [websiteId]);

  const provider = caps?.providers.find((p) => p.capabilities.includes(mode.capability)) ?? caps?.providers[0] ?? null;
  const supported = !!caps?.providers.some((p) => p.capabilities.includes(mode.capability));

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setRunError(null);
    const value = text.trim();
    const body: Record<string, unknown> = { websiteId };
    if (mode.input === "seed") body.seed = value;
    if (mode.input === "keyword") body.keyword = value;
    if (mode.input === "keywords") body.keywords = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (mode.input !== "none" && !value) return setRunError("Enter a keyword first.");
    setRunning(true);
    try {
      const r = await apiRunResearch(mode.kind, body);
      if (r.error || !r.data) {
        setRunError(errorText(r.error ?? { code: "", message: "The research could not run." }));
        if (r.error?.runId) setActive({ id: r.error.runId, reused: null });
        return;
      }
      setActive({ id: r.data.run.id, reused: r.meta?.reused ?? null });
      void loadHistory();
    } finally {
      setRunning(false);
    }
  };

  if (capsError instanceof IntegrationRequired) return <IntegrationRequiredState feature="Keyword research" />;
  if (capsError) return <ErrorState title="Unable to load keyword research" message={capsError.message} onRetry={loadCaps} />;
  if (siteError) return <ErrorState title="Unable to load websites" message={siteError} />;
  if (!caps || !websites) return <LoadingState label="Loading keyword research…" />;
  if (websites.length === 0) return <EmptyState title="No websites yet" description="Add and verify a website to research its keywords." />;

  return (
    <div>
      <PageHeader eyebrow="SEO Research" title="Keywords" subtitle="Keyword research from the enabled data source, with provenance. Metrics a source does not provide are shown as unavailable, never as zero." />
      {caps.providers.length === 0 ? (
        <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">No keyword data source is enabled on this server.</p>
      ) : provider ? (
        <div className="mt-4"><ProviderNotice provider={provider} /></div>
      ) : null}

      <form onSubmit={run} aria-label="Run keyword research" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">
            Website
            <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm">
              {websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}
            </select>
          </label>
          <div role="group" aria-label="Research type" className="flex flex-wrap gap-1">
            {MODES.map((m) => (
              <button key={m.kind} type="button" aria-pressed={mode.kind === m.kind} onClick={() => { setMode(m); setText(""); setRunError(null); }} className={`rounded-full border px-3 py-1 text-xs font-600 ${mode.kind === m.kind ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-600">{mode.help}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {mode.input === "keywords" ? (
            <label className="text-xs text-slate-700">Keywords<textarea value={text} rows={4} maxLength={20_000} onChange={(e) => setText(e.target.value)} className="mt-1 block w-72 rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          ) : mode.input !== "none" ? (
            <label className="text-xs text-slate-700">{mode.input === "seed" ? "Seed keyword" : "Keyword"}<input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          ) : null}
          <fieldset className="flex flex-wrap gap-3" disabled title={provider?.targeting.note}>
            <legend className="sr-only">Targeting</legend>
            <label className="text-xs text-slate-400">Country<select className="mt-1 block rounded border border-slate-200 px-2 py-1 text-xs"><option>All (not selectable)</option></select></label>
            <label className="text-xs text-slate-400">Language<select className="mt-1 block rounded border border-slate-200 px-2 py-1 text-xs"><option>All (not selectable)</option></select></label>
            <label className="text-xs text-slate-400">Device<select className="mt-1 block rounded border border-slate-200 px-2 py-1 text-xs"><option>All (not selectable)</option></select></label>
          </fieldset>
          <button type="submit" disabled={running || !supported || !websiteId} className="rounded-lg bg-blue-600 shadow-sm hover:bg-blue-700 px-3 py-2 text-sm font-700 text-white disabled:opacity-50">{running ? "Running…" : "Run"}</button>
        </div>
        {provider?.targeting.note ? <p className="mt-2 text-[11px] text-slate-500">Targeting: {provider.targeting.note}</p> : null}
        {!supported ? <p role="status" className="mt-2 text-xs text-amber-800">{mode.label} is not supported by the enabled data source.</p> : null}
        {runError ? (
          <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-800">
            {runError} {/Search Console/.test(runError) ? <Link to="/settings/integrations" className="font-700 underline">Open Integrations</Link> : null}
          </p>
        ) : null}
      </form>

      {active ? <RunView key={active.id} runId={active.id} provider={provider} reused={active.reused} /> : null}

      <section aria-labelledby="history-heading" className="mt-6">
        <h3 id="history-heading" className="text-sm font-700 text-slate-900">Recent research for this website</h3>
        {!history ? (
          <LoadingState label="Loading history…" />
        ) : history.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">No research has been run for this website yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => setActive({ id: h.id, reused: null })} className={`text-left hover:underline ${active?.id === h.id ? "font-700" : ""}`}>
                  {new Date(h.created_at).toLocaleString()} · {h.kind} · {h.status} · {h.result_count} keyword(s)
                  {typeof h.params.seed === "string" ? ` · "${h.params.seed}"` : typeof h.params.keyword === "string" ? ` · "${h.params.keyword}"` : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
