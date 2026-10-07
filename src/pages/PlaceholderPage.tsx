import { useLocation } from "react-router";
import { SearchX } from "lucide-react";

/** Fallback for unknown routes. */
export function PlaceholderPage() {
  const location = useLocation();

  return (
    <div className="animate-slide-in flex min-h-[420px] items-center justify-center p-6">
      <div className="card-panel w-full max-w-xl p-8 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
          <SearchX size={26} />
        </div>
        <h2 className="text-2xl font-800 tracking-[-0.04em] text-slate-900">Page not found</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          No page exists at <span className="font-mono">{location.pathname}</span>.
        </p>
      </div>
    </div>
  );
}
