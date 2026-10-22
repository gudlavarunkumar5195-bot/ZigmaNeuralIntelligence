import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";
interface ToastItem { id: number; tone: ToastTone; message: string }
interface ToastApi { notify: (message: string, tone?: ToastTone) => void }

const ToastContext = createContext<ToastApi | null>(null);
const NOOP: ToastApi = { notify: () => undefined };

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;
const STYLE: Record<ToastTone, string> = {
  success: "border-emerald-200 bg-white text-slate-900 [&_svg]:text-emerald-600",
  error: "border-red-200 bg-white text-slate-900 [&_svg]:text-red-600",
  info: "border-slate-200 bg-white text-slate-900 [&_svg]:text-blue-600",
};

/** Transient feedback, announced through a polite live region; errors stay until dismissed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    const id = next.current++;
    setItems((l) => [...l.slice(-3), { id, tone, message }]);
    if (tone !== "error") timers.current.push(window.setTimeout(() => dismiss(id), 5000));
  }, [dismiss]);
  const api = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-label="Notifications" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] shadow-lg [animation:zn-toast-in_.18s_ease-out] ${STYLE[t.tone]}`}>
              <Icon size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1">{t.message}</span>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><X size={14} aria-hidden="true" /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Works without a provider (no-op), so pages render in isolation and in tests. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
