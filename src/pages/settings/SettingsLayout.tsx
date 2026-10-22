import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { PageHeader } from "../../components/ui/Card";

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
    <div className="animate-slide-in">
      <PageHeader eyebrow={eyebrow} title={title} />

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="-mx-1 overflow-x-auto scroll-area lg:mx-0 lg:overflow-visible">
          <div className="flex min-w-max gap-1 border-b border-slate-200 px-1 lg:min-w-0 lg:flex-col lg:border-b-0 lg:px-0">
            {settingsTabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path}
                end
                className={({ isActive }) =>
                  `whitespace-nowrap text-[13px] font-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    isActive
                      ? "-mb-px border-b-2 border-blue-600 px-3 py-2 text-blue-700 lg:mb-0 lg:rounded-lg lg:border-b-0 lg:bg-blue-50"
                      : "-mb-px border-b-2 border-transparent px-3 py-2 text-slate-600 hover:text-slate-900 lg:mb-0 lg:rounded-lg lg:border-b-0 lg:hover:bg-slate-100"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}

/** Honest placeholder for settings that have no backend endpoint yet. */
export function SettingsUnavailable({ title, description }: { title: string; description: string }) {
  return (
    <section
      role="status"
      data-testid="settings-unavailable"
      className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-card-title text-slate-900">{title}</h3>
        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-600 text-slate-700 ring-1 ring-inset ring-slate-200">Not available yet</span>
      </div>
      <p className="mt-2 leading-6">{description}</p>
    </section>
  );
}
