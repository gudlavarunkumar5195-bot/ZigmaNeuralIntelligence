import type { AdminCheckStatus } from "../../services/api";
import { PageHeader as SharedPageHeader } from "../../components/ui/Card";

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

/** Admin pages share the product-wide page header; children are the page actions. */
export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return <SharedPageHeader eyebrow={eyebrow} title={title} action={children ? <div className="flex flex-wrap gap-2">{children}</div> : undefined} />;
}

export { btn, btnDanger, btnPrimary } from "../../components/ui/styles";
