import { isRouteErrorResponse, useRouteError } from "react-router";
import { AlertCircle } from "lucide-react";
import { buttonClass } from "./styles";

/** Root route error boundary: friendly message instead of the router's default error page. */
export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : error instanceof Error
      ? error.message
      : "Unknown error";
  return (
    <main role="alert" className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-600"><AlertCircle size={18} aria-hidden="true" /></div>
        <h1 className="mt-3 text-section-title">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">The page could not be displayed. You can reload it or return to the dashboard.</p>
        <p className="mt-3 break-words font-mono text-xs text-slate-500">{detail}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={() => window.location.reload()} className={buttonClass("secondary", "md")}>Reload</button>
          <a href="#/" className={buttonClass("primary", "md")}>Go to dashboard</a>
        </div>
      </div>
    </main>
  );
}
