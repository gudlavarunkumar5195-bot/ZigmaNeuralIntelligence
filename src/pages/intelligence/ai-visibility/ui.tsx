import type { AivGroupKey, AivMetric, AivProviderStatus } from "../../../services/api";
export { btn, btnPrimary, card, input } from "../../../components/ui/styles";


export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : "—");
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "No data" : `${(v * 100).toFixed(1)}%`);

/** Comma- or newline-separated text to a trimmed list. */
export const toList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export const PROVIDER_STATUS: Record<AivProviderStatus, { label: string; style: string }> = {
  available: { label: "Available", style: "bg-emerald-50 text-emerald-800" },
  not_configured: { label: "Not configured", style: "bg-slate-100 text-slate-700" },
  requires_approval: { label: "Needs cost approval", style: "bg-amber-50 text-amber-900" },
  model_not_allowed: { label: "Model not allowed", style: "bg-amber-50 text-amber-900" },
  manual_import_only: { label: "Import only", style: "bg-sky-50 text-sky-800" },
};

export const VERIFICATION_LABEL: Record<string, string> = {
  unverified: "Not verified",
  reachable_mentions_brand: "Loaded · names the brand",
  reachable_no_mention: "Loaded · does not name the brand",
  unreachable: "Could not be loaded",
  blocked_by_robots: "Blocked by robots.txt",
  not_html: "Not an HTML page",
  unsafe_url: "Refused (unsafe address)",
  error: "Check failed",
};

export const CITATION_KIND_LABEL: Record<string, string> = {
  provider_annotation: "Provider citation",
  provider_citation_list: "Provider source list",
  inline_text_url: "URL in answer text",
  imported: "Imported citation",
};

export const OPPORTUNITY_KIND_LABEL: Record<string, string> = {
  frequently_cited_source: "Frequently cited source",
  mentioned_not_cited: "Mentioned, own site not cited",
  competitor_only_queries: "Competitor-only queries",
  insufficient_data: "Not enough data",
  unreachable_cited_source: "Cited page unreachable",
};

export function groupLabel(k: AivGroupKey, surfaces: Record<string, string>) {
  const method = k.method === "manual_import" ? "Imported" : "API";
  const surface = surfaces[k.surface] ?? k.surface;
  return k.method === "manual_import" ? `${method} · ${surface}` : `${method} · ${k.provider}${k.model ? ` · ${k.model}` : ""}`;
}

/** The group without its method, for headings that already show a MethodPill. */
export const groupSource = (k: AivGroupKey, surfaces: Record<string, string>) => groupLabel(k, surfaces).replace(/^(Imported|API) · /, "");

/** A measured rate with its numerator/denominator; "No data" when nothing was eligible. */
export function MetricValue({ m, label }: { m: AivMetric; label?: string }) {
  return (
    <span className="tabular-nums" title={label}>
      <span className="font-800">{pct(m.value)}</span>
      <span className="ml-1 text-[11px] text-slate-500">({m.numerator}/{m.denominator})</span>
      {m.smallSample && m.denominator > 0 ? <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-700 text-amber-900">small sample</span> : null}
    </span>
  );
}

export function StatusPill({ text, style }: { text: string; style: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-700 ${style}`}>{text}</span>;
}

export const MethodPill = ({ method }: { method: "provider_api" | "manual_import" }) =>
  method === "manual_import" ? <StatusPill text="Imported" style="bg-sky-50 text-sky-800" /> : <StatusPill text="API" style="bg-violet-50 text-violet-800" />;

/** Permission errors read as permission errors, not as failures. */
export const errorMessage = (e: { code: string; message: string }) =>
  e.code === "INSUFFICIENT_ROLE" || e.code === "FORBIDDEN" ? "Your role can view AI visibility data but not change it." : e.message;
