/**
 * Shared class names for controls and surfaces (docs/DESIGN_SYSTEM.md).
 * Module-level `ui` files re-export these so every page uses one set of
 * button, input and card styles.
 */

const focus = "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1";
const base = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-600 transition-colors ${focus} disabled:cursor-not-allowed disabled:opacity-50`;

export const buttonVariants = {
  primary: `${base} bg-blue-600 text-white shadow-sm hover:bg-blue-700`,
  secondary: `${base} border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50`,
  ghost: `${base} text-slate-700 hover:bg-slate-100 hover:text-slate-900`,
  danger: `${base} border border-red-200 bg-white text-red-700 shadow-sm hover:bg-red-50`,
  dangerSolid: `${base} bg-red-600 text-white shadow-sm hover:bg-red-700`,
} as const;
export type ButtonVariant = keyof typeof buttonVariants;

export const buttonSizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-4 text-sm",
  icon: "h-9 w-9 p-0",
} as const;
export type ButtonSize = keyof typeof buttonSizes;

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "sm") => `${buttonVariants[variant]} ${buttonSizes[size]}`;

/** Compact module buttons (kept as plain strings for existing call sites). */
export const btn = buttonClass("secondary", "sm");
export const btnPrimary = buttonClass("primary", "sm");
export const btnDanger = buttonClass("danger", "sm");

/** Text inputs and selects: block, with the label above (`mt-1`). */
export const input = `mt-1 block min-h-9 max-w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 shadow-sm placeholder:text-slate-400 hover:border-slate-400 ${focus} focus-visible:border-blue-500 disabled:bg-slate-50 disabled:text-slate-500`;
export const textarea = `mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-[13px] text-slate-900 shadow-sm placeholder:text-slate-400 hover:border-slate-400 ${focus} focus-visible:border-blue-500`;
export const label = "text-xs font-600 text-slate-700";

export const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
export const cardFlush = "rounded-xl border border-slate-200 bg-white shadow-sm";

/** Status/tone pills: always rendered with text (never colour alone). */
export const toneClasses = {
  neutral: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200",
  accent: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
  success: "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200",
  warning: "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200",
  danger: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200",
  info: "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-100",
} as const;
export type Tone = keyof typeof toneClasses;
export const pill = (tone: Tone) => `inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-600 ${toneClasses[tone]}`;

/** Tables inside an overflow container. */
export const table = "w-full border-separate border-spacing-0 text-left text-xs";
export const th = "sticky top-0 z-[1] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-600 uppercase tracking-wide text-slate-500";
export const td = "border-b border-slate-100 px-3 py-2 align-top text-slate-800";
export const tdNum = `${td} text-right tabular-nums`;
