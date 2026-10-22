import { Link } from "react-router";
import { ArrowRight, Construction } from "lucide-react";
import { PageHeader } from "./Card";
import { buttonClass } from "./styles";

/**
 * Honest state for routes whose backend does not exist yet: no placeholder
 * data, a clear explanation, and a way back to working features.
 */
export function UnavailableAnalysis({ title, dependency = "A tenant-scoped backend endpoint" }: { title: string; dependency?: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={title} eyebrow="Not available" />
      <section className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Construction size={18} aria-hidden="true" /></div>
        <h2 className="mt-3 text-sm font-700 text-slate-900">Not available yet</h2>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-600">
          {dependency} is required before this view can display production records. This feature is not implemented yet and no placeholder data is shown.
        </p>
        <Link to="/websites" className={`${buttonClass("primary", "md")} mt-4`}>View websites <ArrowRight size={14} aria-hidden="true" /></Link>
      </section>
    </div>
  );
}
