import { useEffect, useState } from "react";
import {
  apiListWebsites,
  type ResearchMetric,
  type ResearchProviderInfo,
  type ResearchResult,
  type ResearchRun,
  type WebsiteRecord,
} from "../../../services/api";
import { useSelectedWebsiteId } from "../../../lib/selectedWebsite";

export const METRIC_LABEL: Record<ResearchMetric, string> = {
  search_volume: "Search volume",
  keyword_difficulty: "Difficulty",
  cpc: "CPC",
  competition: "Competition",
  clicks: "Clicks",
  impressions: "Impressions",
  ctr: "CTR",
  position: "Avg. position",
};
export const MARKET_METRICS: ResearchMetric[] = ["search_volume", "keyword_difficulty", "cpc", "competition"];
export const CAPABILITY_LABEL: Record<string, string> = {
  keyword_overview: "Keyword overview",
  keyword_ideas: "Keyword ideas",
  related_keywords: "Related keywords",
  organic_keywords: "Organic keywords",
  competitor_domains: "Competitor discovery",
  keyword_gap: "Keyword gap",
  serp_results: "SERP results",
};
export const ERROR_TEXT: Record<string, string> = {
  CAPABILITY_UNSUPPORTED: "This analysis is not supported by the enabled data source.",
  TARGETING_UNSUPPORTED: "The data source cannot filter by country, language or device.",
  DATA_SOURCE_UNAVAILABLE: "",
  COMPETITOR_DATA_UNAVAILABLE: "",
  QUOTA_EXCEEDED: "",
  PROVIDER_NOT_CONFIGURED: "",
  PROVIDER_RATE_LIMITED: "",
  PROVIDER_UNAVAILABLE: "",
  INSUFFICIENT_ROLE: "Your role can view research but not run it.",
  FORBIDDEN: "Your role can view research but not run it.",
};
export const errorText = (e: { code: string; message: string }) => ERROR_TEXT[e.code] || e.message;

export function formatMetric(metric: ResearchMetric, value: number | undefined): string {
  if (value === undefined) return "—";
  if (metric === "ctr") return `${(value * 100).toFixed(1)}%`;
  if (metric === "position") return value.toFixed(1);
  if (metric === "cpc") return value.toFixed(2);
  return Math.round(value).toLocaleString();
}

/** The websites of the organization, defaulting to the globally selected one. */
export function useWebsites() {
  const selected = useSelectedWebsiteId();
  const [websites, setWebsites] = useState<WebsiteRecord[] | null>(null);
  const [websiteId, setWebsiteId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiListWebsites({ pageSize: 100 })
      .then((r) => {
        if (r.error) throw new Error(r.error.message);
        const list = r.data ?? [];
        setWebsites(list);
        setWebsiteId((current) => current || (list.find((w) => w.id === selected)?.id ?? list[0]?.id ?? ""));
      })
      .catch((e: Error) => setError(e.message));
  }, [selected]);
  return { websites, websiteId, setWebsiteId, error };
}

/** What the data source is, what it can and cannot supply, and its cost. */
export function ProviderNotice({ provider }: { provider: ResearchProviderInfo }) {
  const missing = MARKET_METRICS.filter((m) => !provider.metrics.includes(m));
  return (
    <section aria-label="Data source" className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-700">
      <p className="text-sm font-700 text-slate-900">
        Data source: {provider.name} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-700 uppercase">{provider.kind === "first_party" ? "your own data" : "licensed"}</span>
      </p>
      <p className="mt-1">{provider.metricScope}</p>
      {missing.length ? <p className="mt-1">Not available from this source: {missing.map((m) => METRIC_LABEL[m]).join(", ")}. These need a licensed keyword data provider.</p> : null}
      {provider.unsupported.length ? <p className="mt-1">Not supported: {provider.unsupported.map((c) => CAPABILITY_LABEL[c] ?? c).join(", ")}.</p> : null}
      <p className="mt-1 text-slate-500">{provider.attribution} {provider.costNote}</p>
    </section>
  );
}

