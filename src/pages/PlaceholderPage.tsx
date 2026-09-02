import { useLocation } from "react-router";
import { Construction } from "lucide-react";

export function PlaceholderPage({ title }: { title?: string }) {
  const location = useLocation();
  const name = title || location.pathname.split("/").filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, " ")).join(" / ");

  return (
    <div className="animate-slide-in flex min-h-[420px] items-center justify-center p-6">
      <div className="card-panel w-full max-w-xl p-8 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <Construction size={26} />
        </div>
        <h2 className="text-2xl font-800 tracking-[-0.04em] text-slate-900">{name || "Page"}</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">This section is part of the ZigmaNeural platform. Full implementation connects to backend services.</p>
      </div>
    </div>
  );
}
