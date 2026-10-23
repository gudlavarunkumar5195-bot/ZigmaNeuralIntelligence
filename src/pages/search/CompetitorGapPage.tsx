import { useEffect, useState } from "react";
import { apiListResearchRuns, apiResearchCapabilities, apiRunResearch, IntegrationRequired, type ResearchCapabilities, type ResearchRun } from "../../services/api";
import { EmptyState, ErrorState, InlineError, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { errorText, ProviderNotice, useWebsites } from "./research/shared";
import { RunView } from "./research/RunView";
import { PageHeader } from "../../components/ui/Card";

/** Competitor keyword gap: shared, missing and unique keywords from real, permitted datasets. */
export function CompetitorGapPage() {
  const { websites, websiteId, setWebsiteId, error: siteError } = useWebsites();
  const [caps, setCaps] = useState<ResearchCapabilities | null>(null);
  const [capsError, setCapsError] = useState<Error | null>(null);
  const [competitors, setCompetitors] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [active, setActive] = useState<{ id: string; reused: string | null } | null>(null);
  const [history, setHistory] = useState<ResearchRun[] | null>(null);
  const [historyError, setHistoryError] = useState<{ message: string; status?: number } | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

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
  useEffect(() => {
    setActive(null);
    if (!websiteId) return;
    let live = true;
    setHistory(null);
    setHistoryError(null);
    apiListResearchRuns({ websiteId, kind: "gap", limit: 10 })
      .then((r) => { if (!live) return; if (r.error) setHistoryError(r.error); else setHistory(r.data ?? []); })
      .catch((e: Error) => { if (live) setHistoryError({ message: e.message }); });
    return () => { live = false; };
  }, [websiteId, historyTick]);

  const provider = caps?.providers.find((p) => p.capabilities.includes("keyword_gap")) ?? null;
  const discovery = !!caps?.providers.some((p) => p.capabilities.includes("competitor_domains"));
  const others = (websites ?? []).filter((w) => w.id !== websiteId);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setRunError(null);
    const list = competitors.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return setRunError("Enter at least one competitor domain.");
    if (list.length > (caps?.limits.maxCompetitors ?? 5)) return setRunError(`At most ${caps?.limits.maxCompetitors ?? 5} competitors at a time.`);
    setRunning(true);
    try {
      const r = await apiRunResearch("gap", { websiteId, competitors: list });
      if (r.error || !r.data) {
        setRunError(errorText(r.error ?? { code: "", message: "The gap analysis could not run." }));
        return;
      }
      setActive({ id: r.data.run.id, reused: r.meta?.reused ?? null });
      setHistory((h) => [r.data!.run, ...(h ?? []).filter((x) => x.id !== r.data!.run.id)]);
    } finally {
      setRunning(false);
    }
  };

  if (capsError instanceof IntegrationRequired) return <IntegrationRequiredState feature="Competitor analysis" />;
  if (capsError) return <ErrorState title="Unable to load competitor analysis" message={capsError.message} onRetry={loadCaps} />;
  if (siteError) return <ErrorState title="Unable to load websites" message={siteError} />;
  if (!caps || !websites) return <LoadingState label="Loading competitor analysis…" />;
  if (websites.length === 0) return <EmptyState title="No websites yet" description="Add and verify a website first." />;

  return (
    <div>
      <PageHeader eyebrow="SEO Research" title="Keyword gap" subtitle="Shared, missing and unique keywords against competitors, from real and permitted datasets." />
      {!provider ? (
        <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Keyword gap analysis is not supported by the enabled data source.</p>
      ) : (
        <div className="mt-4"><ProviderNotice provider={provider} /></div>
      )}
      {!discovery ? <p className="mt-2 text-xs text-slate-600">Automatic competitor discovery needs a licensed keyword data provider; enter competitor domains yourself.</p> : null}
      {provider?.kind === "first_party" ? (
        <p className="mt-1 text-xs text-slate-600">
          With Search Console data, a competitor must be another website of your organization with a linked Search Console property
          {others.length ? ` (for example ${others.slice(0, 3).map((w) => w.domain).join(", ")})` : ""}. Any other domain needs a licensed provider.
        </p>
      ) : null}

      <form onSubmit={run} aria-label="Run keyword gap analysis" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-700">
            Your website
            <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm">
              {websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-700">
            Competitor domains (up to {caps.limits.maxCompetitors}, comma or line separated)
            <textarea value={competitors} rows={2} maxLength={2_000} onChange={(e) => setCompetitors(e.target.value)} className="mt-1 block w-80 rounded border border-slate-300 px-2 py-1 text-sm" />
          </label>
          <button type="submit" disabled={running || !provider} className="rounded-lg bg-blue-600 shadow-sm hover:bg-blue-700 px-3 py-2 text-sm font-700 text-white disabled:opacity-50">{running ? "Comparing…" : "Compare"}</button>
        </div>
        {runError ? <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-800">{runError}</p> : null}
      </form>

      <dl className="mt-4 grid gap-2 text-xs text-slate-700 md:grid-cols-3">
        <div><dt className="font-700">Shared</dt><dd>Observed for you and at least one competitor.</dd></div>
        <div><dt className="font-700">Missing</dt><dd>Observed for a competitor, not for you: a possible opportunity.</dd></div>
        <div><dt className="font-700">Unique</dt><dd>Observed for you, for no competitor.</dd></div>
      </dl>
      <p className="mt-1 text-[11px] text-slate-500">When a dataset is only a sample, "missing" and "unique" mean "not observed in the sample", not "absent".</p>

      {active ? <RunView key={active.id} runId={active.id} provider={provider} reused={active.reused} gap /> : null}

      <section aria-labelledby="gap-history" className="mt-6">
        <h3 id="gap-history" className="text-sm font-700 text-slate-900">Previous comparisons</h3>
        {historyError ? <InlineError what="previous comparisons" error={historyError} onRetry={() => setHistoryTick((t) => t + 1)} /> : !history ? <LoadingState label="Loading history…" /> : history.length === 0 ? <p className="mt-2 text-xs text-slate-600">None yet.</p> : (
          <ul className="mt-2 space-y-1 text-xs">
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => setActive({ id: h.id, reused: null })} className="text-left hover:underline">
                  {new Date(h.created_at).toLocaleString()} · {h.status} · vs {(h.params.competitors as string[] | undefined)?.join(", ") ?? "?"}
                  {h.summary.counts ? ` · ${h.summary.counts.shared} shared, ${h.summary.counts.missing} missing, ${h.summary.counts.unique} unique` : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
