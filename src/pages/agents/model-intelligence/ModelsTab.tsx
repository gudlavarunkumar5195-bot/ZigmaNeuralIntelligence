import { useId, useState } from "react";
import { apiAiModels, type AiModel, type AiPricingClass } from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { SectionHeader } from "../../../components/ui/Card";
import { Badge, TableContainer } from "../../../components/ui/Primitives";
import { EmptyState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { input, label as labelClass, table, td, tdNum, th } from "../../../components/ui/styles";
import { ConfidencePill, errorText, fmtDate, fmtDateTime, fmtInt, humanize, PricingBadge } from "./shared";

const FILTERS: Array<{ value: "" | AiPricingClass; label: string }> = [
  { value: "", label: "All pricing classes" },
  { value: "FREE", label: "Free" },
  { value: "TRIAL", label: "Trial" },
  { value: "PAID", label: "Paid (not used)" },
  { value: "UNKNOWN", label: "Unknown (not used)" },
];

const yesNo = (v: boolean | null) => (v === null ? "Unknown" : v ? "Yes" : "No");

function Health({ m }: { m: AiModel }) {
  const h = m.health;
  if (!h) return <span className="text-slate-600">No failures recorded</span>;
  return (
    <div className="space-y-1">
      {h.coolingDown && h.cooldownUntil ? <Badge tone="warning">Cooling down until {fmtDateTime(h.cooldownUntil)}</Badge> : <Badge tone="success">Available</Badge>}
      <div className="text-[11px] text-slate-600">
        {h.consecutiveFailures} consecutive failure{h.consecutiveFailures === 1 ? "" : "s"}
        {h.lastFailureCategory ? ` · last: ${humanize(h.lastFailureCategory)}` : ""}
      </div>
    </div>
  );
}

export function ModelsTab() {
  const [cls, setCls] = useState<"" | AiPricingClass>("");
  const filterId = useId();
  const models = useApiQuery(() => apiAiModels({ pricingClass: cls || undefined, limit: 500 }), [cls]);

  return (
    <section>
      <SectionHeader
        as="h2"
        title="Model catalog"
        subtitle="Every model the catalog knows about. Only FREE models, and TRIAL models while trials are enabled, are eligible for routing."
        action={(
          <div>
            <label htmlFor={filterId} className={labelClass}>Pricing class</label>
            <select id={filterId} className={input} value={cls} onChange={(e) => setCls(e.target.value as "" | AiPricingClass)}>
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
        )}
      />
      {models.loading && !models.data ? <LoadingState label="Loading models…" /> : null}
      {models.error ? <InlineError what="the model catalog" error={{ ...models.error, message: errorText(models.error) }} onRetry={models.reload} /> : null}
      {models.data && models.data.length === 0 ? (
        <EmptyState title="No models" description={cls ? `The catalog has no ${cls} models.` : "The catalog is empty. It fills after the first catalog refresh."} />
      ) : null}
      {models.data && models.data.length > 0 ? (
        <TableContainer maxHeight={640}>
          <table className={table}>
            <caption className="sr-only">Model catalog</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Model</th>
                <th scope="col" className={th}>Pricing</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={`${th} text-right`}>Context</th>
                <th scope="col" className={`${th} text-right`}>Max output</th>
                <th scope="col" className={th}>Structured / tools</th>
                <th scope="col" className={th}>Pricing checked</th>
                <th scope="col" className={th}>Health</th>
                <th scope="col" className={th}>Evaluations</th>
                <th scope="col" className={th}>Admin</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id}>
                  <td className={td}>
                    <div className="font-600 text-slate-900">{m.display_name}</div>
                    <div className="font-mono text-[11px] text-slate-600">{m.openrouter_id}</div>
                  </td>
                  <td className={td}><PricingBadge cls={m.pricing_class} expiresAt={m.expires_at} /></td>
                  <td className={td}>
                    <div>{humanize(m.status)}</div>
                    <div className="text-[11px] text-slate-600">{humanize(m.eligibility_status)}{m.enabled ? "" : " · disabled"}</div>
                  </td>
                  <td className={tdNum}>{m.context_length === null ? "—" : fmtInt(m.context_length)}</td>
                  <td className={tdNum}>{m.max_completion_tokens === null ? "—" : fmtInt(m.max_completion_tokens)}</td>
                  <td className={td}>
                    <div>Structured: {yesNo(m.supports_structured_output)}</div>
                    <div>Tools: {yesNo(m.supports_tool_calling)}</div>
                  </td>
                  <td className={td}>
                    {m.pricing_checked_at ? (
                      <>
                        <Badge tone={m.pricingFresh ? "success" : "warning"}>{m.pricingFresh ? "Fresh" : "Stale"}</Badge>
                        <div className="mt-1 text-[11px] text-slate-600">{fmtDate(m.pricing_checked_at)}</div>
                      </>
                    ) : <Badge tone="warning">Never checked</Badge>}
                  </td>
                  <td className={td}><Health m={m} /></td>
                  <td className={td}>
                    <div className="tabular-nums">{fmtInt(m.evaluations)}</div>
                    <div className="mt-1"><ConfidencePill confidence={m.qualityConfidence} /></div>
                  </td>
                  <td className={td}>{m.excludedByAdmin ? <Badge tone="danger">Excluded by admin</Badge> : <span className="text-slate-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
    </section>
  );
}
