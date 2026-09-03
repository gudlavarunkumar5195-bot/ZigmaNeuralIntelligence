import { useState, useRef } from "react";
import { useNavigate } from "react-router";
import { Network, AlertCircle, Loader, Eye, EyeOff, Sparkles } from "lucide-react";
import { apiLogin, apiRegister, setToken } from "../../services/api";

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

  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      if (mode === "login") {
        const result = await apiLogin(email, password);
        if (result.error) {
          setError(result.error.message);
          return;
        }
        if (result.data?.token) {
          setToken(result.data.token);
          navigate("/");
        }
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
        if (result.data?.token) {
          setToken(result.data.token);
          navigate("/");
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message || "An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell min-h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-6xl grid gap-8 lg:grid-cols-[1.2fr_0.8fr] items-center">
        <div className="hidden lg:flex flex-col gap-8 p-8">
          <div className="brand-chip w-fit">
            <Sparkles size={12} />
            New gen intelligence
          </div>

          <div className="space-y-5">
            <h1 className="text-5xl font-800 leading-tight tracking-[-0.06em] text-slate-900">
              Turn website signals into <span className="text-blue-700">business decisions.</span>
            </h1>
            <p className="max-w-xl text-lg text-slate-600">
              Track SEO, AI visibility, performance, security, and product quality in one intelligent workspace built for modern teams.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 max-w-xl">
            {[
              ["92%", "SEO uplift"],
              ["38ms", "Faster scan loops"],
              ["24/7", "Live monitoring"],
            ].map(([value, label]) => (
              <div key={label} className="metric-card p-4">
                <div className="text-2xl font-800 text-slate-900">{value}</div>
                <div className="mt-1 text-xs font-600 uppercase tracking-[0.1em] text-slate-500">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full max-w-md mx-auto">
          <div className="login-card rounded-[30px] p-6 sm:p-7">
            <div className="flex flex-col items-center mb-7">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3 brand-highlight">
                <Network size={23} className="text-white" />
              </div>
              <h2 className="text-2xl font-800 tracking-[-0.05em] text-slate-900">ZigmaNeural</h2>
              <p className="mt-1 text-sm text-slate-500">Website intelligence platform</p>
            </div>

            <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-1 mb-5">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setError(""); }}
                  className="flex-1 py-2.5 text-sm font-700 rounded-lg transition-all"
                  style={{
                    background: mode === m ? "linear-gradient(135deg, #1d4ed8, #2563eb, #60a5fa)" : "transparent",
                    color: mode === m ? "#fff" : "#64748b",
                    boxShadow: mode === m ? "0 12px 22px rgba(59, 130, 246, 0.22)" : "none",
                  }}
                >
                  {m === "login" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} onInvalid={() => setError("Email and password are required.")} className="space-y-3.5">
              {mode === "register" && (
                <div>
                  <label htmlFor="full-name" className="block text-xs font-700 uppercase tracking-[0.12em] text-slate-500 mb-1.5">Full name</label>
                  <input
                    id="full-name"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Your full name"
                    className="w-full px-3.5 py-2.5 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    style={{ borderColor: error ? "#ef4444" : "rgba(148,163,184,0.35)", background: "rgba(255,255,255,0.8)" }}
                  />
                </div>
              )}

              <div>
                <label htmlFor="email" className="block text-xs font-700 uppercase tracking-[0.12em] text-slate-500 mb-1.5">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(""); }}
                  placeholder="you@company.com"
                  required
                  autoFocus
                  className="w-full px-3.5 py-2.5 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  style={{ borderColor: error ? "#ef4444" : "rgba(148,163,184,0.35)", background: "rgba(255,255,255,0.8)" }}
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-xs font-700 uppercase tracking-[0.12em] text-slate-500 mb-1.5">Password</label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(""); }}
                    placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
                    required
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    style={{ borderColor: error ? "#ef4444" : "rgba(148,163,184,0.35)", background: "rgba(255,255,255,0.8)" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {mode === "register" && (
                <div>
                  <label htmlFor="organization-name" className="block text-xs font-700 uppercase tracking-[0.12em] text-slate-500 mb-1.5">Organization name</label>
                  <input
                    id="organization-name"
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Organization name"
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    style={{ borderColor: "rgba(148,163,184,0.35)", background: "rgba(255,255,255,0.8)" }}
                  />
                </div>
              )}

              {error && (
                <div role="alert" className="flex items-start gap-2 text-xs text-red-600 rounded-xl border border-red-100 bg-red-50 px-3 py-2">
                  <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="primary-button w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-700 text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-1"
              >
                {loading && <Loader size={14} className="animate-spin" />}
                {mode === "login" ? "Sign in" : "Create account"}
              </button>
            </form>
          </div>

          <p className="text-xs text-slate-400 text-center mt-4">
            Secure Website Intelligence Platform
          </p>
        </div>
      </div>
    </div>
  );
}
