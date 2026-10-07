import { isRouteErrorResponse, useRouteError } from "react-router";

/** Root route error boundary: friendly message instead of the router's default error page. */
export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : error instanceof Error
      ? error.message
      : "Unknown error";
  return (
    <main role="alert" className="min-h-screen grid place-items-center bg-slate-50 p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-800 text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">The page could not be displayed. You can reload it or return to the dashboard.</p>
        <p className="mt-3 break-words font-mono text-xs text-slate-400">{detail}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={() => window.location.reload()} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-700 text-slate-700">Reload</button>
          <a href="#/" className="rounded-md bg-slate-950 px-4 py-2 text-sm font-700 text-white">Go to dashboard</a>
        </div>
      </div>
    </main>
  );
}
