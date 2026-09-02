import { useLocation } from "react-router";
import { Construction } from "lucide-react";

export function PlaceholderPage({ title }: { title?: string }) {
  const location = useLocation();
  const name = title || location.pathname.split("/").filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, " ")).join(" / ");

  return (
    <div className="p-6 flex flex-col items-center justify-center min-h-96 animate-slide-in">
      <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-slate-100 mb-4">
        <Construction size={22} className="text-slate-400" />
      </div>
      <h2 className="text-lg font-700 text-slate-900 mb-1">{name || "Page"}</h2>
      <p className="text-sm text-slate-500 text-center max-w-xs">This section is part of the ZigmaNeural platform. Full implementation connects to backend services.</p>
    </div>
  );
}
