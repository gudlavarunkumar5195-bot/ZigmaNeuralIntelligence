import type { AdminCheckStatus } from "../../services/api";

// Shared presentation for the Admin Control Center. Statuses are shown as the
// backend reports them; anything unknown is labelled, never shown as healthy.

export const CHECK_LABEL: Record<AdminCheckStatus, string> = {
  valid: "Verified",
  invalid: "Rejected by provider",
  permission_denied: "Permission denied",
  quota_exceeded: "Quota exhausted",
  rate_limited: "Rate limited",
  unavailable: "Provider unavailable",
  timeout: "Timed out",
  not_configured: "Not configured",
  error: "Check failed",
};

const TONE: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-800 border-emerald-200",
  bad: "bg-red-50 text-red-800 border-red-200",
  warn: "bg-amber-50 text-amber-900 border-amber-200",
  muted: "bg-slate-100 text-slate-700 border-slate-200",
};

export function toneFor(status: string | null | undefined): keyof typeof TONE {
  if (!status) return "muted";
  if (["valid", "ok", "up_to_date", "connected"].includes(status)) return "good";
  if (["invalid", "permission_denied", "failed", "error", "stalled"].includes(status)) return "bad";
  if (["not_configured", "unknown", "not_verified", "not_running_in_this_process", "unavailable_here"].includes(status)) return "muted";
  return "warn";
}

export function StatusPill({ status, label }: { status: string | null | undefined; label?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-700 ${TONE[toneFor(status)]}`}>
      {label ?? (status ? (CHECK_LABEL as Record<string, string>)[status] ?? status.replace(/_/g, " ") : "Unknown")}
    </span>
  );
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-800 text-slate-950">{title}</h2>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-700 text-slate-800 hover:bg-slate-50 disabled:opacity-50";
export const btnPrimary = "rounded-md bg-slate-950 px-3 py-1.5 text-xs font-700 text-white hover:bg-slate-800 disabled:opacity-50";
export const btnDanger = "rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-700 text-red-800 hover:bg-red-50 disabled:opacity-50";
