import { useState } from "react";
import { InlineError } from "../../components/ui/DataState";
import { btn, btnPrimary, input } from "../../components/ui/styles";
import { useApiQuery } from "../../lib/useApiQuery";
import { useBusy } from "../../lib/useBusy";
import { apiCreateMonitoringRule, apiListMonitoringRules, apiUpdateMonitoringRule, type MonitoringAlertRule } from "../../services/api";

/** What each rule raises an alert for (mirrors monitoring.service matching). */
export const RULE_TYPES: Array<{ id: string; label: string; threshold?: string }> = [
  { id: "new_critical", label: "A new critical finding" },
  { id: "regression", label: "A regression of medium severity or worse" },
  { id: "score_drop", label: "A score drop of at least…", threshold: "points" },
  { id: "url_disappearance", label: "A previously seen URL disappears" },
  { id: "significant_technical", label: "A high-severity technical change" },
  { id: "seo", label: "Any SEO change" },
  { id: "security", label: "Any security change" },
  { id: "performance", label: "Any performance change" },
  { id: "ssl", label: "Any SSL change" },
];
const labelOf = (id: string) => RULE_TYPES.find((r) => r.id === id)?.label ?? id.replace(/_/g, " ");

/**
 * Alert rules of one monitoring configuration. Only owners and admins may read
 * or change them; the API refuses everyone else and that refusal is shown.
 */
export function AlertRules({ monitoringId, domain }: { monitoringId: string; domain: string }) {
  const rules = useApiQuery(() => apiListMonitoringRules(monitoringId), [monitoringId]);
  const { busy, guard } = useBusy();
  const [ruleType, setRuleType] = useState("score_drop");
  const [threshold, setThreshold] = useState("10");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const needsThreshold = !!RULE_TYPES.find((r) => r.id === ruleType)?.threshold;
  const thresholdValue = Number(threshold);
  const thresholdInvalid = needsThreshold && (!Number.isFinite(thresholdValue) || thresholdValue <= 0 || thresholdValue > 100);

  const add = guard(async () => {
    const r = await apiCreateMonitoringRule(monitoringId, { ruleType, threshold: needsThreshold ? thresholdValue : null });
    setMessage(r.error ? { ok: false, text: r.error.message } : { ok: true, text: `Rule saved: ${labelOf(ruleType)}${needsThreshold ? ` ${thresholdValue} points` : ""}.` });
    if (!r.error) rules.reload();
  });
  const toggle = guard(async (rule: MonitoringAlertRule) => {
    const r = await apiUpdateMonitoringRule(rule.id, { enabled: !rule.enabled });
    setMessage(r.error ? { ok: false, text: r.error.message } : null);
    rules.reload();
  });

  return (
    <section aria-label={`Alert rules for ${domain}`} className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
      <p className="font-600 text-slate-800">Alert rules</p>
      <p className="mt-0.5 text-slate-500">A detected change raises an alert when any enabled rule matches it.</p>
      {rules.error ? <InlineError what="the alert rules" error={rules.error} onRetry={rules.reload} /> : !rules.data ? <p className="mt-2 text-slate-500">Loading rules…</p> : rules.data.length === 0 ? <p className="mt-2 text-slate-600">No rules: changes are recorded but raise no alerts.</p> : (
        <ul className="mt-2 divide-y divide-slate-200">
          {rules.data.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className={rule.enabled ? "text-slate-800" : "text-slate-400 line-through"}>{labelOf(rule.rule_type)}{rule.threshold !== null ? ` ${rule.threshold} points` : ""}</span>
              <button type="button" className={`${btn} ml-auto`} disabled={busy} onClick={() => void toggle(rule)}>{rule.enabled ? "Turn off" : "Turn on"}</button>
            </li>
          ))}
        </ul>
      )}
      {rules.data ? (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!thresholdInvalid) void add(); }}>
          <label className="text-slate-700">Add rule
            <select className={input} value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
              {RULE_TYPES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          {needsThreshold ? (
            <label className="text-slate-700">Points
              <input className={`${input} w-20`} type="number" min={1} max={100} value={threshold} aria-invalid={thresholdInvalid || undefined} onChange={(e) => setThreshold(e.target.value)} />
            </label>
          ) : null}
          <button type="submit" className={btnPrimary} disabled={busy || thresholdInvalid}>Save rule</button>
          {thresholdInvalid ? <span role="alert" className="text-red-700">Enter 1–100 points.</span> : null}
        </form>
      ) : null}
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 ${message.ok ? "text-slate-700" : "text-red-700"}`}>{message.text}</p> : null}
    </section>
  );
}
