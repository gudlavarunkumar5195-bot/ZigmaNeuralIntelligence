import { SettingsLayout } from "./SettingsLayout";

export function SettingsAPI() {
  return (
    <SettingsLayout eyebrow="API" title="API settings">
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ["Base URL", "/api/v1"],
          ["Auth", "JWT + cookies"],
          ["Rate limit", "200/min"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <p className="mt-2 text-base font-700 text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Connection details</h3>
          <div className="mt-4 space-y-4 text-sm text-slate-700">
            <label className="block">
              <span className="mb-1 block font-600 text-slate-700">API base URL</span>
              <input defaultValue="/api/v1" className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-800 outline-none focus:border-blue-500" />
            </label>
            <label className="block">
              <span className="mb-1 block font-600 text-slate-700">Timeout</span>
              <input defaultValue="30s" className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-800 outline-none focus:border-blue-500" />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Operational notes</h3>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">API requests include the active tenant header and are validated against RBAC rules.</div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">Unauthorized or expired sessions automatically trigger a sign-in redirect and refresh flow.</div>
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
