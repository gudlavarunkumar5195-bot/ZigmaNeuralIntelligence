import { useState, useEffect } from "react";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, RefreshCw, AlertCircle, Database, Info } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { IntegrationRequiredState } from "../../components/ui/DataState";
import { IS_DEMO } from "../../config/env";
import {
  apiListModels, apiGetModel, apiRefreshCatalog,
  type RegistryModel, type RegistryModelDetail,
} from "../../services/api";
import { IntegrationRequired } from "../../services/api";

// ─── Capability cell ──────────────────────────────────────────────────────────

function Cap({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      {ok
        ? <CheckCircle2 size={13} className="text-green-500" />
        : <XCircle size={13} className="text-slate-200" />}
      <span className="text-slate-400" style={{ fontSize: "9px" }}>{label}</span>
    </div>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function EligibilityChip({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ELIGIBLE: "bg-green-100 text-green-700",
    NOT_ELIGIBLE: "bg-slate-100 text-slate-500",
    PENDING_REVIEW: "bg-amber-100 text-amber-700",
    DISABLED: "bg-red-100 text-red-600",
  };
  return (
    <span className={`text-xs font-600 rounded px-1.5 py-0.5 ${colors[status] ?? "bg-slate-100 text-slate-500"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function FreeChip({ status }: { status: string }) {
  if (status === "FREE") return <span className="text-xs font-600 rounded px-1.5 py-0.5 bg-green-100 text-green-700">Free</span>;
  if (status === "CHANGED") return <span className="text-xs font-600 rounded px-1.5 py-0.5 bg-amber-100 text-amber-700">Changed</span>;
  if (status === "PAID") return <span className="text-xs font-600 rounded px-1.5 py-0.5 bg-slate-100 text-slate-500">Paid</span>;
  return <span className="text-xs font-600 rounded px-1.5 py-0.5 bg-slate-100 text-slate-400">Unknown</span>;
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function ModelDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RegistryModelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    apiGetModel(id)
      .then((r) => { if (r.data) setDetail(r.data); else setError(r.error?.message ?? "Failed to load"); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div className="p-6 text-center text-sm text-slate-400">Loading model details…</div>
  );
  if (error) return (
    <div className="p-6 text-center text-sm text-red-500">{error}</div>
  );
  if (!detail) return null;

  const successRate = detail.reliability && detail.reliability.total_requests > 0
    ? Math.round((detail.reliability.successful_requests / detail.reliability.total_requests) * 100)
    : null;

  return (
    <div className="border-t border-slate-100 bg-slate-50 px-5 py-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-700 text-slate-900 text-sm">{detail.display_name}</h3>
          {detail.description && (
            <p className="text-xs text-slate-500 mt-1 max-w-xl">{detail.description}</p>
          )}
        </div>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close ✕</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <div>
          <div className="text-xs text-slate-500 mb-1">Eligibility</div>
          <EligibilityChip status={detail.eligibility_status} />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Status</div>
          <span className="text-sm font-600 text-slate-700">{detail.status}</span>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Free / Paid</div>
          <FreeChip status={detail.free_status} />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Context</div>
          <span className="font-mono text-sm font-700 text-slate-800">
            {detail.context_length ? `${Math.round(detail.context_length / 1000)}K` : "—"}
          </span>
        </div>
      </div>

      {/* Capabilities */}
      <div className="mb-5">
        <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Capabilities (from provider metadata)</div>
        <div className="flex flex-wrap gap-2">
          {[
            { label: "Tool Calling", ok: detail.supports_tool_calling },
            { label: "Structured Output", ok: detail.supports_structured_output },
            { label: "Vision", ok: detail.supports_vision },
          ].map(({ label, ok }) => (
            <div key={label} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-white border border-slate-200">
              {ok ? <CheckCircle2 size={11} className="text-green-500" /> : <XCircle size={11} className="text-slate-300" />}
              <span className="text-slate-600">{label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 mt-1.5 flex items-center gap-1">
          <Info size={10} /> Capabilities are structural metadata, not quality indicators. See benchmark scores for task performance.
        </p>
      </div>

      {/* Benchmark scores */}
      <div className="mb-5">
        <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">ZigmaNeural Benchmark Scores</div>
        {detail.benchmarks.length === 0 ? (
          <div className="text-xs text-slate-400 bg-white border border-slate-200 rounded px-3 py-2">
            No benchmark runs have been executed for this model. Scores will appear here after benchmarking.
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {detail.benchmarks.map((b) => (
              <div key={b.task_type} className="text-center p-2 rounded bg-white border border-slate-200">
                {b.evaluation_status === "BENCHMARKED" && b.score !== null ? (
                  <div className="font-mono text-lg font-700 text-slate-800">{Math.round(b.score)}</div>
                ) : (
                  <div className="text-xs text-slate-400 py-1">Not benchmarked</div>
                )}
                <div className="text-xs text-slate-400 capitalize">{b.task_type.toUpperCase()}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reliability */}
      <div className="mb-4">
        <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Operational Reliability</div>
        {!detail.reliability || detail.reliability.total_requests === 0 ? (
          <div className="text-xs text-slate-400 bg-white border border-slate-200 rounded px-3 py-2">
            Insufficient data — no executions recorded yet.
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <div>
              <div className="font-mono text-sm font-700 text-slate-800">
                {successRate !== null ? `${successRate}%` : "—"}
              </div>
              <div className="text-xs text-slate-400">Success rate</div>
            </div>
            <div>
              <div className="font-mono text-sm font-700 text-slate-800">
                {detail.reliability.avg_latency_ms !== null ? `${detail.reliability.avg_latency_ms}ms` : "—"}
              </div>
              <div className="text-xs text-slate-400">Avg latency</div>
            </div>
            <div>
              <div className="font-mono text-sm font-700 text-slate-800">{detail.reliability.total_requests}</div>
              <div className="text-xs text-slate-400">Total requests</div>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      {detail.history.length > 0 && (
        <div>
          <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-2">Model History</div>
          <div className="space-y-1">
            {detail.history.slice(0, 10).map((h) => (
              <div key={h.created_at + h.event_type} className="flex items-center gap-2 text-xs text-slate-500">
                <span className="text-slate-300">{new Date(h.created_at).toLocaleDateString()}</span>
                <span className="font-600 text-slate-600">{h.event_type}</span>
                {h.reason && <span className="text-slate-400">— {h.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ModelRegistry() {
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [integrationRequired, setIntegrationRequired] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "eligible" | "free">("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    apiListModels()
      .then((r) => {
        if (r.data) setModels(r.data);
        else setError(r.error?.message ?? "Failed to load models");
      })
      .catch((e: Error) => {
        if (e instanceof IntegrationRequired) setIntegrationRequired(true);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg("");
    try {
      const r = await apiRefreshCatalog();
      if (r.error) setRefreshMsg(`Refresh failed: ${r.error.message}`);
      else setRefreshMsg("Catalog refreshed.");
      load();
    } catch (e: unknown) {
      setRefreshMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (IS_DEMO || integrationRequired) {
    return (
      <div className="p-6 max-w-screen-xl mx-auto animate-slide-in">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-700 text-slate-900">Model Registry</h1>
            <p className="text-sm text-slate-500 mt-0.5">ZigmaNeural model intelligence layer</p>
          </div>
        </div>
        <IntegrationRequiredState
          feature="Model Registry"
          description="The model registry requires a connected backend with OPENROUTER_API_KEY configured. Models are discovered from OpenRouter, validated, and must pass eligibility review before being used by OX Alpha."
        />
        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-xs font-600 text-slate-500 uppercase tracking-wide mb-3">Architecture Overview</div>
          <div className="text-xs text-slate-500 space-y-1.5">
            {[
              "OpenRouter Catalog → ZigmaNeural Registry → Eligibility → OX Alpha Router",
              "DISCOVERED models must pass review before becoming ELIGIBLE",
              "Free/paid classification tracked from live pricing data",
              "Benchmark scores only shown after actual benchmark execution",
              "Reliability metrics populated from real agent executions",
            ].map((line) => (
              <div key={line} className="flex items-start gap-2">
                <span className="text-slate-300 mt-0.5">→</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const filtered = models.filter((m) => {
    if (filter === "eligible") return m.eligibility_status === "ELIGIBLE";
    if (filter === "free") return m.free_status === "FREE";
    return true;
  });

  const eligibleCount = models.filter((m) => m.eligibility_status === "ELIGIBLE").length;
  const freeCount = models.filter((m) => m.free_status === "FREE").length;

  return (
    <div className="p-6 max-w-screen-xl mx-auto animate-slide-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-700 text-slate-900">Model Registry</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading ? "Loading…" : `${models.length} models · ${eligibleCount} eligible · ${freeCount} free`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            {(["all", "eligible", "free"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-3 py-1.5 rounded text-xs font-600 transition-colors capitalize"
                style={{ background: filter === f ? "var(--primary)" : "#f1f5f9", color: filter === f ? "white" : "#64748b" }}
              >
                {f}
              </button>
            ))}
          </div>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-600 bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            Refresh catalog
          </button>
        </div>
      </div>

      {/* Registry / Catalog separation notice */}
      <div className="mb-4 flex items-center gap-2 text-xs text-slate-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        <Database size={12} className="text-blue-400" />
        <span>
          <strong className="text-blue-700">ZigmaNeural Registry</strong> — curated approved models ·
          <strong className="text-slate-600"> OpenRouter Catalog</strong> — raw external availability.
          DISCOVERED models require review before becoming ELIGIBLE.
        </span>
      </div>

      {refreshMsg && (
        <div className="mb-4 flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <AlertCircle size={12} />
          {refreshMsg}
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-slate-400">Loading model registry…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Database size={32} className="text-slate-200 mx-auto mb-3" />
          <div className="text-sm text-slate-400">
            {models.length === 0
              ? "No models in registry. Run a catalog refresh to discover available models."
              : "No models match the current filter."}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((model) => (
            <Card key={model.id} padding="none">
              <div
                className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(expandedId === model.id ? null : model.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <span className="font-700 text-slate-900 text-sm">{model.display_name}</span>
                    <FreeChip status={model.free_status} />
                    <EligibilityChip status={model.eligibility_status} />
                  </div>
                  <div className="text-xs text-slate-400">{model.provider} · {model.openrouter_id}</div>
                </div>

                <div className="hidden sm:flex items-center gap-6 text-center">
                  <div>
                    <div className="font-mono text-sm font-700 text-slate-700">
                      {model.context_length ? `${Math.round(model.context_length / 1000)}K` : "—"}
                    </div>
                    <div className="text-xs text-slate-400">Context</div>
                  </div>
                  <div>
                    <div className="text-xs font-600 text-slate-500">{model.status}</div>
                    <div className="text-xs text-slate-400">Status</div>
                  </div>
                </div>

                <div className="hidden md:flex items-center gap-3 mr-2">
                  <Cap ok={model.supports_tool_calling} label="Tools" />
                  <Cap ok={model.supports_structured_output} label="JSON" />
                  <Cap ok={model.supports_vision} label="Vision" />
                </div>

                {expandedId === model.id
                  ? <ChevronUp size={15} className="text-slate-300 flex-shrink-0" />
                  : <ChevronDown size={15} className="text-slate-300 flex-shrink-0" />}
              </div>

              {expandedId === model.id && (
                <ModelDetail id={model.id} onClose={() => setExpandedId(null)} />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
