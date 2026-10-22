import { Link, useLocation } from "react-router";
import { SearchX } from "lucide-react";
import { buttonClass } from "../components/ui/styles";

/** Fallback for unknown routes. */
export function PlaceholderPage() {
  const location = useLocation();

  return (
    <div className="animate-slide-in flex min-h-[420px] items-center justify-center">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <SearchX size={22} aria-hidden="true" />
        </div>
        <h1 className="text-page-title text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          No page exists at <span className="break-all font-mono">{location.pathname}</span>.
        </p>
        <Link to="/" className={`${buttonClass("primary", "md")} mt-5`}>Go to dashboard</Link>
      </div>
    </div>
  );
}
