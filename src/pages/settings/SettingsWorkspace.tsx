import { SettingsLayout } from "./SettingsLayout";

export function SettingsWorkspace() {
  return (
    <SettingsLayout eyebrow="Workspace" title="Workspace settings">
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ["Organization", "ZigmaNeural Intelligence"],
          ["Plan", "Growth"],
          ["Regions", "US East + EU West"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <p className="mt-2 text-base font-700 text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Brand profile</h3>
          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-600 text-slate-700">Workspace name</span>
              <input defaultValue="ZigmaNeural Intelligence" className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-600 text-slate-700">Default language</span>
              <select defaultValue="English" className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500">
                <option>English</option>
                <option>French</option>
                <option>German</option>
              </select>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Default preferences</h3>
          <div className="mt-4 space-y-3">
            {[
              "Auto-create scan tickets after new website onboarding",
              "Send weekly intelligence summaries to workspace admins",
              "Display risk alerts in the overview dashboard",
            ].map((item) => (
              <label key={item} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <input type="checkbox" defaultChecked className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600" />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
