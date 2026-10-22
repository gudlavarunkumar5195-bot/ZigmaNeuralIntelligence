import type { RankProject } from "../../../services/api";

export const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-700 text-slate-800 hover:bg-slate-50 disabled:opacity-50";
export const btnPrimary = "rounded-md bg-slate-950 px-3 py-1.5 text-xs font-700 text-white hover:bg-slate-800 disabled:opacity-50";
export const input = "mt-1 block rounded border border-slate-300 px-2 py-1 text-sm";

export const configLabel = (p: RankProject) =>
  [p.search_engine === "google" ? "Google" : "Bing", p.country?.toUpperCase() ?? "any country", p.language ?? "any language", p.device ?? "any device", p.location].filter(Boolean).join(" · ");
