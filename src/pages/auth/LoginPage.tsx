import { useState, useRef } from "react";
import { useNavigate } from "react-router";
import { Network, AlertCircle, Loader, Eye, EyeOff } from "lucide-react";
import { apiLogin, apiRegister } from "../../services/api";

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
          sessionStorage.setItem("zn_token", result.data.token);
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
          sessionStorage.setItem("zn_token", result.data.token);
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
    <div className="min-h-full flex flex-col items-center justify-center p-6" style={{ background: "var(--background)" }}>
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3" style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}>
            <Network size={22} className="text-white" />
          </div>
          <h1 className="text-xl font-700 text-slate-900">ZigmaNeural</h1>
          <p className="text-sm text-slate-500 mt-0.5">Website Intelligence Platform</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          {/* Tab toggle */}
          <div className="flex rounded-lg border border-slate-200 p-0.5 mb-5">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(""); }}
                className="flex-1 py-1.5 text-sm font-600 rounded-md transition-all"
                style={{
                  background: mode === m ? "#1d4ed8" : "transparent",
                  color: mode === m ? "#fff" : "#64748b",
                }}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === "register" && (
              <div>
                <label className="block text-xs font-600 text-slate-600 mb-1">Full name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  style={{ borderColor: "#e2e8f0" }}
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-600 text-slate-600 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                style={{ borderColor: error ? "#ef4444" : "#e2e8f0" }}
              />
            </div>

            <div>
              <label className="block text-xs font-600 text-slate-600 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
                  required
                  className="w-full px-3 py-2 pr-9 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  style={{ borderColor: error ? "#ef4444" : "#e2e8f0" }}
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
                <label className="block text-xs font-600 text-slate-600 mb-1">Organization name</label>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Organization name"
                  required
                  className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  style={{ borderColor: "#e2e8f0" }}
                />
              </div>
            )}

            {error && (
              <div role="alert" className="flex items-start gap-2 text-xs text-red-600">
                <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-600 text-white transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed mt-1"
              style={{ background: "#1d4ed8" }}
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
  );
}
