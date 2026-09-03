import { SettingsLayout } from "./SettingsLayout";

export function SettingsSecurity() {
  return (
    <SettingsLayout eyebrow="Security" title="Security settings">
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ["MFA", "Enabled for owners"],
          ["Audit logs", "Retained 365 days"],
          ["Risk posture", "Moderate"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <p className="mt-2 text-base font-700 text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Access control</h3>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            {[
              "Session expiration is enforced on a 15-minute access window.",
              "Role-based access control prevents cross-tenant data access.",
              "Critical infrastructure actions require admin approval.",
            ].map((item) => (
              <div key={item} className="rounded-xl border border-slate-200 bg-slate-50 p-3">{item}</div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Security posture</h3>
          <div className="mt-4 space-y-3">
            {[
              ["SSRF protections", "Active"],
              ["Rate limiting", "Enabled"],
              ["Audit trail", "Active"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
                <span className="font-600 text-slate-700">{label}</span>
                <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-700 text-emerald-700">{value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
