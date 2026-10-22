import { cloneElement, isValidElement, useId, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";

type Side = "top" | "right" | "bottom";

// Positioned against the viewport (fixed), so scrolling or clipped parents never cut the tooltip off.
function place(r: DOMRect, side: Side): CSSProperties {
  if (side === "right") return { left: r.right + 8, top: r.top + r.height / 2, transform: "translateY(-50%)" };
  if (side === "bottom") return { left: r.left + r.width / 2, top: r.bottom + 6, transform: "translateX(-50%)" };
  return { left: r.left + r.width / 2, top: r.top - 6, transform: "translate(-50%, -100%)" };
}

/**
 * Tooltip for a focusable trigger. Shown on hover and keyboard focus, hidden
 * with Escape; linked with aria-describedby so screen readers announce it.
 */
export function Tooltip({ content, side = "top", children }: { content: ReactNode; side?: Side; children: ReactElement<Record<string, unknown>> }) {
  const id = useId();
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const open = pos !== null;
  const setOpen = (on: boolean) => setPos(on && anchor.current ? place(anchor.current.getBoundingClientRect(), side) : null);
  if (!isValidElement(children)) return children;
  // Chain the trigger's own handlers rather than replacing them.
  const own = children.props as { onFocus?: (e: React.FocusEvent) => void; onBlur?: (e: React.FocusEvent) => void; onKeyDown?: (e: React.KeyboardEvent) => void; "aria-describedby"?: string };
  const trigger = cloneElement(children, {
    "aria-describedby": open ? [own["aria-describedby"], id].filter(Boolean).join(" ") : own["aria-describedby"],
    onFocus: (e: React.FocusEvent) => { own.onFocus?.(e); setOpen(true); },
    onBlur: (e: React.FocusEvent) => { own.onBlur?.(e); setOpen(false); },
    onKeyDown: (e: React.KeyboardEvent) => { own.onKeyDown?.(e); if (e.key === "Escape") setOpen(false); },
  });
  return (
    <span ref={anchor} className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {trigger}
      {open ? (
        <span role="tooltip" id={id} style={pos} className="pointer-events-none fixed z-[80] w-max max-w-64 rounded-md bg-slate-900 px-2 py-1.5 text-[11px] font-500 leading-snug text-white shadow-lg">
          {content}
        </span>
      ) : null}
    </span>
  );
}

/** Small "i" button that explains a metric or term. */
export function InfoTip({ label, children, side = "top" }: { label: string; children: ReactNode; side?: Side }) {
  return (
    <Tooltip content={children} side={side}>
      <button type="button" aria-label={`About ${label}`} className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <Info size={12} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
