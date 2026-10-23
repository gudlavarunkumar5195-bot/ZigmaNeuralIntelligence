import { useEffect, useState, type ReactNode } from "react";
import { apiGetMe, getActiveOrgId, type AiPricingClass } from "../../../services/api";
import type { ApiError } from "../../../types";
import { Badge } from "../../../components/ui/Primitives";
import type { Tone } from "../../../components/ui/styles";

// ─── Access ──────────────────────────────────────────────────────────────────

export interface Access {
  /** Platform administrator (PLATFORM_ADMIN_USER_IDS), as reported by /auth/me. Only hides controls; the API enforces it. */
  isPlatformAdmin: boolean;
  /** Role in the active organization; null when /auth/me did not say (the API then decides). */
  role: "owner" | "admin" | "member" | "viewer" | null;
  /** Owners and admins can read the admin views (models, tasks, usage, quality, security, settings). */
  isOrgAdmin: boolean;
  loading: boolean;
}

/** Same source as the Shell and the Model Registry page: GET /auth/me. */
export function useAccess(): Access {
  const [state, setState] = useState<Access>({ isPlatformAdmin: false, role: null, isOrgAdmin: true, loading: true });
  useEffect(() => {
    let live = true;
    apiGetMe().then(
      (r) => {
        if (!live) return;
        const activeOrg = getActiveOrgId();
        const role = r.data?.memberships?.find((m) => m.orgId === activeOrg)?.role ?? null;
        setState({ isPlatformAdmin: r.data?.isPlatformAdmin === true, role, isOrgAdmin: role === null || role === "owner" || role === "admin", loading: false });
      },
      () => { if (live) setState({ isPlatformAdmin: false, role: null, isOrgAdmin: true, loading: false }); },
    );
    return () => { live = false; };
  }, []);
  return state;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** PostgreSQL counts and sums can arrive as strings. */
export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
export const fmtInt = (v: unknown) => Math.round(num(v)).toLocaleString();
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : "—");
export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "—");

/** A readable sentence for a failed read, with a role hint on 403. */
export function errorText(error: ApiError): string {
  if (error.status === 403 && error.code !== "PLATFORM_ADMIN_REQUIRED") {
    return `${error.message} This view needs an organization owner or admin.`;
  }
  return error.message;
}

// ─── Badges ──────────────────────────────────────────────────────────────────

/** FREE green, TRIAL amber with its expiry, PAID/UNKNOWN grey "not used" (the router never sends work to them). */
export function PricingBadge({ cls, expiresAt }: { cls: AiPricingClass | string | null; expiresAt?: string | null }) {
  if (cls === "FREE") return <Badge tone="success">Free</Badge>;
  if (cls === "TRIAL") return <Badge tone="warning">{expiresAt ? `Trial · expires ${fmtDate(expiresAt)}` : "Trial · no expiry reported"}</Badge>;
  return <Badge tone="neutral">{cls === "PAID" ? "Paid" : "Unknown"} · not used</Badge>;
}

const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "neutral" };
export function SeverityPill({ severity }: { severity: string }) {
  return <Badge tone={SEVERITY_TONE[severity] ?? "neutral"}>{humanize(severity)}</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  RUNNING: "accent", COMPLETED: "success", FAILED: "danger", CANCELLED: "neutral", REJECTED: "danger",
  PENDING: "warning", APPROVED: "success", DENIED: "danger", EXPIRED: "neutral", USED: "neutral",
};
export function StatusPill({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function ConfidencePill({ confidence }: { confidence: "measured" | "insufficient_data" }) {
  return confidence === "measured"
    ? <Badge tone="success" icon>Measured</Badge>
    : <Badge tone="warning" icon>Insufficient data</Badge>;
}

/** Marks a figure that is an approximation, not provider-confirmed. */
export function EstimatedTag() {
  return <span className="ml-1 rounded bg-slate-100 px-1 py-px text-[10px] font-600 uppercase tracking-wide text-slate-600">estimated</span>;
}

// ─── Meter ───────────────────────────────────────────────────────────────────

/** Labelled usage bar (value / max). Colour reinforces the text, never replaces it. */
export function Meter({ label, value, max, text }: { label: string; value: number; max: number; text?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = pct >= 90 ? "bg-red-600" : pct >= 70 ? "bg-amber-500" : "bg-blue-600";
  return (
    <div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={`${value.toLocaleString()} of ${max.toLocaleString()}`} className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {text ? <p className="mt-1 text-[11px] text-slate-600">{text}</p> : null}
    </div>
  );
}

/** Small label/value pair for definition lists. */
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-600 uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-slate-900">{children}</dd>
    </div>
  );
}
