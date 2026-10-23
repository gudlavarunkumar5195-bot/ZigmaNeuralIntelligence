import { useState, useEffect, useCallback } from "react";
import { useBusy } from "../../lib/useBusy";
import { PageHeader } from "../../components/ui/Card";
import {
  Bot, Shield, Search, Eye, Zap, Code, FileText, Cpu,
  Lock, AlertCircle, CheckCircle2, XCircle, Clock, ChevronRight,
  RefreshCw, Play, Network,
} from "lucide-react";
import {
  apiListAgents, apiGetAgent, apiEnableAgent, apiDisableAgent, apiSimulateAgent,
  IntegrationRequired,
} from "../../services/api";
import type { AgentView, AgentType } from "../../services/api";
import { IS_DEMO } from "../../config/env";
import {
  LoadingState, ErrorState, EmptyState, IntegrationRequiredState,
} from "../../components/ui/DataState";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "registry" | "simulator";

const RISK_COLORS: Record<string, string> = {
  LOW: "text-emerald-700 bg-emerald-50 border-emerald-200",
  MEDIUM: "text-amber-700 bg-amber-50 border-amber-200",
  HIGH: "text-orange-700 bg-orange-50 border-orange-200",
  CRITICAL: "text-red-700 bg-red-50 border-red-200",
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "text-emerald-700",
  DISABLED: "text-slate-500",
  DEPRECATED: "text-amber-700",
  REQUIRES_REVIEW: "text-orange-700",
};

const AGENT_ICONS: Record<string, typeof Bot> = {
  DISCOVERY: Eye,
  SEO_ANALYSIS: Search,
  AEO_ANALYSIS: Cpu,
  GEO_ANALYSIS: Network,
  SECURITY_ANALYSIS: Shield,
  PERFORMANCE_ANALYSIS: Zap,
  ACCESSIBILITY_ANALYSIS: Eye,
  QA_ANALYSIS: CheckCircle2,
  SSL_ANALYSIS: Lock,
  REMEDIATION: Code,
  REPORT_SYNTHESIS: FileText,
};

const PERM_COLORS: Record<string, string> = {
  READ: "text-blue-700",
  ANALYZE: "text-violet-700",
  GENERATE: "text-amber-700",
  PROPOSE: "text-orange-700",
  EXECUTE: "text-red-700",
};

const TABS: Tab[] = ["registry", "simulator"];

// ─── Simulator state types ─────────────────────────────────────────────────────

type SimRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface SimState {
  agentType: AgentType;
  riskLevel: SimRisk;
  satisfiedDeps: string;
}

