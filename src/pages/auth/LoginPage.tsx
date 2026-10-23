import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Network, AlertCircle, Loader, Eye, EyeOff } from "lucide-react";
import { apiLogin, apiRegister, setToken, takeReturnPath } from "../../services/api";
import { buttonClass } from "../../components/ui/styles";
import { AuthLayout, authInput, authLabel } from "./AuthLayout";

type Mode = "login" | "register";

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);


    try {
      if (mode === "login") {
        const result = await apiLogin(email, password);
        if (result.error) {
          setError(result.error.message);
          return;
        }
        if (!result.data?.token) {
          setError("Sign-in did not return a session. Please try again.");
          return;
        }
        setToken(result.data.token);
        navigate(takeReturnPath() ?? "/", { replace: true });
      } else {
        if (!orgName.trim()) {
          setError("Organization name is required.");
          return;
        }
        const result = await apiRegister(email, password, fullName, orgName);
        if (result.error) {
          setError(result.error.message);
          return;
        }
        if (!result.data?.token) {
          setError("Account creation did not return a session. Please try again.");
          return;
        }
        setToken(result.data.token);
        navigate(takeReturnPath() ?? "/", { replace: true });
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message || "An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

  const invalid = error ? true : undefined;

  return (
    <AuthLayout>
      <div className="mb-7 flex flex-col items-center text-center lg:items-start lg:text-left">
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm lg:hidden">
          <Network size={20} aria-hidden="true" />
        </span>
        <h1 className="text-page-title text-slate-900">ZigmaNeural</h1>
        <p className="mt-1 text-sm text-slate-500">{mode === "login" ? "Sign in to your website intelligence workspace." : "Create an account and an organization for your team."}</p>
      </div>

      <div role="group" aria-label="Account" className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => { setMode(m); setError(""); }}
            className={`h-9 rounded-md text-[13px] font-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
          >
            {m === "login" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} onInvalid={() => setError("Email and password are required.")} className="space-y-4">
        {mode === "register" && (
          <div>
            <label htmlFor="full-name" className={authLabel}>Full name</label>
            <input id="full-name" type="text" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" className={authInput} />
          </div>
        )}

        <div>
          <label htmlFor="email" className={authLabel}>Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(""); }}
            placeholder="you@company.com"
            required
            autoFocus
            aria-invalid={invalid}
            aria-describedby={error ? "auth-error" : undefined}
            className={authInput}
          />
        </div>

        <div>
          <label htmlFor="password" className={authLabel}>Password</label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              placeholder={mode === "register" ? "At least 8 characters" : undefined}
              required
              aria-invalid={invalid}
              aria-describedby={error ? "auth-error" : undefined}
              className={`${authInput} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {mode === "login" ? <p className="-mt-2 text-right text-xs"><Link to="/reset-password" className="font-600 text-blue-700 hover:underline">Forgot password?</Link></p> : null}

        {mode === "register" && (
          <div>
            <label htmlFor="organization-name" className={authLabel}>Organization name</label>
            <input id="organization-name" type="text" autoComplete="organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Organization name" required className={authInput} />
          </div>
        )}

        {error && (
          <div id="auth-error" role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className={`${buttonClass("primary", "lg")} w-full`}>
          {loading && <Loader size={14} className="animate-spin" aria-hidden="true" />}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="mt-8 text-center text-xs text-slate-500 lg:text-left">
        Secure Website Intelligence Platform · v{__APP_VERSION__}
      </p>
    </AuthLayout>
  );
}
