export const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-700 text-slate-800 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
export const btnPrimary = "rounded-md bg-slate-950 px-3 py-1.5 text-xs font-700 text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
export const input = "mt-1 block rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

export const SEVERITY_STYLE: Record<string, string> = {
  high: "bg-red-50 text-red-800",
  medium: "bg-amber-50 text-amber-900",
  low: "bg-sky-50 text-sky-800",
  info: "bg-slate-100 text-slate-700",
};

export const CRAWL_STATE_LABEL: Record<string, string> = {
  ok: "Crawled",
  not_html: "Not HTML",
  http_error: "HTTP error",
  fetch_failed: "Fetch failed",
  blocked_by_robots: "Blocked by robots.txt",
  redirected: "Redirects",
  not_reached: "Not reached in the last full crawl",
};

/** Permission errors read as permission errors, not as failures. */
export const errorMessage = (e: { code: string; message: string }) =>
  e.code === "INSUFFICIENT_ROLE" || e.code === "FORBIDDEN" ? "Your role can view content data but not change it." : e.message;
