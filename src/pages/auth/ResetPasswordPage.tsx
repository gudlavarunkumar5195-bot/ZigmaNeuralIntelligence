import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiConfirmPasswordReset, apiRequestPasswordReset } from "../../services/api";
import { buttonClass } from "../../components/ui/styles";
import { AuthLayout, authInput } from "./AuthLayout";

/**
 * Public password reset. Without a token: request a link (the answer is the
 * same whether or not the email exists). With ?token=: choose a new password;
 * the token is single-use and expires after 30 minutes.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  return (
    <AuthLayout>
      <h1 className="text-page-title text-slate-900">{token ? "Choose a new password" : "Reset your password"}</h1>
      <p className="mt-1 text-sm text-slate-500">{token ? "The reset link is single-use and expires after 30 minutes." : "We will email a reset link if an account exists for this address."}</p>
      {token ? <SetPassword token={token} /> : <RequestLink />}
      <p className="mt-6 text-xs"><Link to="/login" className="font-600 text-blue-700 hover:underline">Back to sign in</Link></p>
    </AuthLayout>
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
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-xs font-600 text-slate-700">Email
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${authInput} mt-1.5`} />
      </label>
      <button type="submit" disabled={busy} className={`${buttonClass("primary", "lg")} w-full`}>{busy ? "Sending…" : "Send reset link"}</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2 text-xs ${message.ok ? "border-slate-200 bg-slate-50 text-slate-700" : "border-red-200 bg-red-50 text-red-800"}`}>{message.text}</p> : null}
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
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-xs font-600 text-slate-700">New password
        <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${authInput} mt-1.5`} />
      </label>
      <label className="block text-xs font-600 text-slate-700">Repeat new password
        <input type="password" required minLength={8} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={`${authInput} mt-1.5`} />
      </label>
      <button type="submit" disabled={busy || message?.ok} className={`${buttonClass("primary", "lg")} w-full`}>{busy ? "Saving…" : "Set new password"}</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2 text-xs ${message.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>{message.text}</p> : null}
    </form>
  );
}
