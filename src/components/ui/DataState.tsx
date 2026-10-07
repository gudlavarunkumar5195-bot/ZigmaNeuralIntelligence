import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader, WifiOff, Construction } from "lucide-react";

// ─── Loading ──────────────────────────────────────────────────────────────────

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center py-16 gap-3">
      <Loader size={22} className="text-blue-400 animate-spin-slow" />
      <span className="text-sm text-slate-400">{label}</span>
    </div>
  );
}

// ─── Empty ────────────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-slate-100">
        {icon ?? <Inbox size={18} className="text-slate-400" />}
      </div>
      <div>
        <div className="text-sm font-600 text-slate-700">{title}</div>
        {description && <div className="text-xs text-slate-400 mt-0.5 max-w-xs">{description}</div>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ─── Error ────────────────────────────────────────────────────────────────────

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-red-50">
        <AlertCircle size={18} className="text-red-400" />
      </div>
      <div>
        <div className="text-sm font-600 text-slate-700">{title}</div>
        {message && <div className="text-xs text-slate-500 mt-0.5 max-w-xs">{message}</div>}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 px-3 py-1.5 rounded text-xs font-600 border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ─── Integration Required ─────────────────────────────────────────────────────

export function IntegrationRequiredState({
  feature,
  description,
}: {
  feature: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-50">
        <WifiOff size={18} className="text-amber-400" />
      </div>
      <div>
        <div className="text-sm font-600 text-slate-700">Integration Required</div>
        <div className="text-xs text-slate-500 mt-0.5 max-w-xs">
          {description ??
            `${feature} requires a connected backend. Configure VITE_API_BASE_URL and VITE_APP_MODE=production.`}
        </div>
      </div>
      <div className="text-xs font-mono bg-amber-50 border border-amber-200 rounded px-3 py-1.5 text-amber-700">
        VITE_APP_MODE=production
      </div>
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
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-600 bg-slate-100 text-slate-500 font-mono">
      {label}
    </span>
  );
}

// ─── Partial Result badge ─────────────────────────────────────────────────────

export function PartialResult({ reason }: { reason?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50">
      <AlertCircle size={13} className="text-amber-500 flex-shrink-0" />
      <span className="text-xs text-amber-700 font-500">
        PARTIAL — {reason ?? "Some modules did not complete successfully."}
      </span>
    </div>
  );
}
