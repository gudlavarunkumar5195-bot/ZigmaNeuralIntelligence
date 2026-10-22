import { useCallback, useEffect, useState } from "react";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import {
  apiAdminIntegrations,
  apiAdminReencryptCredentials,
  apiAdminRemoveCredential,
  apiAdminSaveCredential,
  apiAdminSetIntegrationEnabled,
  apiAdminTestIntegration,
  IntegrationRequired,
  type AdminCheckResult,
  type AdminIntegration,
} from "../../services/api";
import { btn, btnDanger, btnPrimary, CHECK_LABEL, fmtTime, PageHeader, StatusPill } from "./adminShared";

/**
 * Admin → Integrations & API keys. Each integration has its own card and
 * state, so a failure in one never blocks another. Stored secrets are never
 * sent back by the server; only a masked suffix is shown.
 */
export function IntegrationsAdminPage() {
  const [items, setItems] = useState<AdminIntegration[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await apiAdminIntegrations();
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      setItems(r.data);
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const replace = (next: AdminIntegration) => setItems((list) => list?.map((i) => (i.id === next.id ? next : i)) ?? null);

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Integrations administration" />;
  if (error) return <ErrorState title={(error as { code?: string }).code === "PLATFORM_ADMIN_REQUIRED" ? "Platform administrators only" : "Unable to load integrations"} message={error.message} onRetry={load} />;
  if (!items) return <LoadingState label="Loading integrations…" />;

  return (
    <div className="max-w-5xl">
      <PageHeader eyebrow="Administration" title="Integrations & API keys">
        <button type="button" className={btn} onClick={() => void load()}>Refresh</button>
      </PageHeader>
      <p className="mt-2 text-xs text-slate-600">
        Keys from external providers must be created in that provider's dashboard; this application never generates them. A key is stored (encrypted) only after the provider accepts it, and a rejected replacement never overwrites a working key.
      </p>
      <div className="mt-4 space-y-4">
        {items.map((i) => <IntegrationCard key={i.id} item={i} onChange={replace} onReload={load} />)}
      </div>
    </div>
  );
}

const MANAGEMENT_LABEL: Record<AdminIntegration["management"], string> = {
  admin: "Managed here",
  deployment: "Deployment setting",
  oauth: "Connected per organization (OAuth)",
  unsupported: "Not available",
};

function IntegrationCard({ item, onChange, onReload }: { item: AdminIntegration; onChange: (i: AdminIntegration) => void; onReload: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; status?: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const cred = item.credential;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const showCheck = (r: AdminCheckResult) => setResult({ ok: r.status === "valid", status: r.status, text: `${CHECK_LABEL[r.status]}: ${r.message}` });

  const save = () =>
    run("save", async () => {
      const value = secret.trim();
      if (!value) return setResult({ ok: false, text: "Enter the key first." });
      const r = await apiAdminSaveCredential(item.id, value);
      setSecret(""); // never keep the key in page state longer than the request
      if (r.error) {
        const status = r.error.details?.status as string | undefined;
        return setResult({ ok: false, status, text: `${status ? `${(CHECK_LABEL as Record<string, string>)[status] ?? status}: ` : ""}${r.error.message}${r.error.details?.previousCredentialKept ? " The previously saved key is still in use." : ""}` });
      }
      onChange(r.data!.integration);
      setResult({ ok: true, status: "valid", text: `Verified and activated. Capabilities: ${item.capabilities.join(", ").replace(/_/g, " ")}.` });
    });

  const test = () =>
    run("test", async () => {
      const r = await apiAdminTestIntegration(item.id);
      if (r.error) return setResult({ ok: false, text: r.error.message });
      onChange(r.data!.integration);
      showCheck(r.data!.result);
    });

  const toggle = (enabled: boolean) =>
    run("toggle", async () => {
      const r = await apiAdminSetIntegrationEnabled(item.id, enabled);
      if (r.error) return setResult({ ok: false, text: r.error.message });
      onChange(r.data!);
      setResult({ ok: true, text: enabled ? "Enabled." : "Disabled: features using this integration are switched off." });
    });

  const remove = () =>
    run("remove", async () => {
      setConfirmRemove(false);
      const r = await apiAdminRemoveCredential(item.id);
      if (r.error) return setResult({ ok: false, text: r.error.message });
      onChange(r.data!.integration);
      setResult({ ok: true, text: r.data!.integration.credential?.envFallback ? "Stored key removed. The deployment's environment key is used again." : "Stored key removed." });
    });

  const reencrypt = () =>
    run("reencrypt", async () => {
      const r = await apiAdminReencryptCredentials();
      if (r.error) return setResult({ ok: false, text: r.error.message });
      setResult({ ok: r.data!.failed === 0, text: `Re-encrypted ${r.data!.reencrypted}, already current ${r.data!.alreadyCurrent}, failed ${r.data!.failed}.` });
      await onReload();
    });

  return (
    <section aria-label={item.name} className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-800 text-slate-950">{item.name}</h3>
          <p className="mt-0.5 text-xs text-slate-600">{item.purpose}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-700 uppercase text-slate-600">{MANAGEMENT_LABEL[item.management]}</span>
          {item.management !== "unsupported" ? <StatusPill status={item.featureEnabled ? "ok" : item.configured ? "warning" : "not_configured"} label={item.featureEnabled ? "Feature enabled" : item.configured ? "Configured, not in use" : "Not configured"} /> : null}
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-700 sm:grid-cols-2">
        {cred ? (
          <>
            <div><dt className="inline font-600">Credential: </dt><dd className="inline">{cred.source === "admin" ? `stored here (••••${cred.suffix ?? ""})` : cred.source === "environment" ? "from the deployment environment" : cred.stored ? `stored (••••${cred.suffix ?? ""}), not in use` : "none"}</dd></div>
            {cred.stored ? <div><dt className="inline font-600">Stored key status: </dt><dd className="inline"><StatusPill status={cred.status} />{cred.enabled ? "" : " · disabled"}</dd></div> : null}
            {cred.stored ? <div><dt className="inline font-600">Last validated: </dt><dd className="inline">{fmtTime(cred.validatedAt)}</dd></div> : null}
            {cred.error ? <div className="sm:col-span-2"><dt className="inline font-600">Last error: </dt><dd className="inline">{cred.error}</dd></div> : null}
            {cred.decryptError ? <div className="sm:col-span-2 text-red-800">{cred.decryptError}</div> : null}
          </>
        ) : null}
        <div><dt className="inline font-600">Last check: </dt><dd className="inline">{item.lastCheck ? <><StatusPill status={item.lastCheck.status} /> {fmtTime(item.lastCheck.checkedAt)}</> : item.canTest ? "Not verified yet" : "No server-side check"}</dd></div>
        <div><dt className="inline font-600">Last successful check: </dt><dd className="inline">{fmtTime(item.lastSuccessAt)}</dd></div>
        {item.lastCheck?.message && item.lastCheck.status !== "valid" ? <div className="sm:col-span-2"><dt className="inline font-600">Check result: </dt><dd className="inline">{item.lastCheck.message}</dd></div> : null}
        {item.capabilities.length ? <div className="sm:col-span-2"><dt className="inline font-600">Capabilities: </dt><dd className="inline">{item.capabilities.join(", ").replace(/_/g, " ")}</dd></div> : null}
        {item.envVars.length ? (
          <div className="sm:col-span-2"><dt className="inline font-600">Deployment variables: </dt><dd className="inline">{item.envVars.map((v) => `${v.name} ${v.set ? "✓ set" : "✗ not set"}`).join(" · ")}</dd></div>
        ) : null}
        {typeof item.details.creditRemaining === "number" || item.details.freeTier !== undefined ? (
          <div className="sm:col-span-2"><dt className="inline font-600">Provider-reported usage: </dt><dd className="inline">{item.details.freeTier === true ? "free tier" : item.details.freeTier === false ? "paid account" : ""}{typeof item.details.creditRemaining === "number" ? ` · ${item.details.creditRemaining} credits remaining` : ""}</dd></div>
        ) : null}
        {item.details.connections ? <div className="sm:col-span-2"><dt className="inline font-600">Connections: </dt><dd className="inline">{Object.entries(item.details.connections as Record<string, number>).map(([s, n]) => `${n} ${s}`).join(" · ") || "none"}</dd></div> : null}
      </dl>
      <p className="mt-2 text-xs text-slate-600">{item.setup} {item.docsUrl ? <a href={item.docsUrl} target="_blank" rel="noreferrer noopener" className="font-600 underline">Provider documentation</a> : null}</p>

      {item.management === "admin" ? (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="text-xs text-slate-700">
            {cred?.stored ? "Replace API key" : "API key"}
            <input type="password" autoComplete="off" spellCheck={false} value={secret} maxLength={512} onChange={(e) => setSecret(e.target.value)} className="mt-1 block w-80 rounded border border-slate-300 px-2 py-1 font-mono text-xs" />
          </label>
          <button type="submit" className={btnPrimary} disabled={!!busy || !secret.trim()}>{busy === "save" ? "Validating…" : "Save & validate"}</button>
        </form>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {item.canTest ? <button type="button" className={btn} disabled={!!busy} onClick={() => void test()}>{busy === "test" ? "Testing…" : cred?.stored ? "Test stored key" : "Test connection"}</button> : null}
        {cred?.stored ? (
          cred.enabled
            ? <button type="button" className={btn} disabled={!!busy} onClick={() => void toggle(false)}>Disable</button>
            : <button type="button" className={btn} disabled={!!busy} onClick={() => void toggle(true)}>Enable</button>
        ) : null}
        {cred?.stored ? (
          confirmRemove ? (
            <span className="flex items-center gap-2 text-xs">Remove the stored key?
              <button type="button" className={btnDanger} disabled={!!busy} onClick={() => void remove()}>Yes, remove</button>
              <button type="button" className={btn} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </span>
          ) : <button type="button" className={btnDanger} disabled={!!busy} onClick={() => setConfirmRemove(true)}>Remove key</button>
        ) : null}
        {item.id === "encryption" && item.configured ? <button type="button" className={btn} disabled={!!busy} onClick={() => void reencrypt()}>{busy === "reencrypt" ? "Re-encrypting…" : "Re-encrypt with active key"}</button> : null}
      </div>
      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`mt-2 rounded px-3 py-2 text-xs ${result.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}>{result.text}</p>
      ) : null}
    </section>
  );
}
