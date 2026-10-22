import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { KpiCard } from "./Kpi";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
  hover?: boolean;
}

export function Card({ children, className = "", padding = "md", hover = false }: CardProps) {
  const padMap = { none: "", sm: "p-3", md: "p-4", lg: "p-6" };
  return (
    <div className={`rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm ${padMap[padding]} ${hover ? "transition-colors hover:border-blue-300" : ""} ${className}`}>
      {children}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
  /** Heading level for the document outline (default h2). */
  as?: "h2" | "h3";
}

export function SectionHeader({ title, subtitle, action, className = "", as: H = "h2" }: SectionHeaderProps) {
  return (
    <div className={`mb-3 flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <H className="text-section-title">{title}</H>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  /** Short description under the title. */
  subtitle?: ReactNode;
  /** Small uppercase label above the title (module or group). */
  eyebrow?: string;
  /** Page-level actions, right-aligned on wide screens. */
  action?: ReactNode;
  badge?: ReactNode;
  /** Extra row under the description (context selectors, metadata). */
  children?: ReactNode;
}

/** The page's main heading (h1): every page uses this so titles, spacing and actions line up. */
export function PageHeader({ title, subtitle, eyebrow, action, badge, children }: PageHeaderProps) {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className="text-eyebrow">{eyebrow}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-page-title">{title}</h1>
            {badge}
          </div>
          {subtitle ? <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-500">{subtitle}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap items-end gap-2">{action}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}

/** Container for page content: consistent width and gutters. */
export function PageContainer({ children, width = "wide" }: { children: ReactNode; width?: "narrow" | "default" | "wide" }) {
  const max = width === "narrow" ? "max-w-3xl" : width === "default" ? "max-w-6xl" : "max-w-[1360px]";
  return <div className={`mx-auto w-full ${max}`}>{children}</div>;
}

interface MetricCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: { value: number; direction: "up" | "down" | "neutral" };
  icon?: ReactNode;
}

/** Compatibility wrapper around KpiCard. */
export function MetricCard({ label, value, subtext, trend }: MetricCardProps) {
  return <KpiCard label={label} value={value} period={subtext} delta={trend ? { value: trend.direction === "down" ? -Math.abs(trend.value) : trend.direction === "up" ? Math.abs(trend.value) : 0, format: "abs", better: "none" } : undefined} />;
}

interface FindingRowProps {
  id: string;
  severity: string;
  title: string;
  description: string;
  verified?: boolean;
  score?: number;
  evidence?: string;
  affectedUrls?: string[];
  onExpand?: () => void;
  expanded?: boolean;
  children?: ReactNode;
}

export function FindingRow({ severity, title, description, verified, score, evidence, affectedUrls, onExpand, expanded, children }: FindingRowProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button type="button" aria-expanded={!!expanded} onClick={onExpand} className="flex w-full items-start gap-3 p-3.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
        <StatusBadge status={severity} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-600 text-slate-900">{title}</span>
          <span className="line-clamp-2 block text-xs text-slate-500">{description}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-3">
          {verified ? <span className="text-xs font-600 text-emerald-700">Verified</span> : null}
          {score ? <span className="font-mono text-xs text-slate-500">Q:{score}</span> : null}
          <ChevronDown size={14} aria-hidden="true" className={`text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50 p-4">
          {evidence && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-600 uppercase tracking-wide text-slate-500">Evidence</div>
              <div className="rounded border border-slate-200 bg-white p-2.5 font-mono text-xs text-slate-700">{evidence}</div>
            </div>
          )}
          {affectedUrls && affectedUrls.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-600 uppercase tracking-wide text-slate-500">Affected URLs ({affectedUrls.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {affectedUrls.map((url) => <span key={url} className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-600">{url}</span>)}
              </div>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
