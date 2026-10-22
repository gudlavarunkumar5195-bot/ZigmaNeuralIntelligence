import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, CheckCircle2, Globe2, ShieldCheck } from "lucide-react";
import { apiAddWebsite, apiVerifyOwnership, ApiCallError, IntegrationRequired } from "../../services/api";
import { PageHeader } from "../../components/ui/Card";
import { ErrorState, IntegrationRequiredState } from "../../components/ui/DataState";
import { Notice } from "../../components/ui/Primitives";
import { buttonClass, card } from "../../components/ui/styles";
import { validateScanUrl } from "../../lib/validation";

const METHOD_LABEL: Record<string, string> = { html: "HTML meta tag", dns: "DNS TXT record", file: "verification file" };

/** Website onboarding: add a URL, then prove ownership before any scan can run. */
export function AddWebsite() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("html");
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [website, setWebsite] = useState<{ id: string; domain: string; verification_token: string | null } | null>(null);
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const check = validateScanUrl(url);
    if (!check.valid) { setError(new Error(check.error ?? "Enter a valid public URL.")); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await apiAddWebsite(check.normalizedUrl ?? url, method);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setWebsite(result.data as { id: string; domain: string; verification_token: string | null });
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setSaving(false);
    }
  };
  const verify = async () => {
    if (!website) return;
    setChecking(true);
    setError(null);
    try {
      const result = await apiVerifyOwnership(website.id);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setVerified(true);
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setChecking(false);
    }
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Add website" />;

  const steps = (
    <ol aria-label="Steps" className="mb-5 flex gap-2 text-[11px] font-600">
      {["Add the website", "Verify ownership", "Scan"].map((s, i) => {
        const done = (i === 0 && !!website) || (i === 1 && verified);
        const current = (i === 0 && !website) || (i === 1 && !!website && !verified) || (i === 2 && verified);
        return (
          <li key={s} aria-current={current ? "step" : undefined} className={`flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 ${current ? "border-blue-300 bg-blue-50 text-blue-800" : done ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-500"}`}>
            <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] ${current ? "bg-blue-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}>{done ? "✓" : i + 1}</span>
            <span className="truncate">{s}{done ? <span className="sr-only"> (done)</span> : null}</span>
          </li>
        );
      })}
    </ol>
  );

  if (website) {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader eyebrow="Ownership check" title={`Verify ${website.domain}`} subtitle={METHOD_LABEL[method] ? `Add this token using the selected ${METHOD_LABEL[method]}, then check the site.` : "Check the site; the server confirms whether this account may use the selected method."} />
        {steps}
        <div className={card}>
          <p className="text-[11px] font-600 uppercase tracking-[.12em] text-slate-500">Verification token</p>
          <code className="mt-2 block break-all rounded-md bg-slate-50 p-2.5 font-mono text-sm text-slate-900">{website.verification_token ?? "Token unavailable"}</code>
          <p className="mt-3 text-xs leading-5 text-slate-500">The server fetches the public site and confirms this exact token{METHOD_LABEL[method] ? ` (${METHOD_LABEL[method]})` : ""} before allowing scans.</p>
        </div>
        {error && <div className="mt-5"><ErrorState title="Ownership check failed" message={error.message} /></div>}
        {verified
          ? <div role="status" className="mt-5 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-700 text-emerald-800"><CheckCircle2 size={17} aria-hidden="true" />Ownership verified</div>
          : <button onClick={verify} disabled={checking} className={`${buttonClass("primary", "lg")} mt-5 w-full`}>{checking ? "Checking website…" : "Check ownership"}<ShieldCheck size={15} aria-hidden="true" /></button>}
        {verified && <button onClick={() => navigate("/websites")} className={`${buttonClass("secondary", "lg")} mt-3 w-full`}>Continue to websites</button>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow="Website onboarding" title="Connect a website" subtitle="Only submit websites you own or have explicit authorization to assess. Server-side URL validation blocks private and internal networks." />
      {steps}
      <form onSubmit={submit} className={`${card} space-y-5`}>
        <label className="block">
          <span className="text-xs font-600 text-slate-700">Public website URL</span>
          <div className="relative mt-1">
            <Globe2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-domain.com" className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm shadow-sm outline-none hover:border-slate-400 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500" />
          </div>
        </label>
        <label className="block">
          <span className="text-xs font-600 text-slate-700">Verification method</span>
          <select value={method} onChange={(event) => setMethod(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <option value="html">HTML meta tag</option><option value="dns">DNS TXT record</option><option value="file">Verification file</option><option value="qa_bypass">QA/Test Verification (authorized users only)</option>
          </select>
        </label>
        {method === "qa_bypass" && <Notice tone="warning">This verification method is available only to authorized QA/admin users for the approved ZigmaNeural test domain. The server enforces this restriction.</Notice>}
        {error && <ErrorState title="Website could not be connected" message={error.message} />}
        <Notice tone="info">Ownership verification is required before a scan can start.</Notice>
        <button disabled={saving} className={`${buttonClass("primary", "lg")} w-full`}>{saving ? "Connecting…" : "Connect website"}<ArrowRight size={15} aria-hidden="true" /></button>
      </form>
    </div>
  );
}
