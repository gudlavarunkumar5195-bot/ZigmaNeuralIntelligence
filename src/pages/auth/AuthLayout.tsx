import type { ReactNode } from "react";
import { Activity, Bot, Gauge, Network, Search, ShieldCheck } from "lucide-react";

// What the product does, stated as capabilities only: no metrics, customers or claims.
const CAPABILITIES = [
  { icon: Search, title: "SEO research", text: "Keywords, rankings, backlinks and competitor gaps from your own data sources." },
  { icon: Gauge, title: "Technical health", text: "Crawls, performance, security and SSL checks of websites you have verified." },
  { icon: Bot, title: "AI visibility", text: "How AI answers mention your brand, from observed or imported answers." },
  { icon: Activity, title: "Monitoring", text: "Scheduled scans, change detection and alerts." },
] as const;

/** Two-column frame for the public auth pages: product panel (wide screens) and the form card. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-[var(--zn-sidebar)] p-10 text-white lg:flex lg:flex-col" aria-label="About ZigmaNeural">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(600px_circle_at_0%_0%,rgba(81,70,229,.35),transparent_60%),radial-gradient(500px_circle_at_100%_100%,rgba(14,159,154,.22),transparent_60%)]" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600"><Network size={18} aria-hidden="true" /></span>
          <span className="text-base font-700 tracking-tight">ZigmaNeural</span>
        </div>
        <div className="relative mt-auto max-w-lg">
          <p className="text-[2rem] font-700 leading-tight tracking-[-0.03em]">Website and search intelligence in one workspace.</p>
          <p className="mt-3 text-sm leading-6 text-[var(--zn-sidebar-text)]">Every figure is shown with its source and freshness. Where a data source is not connected, the product says so instead of estimating.</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {CAPABILITIES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="rounded-xl border border-white/10 bg-white/[.04] p-4">
                <Icon size={16} className="text-[var(--zn-sidebar-accent)]" aria-hidden="true" />
                <p className="mt-2 text-sm font-600">{title}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--zn-sidebar-text)]">{text}</p>
              </li>
            ))}
          </ul>
          <p className="mt-8 flex items-center gap-2 text-xs text-[var(--zn-sidebar-text)]"><ShieldCheck size={14} aria-hidden="true" />Scans run only on websites whose ownership you have verified.</p>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
    </div>
  );
}

/** Shared input styling for auth forms (larger touch targets than in-app inputs). */
export const authInput =
  "block h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 hover:border-slate-400 focus:outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 aria-[invalid=true]:border-red-500";
export const authLabel = "mb-1.5 block text-xs font-600 text-slate-700";
