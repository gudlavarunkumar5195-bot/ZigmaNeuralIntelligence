import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { InfoTip } from "./Tooltip";

export interface DeltaProps {
  /** Change as a fraction for "pct", absolute otherwise; null means no comparison. */
  value: number | null | undefined;
  format?: "pct" | "abs" | "pts";
  /** Which direction is an improvement (position: lower is better). */
  better?: "up" | "down" | "none";
  digits?: number;
}

/** Change indicator with arrow, sign and words, so it never relies on colour alone. */
export function Delta({ value, format = "pct", better = "up", digits = 1 }: DeltaProps) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="text-meta">No comparison</span>;
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const good = better === "none" || dir === "flat" ? null : (dir === better);
  const text = format === "pct" ? `${Math.abs(value * 100).toFixed(digits)}%` : format === "pts" ? `${Math.abs(value * 100).toFixed(2)} pts` : Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: digits });
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const tone = good === null ? "text-slate-600" : good ? "text-emerald-700" : "text-red-700";
  const words = dir === "flat" ? "no change" : `${dir === "up" ? "up" : "down"} ${text}${good === null ? "" : good ? ", better" : ", worse"}`;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-600 ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      <span aria-hidden="true">{dir === "flat" ? "0" : `${dir === "up" ? "+" : "−"}${text}`}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}

/**
 * Inline trend line. Null values break the line (missing data is never drawn
 * as zero). Decorative: the KPI states the value and change in text.
 */
export function Sparkline({ values, height = 28, label }: { values: Array<number | null>; height?: number; label?: string }) {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length < 2) return null;
  const w = 100;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const segments: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${(i * step).toFixed(2)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(2)}`);
  });
  if (cur.length > 1) segments.push(cur.join(" "));
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-7 w-full" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {segments.map((s) => <polyline key={s} points={s} fill="none" stroke="var(--zn-chart-1)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />)}
    </svg>
  );
}

/** Compact KPI: name, value, comparison, optional trend, period and source. */
export function KpiCard({ label, value, delta, sparkline, period, source, info, footer }: { label: string; value: ReactNode; delta?: DeltaProps; sparkline?: Array<number | null>; period?: string; source?: string; info?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-1.5">
        <p className="truncate text-card-title">{label}</p>
        {info ? <InfoTip label={label}>{info}</InfoTip> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-kpi">{value}</span>
        {delta ? <Delta {...delta} /> : null}
      </div>
      {sparkline ? <div className="mt-2"><Sparkline values={sparkline} /></div> : null}
      {footer ? <div className="mt-1.5 text-xs leading-5 text-slate-500">{footer}</div> : null}
      {period || source ? <p className="mt-auto pt-2 text-meta">{[period, source].filter(Boolean).join(" · ")}</p> : null}
    </div>
  );
}
