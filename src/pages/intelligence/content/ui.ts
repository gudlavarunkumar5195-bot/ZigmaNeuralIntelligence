export { btn, btnPrimary, input } from "../../../components/ui/styles";

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
