import { apiAiQuality } from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { SectionHeader } from "../../../components/ui/Card";
import { TableContainer } from "../../../components/ui/Primitives";
import { EmptyState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { table, td, tdNum, th } from "../../../components/ui/styles";
import { ConfidencePill, errorText, fmtDateTime, humanize } from "./shared";

/** Pass rate as text plus a bar drawn from the same row value (no derived data). */
function PassRate({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-600">—</span>;
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{value.toFixed(1)}%</span>
      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export function QualityTab() {
  const quality = useApiQuery(() => apiAiQuality(), []);
  const rows = quality.data?.data ?? [];
  const minSamples = quality.data?.minSamples;

  return (
    <section>
      <SectionHeader
        as="h2"
        title="Quality by model and task category"
        subtitle={`Scores from the last 90 days, pooled across organizations (scores only, never content); this organization's own count is shown beside them.${minSamples ? ` A combination is "measured" once it has ${minSamples} evaluations.` : ""}`}
      />
      {quality.loading && !quality.data ? <LoadingState label="Loading quality…" /> : null}
      {quality.error ? <InlineError what="quality summaries" error={{ ...quality.error, message: errorText(quality.error) }} onRetry={quality.reload} /> : null}
      {quality.data && rows.length === 0 ? (
        <EmptyState
          title="No evaluations yet"
          description={`No evaluations yet — quality rankings need at least ${minSamples ?? "a minimum number of"} evaluated results per model and task category. Until then the router relies on catalog data and benchmarks.`}
        />
      ) : null}
      {rows.length > 0 ? (
        <TableContainer maxHeight={640}>
          <table className={table}>
            <caption className="sr-only">Quality by model and task category</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Model</th>
                <th scope="col" className={th}>Task category</th>
                <th scope="col" className={`${th} text-right`}>Evaluations</th>
                <th scope="col" className={`${th} text-right`}>This org</th>
                <th scope="col" className={`${th} text-right`}>Avg score</th>
                <th scope="col" className={`${th} text-right`}>Pass rate</th>
                <th scope="col" className={`${th} text-right`}>Security violations</th>
                <th scope="col" className={`${th} text-right`}>User ratings</th>
                <th scope="col" className={th}>Confidence</th>
                <th scope="col" className={th}>Last evaluated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.model}|${r.taskType}`} className={r.confidence === "measured" ? "" : "bg-slate-50"}>
                  <td className={`${td} font-mono`}>{r.model}</td>
                  <td className={td}>{humanize(r.taskType)}</td>
                  <td className={tdNum}>{r.evaluations.toLocaleString()}</td>
                  <td className={tdNum}>{r.orgEvaluations.toLocaleString()}</td>
                  <td className={tdNum}>{r.averageScore === null ? "—" : r.averageScore.toFixed(1)}</td>
                  <td className={tdNum}><PassRate value={r.passRate} /></td>
                  <td className={`${tdNum} ${r.securityViolations > 0 ? "font-700 text-red-700" : ""}`}>{r.securityViolations.toLocaleString()}</td>
                  <td className={tdNum}>{r.userRatings.toLocaleString()}</td>
                  <td className={td}><ConfidencePill confidence={r.confidence} /></td>
                  <td className={td}>{fmtDateTime(r.lastEvaluatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
    </section>
  );
}
