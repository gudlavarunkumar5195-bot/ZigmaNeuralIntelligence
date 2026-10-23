import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AI_ROUTER_TASK_TYPES, apiAiSettings, apiAiUpdateSettings,
  type AiRouterSettings, type AiRouterTaskType, type AiStoredSettings,
} from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { useBusy } from "../../../lib/useBusy";
import { Card, SectionHeader } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, Field, Notice } from "../../../components/ui/Primitives";
import { InlineError, LoadingState } from "../../../components/ui/DataState";
import { useToast } from "../../../components/ui/Toast";
import { input, textarea } from "../../../components/ui/styles";
import { errorText, fmtDateTime, humanize, Stat, type Access } from "./shared";

// ─── Schema mirror ───────────────────────────────────────────────────────────
// Same bounds as routerSettingsSchema / ROUTER_CEILINGS in server/src/ai/router/settings.ts.
// The server validates again; these only stop an obviously invalid save early.

type NumKey =
  | "trials.dailyRequestCap" | "quota.freeDailyRequests" | "quota.freeRequestsPerMinute" | "perOrg.dailyRequests" | "perOrg.dailyTokens"
  | `perTask.${keyof AiRouterSettings["perTask"]}` | `catalog.${keyof AiRouterSettings["catalog"]}` | `quality.${keyof AiRouterSettings["quality"]}`
  | `weights.${keyof AiRouterSettings["weights"]}` | "retentionDays";

interface NumField { key: NumKey; label: string; min: number; max: number; int: boolean; step?: number; hint?: string }

export const NUMBER_FIELDS: Record<string, NumField[]> = {
  "Trials and quota": [
    { key: "trials.dailyRequestCap", label: "Trial daily request cap", min: 0, max: 1_000, int: true },
    { key: "quota.freeDailyRequests", label: "Free requests per day", min: 1, max: 1_000, int: true, hint: "OpenRouter allows 50 per day (1,000 after 10 credits were ever purchased)." },
    { key: "quota.freeRequestsPerMinute", label: "Free requests per minute", min: 1, max: 20, int: true },
  ],
  "Per organization": [
    { key: "perOrg.dailyRequests", label: "Requests per organization per day", min: 1, max: 2_000, int: true },
    { key: "perOrg.dailyTokens", label: "Tokens per organization per day", min: 1_000, max: 20_000_000, int: true },
  ],
  "Per task": [
    { key: "perTask.maxInputTokens", label: "Max input tokens", min: 500, max: 200_000, int: true },
    { key: "perTask.maxOutputTokens", label: "Max output tokens", min: 64, max: 32_768, int: true },
    { key: "perTask.maxTotalTokens", label: "Max total tokens", min: 1_000, max: 1_000_000, int: true },
    { key: "perTask.maxCalls", label: "Max model calls", min: 1, max: 12, int: true },
    { key: "perTask.maxAgents", label: "Max agents", min: 1, max: 8, int: true },
    { key: "perTask.maxDepth", label: "Max agent depth", min: 0, max: 3, int: true },
    { key: "perTask.maxConcurrency", label: "Max concurrency", min: 1, max: 4, int: true },
    { key: "perTask.maxRetriesPerModel", label: "Max retries per model", min: 1, max: 3, int: true },
    { key: "perTask.maxFallbackModels", label: "Max fallback models", min: 0, max: 5, int: true },
    { key: "perTask.maxWallClockMs", label: "Max wall-clock time (ms)", min: 5_000, max: 600_000, int: true },
    { key: "perTask.maxReductionIterations", label: "Max reduction iterations", min: 0, max: 5, int: true },
    { key: "perTask.maxEvaluationAttempts", label: "Max evaluation attempts", min: 0, max: 2, int: true },
    { key: "perTask.maxRepairAttempts", label: "Max repair attempts", min: 0, max: 1, int: true },
  ],
  "Catalog": [
    { key: "catalog.refreshIntervalMinutes", label: "Refresh interval (minutes)", min: 30, max: 1_440, int: true },
    { key: "catalog.maxStaleHours", label: "Stale after (hours)", min: 1, max: 72, int: true },
  ],
  "Quality and learning": [
    { key: "quality.minQualityScore", label: "Minimum quality score", min: 0, max: 100, int: true },
    { key: "quality.minSamples", label: "Minimum samples for a measured score", min: 3, max: 200, int: true },
    { key: "quality.halfLifeDays", label: "Score half-life (days)", min: 1, max: 90, int: true },
    { key: "quality.explorationRate", label: "Exploration rate", min: 0, max: 0.25, int: false, step: 0.01, hint: "Share of low-risk tasks used to try less-measured models." },
  ],
  "Retention": [
    { key: "retentionDays", label: "Keep router records for (days)", min: 30, max: 730, int: true },
  ],
};

