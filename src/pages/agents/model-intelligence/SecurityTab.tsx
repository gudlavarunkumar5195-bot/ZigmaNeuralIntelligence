import { useId, useState } from "react";
import {
  AI_APPROVAL_STATUSES, AI_SECURITY_EVENT_KINDS, apiAiApprovals, apiAiDecideApproval, apiAiSecurityEvents,
  type AiApprovalStatus, type AiToolApproval,
} from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { useBusy } from "../../../lib/useBusy";
import { SectionHeader } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, Notice, TableContainer } from "../../../components/ui/Primitives";
import { EmptyState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { useToast } from "../../../components/ui/Toast";
import { input, label as labelClass, table, td, th } from "../../../components/ui/styles";
import { errorText, fmtDateTime, humanize, SeverityPill, StatusPill } from "./shared";

const preview = (v: unknown) => {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

function SecurityEvents() {
  const [kind, setKind] = useState("");
  const kindId = useId();
  const events = useApiQuery(() => apiAiSecurityEvents({ kind: kind || undefined, limit: 100 }), [kind]);
  return (
    <section>
      <SectionHeader
        as="h2"
        title="Security events"
        subtitle="Suspected prompt injection, guarded output, rejected tool calls and policy refusals for this organization. Prompts and model output are never stored."
        action={(
          <div>
            <label htmlFor={kindId} className={labelClass}>Kind</label>
            <select id={kindId} className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {AI_SECURITY_EVENT_KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
            </select>
          </div>
        )}
      />
      {events.loading && !events.data ? <LoadingState label="Loading security events…" /> : null}
      {events.error ? <InlineError what="security events" error={{ ...events.error, message: errorText(events.error) }} onRetry={events.reload} /> : null}
      {events.data && events.data.length === 0 ? <EmptyState title="No security events" description={kind ? `No ${humanize(kind).toLowerCase()} events recorded.` : "Nothing has been flagged for this organization."} /> : null}
      {events.data && events.data.length > 0 ? (
        <TableContainer maxHeight={480}>
          <table className={table}>
            <caption className="sr-only">Security events</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Kind</th>
                <th scope="col" className={th}>Severity</th>
                <th scope="col" className={th}>Source</th>
                <th scope="col" className={th}>Categories</th>
                <th scope="col" className={th}>Model</th>
                <th scope="col" className={th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e) => (
                <tr key={e.id}>
                  <td className={td}>{humanize(e.kind)}</td>
                  <td className={td}><SeverityPill severity={e.severity} /></td>
                  <td className={td}>{e.source ? humanize(e.source) : "—"}</td>
                  <td className={td}>{e.categories?.length ? e.categories.map((c) => <span key={c} className="mr-1 inline-block"><Badge>{c}</Badge></span>) : "—"}</td>
                  <td className={`${td} font-mono`}>{e.model ?? "—"}</td>
                  <td className={td}>{fmtDateTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
    </section>
  );
}

function ApprovalRow({ a, onDecided }: { a: AiToolApproval; onDecided: () => void }) {
  const { busy, guard } = useBusy();
  const { notify } = useToast();
  const [error, setError] = useState<string | null>(null);
  const decide = guard(async (approve: boolean) => {
    setError(null);
    const r = await apiAiDecideApproval(a.id, approve);
    if (r.error) return setError(r.error.message);
    notify(approve ? `Approved ${a.tool_id}.` : `Denied ${a.tool_id}.`, "success");
    onDecided();
  });
  return (
    <tr>
      <td className={`${td} font-mono`}>{a.tool_id}</td>
      <td className={td}><SeverityPill severity={a.risk} /></td>
      <td className={td}><StatusPill status={a.status} /></td>
      <td className={`${td} max-w-xs break-words font-mono text-[11px]`}>{preview(a.args_preview)}</td>
      <td className={td}>{fmtDateTime(a.created_at)}</td>
      <td className={td}>{fmtDateTime(a.expires_at)}</td>
      <td className={td}>
        {a.status === "PENDING" ? (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={busy} aria-label={`Approve ${a.tool_id}`} onClick={() => void decide(true)}>Approve</Button>
            <Button size="sm" variant="danger" disabled={busy} aria-label={`Deny ${a.tool_id}`} onClick={() => void decide(false)}>Deny</Button>
          </div>
        ) : a.decided_at ? <span className="text-[11px] text-slate-600">Decided {fmtDateTime(a.decided_at)}</span> : <span className="text-slate-600">—</span>}
        {error ? <p role="alert" className="mt-1 max-w-xs text-[11px] font-600 text-red-700">{error}</p> : null}
      </td>
    </tr>
  );
}

function Approvals() {
  const [status, setStatus] = useState<"" | AiApprovalStatus>("PENDING");
  const statusId = useId();
  const approvals = useApiQuery(() => apiAiApprovals({ status: status || undefined, limit: 100 }), [status]);
  return (
    <section>
      <SectionHeader
        as="h2"
        title="Tool approvals"
        subtitle="High-risk tool calls a model proposed wait here for an owner or admin. You cannot approve a request you made yourself."
        action={(
          <div>
            <label htmlFor={statusId} className={labelClass}>Status</label>
            <select id={statusId} className={input} value={status} onChange={(e) => setStatus(e.target.value as "" | AiApprovalStatus)}>
              <option value="">All statuses</option>
              {AI_APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </div>
        )}
      />
      {approvals.loading && !approvals.data ? <LoadingState label="Loading approvals…" /> : null}
      {approvals.error ? <InlineError what="tool approvals" error={{ ...approvals.error, message: errorText(approvals.error) }} onRetry={approvals.reload} /> : null}
      {approvals.data && approvals.data.length === 0 ? <EmptyState title="No approvals" description={status ? `No ${humanize(status).toLowerCase()} tool approvals.` : "No tool call has needed approval."} /> : null}
      {approvals.data && approvals.data.length > 0 ? (
        <TableContainer>
          <table className={table}>
            <caption className="sr-only">Tool approvals</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Tool</th>
                <th scope="col" className={th}>Risk</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}>Arguments</th>
                <th scope="col" className={th}>Requested</th>
                <th scope="col" className={th}>Expires</th>
                <th scope="col" className={th}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {approvals.data.map((a) => <ApprovalRow key={a.id} a={a} onDecided={approvals.reload} />)}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
      <div className="mt-2"><Notice tone="info">Approvals expire after 30 minutes. An approved call runs once.</Notice></div>
    </section>
  );
}

export function SecurityTab() {
  return (
    <div className="space-y-6">
      <SecurityEvents />
      <Approvals />
    </div>
  );
}
