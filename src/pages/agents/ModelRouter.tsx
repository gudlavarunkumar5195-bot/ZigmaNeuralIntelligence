import { useState, useEffect } from "react";
import type React from "react";
import { Card } from "../../components/ui/Card";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Filter,
  Info,
  Play,
  RefreshCw,
  Settings,
  XCircle,
  Zap,
} from "lucide-react";
import { IS_DEMO } from "../../config/env";
import {
  apiSimulateRouting,
  apiGetRoutingDecisions,
  apiGetRoutingPolicy,
  IntegrationRequired,
  type RoutingRequirements,
  type RoutingDecisionSummary,
  type RoutingPolicy,
  type TaskType,
  type ModelCapability,
} from "../../services/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "simulator" | "history" | "policy";

// ─── Constants ────────────────────────────────────────────────────────────────

const TASK_TYPES: TaskType[] = [
  "DISCOVERY", "SEO_ANALYSIS", "AEO_ANALYSIS", "GEO_ANALYSIS",
  "SECURITY_ANALYSIS", "PERFORMANCE_ANALYSIS", "ACCESSIBILITY_ANALYSIS",
  "QA_ANALYSIS", "SSL_ANALYSIS", "REMEDIATION", "CODE_GENERATION",
  "REPORT_SYNTHESIS", "EVIDENCE_SUMMARIZATION", "STRUCTURED_EXTRACTION",
];

const CAPABILITIES: ModelCapability[] = [
  "REASONING", "CODING", "VISION", "TOOL_CALLING", "STRUCTURED_OUTPUT",
  "LONG_CONTEXT", "SEO", "SECURITY", "ACCESSIBILITY", "PERFORMANCE",
];

const TABS: Tab[] = ["simulator", "history", "policy"];

type ComplexityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type BoolKey = "structuredOutputRequired" | "toolCallingRequired" | "visionRequired" | "freeOnly";

const BOOL_FIELDS: Array<{ label: string; key: BoolKey }> = [
  { label: "Structured output required", key: "structuredOutputRequired" },
  { label: "Tool calling required", key: "toolCallingRequired" },
  { label: "Vision required", key: "visionRequired" },
  { label: "Free models only", key: "freeOnly" },
];

