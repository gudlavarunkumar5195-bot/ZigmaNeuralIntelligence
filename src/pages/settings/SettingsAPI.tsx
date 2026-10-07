import { config } from "../../config/env";
import { SettingsLayout, SettingsUnavailable } from "./SettingsLayout";

export function SettingsAPI() {
  return (
    <SettingsLayout eyebrow="API" title="API settings">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-800 text-slate-900">Connection</h3>
        <dl className="mt-4 text-sm text-slate-700">
          <dt className="text-[11px] uppercase tracking-[0.12em] text-slate-500">API base URL</dt>
          <dd className="mt-1 font-mono text-slate-900">{config.apiBaseUrl || "Not configured"}</dd>
        </dl>
      </section>
      <SettingsUnavailable
        title="API keys and limits"
        description="API key management and rate-limit reporting are not available yet."
      />
    </SettingsLayout>
  );
}
