import { useEffect, useState } from "react";
import { ApiCallError, apiGetMe, getActiveOrgId } from "../../services/api";
import { ErrorState, LoadingState } from "../../components/ui/DataState";
import { SettingsLayout, SettingsUnavailable } from "./SettingsLayout";

type Me = { id: string; email: string; orgIds: string[] };

export function SettingsWorkspace() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = async () => {
    setError(null);
    try {
      const result = await apiGetMe();
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setMe(result.data);
    } catch (cause) {
      setError(cause as Error);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <SettingsLayout eyebrow="Workspace" title="Workspace settings">
      {!me && !error ? <LoadingState label="Loading account..." /> : null}
      {error ? <ErrorState title="Unable to load account" message={error.message} onRetry={load} /> : null}
      {me ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-800 text-slate-900">Signed-in account</h3>
          <dl className="mt-4 grid gap-4 text-sm md:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Email</dt>
              <dd className="mt-1 text-slate-900">{me.email}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Active organization ID</dt>
              <dd className="mt-1 font-mono text-slate-900">{getActiveOrgId() ?? me.orgIds[0] ?? "None"}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      <SettingsUnavailable
        title="Workspace profile and preferences"
        description="Organization name, plan, regions and default preferences are not available yet because the backend has no organization settings endpoint."
      />
    </SettingsLayout>
  );
}
