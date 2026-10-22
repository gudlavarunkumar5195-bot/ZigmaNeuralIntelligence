import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../../components/ui/DataState";
import { apiAivBrands, apiAivProviders, IntegrationRequired, type AivBrand, type AivProviders } from "../../../services/api";
import { CitationsTab, CompetitorsTab, ObservationsTab, OverviewTab, RecommendationsTab } from "./insights";
import { BrandForm, BrandTab, ImportTab, QueriesTab } from "./setup";
import { btn, input } from "./ui";

export const AIV_TABS = [
  { id: "overview", label: "Overview" },
  { id: "brand", label: "Brand & competitors" },
  { id: "queries", label: "Queries & runs" },
  { id: "observations", label: "Observations" },
  { id: "citations", label: "Citations" },
  { id: "competitors", label: "Competitor comparison" },
  { id: "recommendations", label: "Recommendations" },
  { id: "import", label: "Import" },
] as const;
export type AivTab = (typeof AIV_TABS)[number]["id"];

/**
 * AI search visibility: how monitored brands appear in AI answers, from
 * provider collection runs or imported observations. Every number comes from
 * stored observations and is shown with its sample.
 */
export function AIVisibilityPage() {
  const { tab: rawTab } = useParams();
  const tab: AivTab = (AIV_TABS.find((t) => t.id === rawTab)?.id ?? "overview") as AivTab;
  const [brands, setBrands] = useState<AivBrand[] | null>(null);
  const [providers, setProviders] = useState<AivProviders | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [brandId, setBrandId] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, p] = await Promise.all([apiAivBrands(), apiAivProviders()]);
      if (b.error) throw new Error(b.error.message);
      if (p.error) throw new Error(p.error.message);
      setBrands(b.data ?? []);
      setProviders(p.data);
      setBrandId((cur) => (b.data ?? []).find((x) => x.id === cur)?.id ?? b.data?.[0]?.id ?? "");
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="AI visibility" />;
  if (error) return <ErrorState title="Unable to load AI visibility" message={error.message} onRetry={load} />;
  if (!brands || !providers) return <LoadingState label="Loading AI visibility…" />;
  const brand = brands.find((b) => b.id === brandId) ?? null;
  const apiAvailable = providers.providers.some((p) => p.collection === "provider_api" && p.status === "available");

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Intelligence</p>
        <h2 className="mt-2 text-2xl font-800 text-slate-950">AI visibility</h2>
      </div>
      {brands.length && !creating ? (
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-700">Brand
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={input}>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}{b.status !== "active" ? ` (${b.status})` : ""}</option>)}</select>
          </label>
          <button type="button" className={btn} onClick={() => setCreating(true)}>Add brand</button>
        </div>
      ) : null}
    </div>
  );

  if (!brands.length || creating || !brand) {
    return (
      <div className="mx-auto max-w-3xl p-6 md:p-10">
        {header}
        <section aria-labelledby="aiv-setup" className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
          <h3 id="aiv-setup" className="text-sm font-800 text-slate-900">{brands.length ? "Add a brand to monitor" : "Start monitoring a brand"}</h3>
          <p className="mt-1 text-xs text-slate-600">
            Configure the brand, its official domains and the names AI answers might use. Then add the questions you want to check and collect answers
            {apiAvailable ? " with a configured provider, or" : ""} by importing answers you observed in ChatGPT, Google AI Overviews, Perplexity and others.
            Results only describe the questions you monitor; they are not a measure of all AI search traffic.
          </p>
          <BrandForm
            submitLabel="Create brand"
            onCancel={brands.length ? () => setCreating(false) : undefined}
            onSaved={(b) => { setCreating(false); setBrandId(b.id); void load(); }}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      {header}
      {!apiAvailable ? (
        <p role="note" className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          No answer provider is available for automatic collection ({providers.providers.filter((p) => p.collection === "provider_api").map((p) => `${p.name}: ${p.detail}`).join(" ")}).
          You can still <Link className="underline" to="/intelligence/ai-visibility/import">import answers you observed</Link> and review existing data.
        </p>
      ) : null}
      <nav aria-label="AI visibility sections" className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {AIV_TABS.map((t) => (
          <NavLink key={t.id} to={t.id === "overview" ? "/intelligence/ai-visibility" : `/intelligence/ai-visibility/${t.id}`} end aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-xs font-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${tab === t.id ? "border-blue-600 text-blue-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-4" key={brand.id}>
        {tab === "overview" && <OverviewTab brand={brand} providers={providers} />}
        {tab === "brand" && <BrandTab brand={brand} providers={providers} onChanged={load} />}
        {tab === "queries" && <QueriesTab brand={brand} providers={providers} />}
        {tab === "observations" && <ObservationsTab brand={brand} providers={providers} />}
        {tab === "citations" && <CitationsTab brand={brand} />}
        {tab === "competitors" && <CompetitorsTab brand={brand} providers={providers} />}
        {tab === "recommendations" && <RecommendationsTab brand={brand} />}
        {tab === "import" && <ImportTab brand={brand} providers={providers} />}
      </div>
    </div>
  );
}
