import { useId, type ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { AlertTriangle, CheckCircle2, Clock, Info, XCircle } from "lucide-react";
import { pill, type Tone } from "./styles";

// ─── Badges ──────────────────────────────────────────────────────────────────

const TONE_ICON: Partial<Record<Tone, typeof Info>> = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info };

/** Tone badge with text (and an icon for status tones), never colour alone. */
export function Badge({ tone = "neutral", icon = false, children }: { tone?: Tone; icon?: boolean; children: ReactNode }) {
  const Icon = icon ? TONE_ICON[tone] : undefined;
  return <span className={pill(tone)}>{Icon ? <Icon size={11} aria-hidden="true" /> : null}{children}</span>;
}

/** "Updated …" with a stale marker in words. */
export function Freshness({ at, stale = false, never = "Never updated" }: { at: string | null | undefined; stale?: boolean; never?: string }) {
  if (!at) return <span className="text-meta">{never}</span>;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${stale ? "font-600 text-amber-800" : "text-slate-500"}`}>
      <Clock size={11} aria-hidden="true" />Updated {new Date(at).toLocaleString()}{stale ? " · stale" : ""}
    </span>
  );
}

/** Where a number comes from, e.g. "Google Search Console" or "Imported (CSV)". */
export function SourceLabel({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-600">{children}</span>;
}

// ─── Notices ─────────────────────────────────────────────────────────────────

const NOTICE: Record<"info" | "warning" | "danger" | "success", { box: string; Icon: typeof Info }> = {
  info: { box: "border-blue-200 bg-blue-50 text-slate-800", Icon: Info },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-950", Icon: AlertTriangle },
  danger: { box: "border-red-200 bg-red-50 text-red-950", Icon: XCircle },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-950", Icon: CheckCircle2 },
};

/** Inline notice for partial data, setup guidance or limitations. */
export function Notice({ tone = "info", title, children, action }: { tone?: keyof typeof NOTICE; title?: string; children?: ReactNode; action?: ReactNode }) {
  const { box, Icon } = NOTICE[tone];
  return (
    <div role="note" className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs ${box}`}>
      <Icon size={15} className="mt-px flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-700">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
      </div>
      {action ? <div className="flex-shrink-0">{action}</div> : null}
    </div>
  );
}

// ─── Forms ───────────────────────────────────────────────────────────────────

export interface FieldControlProps { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }

/** Label, control, hint and error wired together for assistive technology. */
export function Field({ label, hint, error, required, children, className = "" }: { label: string; hint?: ReactNode; error?: string | null; required?: boolean; children: (props: FieldControlProps) => ReactNode; className?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="text-xs font-600 text-slate-700">{label}{required ? <span aria-hidden="true" className="text-red-600"> *</span> : null}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? <p id={hintId} className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
      {error ? <p id={errId} role="alert" className="mt-1 text-[11px] font-600 text-red-700">{error}</p> : null}
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

/** Section tabs as links. Pass `current` when the active tab comes from a route param; otherwise the URL decides. */
export function RouteTabs({ label, tabs, current }: { label: string; tabs: ReadonlyArray<{ id: string; label: string; to: string }>; current?: string }) {
  const cls = (on: boolean) => `-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"}`;
  return (
    <nav aria-label={label} className="-mx-1 overflow-x-auto scroll-area">
      <div className="flex min-w-max gap-1 border-b border-slate-200 px-1">
        {tabs.map((t) => current === undefined ? (
          <NavLink key={t.id} to={t.to} className={({ isActive }) => cls(isActive)}>{t.label}</NavLink>
        ) : (
          <Link key={t.id} to={t.to} aria-current={current === t.id ? "page" : undefined} className={cls(current === t.id)}>
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

// ─── Tables and charts ───────────────────────────────────────────────────────

/** Horizontal scrolling container with a caption for tables; header cells use `th` from styles. */
export function TableContainer({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  return (
    <div className="overflow-auto rounded-lg border border-slate-200 bg-white scroll-area" style={maxHeight ? { maxHeight } : undefined}>
      {children}
    </div>
  );
}

/** Chart frame with a title, an accessible text summary, and explicit empty/loading states. */
export function ChartFrame({ title, description, summary, legend, loading, empty, emptyText = "No data for this period.", height = 220, children }: { title: string; description?: string; summary: string; legend?: ReactNode; loading?: boolean; empty?: boolean; emptyText?: string; height?: number; children: ReactNode }) {
  return (
    <figure className="m-0 min-w-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-card-title">{title}</span>
        {legend ? <span className="flex flex-wrap gap-3 text-[11px] text-slate-600">{legend}</span> : null}
      </figcaption>
      {description ? <p className="text-meta">{description}</p> : null}
      <div className="mt-2" style={{ height }}>
        {loading ? <div className="zn-skeleton h-full w-full" aria-hidden="true" /> : empty ? <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-500">{emptyText}</div> : <div role="img" aria-label={`${title}. ${summary}`} className="h-full">{children}</div>}
      </div>
    </figure>
  );
}

/** A colour swatch plus a text label for chart legends. */
export function LegendItem({ color, children, dashed = false }: { color: string; children: ReactNode; dashed?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`inline-block h-0.5 w-4 ${dashed ? "border-t-2 border-dashed" : ""}`} style={dashed ? { borderColor: color } : { background: color }} />{children}</span>;
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden="true" className={`zn-skeleton ${className}`} />;
}
