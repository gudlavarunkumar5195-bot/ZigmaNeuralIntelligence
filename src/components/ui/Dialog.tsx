import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./Button";

/**
 * Modal dialog on the native <dialog> element: the browser traps focus,
 * closes on Escape and restores focus to the trigger.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={`m-auto w-[calc(100%-2rem)] ${width} rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl`}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 id={titleId} className="text-section-title">{title}</h2>
              {description ? <p id={descId} className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
            </div>
            <IconButton aria-label="Close dialog" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>
          </div>
          {children ? <div className="overflow-y-auto px-5 py-4 text-sm">{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Confirmation for consequential actions; the confirm button states exactly what happens. */
export function ConfirmDialog({ open, title, description, confirmLabel, tone = "danger", busy = false, onConfirm, onCancel }: { open: boolean; title: string; description: ReactNode; confirmLabel: string; tone?: "danger" | "primary"; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} size="sm" footer={
      <>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={tone === "danger" ? "dangerSolid" : "primary"} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </>
    }>
      <div className="text-sm text-slate-700">{description}</div>
    </Dialog>
  );
}
