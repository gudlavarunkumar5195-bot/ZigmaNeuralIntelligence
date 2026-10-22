import type { ReactNode } from "react";
import { AlertCircle, Inbox, PlugZap } from "lucide-react";

// ─── Loading ──────────────────────────────────────────────────────────────────

/** Loading placeholder: skeleton blocks plus a visible, announced label. */
export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="py-6">
      <div className="space-y-2.5" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <div key={i} className="zn-skeleton h-3.5" style={{ width: `${92 - i * 14}%` }} />)}
      </div>
      <span className="mt-3 block text-xs text-slate-500">{label}</span>
    </div>
  );
}

// ─── Empty ────────────────────────────────────────────────────────────────────

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    // Not an alert: an empty list is normal content, not an urgent message.
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        {icon ?? <Inbox size={18} aria-hidden="true" />}
      </div>
      <div>
        <div className="text-sm font-700 text-slate-900">{title}</div>
        {description && <div className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{description}</div>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ─── Error ────────────────────────────────────────────────────────────────────

export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-200 bg-white px-6 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-600">
        <AlertCircle size={18} aria-hidden="true" />
      </div>
      <div>
        <div className="text-sm font-700 text-slate-900">{title}</div>
        {message && <div className="mx-auto mt-1 max-w-md text-xs text-slate-600">{message}</div>}
      </div>
      {onRetry && (
        <button onClick={onRetry} className="mt-1 h-8 rounded-lg border border-slate-300 bg-white px-3 text-xs font-600 text-slate-800 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          Retry
        </button>
      )}
    </div>
  );
}

// ─── Integration Required ─────────────────────────────────────────────────────

export function IntegrationRequiredState({ feature, description }: { feature: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-amber-200 bg-white px-6 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
        <PlugZap size={18} aria-hidden="true" />
      </div>
      <div>
        <div className="text-sm font-700 text-slate-900">Integration Required</div>
        <div className="mx-auto mt-1 max-w-md text-xs text-slate-600">
          {description ?? `${feature} requires a connected backend. Configure VITE_API_BASE_URL and VITE_APP_MODE=production.`}
        </div>
      </div>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 font-mono text-xs text-amber-900">VITE_APP_MODE=production</div>
    </div>
  );
}

/**
 * Compatibility boundary for cached development chunks from versions that
 * imported this symbol. It deliberately renders nothing and contains no
 * development data or messaging.
 */
export function DemoBanner() {
  return null;
}

// ─── NOT_MEASURED badge ───────────────────────────────────────────────────────

export function NotMeasured({ label = "NOT MEASURED" }: { label?: string }) {
  return <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-600 text-slate-600">{label}</span>;
}

// ─── Partial Result badge ─────────────────────────────────────────────────────

export function PartialResult({ reason }: { reason?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <AlertCircle size={13} className="flex-shrink-0 text-amber-700" aria-hidden="true" />
      <span className="text-xs font-500 text-amber-900">PARTIAL — {reason ?? "Some modules did not complete successfully."}</span>
    </div>
  );
}