const COMPLEXITY_LEVELS: ComplexityLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const SCORE_KEYS = ["benchmark", "reliability", "capability", "latency", "context"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function confidenceColor(v: number): string {
  return v >= 80 ? "#10b981" : v >= 60 ? "#3b82f6" : v >= 40 ? "#f59e0b" : "#ef4444";
}

function ScoreBar({ value, label }: { value: number; label?: string }) {
  const color = confidenceColor(value);
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-slate-500 w-24 flex-shrink-0 capitalize">{label}</span>}
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="font-mono text-xs font-700 w-7 text-right" style={{ color }}>{Math.round(value)}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    RESOLVED: "bg-green-50 text-green-700 border-green-200",
    NO_CANDIDATES: "bg-amber-50 text-amber-700 border-amber-200",
    ERROR: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-500 border ${map[status] ?? "bg-slate-50 text-slate-500 border-slate-200"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, string> = {
    OX_ALPHA: "bg-purple-50 text-purple-700 border-purple-200",
    DETERMINISTIC: "bg-blue-50 text-blue-700 border-blue-200",
    FALLBACK: "bg-slate-50 text-slate-600 border-slate-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-500 border ${map[source] ?? "bg-slate-50 text-slate-500 border-slate-200"}`}>
      {source === "OX_ALPHA" && <Zap size={10} />}
      {source.replace("_", " ")}
    </span>
  );
}

// ─── Integration required placeholder ────────────────────────────────────────

function IntegrationPlaceholder() {
  return (
    <div className="p-6 max-w-screen-xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-700 text-slate-900">Model Router</h1>
        <p className="text-sm text-slate-500 mt-0.5">OX Alpha Intelligent Model Routing Engine</p>
      </div>

      <div className="flex items-center gap-3 p-3.5 rounded-lg bg-amber-50 border border-amber-200 mb-6">
        <AlertTriangle size={15} className="text-amber-600 flex-shrink-0" />
        <p className="text-xs text-amber-800">
          <strong>Backend integration required.</strong> Configure{" "}
          <code className="bg-amber-100 px-1 rounded">VITE_API_BASE_URL</code> and{" "}
          <code className="bg-amber-100 px-1 rounded">OPENROUTER_API_KEY</code> to enable the routing engine.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-600 text-slate-800 mb-3 text-sm">Routing Architecture</h3>
          <ol className="space-y-2 text-xs text-slate-600">
            {[
              "Task → TaskRequirements (system-trusted, never from website content)",
              "Model Registry → all AVAILABLE / ELIGIBLE models loaded",
              "Eligibility filter → hard constraints applied deterministically",
              "Candidate scoring → weighted: benchmark 30%, reliability 20%, capability 15%…",
              "OX Alpha selection → picks from eligible set, validates response",
              "Routing decision → persisted with full candidate score breakdown",
            ].map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-700 text-slate-400 flex-shrink-0 w-4">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card>
          <h3 className="font-600 text-slate-800 mb-3 text-sm">Hard Constraints (cannot be overridden)</h3>
          <ul className="space-y-1.5 text-xs text-slate-600">
            {[
              "Disabled / ineligible models always excluded",
              "Free-only policy: PAID models blocked when active",
              "Missing required capability (structured output, vision, tool calling)",
              "Context window below task minimum",
              "Provider or model on exclusion list",
              "OX Alpha CANNOT override any of the above",
            ].map((rule) => (
              <li key={rule} className="flex items-center gap-2">
                <XCircle size={11} className="text-red-400 flex-shrink-0" />
                {rule}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

// ─── Simulator ────────────────────────────────────────────────────────────────

interface SimulatorState {
  taskType: TaskType;
  complexity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  structuredOutputRequired: boolean;
  toolCallingRequired: boolean;
  visionRequired: boolean;
  freeOnly: boolean;
  requiredCapabilities: ModelCapability[];
  preferredCapabilities: ModelCapability[];
}

const defaultSim: SimulatorState = {
  taskType: "SEO_ANALYSIS",
  complexity: "MEDIUM",
  riskLevel: "MEDIUM",
  structuredOutputRequired: false,
  toolCallingRequired: false,
  visionRequired: false,
  freeOnly: false,
  requiredCapabilities: [],
  preferredCapabilities: [],
};

function CapabilityToggle({ cap, selected, onToggle }: { cap: ModelCapability; selected: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`px-2.5 py-1 rounded-full text-xs font-500 border transition-colors ${
        selected ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
      }`}
    >
      {cap.replace(/_/g, " ")}
    </button>
  );
}

interface SimResultData {
  status: string;
  selectedModel: {
    openrouterId: string; displayName: string; compositeScore: number;
    components: Record<string, { value: number; status: string; detail?: string }>;
  } | null;
  fallbackModels: Array<{ openrouterId: string; displayName: string; compositeScore: number }>;
  allCandidates: Array<{ openrouterId: string; displayName: string; compositeScore: number; components: Record<string, { value: number; status: string }> }>;
  excludedCandidates: Array<{ openrouterId: string; displayName: string; reason: string; detail?: string }>;
  decisionReason: string;
  decisionConfidence: number;
  decisionSource: string;
  decisionDurationMs: number;
}

function SimulatorResult({ result }: { result: SimResultData }) {
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (result.status === "NO_CANDIDATES") {
    return (
      <Card className="border-amber-200 bg-amber-50">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={15} className="text-amber-600" />
          <span className="font-600 text-amber-800 text-sm">No eligible candidates</span>
        </div>
        <p className="text-xs text-amber-700">{result.decisionReason}</p>
        {result.excludedCandidates.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-600 text-amber-700 mb-1.5">{result.excludedCandidates.length} model(s) excluded:</p>
            <ul className="space-y-1">
              {result.excludedCandidates.map((ex) => (
                <li key={ex.openrouterId} className="text-xs text-amber-700 flex items-center gap-1.5">
                  <XCircle size={10} />
                  <span className="font-500">{ex.displayName}</span>
                  <span className="text-amber-500">— {ex.reason.replace(/_/g, " ")}{ex.detail ? `: ${ex.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    );
  }

  const { selectedModel, fallbackModels, allCandidates, excludedCandidates } = result;
  if (!selectedModel) return null;


  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <SourceBadge source={result.decisionSource} />
        <span className="text-xs text-slate-500">
          Confidence:{" "}
          <span className="font-700 ml-1" style={{ color: confidenceColor(result.decisionConfidence) }}>
            {result.decisionConfidence}%
          </span>
        </span>
        <span className="text-xs text-slate-400">{result.decisionDurationMs}ms</span>
      </div>

      {/* Primary selection */}
      <Card className="border-green-200 bg-green-50">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <CheckCircle2 size={13} className="text-green-600" />
              <span className="text-xs font-600 text-green-700 uppercase tracking-wide">Primary selection</span>
            </div>
            <p className="font-700 text-slate-800">{selectedModel.displayName}</p>
            <p className="text-xs text-slate-400 font-mono mt-0.5">{selectedModel.openrouterId}</p>
          </div>
          <div className="text-right">
            <div className="font-mono text-2xl font-700" style={{ color: confidenceColor(selectedModel.compositeScore) }}>
              {selectedModel.compositeScore.toFixed(1)}
            </div>
            <div className="text-xs text-slate-400">composite</div>
          </div>
        </div>
        <div className="space-y-1.5">
          {SCORE_KEYS.map((k) => {
            const comp = selectedModel.components[k];
            return comp ? (
              <div key={k}>
                <ScoreBar value={comp.value} label={k} />
                {comp.status === "UNKNOWN" && (
                  <p className="text-xs text-slate-400 mt-0.5 leading-tight" style={{ paddingLeft: "6.5rem" }}>{comp.detail ?? "No data available"}</p>
                )}
              </div>
            ) : null;
          })}
        </div>
      </Card>

      {/* Reason */}
      <div className="px-4 py-3 rounded-lg bg-slate-50 border border-slate-200">
        <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-1">Why this model?</p>
        <p className="text-xs text-slate-700 leading-relaxed">{result.decisionReason}</p>
      </div>

      {/* Fallbacks */}
      {fallbackModels.length > 0 && (
        <div>
          <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Fallback chain</p>
          <div className="space-y-2">
            {fallbackModels.map((fb, i) => (
              <div key={fb.openrouterId} className="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-600 text-slate-400 w-5">#{i + 1}</span>
                  <div>
                    <p className="text-xs font-600 text-slate-700">{fb.displayName}</p>
                    <p className="text-xs text-slate-400 font-mono">{fb.openrouterId}</p>
                  </div>
                </div>
                <span className="font-mono text-sm font-700" style={{ color: confidenceColor(fb.compositeScore) }}>
                  {fb.compositeScore.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All candidates */}
      {allCandidates.length > 1 && (
        <>
          <button onClick={() => setShowAll((v) => !v)} className="flex items-center gap-1.5 text-xs text-blue-600 font-500">
            {showAll ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {showAll ? "Hide" : "Show"} all {allCandidates.length} scored candidates
          </button>
          {showAll && (
            <Card padding="none">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-4 py-2 text-left font-600 text-slate-500">Model</th>
                    <th className="px-4 py-2 text-right font-600 text-slate-500">Score</th>
                    <th className="px-4 py-2 text-right font-600 text-slate-500">Benchmark</th>
                    <th className="px-4 py-2 text-right font-600 text-slate-500">Reliability</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {allCandidates.map((c) => (
                    <tr key={c.openrouterId} className={c.openrouterId === selectedModel.openrouterId ? "bg-green-50" : ""}>
                      <td className="px-4 py-2 font-500 text-slate-700">{c.displayName}</td>
                      <td className="px-4 py-2 text-right font-mono font-700" style={{ color: confidenceColor(c.compositeScore) }}>
                        {c.compositeScore.toFixed(1)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500">
                        {c.components.benchmark?.status === "UNKNOWN" ? <span className="text-slate-300">—</span> : c.components.benchmark?.value}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500">
                        {c.components.reliability?.status === "UNKNOWN" ? <span className="text-slate-300">—</span> : c.components.reliability?.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {/* Excluded */}
      {excludedCandidates.length > 0 && (
        <>
          <button onClick={() => setShowExcluded((v) => !v)} className="flex items-center gap-1.5 text-xs text-slate-500 font-500">
            {showExcluded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Filter size={10} />
            {excludedCandidates.length} model(s) excluded by hard constraints
          </button>
          {showExcluded && (
            <Card padding="none">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-4 py-2 text-left font-600 text-slate-500">Model</th>
                    <th className="px-4 py-2 text-left font-600 text-slate-500">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {excludedCandidates.map((ex) => (
                    <tr key={ex.openrouterId}>
                      <td className="px-4 py-2 text-slate-600 font-500">{ex.displayName}</td>
                      <td className="px-4 py-2 text-red-500">{ex.reason.replace(/_/g, " ")}{ex.detail ? ` — ${ex.detail}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function policyFields(p: RoutingPolicy): Array<{ label: string; value: string }> {
  return [
    { label: "Free models only", value: p.freeOnly ? "Yes" : "No" },
    { label: "Min reliability", value: p.minReliability > 0 ? `${(p.minReliability * 100).toFixed(0)}%` : "None" },
    { label: "Min quality", value: p.minQuality > 0 ? String(p.minQuality) : "None" },
    { label: "Max attempts", value: String(p.maxAttempts) },
    { label: "Cross-model verification", value: p.requireCrossModelVerification ? "Required" : "Not required" },
    { label: "Allowed providers", value: p.allowedProviders?.join(", ") ?? "All" },
    { label: "Excluded models", value: p.excludedModels?.length ? String(p.excludedModels.length) : "None" },
  ];
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ModelRouter() {
  const [tab, setTab] = useState<Tab>("simulator");
  const [sim, setSim] = useState<SimulatorState>(defaultSim);
  const [simResult, setSimResult] = useState<SimResultData | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  const [history, setHistory] = useState<RoutingDecisionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [policy, setPolicy] = useState<RoutingPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);

  useEffect(() => {
    if (tab !== "history" || IS_DEMO || history.length > 0) return;
    setHistoryLoading(true);
    apiGetRoutingDecisions(50)
      .then((r) => { if (r.data) setHistory(r.data); else setHistoryError(r.error?.message ?? "Failed"); })
      .catch((e: unknown) => setHistoryError(e instanceof IntegrationRequired ? "Backend integration required" : (e as Error).message))
      .finally(() => setHistoryLoading(false));
  }, [tab, history.length]);

  useEffect(() => {
    if (tab !== "policy" || IS_DEMO || policy) return;
    setPolicyLoading(true);
    apiGetRoutingPolicy()
      .then((r) => { if (r.data) setPolicy(r.data); })
      .catch(() => {})
      .finally(() => setPolicyLoading(false));
  }, [tab, policy]);

  if (IS_DEMO) return <IntegrationPlaceholder />;

  const handleTaskTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (TASK_TYPES.includes(v as TaskType)) setSim((p) => ({ ...p, taskType: v as TaskType }));
  };
  const handleComplexityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as ComplexityLevel;
    setSim((p) => ({ ...p, complexity: v }));
  };
  const handleRiskChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as ComplexityLevel;
    setSim((p) => ({ ...p, riskLevel: v }));
  };

  const toggleCap = (cap: ModelCapability, field: "requiredCapabilities" | "preferredCapabilities") => {
    setSim((prev) => {
      const cur = prev[field];
      return { ...prev, [field]: cur.includes(cap) ? cur.filter((c) => c !== cap) : [...cur, cap] };
    });
  };

  const runSimulation = async () => {
    setSimLoading(true);
    setSimError(null);
    setSimResult(null);
    const req: RoutingRequirements = {
      taskType: sim.taskType,
      complexity: sim.complexity,
      riskLevel: sim.riskLevel,
      structuredOutputRequired: sim.structuredOutputRequired,
      toolCallingRequired: sim.toolCallingRequired,
      visionRequired: sim.visionRequired,
      freeOnly: sim.freeOnly || undefined,
      requiredCapabilities: sim.requiredCapabilities,
      preferredCapabilities: sim.preferredCapabilities,
    };
    try {
      const result = await apiSimulateRouting(req);
      if (result.data) setSimResult(result.data as SimResultData);
      else setSimError(result.error?.message ?? "Simulation failed");
    } catch (e: unknown) {
      setSimError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setSimLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-screen-xl mx-auto animate-slide-in">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-700 text-slate-900">Model Router</h1>
          <p className="text-sm text-slate-500 mt-0.5">OX Alpha selects among eligible candidates — policy and registry drive routing, not hard-coded rules</p>
        </div>
      </div>

      <div className="flex items-center gap-3 p-3.5 rounded-lg bg-blue-50 border border-blue-200 mb-5">
        <Info size={15} className="text-blue-600 flex-shrink-0" />
        <p className="text-xs text-blue-700">
          <strong>Routing is policy-constrained and registry-driven.</strong> OX Alpha selects among pre-filtered eligible candidates but cannot override hard eligibility or security controls.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-500 border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "simulator" && <><Play size={12} />Simulator</>}
            {t === "history" && <><Clock size={12} />History</>}
            {t === "policy" && <><Settings size={12} />Policy</>}
          </button>
        ))}
      </div>

      {/* ── Simulator tab ── */}
      {tab === "simulator" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-6">
          <div className="space-y-4">
            <Card>
              <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-3">Task</p>
              <label className="block text-xs text-slate-600 mb-1">Task type</label>
              <select
                value={sim.taskType}
                onChange={handleTaskTypeChange}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              >
                {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Complexity</label>
                  <select value={sim.complexity} onChange={handleComplexityChange}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 bg-white focus:outline-none">
                    {COMPLEXITY_LEVELS.map((v) => <option key={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Risk level</label>
                  <select value={sim.riskLevel} onChange={handleRiskChange}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 bg-white focus:outline-none">
                    {COMPLEXITY_LEVELS.map((v) => <option key={v}>{v}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2 mt-2">Hard constraints</p>
              <div className="space-y-2">
                {BOOL_FIELDS.map(({ label, key }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={sim[key]} onChange={(e) => setSim((p) => ({ ...p, [key]: e.target.checked }))} className="rounded" />
                    <span className="text-xs text-slate-700">{label}</span>
                  </label>
                ))}
              </div>
            </Card>

            <Card>
              <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Required capabilities</p>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {CAPABILITIES.map((cap) => (
                  <CapabilityToggle key={cap} cap={cap} selected={sim.requiredCapabilities.includes(cap)} onToggle={() => toggleCap(cap, "requiredCapabilities")} />
                ))}
              </div>
              <p className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Preferred capabilities</p>
              <div className="flex flex-wrap gap-1.5">
                {CAPABILITIES.map((cap) => (
                  <CapabilityToggle key={cap} cap={cap} selected={sim.preferredCapabilities.includes(cap)} onToggle={() => toggleCap(cap, "preferredCapabilities")} />
                ))}
              </div>
            </Card>

            <button onClick={runSimulation} disabled={simLoading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-600 text-sm py-3 rounded-xl transition-colors">
              {simLoading ? <><RefreshCw size={14} className="animate-spin" />Running…</> : <><Play size={14} />Run simulation</>}
            </button>
          </div>

          <div>
            {simError && (
              <div className="flex items-center gap-3 p-3.5 rounded-lg bg-red-50 border border-red-200 mb-4">
                <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />
                <p className="text-xs text-red-700">{simError}</p>
              </div>
            )}
            {!simResult && !simLoading && !simError && (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                  <Zap size={20} className="text-slate-400" />
                </div>
                <p className="text-sm font-500 text-slate-500">Configure task requirements</p>
                <p className="text-xs text-slate-400 mt-1">Run a simulation to see candidate scoring and the routing decision</p>
              </div>
            )}
            {simResult && <SimulatorResult result={simResult} />}
          </div>
        </div>
      )}

      {/* ── History tab ── */}
      {tab === "history" && (
        <div>
          {historyLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
              <RefreshCw size={14} className="animate-spin" />Loading routing history…
            </div>
          )}
          {historyError && (
            <div className="flex items-center gap-3 p-3.5 rounded-lg bg-red-50 border border-red-200">
              <AlertTriangle size={14} className="text-red-500" />
              <p className="text-xs text-red-700">{historyError}</p>
            </div>
          )}
          {!historyLoading && !historyError && history.length === 0 && (
            <div className="text-center py-16 text-slate-400 text-sm">
              No routing decisions recorded yet. Use the simulator or run an agent task.
            </div>
          )}
          {history.length > 0 && (
            <Card padding="none">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    {["Task", "Selected Model", "Confidence", "Source", "Candidates", "Status", "Date"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-600 text-slate-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {history.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-600 text-slate-800 text-xs block">{d.taskType.replace(/_/g, " ")}</span>
                        <span className="text-xs text-slate-400">{d.complexity} / {d.riskLevel}</span>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600 max-w-[200px] truncate">
                        {d.selectedOpenrouterId ?? <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {d.decisionConfidence !== null ? (
                          <span className="font-700 font-mono text-xs" style={{ color: confidenceColor(d.decisionConfidence) }}>
                            {d.decisionConfidence}%
                          </span>
                        ) : <span className="text-slate-300 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3"><SourceBadge source={d.decisionSource} /></td>
                      <td className="px-4 py-3 text-xs text-slate-500">{d.candidateCount} / {d.excludedCount} excl.</td>
                      <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                      <td className="px-4 py-3 text-xs text-slate-400">{new Date(d.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}

      {/* ── Policy tab ── */}
      {tab === "policy" && (
        <div className="max-w-2xl space-y-4">
          {policyLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
              <RefreshCw size={14} className="animate-spin" />Loading policy…
            </div>
          )}
          {!policyLoading && !policy && (
            <div className="text-slate-400 text-sm py-8">Policy unavailable — backend connection required.</div>
          )}
          {policy && (
            <>
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-600 text-slate-800 text-sm">Active Routing Policy</h3>
                  <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded border border-blue-200">v{policy.version}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-xs">
                  {policyFields(policy).map(({ label, value }) => (
                    <div key={label}>
                      <dt className="text-slate-500">{label}</dt>
                      <dd className="font-600 text-slate-800 mt-0.5">{value}</dd>
                    </div>
                  ))}
                </dl>
                {policy.description && (
                  <p className="text-xs text-slate-400 mt-3 pt-3 border-t border-slate-100">{policy.description}</p>
                )}
              </Card>

              <Card>
                <h3 className="font-600 text-slate-800 text-sm mb-3">Scoring Weights</h3>
                <div className="space-y-2">
                  {Object.entries(policy.weights).map(([k, v]) => (
                    <ScoreBar key={k} value={Math.round(Number(v) * 100)} label={k.replace(/([A-Z])/g, " $1").toLowerCase()} />
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-3">Shown as percentage contribution. Update via routing policy API.</p>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
