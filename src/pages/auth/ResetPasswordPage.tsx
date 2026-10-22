import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiConfirmPasswordReset, apiRequestPasswordReset } from "../../services/api";

/**
 * Public password reset. Without a token: request a link (the answer is the
 * same whether or not the email exists). With ?token=: choose a new password;
 * the token is single-use and expires after 30 minutes.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-800 text-slate-950">{token ? "Choose a new password" : "Reset your password"}</h1>
        {token ? <SetPassword token={token} /> : <RequestLink />}
        <p className="mt-4 text-xs"><Link to="/login" className="font-600 text-blue-700 underline">Back to sign in</Link></p>
      </div>
    </div>
  );
}

function RequestLink() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await apiRequestPasswordReset(email.trim());
      setMessage(r.error ? { ok: false, text: r.error.message } : { ok: true, text: r.data?.message ?? "Request received." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block text-xs text-slate-700">Email
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-950 py-2 text-sm font-700 text-white disabled:opacity-50">{busy ? "Sending…" : "Send reset link"}</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-slate-700" : "text-red-800"}`}>{message.text}</p> : null}
      <p className="text-[11px] text-slate-500">If you do not receive an email, ask a platform administrator: email delivery may not be configured on this installation.</p>
    </form>
  );
}

function SetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setMessage({ ok: false, text: "The passwords do not match." });
    if (password.length < 8) return setMessage({ ok: false, text: "Use at least 8 characters." });
    setBusy(true);
    try {
      const r = await apiConfirmPasswordReset(token, password);
      setMessage(r.error ? { ok: false, text: r.error.message } : { ok: true, text: r.data?.message ?? "Password changed." });
      if (!r.error) {
        setPassword("");
        setRepeat("");
      }
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block text-xs text-slate-700">New password
        <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="block text-xs text-slate-700">Repeat new password
        <input type="password" required minLength={8} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <button type="submit" disabled={busy || message?.ok} className="w-full rounded-md bg-slate-950 py-2 text-sm font-700 text-white disabled:opacity-50">{busy ? "Saving…" : "Set new password"}</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-emerald-800" : "text-red-800"}`}>{message.text}</p> : null}
    </form>
  );
}