export const WEIGHT_FIELDS: NumField[] = (["quality", "reliability", "structured", "latency", "context", "availability", "security", "resourceFit"] as const)
  .map((w) => ({ key: `weights.${w}` as NumKey, label: humanize(w === "resourceFit" ? "resource_fit" : w), min: 0, max: 1, int: false, step: 0.01 }));

const ALL_NUMBER_FIELDS = [...Object.values(NUMBER_FIELDS).flat(), ...WEIGHT_FIELDS];
const OPENROUTER_ID = /^[a-z0-9][\w.-]*\/[\w.\-:]+$/i;

function getPath(s: AiRouterSettings, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), s);
}
function setPath(s: AiRouterSettings, key: string, value: unknown): void {
  const parts = key.split(".");
  let o = s as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
  o[parts[parts.length - 1]] = value;
}

/** Client-side check of one numeric value against the server schema's bounds. */
export function checkNumber(f: NumField, raw: string): string | null {
  if (raw.trim() === "") return "Required.";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (f.int && !Number.isInteger(n)) return "Enter a whole number.";
  if (n < f.min || n > f.max) return `Must be between ${f.min.toLocaleString()} and ${f.max.toLocaleString()}.`;
  return null;
}

export const weightSum = (raw: Record<string, string>) => WEIGHT_FIELDS.reduce((sum, f) => sum + (Number(raw[f.key]) || 0), 0);

// ─── Read-only view ──────────────────────────────────────────────────────────

function ReadOnly({ s }: { s: AiRouterSettings }) {
  const pins = Object.entries(s.models.pins);
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-card-title">Switches</h3>
        <dl className="mt-2 grid gap-3 sm:grid-cols-3">
          <Stat label="Trial models">{s.trials.enabled ? "Enabled" : "Disabled"}</Stat>
          <Stat label="Auto-approve free models">{s.autoApproveFreeModels ? "Yes" : "No"}</Stat>
          <Stat label="Sync quota from provider">{s.quota.syncFromProvider ? "Yes" : "No"}</Stat>
        </dl>
      </Card>
      {Object.entries(NUMBER_FIELDS).map(([group, fields]) => (
        <Card key={group}>
          <h3 className="text-card-title">{group}</h3>
          <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => <Stat key={f.key} label={f.label}>{Number(getPath(s, f.key)).toLocaleString()}</Stat>)}
          </dl>
        </Card>
      ))}
      <Card>
        <h3 className="text-card-title">Scoring weights</h3>
        <dl className="mt-2 grid gap-3 sm:grid-cols-4">
          {WEIGHT_FIELDS.map((f) => <Stat key={f.key} label={f.label}>{Number(getPath(s, f.key)).toFixed(2)}</Stat>)}
        </dl>
      </Card>
      <Card>
        <h3 className="text-card-title">Models</h3>
        <dl className="mt-2 grid gap-3 sm:grid-cols-2">
          <Stat label="Excluded models">{s.models.excluded.length ? <span className="font-mono text-xs">{s.models.excluded.join(", ")}</span> : "None"}</Stat>
          <Stat label="Pinned models">{pins.length ? <span className="font-mono text-xs">{pins.map(([k, v]) => `${humanize(k)} → ${v}`).join("; ")}</span> : "None"}</Stat>
        </dl>
      </Card>
    </div>
  );
}

// ─── Editable form (platform administrators) ─────────────────────────────────

function toRaw(s: AiRouterSettings): Record<string, string> {
  return Object.fromEntries(ALL_NUMBER_FIELDS.map((f) => [f.key, String(getPath(s, f.key))]));
}

