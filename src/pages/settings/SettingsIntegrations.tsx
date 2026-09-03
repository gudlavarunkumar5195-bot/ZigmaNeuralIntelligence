import { SettingsLayout } from "./SettingsLayout";

export function SettingsIntegrations() {
  return (
    <SettingsLayout eyebrow="Integrations" title="Connected integrations">
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ["Supabase", "Configured"],
          ["OpenRouter", "Optional"],
          ["DigitalOcean", "Production"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <p className="mt-2 text-base font-700 text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Available integrations</h3>
          <div className="mt-4 space-y-3">
            {[
              ["Supabase Postgres", "Connected"],
              ["OpenRouter AI gateway", "Optional"],
              ["CI/CD deployment", "Enabled"],
            ].map(([name, status]) => (
              <div key={name} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
                <span className="font-600 text-slate-700">{name}</span>
                <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-700 text-emerald-700">{status}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Integration health</h3>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">Database connectivity is validated at startup and checked during routine health checks.</div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">AI provider credentials remain server-side only and are never exposed to the browser bundle.</div>
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