const RISK_LEVELS: SimRisk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentRegistry() {
  const [tab, setTab] = useState<Tab>("registry");
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selected, setSelected] = useState<(AgentView & { versions?: unknown[]; instructionProfileSummary?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [integrationRequired, setIntegrationRequired] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // Simulator state
  const [simState, setSimState] = useState<SimState>({
    agentType: "DISCOVERY",
    riskLevel: "LOW",
    satisfiedDeps: "",
  });
  const [simResult, setSimResult] = useState<unknown>(null);
  const [simRunning, setSimRunning] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiListAgents();
      if (res.error) { setError(res.error.message); return; }
      setAgents(res.data ?? []);
    } catch (e) {
      if (e instanceof IntegrationRequired) { setIntegrationRequired(true); return; }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (!IS_DEMO) load(); else setIntegrationRequired(true); }, [load]);

  const loadDetail = useCallback(async (agentType: string) => {
    setDetailLoading(true);
    try {
      const res = await apiGetAgent(agentType);
      if (res.error) setToggleError(res.error.message);
      else if (res.data) setSelected(res.data);
    } catch (e) {
      setToggleError(`Unable to load agent details: ${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleToggle = useCallback(async (agent: AgentView) => {
    setToggleError(null);
    try {
      const res = agent.enabled
        ? await apiDisableAgent(agent.agentType, "Disabled by administrator")
        : await apiEnableAgent(agent.agentType);
      // Enabling/disabling agents is a platform-wide change; the API returns
      // PLATFORM_ADMIN_REQUIRED (with a clear message) for non-platform admins.
      if (res.error) { setToggleError(res.error.message); return; }
      await load();
    } catch (e) { setToggleError((e as Error).message); }
  }, [load]);

  const handleSimulate = useCallback(async () => {
    setSimRunning(true);
    setSimError(null);
    setSimResult(null);
    try {
      const deps = simState.satisfiedDeps
        ? simState.satisfiedDeps.split(",").map((d) => d.trim()).filter(Boolean)
        : [];
      const res = await apiSimulateAgent({
        agentType: simState.agentType,
        riskLevel: simState.riskLevel,
        satisfiedDependencies: deps,
      });
      if (res.error) { setSimError(res.error.message); return; }
      setSimResult(res.data);
    } catch (e) {
      if (e instanceof IntegrationRequired) { setSimError("Backend not connected"); return; }
      setSimError((e as Error).message);
    } finally {
      setSimRunning(false);
    }
  }, [simState]);

  const handleAgentTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSimState((s) => ({ ...s, agentType: e.target.value as AgentType }));
  };

  const handleRiskChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSimState((s) => ({ ...s, riskLevel: e.target.value as SimRisk }));
  };

  if (integrationRequired) {
    return (
      <div>
        <PageHeader eyebrow="AI Agents" title="Agent Registry" subtitle="Specialist agents, their capabilities and tool permissions." />
        <IntegrationRequiredState
          feature="Agent Registry"
          description="The Specialist Agent Registry requires a connected backend. Agents are globally defined with capabilities, tool permissions, and routing integration. Model selection is delegated to the Phase 3C router — agents never hard-code models."
        />
        <div className="mt-8 max-w-2xl mx-auto">
          <h3 className="text-sm font-600 text-slate-700 mb-3">Agent Architecture</h3>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 font-mono text-xs text-slate-600 leading-6">
            <div className="text-slate-700">OX Alpha</div>
            <div className="pl-4 text-slate-600">↓ orchestrates</div>
            <div className="pl-4 text-slate-700">Specialist Agent</div>
            <div className="pl-8 text-slate-600">↓ declares requirements</div>
            <div className="pl-8 text-slate-700">Task Requirements</div>
            <div className="pl-12 text-slate-600">↓ routes via</div>
            <div className="pl-12 text-slate-700">Phase 3C Model Router</div>
            <div className="pl-16 text-slate-600">↓ selects best eligible model</div>
            <div className="pl-16 text-emerald-700">Best Eligible Model</div>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Agent ≠ Model. An agent defines responsibility, tools, and output contracts.
            The router selects the model. No agent hard-codes a model.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader eyebrow="AI Agents" title="Agent Registry" subtitle="Specialist agents, their capabilities and tool permissions. Model selection is delegated to the router." />
      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-500 rounded-t border-b-2 transition-colors capitalize ${
              tab === t
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t === "registry" ? "Agent Registry" : "Simulator"}
          </button>
        ))}
      </div>

      {toggleError && (
        <div role="alert" className="mt-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">{toggleError}</div>
      )}

      {tab === "registry" && (
        <RegistryTab
          agents={agents}
          loading={loading}
          error={error}
          selected={selected}
          detailLoading={detailLoading}
          onSelect={(a) => { setSelected(a); loadDetail(a.agentType); }}
          onToggle={handleToggle}
          onRefresh={load}
        />
      )}

      {tab === "simulator" && (
        <SimulatorTab
          simState={simState}
          onAgentTypeChange={handleAgentTypeChange}
          onRiskChange={handleRiskChange}
          onSatisfiedDepsChange={(v) => setSimState((s) => ({ ...s, satisfiedDeps: v }))}
          onRun={handleSimulate}
          running={simRunning}
          result={simResult}
          error={simError}
        />
      )}
    </div>
  );
}

// ─── Registry Tab ─────────────────────────────────────────────────────────────

function RegistryTab({
  agents, loading, error, selected, detailLoading, onSelect, onToggle, onRefresh,
}: {
  agents: AgentView[];
  loading: boolean;
  error: string | null;
  selected: (AgentView & { versions?: unknown[]; instructionProfileSummary?: string }) | null;
  detailLoading: boolean;
  onSelect: (a: AgentView) => void;
  onToggle: (a: AgentView) => Promise<void>;
  onRefresh: () => void;
}) {
  if (loading) return <LoadingState label="Loading agent registry…" />;
  if (error) return <ErrorState message={error} onRetry={onRefresh} />;
  if (agents.length === 0) return <EmptyState title="No agents found" description="Agent definitions have not been seeded into the database." />;

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* Agent list */}
      <div className="w-72 border-r border-slate-200 overflow-y-auto flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <span className="text-xs font-600 text-slate-600 uppercase tracking-wide">
            {agents.length} Agents
          </span>
          <button onClick={onRefresh} aria-label="Refresh agents" className="rounded-md p-1 text-slate-500 hover:text-slate-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <RefreshCw size={13} />
          </button>
        </div>
        {agents.map((agent) => {
          const Icon = AGENT_ICONS[agent.agentType] ?? Bot;
          const isSelected = selected?.agentType === agent.agentType;
          return (
            <button
              key={agent.agentType}
              onClick={() => onSelect(agent)}
              className={`w-full text-left px-4 py-3 border-b border-slate-100 flex items-start gap-3 transition-colors ${
                isSelected ? "bg-blue-50" : "hover:bg-slate-50"
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                agent.enabled ? "bg-blue-50" : "bg-slate-100"
              }`}>
                <Icon size={15} className={agent.enabled ? "text-blue-700" : "text-slate-500"} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-500 truncate ${agent.enabled ? "text-slate-800" : "text-slate-500"}`}>
                    {agent.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-xs ${RISK_COLORS[agent.riskLevel]} px-1.5 py-0.5 rounded border text-[10px] font-600`}>
                    {agent.riskLevel}
                  </span>
                  <span className={`text-[11px] ${STATUS_COLORS[agent.status]}`}>
                    {agent.enabled ? agent.status : "DISABLED"}
                  </span>
                </div>
              </div>
              <ChevronRight size={14} className="text-slate-500 flex-shrink-0 mt-2" />
            </button>
          );
        })}
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected && (
          <EmptyState title="Select an agent" description="Choose an agent from the list to view its details, capabilities, and tool permissions." />
        )}
        {selected && (
          <AgentDetail agent={selected} loading={detailLoading} onToggle={() => onToggle(selected)} />
        )}
      </div>
    </div>
  );
}

// ─── Agent Detail ─────────────────────────────────────────────────────────────

function AgentDetail({
  agent, loading, onToggle,
}: {
  agent: AgentView & { versions?: unknown[]; instructionProfileSummary?: string };
  loading: boolean;
  onToggle: () => Promise<void>;
}) {
  const { busy, guard } = useBusy();
  const Icon = AGENT_ICONS[agent.agentType] ?? Bot;

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
            <Icon size={20} className="text-blue-700" />
          </div>
          <div>
            <h2 className="text-lg font-600 text-slate-900">{agent.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-slate-500">v{agent.version}</span>
              <span className="text-slate-400">·</span>
              <span className={`text-xs font-600 ${STATUS_COLORS[agent.status]}`}>
                {agent.enabled ? agent.status : "DISABLED"}
              </span>
              <span className="text-slate-400">·</span>
              <span className={`text-xs px-1.5 py-0.5 rounded border font-600 ${RISK_COLORS[agent.riskLevel]}`}>
                {agent.riskLevel} RISK
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => void guard(onToggle)()}
          disabled={busy}
          className={`px-3 py-1.5 rounded text-xs font-600 border transition-colors disabled:opacity-50 ${
            agent.enabled
              ? "border-red-200 text-red-700 hover:bg-red-50"
              : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
          }`}
        >
          {agent.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {/* Description */}
      <p className="text-sm text-slate-600 leading-relaxed">{agent.description}</p>

      {loading && <LoadingState label="Loading agent details…" />}

      {/* Model routing */}
      <Section title="Model Routing">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Cpu size={14} className="text-blue-700" />
          <span>Dynamic via Phase 3C Model Router — no hard-coded model</span>
        </div>
        <div className="mt-2 text-xs text-slate-500">
          Agent type maps to{" "}
          <code className="font-mono bg-slate-100 px-1 rounded">{agent.agentType}</code>{" "}
          task requirements, routed to the best currently eligible model.
        </div>
      </Section>

      {/* Capabilities */}
      <Section title="Agent Capabilities">
        <div className="flex flex-wrap gap-2">
          {agent.capabilities.map((cap) => (
            <span key={cap} className="px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-mono border border-slate-300">
              {cap}
            </span>
          ))}
        </div>
      </Section>

      {/* Allowed tools */}
      <Section title="Allowed Tools">
        <div className="space-y-1.5">
          {agent.allowedTools.map((tool) => (
            <div key={tool.name} className="flex items-center justify-between py-1.5 px-2 rounded bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={12} className="text-emerald-600" />
                <span className="text-xs font-mono text-slate-700">{tool.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-600 ${PERM_COLORS[tool.permissionLevel]}`}>
                  {tool.permissionLevel}
                </span>
                <span className="text-xs text-slate-500">{tool.description}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Agents never receive unrestricted system access. EXECUTE permission is not granted by default.
        </p>
      </Section>

      {/* Dependencies */}
      {agent.dependencies.length > 0 && (
        <Section title="Dependencies">
          <div className="space-y-1.5">
            {agent.dependencies.map((dep) => (
              <div key={dep.agentType} className="flex items-center gap-2 text-xs">
                <span className={dep.dependencyType === "REQUIRED" ? "text-orange-700" : "text-slate-500"}>
                  {dep.dependencyType === "REQUIRED" ? "REQUIRED" : "OPTIONAL"}
                </span>
                <span className="text-slate-600 font-mono">{dep.agentType}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Instruction profile summary */}
      {agent.instructionProfileSummary && (
        <Section title="Instruction Profile">
          <p className="text-xs text-slate-600 font-mono leading-relaxed">
            {agent.instructionProfileSummary}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Full instruction profile is predefined (Phase 3E will enable dynamic generation).
            Internal chain-of-thought is never exposed.
          </p>
        </Section>
      )}

      {/* Output contract */}
      <Section title="Output Contract">
        <div className="text-xs font-mono text-slate-600 space-y-0.5">
          <div><span className="text-blue-700">status</span>: SUCCESS | PARTIAL | FAILED</div>
          <div><span className="text-blue-700">findings</span>: AgentFinding[] — validated severity + evidence refs</div>
          <div><span className="text-blue-700">confidence</span>: 0–100 (agent analysis confidence, not routing)</div>
          <div><span className="text-blue-700">recommendations</span>: string[]</div>
          <div><span className="text-blue-700">warnings</span>: string[] — limitations and data gaps</div>
        </div>
      </Section>
    </div>
  );
}

// ─── Simulator Tab ────────────────────────────────────────────────────────────

function SimulatorTab({
  simState, onAgentTypeChange, onRiskChange, onSatisfiedDepsChange, onRun, running, result, error,
}: {
  simState: SimState;
  onAgentTypeChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onRiskChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onSatisfiedDepsChange: (v: string) => void;
  onRun: () => void;
  running: boolean;
  result: unknown;
  error: string | null;
}) {
  const selectClass = "w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:border-blue-600";

  return (
    <div className="p-6 flex flex-col gap-6 max-w-2xl">
      <div>
        <h3 className="text-sm font-600 text-slate-700 mb-1">Agent Simulator</h3>
        <p className="text-xs text-slate-500">
          Simulate agent routing and execution planning without calling any model or modifying infrastructure.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-500 text-slate-600 mb-1">Agent Type</label>
          <select value={simState.agentType} onChange={onAgentTypeChange} className={selectClass}>
            {(["DISCOVERY","SEO_ANALYSIS","AEO_ANALYSIS","GEO_ANALYSIS","SECURITY_ANALYSIS",
               "PERFORMANCE_ANALYSIS","ACCESSIBILITY_ANALYSIS","QA_ANALYSIS","SSL_ANALYSIS",
               "REMEDIATION","REPORT_SYNTHESIS"] as const).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-500 text-slate-600 mb-1">Risk Level</label>
          <select value={simState.riskLevel} onChange={onRiskChange} className={selectClass}>
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-500 text-slate-600 mb-1">Satisfied Dependencies (comma-separated)</label>
          <input
            type="text"
            value={simState.satisfiedDeps}
            onChange={(e) => onSatisfiedDepsChange(e.target.value)}
            placeholder="e.g. DISCOVERY, SEO_ANALYSIS"
            className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 shadow-sm placeholder-slate-400 focus:outline-none focus:border-blue-600"
          />
        </div>

        <button
          onClick={onRun}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white shadow-sm text-sm font-500 transition-colors"
        >
          {running ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <Play size={14} />
          )}
          {running ? "Running simulation…" : "Run Simulation"}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded border border-red-200 bg-red-50">
          <AlertCircle size={14} className="text-red-700 mt-0.5 flex-shrink-0" />
          <span className="text-xs text-red-800">{error}</span>
        </div>
      )}

      {result !== null && (
        <div className="space-y-2">
          <h4 className="text-xs font-600 text-slate-600 uppercase tracking-wide">Simulation Result</h4>
          <pre className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-700 overflow-x-auto whitespace-pre-wrap">
            {String(JSON.stringify(result, null, 2))}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Section helper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">{title}</h4>
      {children}
    </div>
  );
}
