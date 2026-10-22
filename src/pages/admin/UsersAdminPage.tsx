import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import {
  apiAdminChangeRole,
  apiAdminCredentialAccount,
  apiAdminGenerateCredentials,
  apiAdminRevokeSessions,
  apiAdminSendPasswordReset,
  apiAdminSetUserActive,
  apiAdminUser,
  apiAdminUsers,
  IntegrationRequired,
  type AdminUser,
} from "../../services/api";
import { btn, btnDanger, btnPrimary, fmtTime, PageHeader, StatusPill } from "./adminShared";

/** Admin → Users & access. Every action is confirmed here and enforced and audited on the server. */
export function UsersAdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "active" | "inactive">("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (more?: string | null) => {
    setError(null);
    try {
      const r = await apiAdminUsers({ search: search || undefined, status: status || undefined, cursor: more ?? undefined });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      setUsers((prev) => (more ? [...(prev ?? []), ...(r.data ?? [])] : r.data ?? []));
      setCursor(r.meta?.nextCursor ?? null);
    } catch (e) {
      setError(e as Error);
    }
  }, [search, status]);
  useEffect(() => {
    setUsers(null);
    void load();
  }, [load]);

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="User administration" />;
  if (error) return <ErrorState title={(error as { code?: string }).code === "PLATFORM_ADMIN_REQUIRED" ? "Platform administrators only" : "Unable to load users"} message={error.message} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader eyebrow="Administration" title="Users & access" />
      <CredentialGenerator />

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <form role="search" aria-label="Search users" className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}>
          <label className="text-xs text-slate-700">Email or name<input value={searchInput} maxLength={200} onChange={(e) => setSearchInput(e.target.value)} className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          <button type="submit" className={btn}>Search</button>
        </form>
        <label className="text-xs text-slate-700">Status
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="">All</option><option value="active">Active</option><option value="inactive">Deactivated</option>
          </select>
        </label>
      </div>

      {!users ? <LoadingState label="Loading users…" /> : users.length === 0 ? <p className="mt-4 text-sm text-slate-600">No users match.</p> : (
        <table className="mt-4 w-full text-left text-xs">
          <caption className="sr-only">Users</caption>
          <thead className="text-slate-500"><tr><th className="py-1 pr-2">User</th><th className="py-1 pr-2">Status</th><th className="py-1 pr-2">Organizations</th><th className="py-1 pr-2">Created</th><th className="py-1 pr-2">Last sign-in</th><th className="py-1">Sessions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={`border-t border-slate-100 align-top ${selected === u.id ? "bg-blue-50/50" : ""}`}>
                <td className="py-1.5 pr-2">
                  <button type="button" className="text-left font-600 text-slate-900 hover:underline" onClick={() => setSelected(u.id)}>{u.email}</button>
                  {u.isPlatformAdmin ? <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-700 text-violet-800">platform admin</span> : null}
                  {u.full_name ? <span className="block text-slate-500">{u.full_name}</span> : null}
                </td>
                <td className="py-1.5 pr-2"><StatusPill status={u.active ? "ok" : "failed"} label={u.active ? "Active" : "Deactivated"} /></td>
                <td className="py-1.5 pr-2">{u.memberships.map((m) => `${m.orgName} (${m.role})`).join(", ") || "—"}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">{fmtTime(u.created_at)}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">{u.last_login_at ? fmtTime(u.last_login_at) : "Not recorded"}</td>
                <td className="py-1.5">{u.active_sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor ? <button type="button" className={`${btn} mt-3`} onClick={() => void load(cursor)}>Load more</button> : null}
      {selected ? <UserDetail key={selected} userId={selected} onChanged={() => void load()} /> : null}
    </div>
  );
}

function UserDetail({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiAdminUser>>["data"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<null | { label: string; run: () => Promise<void> }>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiAdminUser(userId);
    if (r.error) return setError(r.error.message);
    setData(r.data);
  }, [userId]);
  useEffect(() => void load(), [load]);

  const act = (label: string, fn: () => Promise<{ error: { message: string } | null }>, success: string) =>
    setConfirm({
      label,
      run: async () => {
        setBusy(true);
        setConfirm(null);
        try {
          const r = await fn();
          setNotice(r.error ? { ok: false, text: r.error.message } : { ok: true, text: success });
          if (!r.error) {
            await load();
            onChanged();
          }
        } finally {
          setBusy(false);
        }
      },
    });

  if (error) return <p role="alert" className="mt-4 text-sm text-red-800">{error}</p>;
  if (!data) return <LoadingState label="Loading user…" />;
  const u = data.user;

  return (
    <section aria-label={`User ${u.email}`} className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-800 text-slate-950">{u.email}</h3>
      <p className="text-xs text-slate-600">ID {u.id} · {u.active ? "active" : "deactivated"} · {u.active_sessions} active session(s){u.isPlatformAdmin ? " · platform administrator (set by PLATFORM_ADMIN_USER_IDS)" : ""}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {u.active
          ? <button type="button" className={btnDanger} disabled={busy} onClick={() => act(`Deactivate ${u.email}? All their sessions end immediately.`, () => apiAdminSetUserActive(u.id, false), "Account deactivated and sessions revoked.")}>Deactivate</button>
          : <button type="button" className={btn} disabled={busy} onClick={() => act(`Reactivate ${u.email}?`, () => apiAdminSetUserActive(u.id, true), "Account reactivated.")}>Activate</button>}
        <button type="button" className={btn} disabled={busy} onClick={() => act(`Sign ${u.email} out everywhere?`, () => apiAdminRevokeSessions(u.id), "Sessions revoked; access tokens expire within 15 minutes.")}>Revoke sessions</button>
        <button type="button" className={btn} disabled={busy} onClick={() => act(`Email ${u.email} a password-reset link? You will not see the link.`, () => apiAdminSendPasswordReset(u.id), "Reset link sent.")}>Send password-reset link</button>
      </div>

      {u.memberships.length ? (
        <table className="mt-4 w-full max-w-xl text-left text-xs">
          <caption className="text-left text-xs font-700 text-slate-900">Organization roles</caption>
          <tbody>
            {u.memberships.map((m) => (
              <tr key={m.orgId} className="border-t border-slate-100">
                <td className="py-1.5 pr-2">{m.orgName}</td>
                <td className="py-1.5">
                  <label className="sr-only" htmlFor={`role-${m.orgId}`}>Role in {m.orgName}</label>
                  <select id={`role-${m.orgId}`} value={m.role} disabled={busy} className="rounded border border-slate-300 px-2 py-1 text-xs"
                    onChange={(e) => {
                      const role = e.target.value as typeof m.role;
                      act(`Change ${u.email}'s role in ${m.orgName} from ${m.role} to ${role}?`, () => apiAdminChangeRole(u.id, m.orgId, role), `Role changed to ${role}.`);
                    }}>
                    {(["owner", "admin", "member", "viewer"] as const).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {confirm ? (
        <div role="alertdialog" aria-label="Confirm action" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <span>{confirm.label}</span>
          <button type="button" className={btnPrimary} onClick={() => void confirm.run()}>Confirm</button>
          <button type="button" className={btn} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      ) : null}
      {notice ? <p role={notice.ok ? "status" : "alert"} className={`mt-2 rounded px-3 py-2 text-xs ${notice.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}>{notice.text}</p> : null}

      <h4 className="mt-4 text-xs font-700 text-slate-900">Recent access events</h4>
      {data.events.length === 0 ? <p className="text-xs text-slate-600">None recorded.</p> : (
        <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
          {data.events.map((e, i) => <li key={i}>{fmtTime(e.timestamp)} · {e.action.replace(/_/g, " ")} · {e.result}{e.byUser === "admin" ? " · by an administrator" : ""}</li>)}
        </ul>
      )}
    </section>
  );
}

/**
 * One-click login credentials for the designated account. The server
 * generates the password; it is shown once, kept only in this component's
 * memory, and cleared when hidden, after five minutes, or on navigation.
 */
function CredentialGenerator() {
  const [account, setAccount] = useState<{ email: string; exists: boolean; active: boolean | null } | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "confirm">("idle");
  const [result, setResult] = useState<{ email: string; password: string; created: boolean; accountActive: boolean; revokedSessions: number } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    apiAdminCredentialAccount().then((r) => { if (r.data) setAccount(r.data); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 5 * 60_000);
    return () => clearTimeout(t);
  }, [result]);

  const email = account?.email ?? "info@zigmaneural.com";

  const generate = async (confirmReset: boolean) => {
    if (inFlight.current) return; // duplicate clicks while a request is running
    inFlight.current = true;
    setState("busy");
    setMessage(null);
    setResult(null);
    try {
      const r = await apiAdminGenerateCredentials(email, confirmReset);
      if (r.error?.code === "CONFIRMATION_REQUIRED") {
        setState("confirm");
        return;
      }
      setState("idle");
      if (r.error) return setMessage({ ok: false, text: r.error.message });
      setResult(r.data);
      setAccount((a) => (a ? { ...a, exists: true, active: r.data!.accountActive } : a));
    } catch (e) {
      setState("idle");
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      inFlight.current = false;
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.password);
      setMessage({ ok: true, text: "Password copied. Paste it into your password manager now." });
    } catch {
      setMessage({ ok: false, text: "Copy failed; select the password and copy it manually." });
    }
  };

  return (
    <section aria-labelledby="cred-h" className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <h3 id="cred-h" className="text-sm font-800 text-slate-950">Login credentials for {email}</h3>
      <p className="mt-1 text-xs text-slate-600">
        Generates a strong password on the server{account?.exists ? " and replaces this account's current password (its sessions are signed out)" : " and creates the account with its own organization"}. Existing passwords can never be viewed.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-700">Email
          <input value={email} readOnly aria-readonly="true" className="mt-1 block w-72 cursor-not-allowed rounded border border-slate-300 bg-slate-100 px-2 py-1 text-sm text-slate-700" />
        </label>
        <button type="button" className={btnPrimary} disabled={state !== "idle"} onClick={() => void generate(false)}>{state === "busy" ? "Generating…" : "Generate Login Credentials"}</button>
      </div>
      {account?.exists && account.active === false ? <p className="mt-2 text-xs text-amber-900">This account is deactivated: activate it below before the new password can be used.</p> : null}

      {state === "confirm" ? (
        <div role="alertdialog" aria-label="Confirm password replacement" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <p>{email} already exists. Replace its password? Everyone signed in with it will be signed out.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnDanger} onClick={() => void generate(true)}>Replace password</button>
            <button type="button" className={btn} onClick={() => setState("idle")}>Cancel</button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div role="region" aria-label="Generated credentials" className="mt-3 rounded-lg border border-slate-300 bg-white p-3 text-xs">
          <p className="font-700 text-red-800">Save this password in a password manager now. It is shown only once and cannot be retrieved later.</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="font-600">Email</dt><dd className="font-mono">{result.email}</dd>
            <dt className="font-600">Password</dt><dd className="font-mono select-all break-all" data-testid="generated-password">{result.password}</dd>
          </dl>
          <p className="mt-2 text-slate-600">{result.created ? "Account created." : `Password replaced; ${result.revokedSessions} session(s) signed out.`}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnPrimary} onClick={() => void copy()}>Copy Password</button>
            <button type="button" className={btn} onClick={() => { setResult(null); setMessage(null); }}>Hide</button>
          </div>
        </div>
      ) : null}
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-emerald-900" : "text-red-800"}`}>{message.text}</p> : null}
    </section>
  );
}
