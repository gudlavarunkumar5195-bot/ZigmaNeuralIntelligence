import type { ReactNode } from "react";
import { NavLink } from "react-router";

const settingsTabs = [
  { label: "Workspace", path: "/settings/workspace" },
  { label: "Team", path: "/settings/team" },
  { label: "Security", path: "/settings/security" },
  { label: "API", path: "/settings/api" },
  { label: "Integrations", path: "/settings/integrations" },
] as const;

export function SettingsLayout({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl animate-slide-in">
      <header className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-blue-700">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-800 tracking-[-0.03em] text-slate-950">{title}</h2>
      </header>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 shadow-sm">
          <p className="px-2 pb-2 text-[10px] font-700 uppercase tracking-[0.14em] text-slate-500">Settings</p>
          <nav className="space-y-1">
            {settingsTabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path}
                end
                className={({ isActive }) =>
                  `block rounded-xl px-3 py-2.5 text-sm transition-colors ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-white hover:text-slate-900"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}