/** Provenance of one run: source, period, sample, cache, notes. */
export function RunProvenance({ run, reused }: { run: ResearchRun; reused?: string | null }) {
  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <p>
        <strong>{run.status === "partial" ? "Partial result" : run.status === "failed" ? "Failed" : "Result"}</strong> from {run.provider.replace(/_/g, " ")}
        {run.observed_through ? `, data through ${run.observed_through}` : ""} · retrieved {new Date(run.created_at).toLocaleString()}
        {reused === "cache" ? " (reused: an identical request was answered recently)" : reused === "in_progress" ? " (an identical request is still running)" : ""}
      </p>
      {run.sample ? <p className="mt-1">This is a sample of the source's data, not a complete keyword database.</p> : null}
      {run.notes.length ? <ul className="mt-1 list-disc pl-4">{run.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
      {run.error ? <p role="alert" className="mt-1 text-red-700">{run.error}</p> : null}
    </div>
  );
}

const INTENT_STYLE: Record<string, string> = {
  informational: "bg-sky-50 text-sky-800",
  navigational: "bg-violet-50 text-violet-800",
  commercial: "bg-amber-50 text-amber-800",
  transactional: "bg-emerald-50 text-emerald-800",
};

export type SortState = { sort: string; order: "asc" | "desc" };

/** Results table: provider metrics only, server-side sorting, optional selection and gap columns. */
export function ResultsTable({
  rows,
  metrics,
  sort,
  onSort,
  selected,
  onToggle,
  caption,
  gap,
}: {
  rows: ResearchResult[];
  metrics: ResearchMetric[];
  sort: SortState;
  onSort: (s: SortState) => void;
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  caption: string;
  gap?: boolean;
}) {
  const header = (key: string, label: string) => (
    <th key={key} scope="col" aria-sort={sort.sort === key ? (sort.order === "desc" ? "descending" : "ascending") : "none"} className="py-2 pr-3">
      <button
        type="button"
        onClick={() => onSort({ sort: key, order: sort.sort === key ? (sort.order === "desc" ? "asc" : "desc") : key === "position" || key === "keyword" ? "asc" : "desc" })}
        className="font-600 hover:underline"
      >
        {label}{sort.sort === key ? (sort.order === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-slate-500">
          <tr>
            {onToggle ? <th scope="col" className="w-8 py-2"><span className="sr-only">Select</span></th> : null}
            {header("keyword", "Keyword")}
            {metrics.map((m) => header(m, METRIC_LABEL[m]))}
            <th scope="col" className="py-2 pr-3">Intent <span className="font-400 text-slate-400">(rule-based)</span></th>
            {gap ? <th scope="col" className="py-2 pr-3">Gap</th> : null}
            {gap ? <th scope="col" className="py-2 pr-3">Competitors</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.keyword_key} className="border-t border-slate-100 align-top">
              {onToggle ? (
                <td className="py-2">
                  <input type="checkbox" aria-label={`Select ${r.keyword}`} checked={selected?.has(r.keyword_key) ?? false} onChange={() => onToggle(r.keyword_key)} />
                </td>
              ) : null}
              <td className="break-all py-2 pr-3 font-600 text-slate-900">{r.keyword}</td>
              {metrics.map((m) => (
                <td key={m} className="py-2 pr-3 tabular-nums" title={r.metrics[m] === undefined ? "Not returned by the data source" : undefined}>
                  {formatMetric(m, r.metrics[m])}
                </td>
              ))}
              <td className="py-2 pr-3">
                {r.intent ? <span title={`Rule: ${r.intent_rule ?? ""}`} className={`rounded-full px-2 py-0.5 text-[10px] font-700 ${INTENT_STYLE[r.intent]}`}>{r.intent}</span> : <span className="text-slate-400">unclassified</span>}
              </td>
              {gap ? (
                <td className="py-2 pr-3">
                  {r.gap_category}
                  {r.absence_from_sample ? <span className="block text-[10px] text-slate-500">not observed in a sample</span> : null}
                </td>
              ) : null}
              {gap ? <td className="py-2 pr-3">{r.competitors_present ?? "—"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
