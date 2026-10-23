import { useState, type FormEvent } from "react";
import { AI_FEATURES, AI_ROUTER_TASK_TYPES, apiAiFeasibility, type AiFeasibilityResult, type AiFeature, type AiRouterTaskType } from "../../../services/api";
import { useBusy } from "../../../lib/useBusy";
import { Card, SectionHeader } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, Field, Notice } from "../../../components/ui/Primitives";
import type { Tone } from "../../../components/ui/styles";
import { input } from "../../../components/ui/styles";
import { EstimatedTag, fmtInt, humanize, Stat } from "./shared";

const TONE: Record<string, Tone> = {
  FEASIBLE: "success", FEASIBLE_WITH_REDUCTION: "warning", SPLIT_REQUIRED: "warning",
  INSUFFICIENT_BUDGET: "danger", NO_ELIGIBLE_MODEL: "danger", BLOCKED_BY_POLICY: "danger",
};
const MAX_CHARS = 5_000_000;

export function FeasibilityTab() {
  const { busy, guard } = useBusy();
  const [by, setBy] = useState<"feature" | "taskType">("feature");
  const [feature, setFeature] = useState<AiFeature>("content_brief");
  const [taskType, setTaskType] = useState<AiRouterTaskType>("SEO_ANALYSIS");
  const [chars, setChars] = useState("2000");
  const [requireJson, setRequireJson] = useState(false);
  const [result, setResult] = useState<AiFeasibilityResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const n = Number(chars);
  const charsError = chars.trim() === "" || !Number.isInteger(n) || n < 0 || n > MAX_CHARS ? `Enter a whole number from 0 to ${MAX_CHARS.toLocaleString()}.` : null;

  const run = guard(async () => {
    setError(null);
    if (charsError) return;
    const r = await apiAiFeasibility({ ...(by === "feature" ? { feature } : { taskType }), inputChars: n, requireJson });
    if (r.error) {
      setResult(null);
      setError(r.error.message);
      return;
    }
    setResult(r.data);
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void run(); };

  return (
    <section className="space-y-4">
      <SectionHeader as="h2" title="Feasibility check" subtitle="Preview whether a task could run right now, which free model would take it, and how much budget it needs. No model is called." />
      <Card>
        <form onSubmit={onSubmit} noValidate aria-label="Feasibility check" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Check by">
            {(p) => (
              <select {...p} className={`${input} w-full`} value={by} onChange={(e) => setBy(e.target.value as "feature" | "taskType")}>
                <option value="feature">Product feature</option>
                <option value="taskType">Task category</option>
              </select>
            )}
          </Field>
          {by === "feature" ? (
            <Field label="Feature">
              {(p) => (
                <select {...p} className={`${input} w-full`} value={feature} onChange={(e) => setFeature(e.target.value as AiFeature)}>
                  {AI_FEATURES.map((f) => <option key={f} value={f}>{humanize(f)}</option>)}
                </select>
              )}
            </Field>
          ) : (
            <Field label="Task category">
              {(p) => (
                <select {...p} className={`${input} w-full`} value={taskType} onChange={(e) => setTaskType(e.target.value as AiRouterTaskType)}>
                  {AI_ROUTER_TASK_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                </select>
              )}
            </Field>
          )}
          <Field label="Approximate input size (characters)" hint="About 3 characters per token." error={charsError}>
            {(p) => <input {...p} type="number" inputMode="numeric" min={0} max={MAX_CHARS} step={1} className={`${input} w-full`} value={chars} onChange={(e) => setChars(e.target.value)} />}
          </Field>
          <div className="flex flex-col justify-end gap-2">
            <label htmlFor="mi-require-json" className="flex items-center gap-2 text-[13px] text-slate-800">
              <input id="mi-require-json" type="checkbox" className="h-4 w-4 rounded border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" checked={requireJson} onChange={(e) => setRequireJson(e.target.checked)} />
              Needs structured (JSON) output
            </label>
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!!charsError}>Check feasibility</Button>
          </div>
        </form>
      </Card>
      {error ? <Notice tone="danger" title="Could not check feasibility">{error}</Notice> : null}
      {result ? (
        <Card>
          <div aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[result.feasibility] ?? "neutral"} icon>{humanize(result.feasibility)}</Badge>
              <span className="text-xs text-slate-600">Task category: {humanize(result.taskCategory)}</span>
            </div>
            <p className="mt-2 text-[13px] text-slate-900">{result.message}</p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="Selected model"><span className="font-mono text-xs">{result.selectedModel ?? "None"}</span></Stat>
              <Stat label="Fallbacks"><span className="font-mono text-xs">{result.fallbacks.length ? result.fallbacks.join(", ") : "None"}</span></Stat>
              <Stat label="Routing reason">{result.reason ?? "—"}</Stat>
              <Stat label="Input tokens">{fmtInt(result.estimatedInputTokens)}<EstimatedTag /></Stat>
              <Stat label="Reserved output tokens">{fmtInt(result.reservedOutputTokens)}</Stat>
              <Stat label="Free requests remaining today">{fmtInt(result.budget.freeRequestsRemaining)}</Stat>
              <Stat label="Organization tokens, last 24 hours">{fmtInt(result.budget.orgTokensUsed24h)} of {fmtInt(result.budget.orgTokenLimit24h)}</Stat>
              {Object.keys(result.exclusions).length ? (
                <Stat label="Models ruled out">{Object.entries(result.exclusions).map(([k, v]) => `${humanize(k)}: ${v}`).join(" · ")}</Stat>
              ) : null}
            </dl>
            <p className="mt-2 text-[11px] text-slate-600">Token figures are estimated with {result.estimate}.</p>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
