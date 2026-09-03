import { SettingsLayout } from "./SettingsLayout";

export function SettingsTeam() {
  return (
    <SettingsLayout eyebrow="Team" title="Team settings">
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ["Members", "12 active"],
          ["Roles", "3 configured"],
          ["Invites", "2 pending"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <p className="mt-2 text-base font-700 text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Members</h3>
          <div className="mt-4 space-y-3">
            {[
              ["Ava Thompson", "Owner"],
              ["Miles Chen", "Admin"],
              ["Nina Patel", "Editor"],
            ].map(([name, role]) => (
              <div key={name} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div>
                  <p className="font-600 text-slate-800">{name}</p>
                  <p className="text-xs text-slate-500">{role}</p>
                </div>
                <button className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-600 text-slate-700">Manage</button>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Access policy</h3>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="font-600 text-slate-800">Default permissions</p>
              <p className="mt-1">Members can view dashboards and run scans, but only owners and admins can manage billing and workspace settings.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="font-600 text-slate-800">Two-factor requirement</p>
              <p className="mt-1">Admins and owners must use MFA before accessing protected settings.</p>
            </div>
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
