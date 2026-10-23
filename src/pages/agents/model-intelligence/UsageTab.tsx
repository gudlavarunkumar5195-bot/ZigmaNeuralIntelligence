import { useId, useState } from "react";
import { apiAiUsage } from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { Card, SectionHeader } from "../../../components/ui/Card";
import { Notice, SourceLabel, TableContainer } from "../../../components/ui/Primitives";
import { EmptyState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { input, label as labelClass, table, td, tdNum, th } from "../../../components/ui/styles";
import { errorText, EstimatedTag, fmtInt, humanize, Meter, num, PricingBadge } from "./shared";

export function UsageTab() {
  const [days, setDays] = useState(7);
  const daysId = useId();
  const usage = useApiQuery(() => apiAiUsage(days), [days]);
  const u = usage.data;

  return (
    <section className="space-y-4">
      <SectionHeader
        as="h2"
        title="Usage"
        subtitle="This organization's model attempts. Estimated figures are approximations made before a call; provider figures are what OpenRouter reported afterwards."
        action={(
          <div>
            <label htmlFor={daysId} className={labelClass}>Period</label>
            <select id={daysId} className={input} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
            </select>
          </div>
        )}
      />
      {usage.loading && !u ? <LoadingState label="Loading usage…" /> : null}
      {usage.error ? <InlineError what="usage" error={{ ...usage.error, message: errorText(usage.error) }} onRetry={usage.reload} /> : null}
      {u ? (
        <>
          <Card>
            <h3 className="text-card-title">Organization tokens, last 24 hours</h3>
            <p className="mt-1 text-xl font-700 tabular-nums text-slate-900">
              {fmtInt(u.orgTokensUsed24h)} <span className="text-sm font-500 text-slate-500">/ {fmtInt(u.orgTokenLimit24h)} limit</span>
            </p>
            <div className="mt-2"><Meter label="Organization tokens used in the last 24 hours" value={num(u.orgTokensUsed24h)} max={num(u.orgTokenLimit24h)} text={`${Math.max(0, num(u.orgTokenLimit24h) - num(u.orgTokensUsed24h)).toLocaleString()} tokens left in the rolling 24-hour window`} /></div>
          </Card>
          <Notice tone="info">{u.note}</Notice>
          {u.byModel.length === 0 ? (
            <EmptyState title="No model attempts" description={`No model calls were made for this organization in the last ${u.days} days.`} />
          ) : (
            <TableContainer>
              <table className={table}>
                <caption className="sr-only">Usage by model, last {u.days} days</caption>
                <thead>
                  <tr>
                    <th scope="col" className={th}>Model</th>
                    <th scope="col" className={th}>Pricing</th>
                    <th scope="col" className={`${th} text-right`}>Attempts</th>
                    <th scope="col" className={`${th} text-right`}>Completed</th>
                    <th scope="col" className={`${th} text-right`}>Failed</th>
                    <th scope="col" className={`${th} text-right`}>Input (estimated)</th>
                    <th scope="col" className={`${th} text-right`}>Input (provider)</th>
                    <th scope="col" className={`${th} text-right`}>Output (provider)</th>
                    <th scope="col" className={`${th} text-right`}>Estimate-only attempts</th>
                    <th scope="col" className={`${th} text-right`}>Reported cost (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {u.byModel.map((r, i) => (
                    <tr key={r.model ?? `unknown-${i}`}>
                      <td className={`${td} font-mono`}>{r.model ?? "—"}</td>
                      <td className={td}>{r.pricing_class ? <PricingBadge cls={r.pricing_class} /> : "—"}</td>
                      <td className={tdNum}>{fmtInt(r.attempts)}</td>
                      <td className={tdNum}>{fmtInt(r.completed)}</td>
                      <td className={tdNum}>{fmtInt(r.failed)}</td>
                      <td className={tdNum}>{fmtInt(r.estimated_input)}<EstimatedTag /></td>
                      <td className={tdNum}>{fmtInt(r.provider_input)}</td>
                      <td className={tdNum}>{fmtInt(r.provider_output)}</td>
                      <td className={tdNum}>{fmtInt(r.estimated_only)}</td>
                      <td className={tdNum}>${num(r.reported_cost_usd).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
          {u.reservations.length > 0 ? (
            <div>
              <h3 className="text-card-title">Token reservations</h3>
              <p className="text-[11px] text-slate-600">Budget held before each call and settled afterwards. <SourceLabel>usage source</SourceLabel> says whether the settled amount came from the provider or an estimate.</p>
              <div className="mt-2"><TableContainer>
                <table className={table}>
                  <caption className="sr-only">Token reservations, last {u.days} days</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={th}>Status</th>
                      <th scope="col" className={th}>Usage source</th>
                      <th scope="col" className={`${th} text-right`}>Reservations</th>
                      <th scope="col" className={`${th} text-right`}>Reserved tokens</th>
                      <th scope="col" className={`${th} text-right`}>Settled tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.reservations.map((r, i) => (
                      <tr key={`${r.status}-${r.usage_source}-${i}`}>
                        <td className={td}>{humanize(r.status)}</td>
                        <td className={td}>{humanize(r.usage_source)}</td>
                        <td className={tdNum}>{fmtInt(r.n)}</td>
                        <td className={tdNum}>{fmtInt(r.reserved)}</td>
                        <td className={tdNum}>{fmtInt(r.settled)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableContainer></div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
