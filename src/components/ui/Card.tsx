import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
  hover?: boolean;
}

export function Card({ children, className = "", padding = "md", hover = false }: CardProps) {
  const padMap = { none: "", sm: "p-4", md: "p-5", lg: "p-6" };
  return (
    <div
      className={`bg-card text-card-foreground rounded-lg border border-border shadow-[0_1px_2px_rgba(15,23,42,0.025)] ${padMap[padding]} ${hover ? "hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, subtitle, action, className = "" }: SectionHeaderProps) {
  return (
    <div className={`flex items-start justify-between gap-4 mb-5 ${className}`}>
      <div>
        <h2 className="text-base font-700 text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  badge?: ReactNode;
}

export function PageHeader({ title, subtitle, action, badge }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-700 tracking-[-0.02em] text-slate-900">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: { value: number; direction: "up" | "down" | "neutral" };
  color?: string;
  icon?: ReactNode;
}

export function MetricCard({ label, value, subtext, trend, color, icon }: MetricCardProps) {
  const trendColor = !trend ? "" : trend.direction === "up" ? "text-green-600" : trend.direction === "down" ? "text-red-500" : "text-slate-500";
  const trendArrow = !trend ? "" : trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "—";

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-500 text-slate-500 uppercase tracking-wide mb-2">{label}</div>
          <div className="text-2xl font-700 text-slate-900 leading-none mb-1" style={color ? { color } : {}}>
            {value}
          </div>
          {(subtext || trend) && (
            <div className="flex items-center gap-2">
              {trend && (
                <span className={`text-xs font-600 ${trendColor}`}>
                  {trendArrow} {Math.abs(trend.value)}
                </span>
              )}
              {subtext && <span className="text-xs text-slate-400">{subtext}</span>}
            </div>
          )}
        </div>
        {icon && (
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: color ? `${color}15` : "#eff6ff" }}>
            <span style={{ color: color || "var(--primary)" }}>{icon}</span>
          </div>
        )}
      </div>
    </Card>
  );
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
  const sevColor: Record<string, string> = { critical: "#ef4444", high: "#f97316", medium: "#f59e0b", low: "#6366f1" };
  const sevBg: Record<string, string> = { critical: "#fef2f2", high: "#fff7ed", medium: "#fffbeb", low: "#eef2ff" };
  const color = sevColor[severity] || "#64748b";
  const bg = sevBg[severity] || "#f1f5f9";

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div
        className="flex items-start gap-3 p-4 hover:bg-slate-50 transition-colors cursor-pointer"
        onClick={onExpand}
      >
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-600 flex-shrink-0 mt-0.5" style={{ color, background: bg }}>
          {severity.charAt(0).toUpperCase() + severity.slice(1)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-600 text-slate-900 mb-0.5">{title}</div>
          <div className="text-xs text-slate-500 line-clamp-2">{description}</div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {verified && (
            <span className="text-xs text-green-600 font-500 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Verified
            </span>
          )}
          {score && (
            <span className="font-mono text-xs font-600 text-slate-500">Q:{score}</span>
          )}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={`text-slate-300 transition-transform ${expanded ? "rotate-180" : ""}`}>
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50 p-4">
          {evidence && (
            <div className="mb-3">
              <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-1">Evidence</div>
              <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded p-2.5 font-mono">{evidence}</div>
            </div>
          )}
          {affectedUrls && affectedUrls.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-1">Affected URLs ({affectedUrls.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {affectedUrls.map((url) => (
                  <span key={url} className="text-xs bg-white border border-slate-200 rounded px-2 py-0.5 font-mono text-slate-600">{url}</span>
                ))}
              </div>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
