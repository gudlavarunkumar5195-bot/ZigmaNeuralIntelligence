import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FlaskConical, ShieldCheck, Sparkles } from "lucide-react";
import { Card, PageHeader } from "../../components/ui/Card";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { apiListInstructionProfiles, apiSimulateInstructions, IntegrationRequired, type AgentRiskLevel, type AgentType, type InstructionProfileView } from "../../services/api";

const AGENTS: AgentType[] = ["DISCOVERY", "SEO_ANALYSIS", "AEO_ANALYSIS", "GEO_ANALYSIS", "SECURITY_ANALYSIS", "PERFORMANCE_ANALYSIS", "ACCESSIBILITY_ANALYSIS", "QA_ANALYSIS", "SSL_ANALYSIS", "REMEDIATION", "REPORT_SYNTHESIS"];

export function Instructions() {
  const [profiles, setProfiles] = useState<InstructionProfileView[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [agentType, setAgentType] = useState<AgentType>("SEO_ANALYSIS");
  const [riskLevel, setRiskLevel] = useState<AgentRiskLevel>("MEDIUM");
  const [result, setResult] = useState<{ plan: { status: string; reasonCodes: string[]; explanation: string; additionalInstructions: Array<{ text: string }> }; validation: { status: string; violations: string[] }; composition: { hash: string; orderedSections: unknown[] } } | null>(null);
  const [simulating, setSimulating] = useState(false);

  const load = () => {
    setLoading(true); setError(null);
    apiListInstructionProfiles().then((response) => {
      if (response.error) throw new Error(response.error.message);
      setProfiles(response.data ?? []);
    }).catch(setError).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const simulate = async () => {
    setSimulating(true); setResult(null);
    try {
      const response = await apiSimulateInstructions({ agentType, taskId: "admin-simulation", riskLevel, context: {}, evidenceReferences: ["evidence-summary"] });
      if (response.error) throw new Error(response.error.message);
      setResult(response.data as typeof result);
    } catch (err) { setError(err as Error); } finally { setSimulating(false); }
  };

  if (loading) return <LoadingState label="Loading approved instruction profiles…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Instruction Intelligence" description="Instruction profiles and simulation require the connected backend; demo mode does not fabricate instruction decisions." />;
  if (error) return <ErrorState title="Unable to load instruction profiles" message={error.message} onRetry={load} />;

  return <div className="p-6 max-w-screen-xl mx-auto animate-slide-in">
    <PageHeader title="Instruction Intelligence" subtitle="Versioned agent contracts, deterministic validation, and controlled task specialization." />
    <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_0.9fr] gap-6 items-start">
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1 text-xs text-slate-500"><ShieldCheck size={14} className="text-emerald-600" /><span>System safety → platform policy → agent contract → task specialization</span></div>
        {profiles.map((profile) => {
          const open = expanded === profile.instructionProfileId;
          const mandatory = profile.instructions.filter((item) => item.mandatory);
          return <Card key={profile.instructionProfileId} padding="none" className="overflow-hidden">
            <button onClick={() => setExpanded(open ? null : profile.instructionProfileId)} className="w-full px-5 py-4 text-left flex items-center gap-4 hover:bg-slate-50 transition-colors">
              <div className="h-9 w-9 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-700"><Sparkles size={16} /></div>
              <div className="min-w-0 flex-1"><div className="text-sm font-700 text-slate-900">{profile.agentId.replaceAll("_", " ")}</div><div className="text-xs text-slate-500 mt-0.5">Profile v{profile.version} · {mandatory.length} mandatory controls</div></div>
              <span className="font-mono text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded">{profile.status}</span>{open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
            </button>
            {open && <div className="border-t border-slate-100 divide-y divide-slate-100">{profile.instructions.map((item) => <div className="px-5 py-3.5" key={item.id}><div className="flex items-center gap-2 mb-1.5"><span className="font-mono text-[10px] tracking-wide text-slate-500">{item.type}</span>{item.mandatory && <span className="text-[10px] font-700 text-red-600">MANDATORY</span>}<span className="ml-auto text-[10px] text-slate-400">v{item.version}</span></div><p className="text-xs leading-relaxed text-slate-600 whitespace-pre-line line-clamp-4">{item.text}</p></div>)}</div>}
          </Card>;
        })}
      </div>
      <Card className="sticky top-6">
        <div className="flex items-center gap-2 mb-1"><FlaskConical size={16} className="text-violet-600" /><h2 className="text-sm font-700 text-slate-900">Admin instruction simulator</h2></div>
        <p className="text-xs leading-relaxed text-slate-500 mb-5">Plans and validates an instruction set only. It never executes models or tools.</p>
        <div className="space-y-3"><label className="block text-xs font-600 text-slate-600">Agent<select value={agentType} onChange={(event) => setAgentType(event.target.value as AgentType)} className="mt-1.5 w-full rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">{AGENTS.map((agent) => <option key={agent}>{agent}</option>)}</select></label><label className="block text-xs font-600 text-slate-600">Risk<select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as AgentRiskLevel)} className="mt-1.5 w-full rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((risk) => <option key={risk}>{risk}</option>)}</select></label><button disabled={simulating} onClick={simulate} className="w-full rounded bg-blue-700 text-white text-xs font-700 py-2.5 hover:bg-blue-800 disabled:opacity-60">{simulating ? "Planning…" : "Simulate instruction plan"}</button></div>
        {result && <div className="mt-5 border-t border-slate-100 pt-4 space-y-3"><div className="flex gap-2 items-start"><CheckCircle2 size={16} className="text-emerald-600 mt-0.5" /><div><div className="text-xs font-700 text-slate-800">{result.plan.status}</div><p className="text-xs text-slate-500 mt-0.5">{result.plan.explanation}</p></div></div><div className="text-xs"><span className="font-600 text-slate-600">Reason codes: </span><span className="font-mono text-slate-500">{result.plan.reasonCodes.join(", ") || "—"}</span></div><div className="text-xs"><span className="font-600 text-slate-600">Validation: </span><span className="text-emerald-700">{result.validation.status}</span></div><div className="text-[10px] font-mono text-slate-400 break-all">composition {result.composition.hash}</div></div>}
      </Card>
    </div>
  </div>;
}