function SettingsForm({ stored, onSaved }: { stored: AiStoredSettings; onSaved: () => void }) {
  const { busy, guard } = useBusy();
  const { notify } = useToast();
  const [raw, setRaw] = useState<Record<string, string>>(() => toRaw(stored.settings));
  const [flags, setFlags] = useState({ trials: stored.settings.trials.enabled, autoApprove: stored.settings.autoApproveFreeModels, sync: stored.settings.quota.syncFromProvider });
  const [excluded, setExcluded] = useState(stored.settings.models.excluded.join("\n"));
  const [pins, setPins] = useState<Record<string, string>>(() => ({ ...stored.settings.models.pins }));
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; issues: string[]; conflict: boolean } | null>(null);

  // A reload after a conflict brings a new version: start again from it.
  useEffect(() => {
    setRaw(toRaw(stored.settings));
    setFlags({ trials: stored.settings.trials.enabled, autoApprove: stored.settings.autoApproveFreeModels, sync: stored.settings.quota.syncFromProvider });
    setExcluded(stored.settings.models.excluded.join("\n"));
    setPins({ ...stored.settings.models.pins });
    setServerError(null);
    setSubmitted(false);
  }, [stored]);

  const fieldErrors = useMemo(() => Object.fromEntries(ALL_NUMBER_FIELDS.map((f) => [f.key, checkNumber(f, raw[f.key] ?? "")])), [raw]);
  const sum = weightSum(raw);
  const sumOk = Math.abs(sum - 1) < 0.001;
  const excludedList = excluded.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const excludedError = excludedList.length > 200 ? "At most 200 models." : excludedList.find((x) => !OPENROUTER_ID.test(x) || x.length > 255) ? `Not a model id: ${excludedList.find((x) => !OPENROUTER_ID.test(x) || x.length > 255)}` : null;
  const pinErrors = Object.fromEntries(AI_ROUTER_TASK_TYPES.map((t) => {
    const v = (pins[t] ?? "").trim();
    return [t, v && (!OPENROUTER_ID.test(v) || v.length > 255) ? "Use a model id such as vendor/model:free." : null];
  }));
  const valid = sumOk && !excludedError && Object.values(fieldErrors).every((e) => !e) && Object.values(pinErrors).every((e) => !e);
  const show = (key: string) => (submitted || raw[key] !== String(getPath(stored.settings, key)) ? fieldErrors[key] : null);

  const save = guard(async () => {
    setSubmitted(true);
    setServerError(null);
    if (!valid) return;
    const next = structuredClone(stored.settings) as AiRouterSettings;
    for (const f of ALL_NUMBER_FIELDS) setPath(next, f.key, Number(raw[f.key]));
    next.trials.enabled = flags.trials;
    next.autoApproveFreeModels = flags.autoApprove;
    next.quota.syncFromProvider = flags.sync;
    next.models = {
      excluded: [...new Set(excludedList)],
      pins: Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) as Partial<Record<AiRouterTaskType, string>>,
    };
    const r = await apiAiUpdateSettings(next, stored.version);
    if (r.error) {
      setServerError({
        message: r.error.status === 409 ? "Someone else changed these settings since you opened them. Reload to see their version, then make your change again." : r.error.message,
        issues: r.error.issues ?? [],
        conflict: r.error.status === 409,
      });
      return;
    }
    notify(`Router settings saved (version ${r.data?.version ?? stored.version + 1}).`, "success");
    onSaved();
  });

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void save(); };
  const numInput = (f: NumField) => (
    <Field key={f.key} label={f.label} hint={f.hint ?? `${f.min.toLocaleString()}–${f.max.toLocaleString()}`} error={show(f.key)}>
      {(p) => (
        <input {...p} type="number" inputMode={f.int ? "numeric" : "decimal"} min={f.min} max={f.max} step={f.step ?? 1} className={`${input} w-full`}
          value={raw[f.key] ?? ""} onChange={(e) => setRaw((r) => ({ ...r, [f.key]: e.target.value }))} />
      )}
    </Field>
  );
  const check = (id: string, labelText: string, checked: boolean, onChange: (v: boolean) => void) => (
    <label htmlFor={id} className="flex items-center gap-2 text-[13px] text-slate-800">
      <input id={id} type="checkbox" className="h-4 w-4 rounded border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {labelText}
    </label>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="Router settings">
      <Card>
        <h3 className="text-card-title">Switches</h3>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {check("mi-trials", "Use trial models", flags.trials, (v) => setFlags((f) => ({ ...f, trials: v })))}
          {check("mi-auto", "Auto-approve new free models", flags.autoApprove, (v) => setFlags((f) => ({ ...f, autoApprove: v })))}
          {check("mi-sync", "Sync free quota from OpenRouter", flags.sync, (v) => setFlags((f) => ({ ...f, sync: v })))}
        </div>
        <p className="mt-2 text-[11px] text-slate-600">Paid models cannot be enabled here; that stays behind a deployment switch.</p>
      </Card>

      {Object.entries(NUMBER_FIELDS).map(([group, fields]) => (
        <Card key={group}>
          <fieldset>
            <legend className="text-card-title">{group}</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(numInput)}</div>
          </fieldset>
        </Card>
      ))}

      <Card>
        <fieldset>
          <legend className="text-card-title">Scoring weights</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{WEIGHT_FIELDS.map(numInput)}</div>
          <p role="status" aria-live="polite" className={`mt-3 text-xs font-600 ${sumOk ? "text-emerald-800" : "text-red-700"}`}>
            Sum: {sum.toFixed(2)} — {sumOk ? "OK, the weights sum to 1.00." : "the weights must sum to 1.00 before you can save."}
          </p>
        </fieldset>
      </Card>

      <Card>
        <fieldset>
          <legend className="text-card-title">Models</legend>
          <Field label="Excluded models" hint="One OpenRouter model id per line. Excluded models are never routed to." error={submitted || excluded !== stored.settings.models.excluded.join("\n") ? excludedError : null} className="mt-2">
            {(p) => <textarea {...p} rows={4} className={`${textarea} font-mono`} value={excluded} onChange={(e) => setExcluded(e.target.value)} />}
          </Field>
          <h4 className="mt-4 text-xs font-700 text-slate-800">Pinned model per task category</h4>
          <p className="text-[11px] text-slate-600">Leave empty to let the router choose. A pinned model must still be free and eligible.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AI_ROUTER_TASK_TYPES.map((t) => (
              <Field key={t} label={humanize(t)} error={pinErrors[t]}>
                {(p) => <input {...p} type="text" className={`${input} w-full font-mono`} placeholder="vendor/model:free" value={pins[t] ?? ""} onChange={(e) => setPins((s) => ({ ...s, [t]: e.target.value }))} />}
              </Field>
            ))}
          </div>
        </fieldset>
      </Card>

      {serverError ? (
        <Notice tone={serverError.conflict ? "warning" : "danger"} title={serverError.conflict ? "Settings changed elsewhere" : "Settings were not saved"} action={serverError.conflict ? <Button size="sm" onClick={onSaved}>Reload settings</Button> : undefined}>
          <p>{serverError.message}</p>
          {serverError.issues.length ? <ul className="mt-1 list-disc pl-4">{serverError.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Notice>
      ) : null}
      {submitted && !valid ? <Notice tone="danger">Fix the highlighted values before saving.</Notice> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={busy} disabled={!sumOk}>Save settings</Button>
        <span className="text-[11px] text-slate-600">Saves as version {stored.version + 1}. Every change is audited.</span>
      </div>
    </form>
  );
}

export function SettingsTab({ access }: { access: Access }) {
  const settings = useApiQuery(() => apiAiSettings(), []);
  if (settings.loading && !settings.data) return <LoadingState label="Loading router settings…" />;
  if (settings.error) return <InlineError what="router settings" error={{ ...settings.error, message: errorText(settings.error) }} onRetry={settings.reload} />;
  const d = settings.data;
  if (!d) return null;
  return (
    <section className="space-y-4">
      <SectionHeader
        as="h2"
        title="Router settings"
        subtitle="Platform-wide budgets, quotas and learning parameters. Every value is capped by a hard ceiling in code."
        action={<Badge tone={d.paidModelsAllowed ? "warning" : "success"}>{d.paidModelsAllowed ? "Paid models allowed by deployment" : "Free models only"}</Badge>}
      />
      <p className="text-xs text-slate-600">
        Version {d.version} · {d.source === "default" ? "built-in defaults" : `saved ${fmtDateTime(d.updatedAt)}`}
      </p>
      {access.isPlatformAdmin ? (
        <SettingsForm stored={d} onSaved={settings.reload} />
      ) : (
        <>
          <Notice tone="info">These settings are shared by every organization, so only platform administrators can change them.</Notice>
          <ReadOnly s={d.settings} />
        </>
      )}
    </section>
  );
}
