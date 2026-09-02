import { useNavigate } from "react-router";
import { ArrowRight, DatabaseZap } from "lucide-react";
import { EmptyState } from "./DataState";

/** Used only where the backend does not yet expose a tenant-scoped read model. */
export function UnavailableAnalysis({ title, dependency = "A tenant-scoped backend endpoint" }: { title: string; dependency?: string }) {
  const navigate = useNavigate();
  return <div className="mx-auto max-w-4xl p-6 md:p-10"><p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">{title}</p><EmptyState icon={<DatabaseZap size={19} className="text-blue-600" />} title="Integration required" description={`${dependency} is required before this view can display production records. No local fallback data is shown.`} action={<button onClick={() => navigate("/websites")} className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-700 text-white">View websites <ArrowRight size={14} /></button>} /></div>;
}
