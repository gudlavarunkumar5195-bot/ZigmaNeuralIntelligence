import { useId, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { apiAiCancelTask, apiAiTask, apiAiTaskFeedback, apiAiTasks, type AiFeedbackReason, type AiTaskDetail } from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { useBusy } from "../../../lib/useBusy";
import { SectionHeader } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { Badge, Notice, TableContainer } from "../../../components/ui/Primitives";
import { EmptyState, InlineError, LoadingState } from "../../../components/ui/DataState";
import { useToast } from "../../../components/ui/Toast";
import { input, label as labelClass, table, td, tdNum, th } from "../../../components/ui/styles";
import { errorText, EstimatedTag, fmtDateTime, fmtInt, humanize, num, StatusPill } from "./shared";

const STATUSES = ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "REJECTED"] as const;
const REASONS: Array<{ value: "" | AiFeedbackReason; label: string }> = [
  { value: "", label: "No reason" },
  { value: "helpful", label: "Helpful" },
  { value: "accurate", label: "Accurate" },
  { value: "incorrect", label: "Incorrect" },
  { value: "incomplete", label: "Incomplete" },
  { value: "off_topic", label: "Off topic" },
  { value: "format", label: "Wrong format" },
  { value: "unsafe", label: "Unsafe" },
  { value: "other", label: "Other" },
];

function SubTable({ caption, headers, children, empty }: { caption: string; headers: string[]; children: React.ReactNode; empty: boolean }) {
  return (
    <div className="mt-4">
      <h3 className="text-card-title">{caption}</h3>
      {empty ? <p className="mt-1 text-xs text-slate-600">None recorded.</p> : (
        <div className="mt-1"><TableContainer>
          <table className={table}>
            <caption className="sr-only">{caption}</caption>
            <thead><tr>{headers.map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
            <tbody>{children}</tbody>
          </table>
        </TableContainer></div>
      )}
    </div>
  );
}

function Feedback({ task, onDone }: { task: AiTaskDetail; onDone: () => void }) {
  const { busy, guard } = useBusy();
  const reasonId = useId();
  const [reason, setReason] = useState<"" | AiFeedbackReason>("");
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  const rate = guard(async (rating: 1 | -1) => {
    setMessage(null);
    const r = await apiAiTaskFeedback(task.id, rating, reason || undefined);
    if (r.error) {
      setMessage(r.error.status === 409
        ? { tone: "warning", text: "You have already rated this result. Each person can rate a task once." }
        : { tone: "danger", text: r.error.message });
      return;
    }
    setMessage({ tone: "success", text: "Thanks. Your rating was recorded and feeds the quality scores." });
    onDone();
  });
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-3">
      <h3 className="text-card-title">Rate this result</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={reasonId} className={labelClass}>Reason (optional)</label>
          <select id={reasonId} className={input} value={reason} onChange={(e) => setReason(e.target.value as "" | AiFeedbackReason)}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <Button size="sm" disabled={busy} icon={<ThumbsUp size={14} aria-hidden="true" />} onClick={() => void rate(1)}>Good result</Button>
        <Button size="sm" disabled={busy} icon={<ThumbsDown size={14} aria-hidden="true" />} onClick={() => void rate(-1)}>Poor result</Button>
      </div>
      {message ? <div className="mt-2"><Notice tone={message.tone}>{message.text}</Notice></div> : null}
    </div>
  );
}

function TaskDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useApiQuery(() => apiAiTask(id), [id]);
  const { busy, guard } = useBusy();
  const { notify } = useToast();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = guard(async () => {
    setCancelError(null);
    const r = await apiAiCancelTask(id);
    if (r.error) return setCancelError(r.error.message);
    notify("Cancellation requested. The task stops at its next checkpoint.", "success");
    detail.reload();
    onChanged();
  });

  if (detail.loading && !detail.data) return <LoadingState label="Loading task…" />;
  if (detail.error) return <InlineError what="the task" error={detail.error} onRetry={detail.reload} />;
  const t = detail.data;
  if (!t) return null;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div><dt className="font-600 text-slate-600">Status</dt><dd className="mt-0.5"><StatusPill status={t.status} /></dd></div>
        <div><dt className="font-600 text-slate-600">Task category</dt><dd className="mt-0.5">{humanize(t.task_type)}</dd></div>
        <div><dt className="font-600 text-slate-600">Feature</dt><dd className="mt-0.5">{t.feature ?? "—"}</dd></div>
        <div><dt className="font-600 text-slate-600">Tokens used / reserved</dt><dd className="mt-0.5 tabular-nums">{fmtInt(t.tokens_used)} / {fmtInt(t.tokens_reserved)}</dd></div>
        <div><dt className="font-600 text-slate-600">Feasibility</dt><dd className="mt-0.5">{humanize(t.feasibility)}</dd></div>
        <div><dt className="font-600 text-slate-600">Error</dt><dd className="mt-0.5">{t.error_code ?? "—"}</dd></div>
      </dl>
      {t.status === "RUNNING" ? (
        <div className="mt-3">
          <Button variant="danger" size="sm" loading={busy} onClick={() => void cancel()}>Cancel task</Button>
          {cancelError ? <div className="mt-2"><Notice tone="danger">{cancelError}</Notice></div> : null}
        </div>
      ) : null}

      <SubTable caption="Routing decision" headers={["Selected", "Fallbacks", "Reason", "Source", "Confidence", "Candidates"]} empty={t.routing.length === 0}>
        {t.routing.map((r) => (
          <tr key={r.id}>
            <td className={`${td} font-mono`}>{r.selected_openrouter_id ?? "—"}</td>
            <td className={`${td} font-mono`}>{r.fallback_openrouter_ids?.length ? r.fallback_openrouter_ids.join(", ") : "—"}</td>
            <td className={td}>{r.decision_reason ?? "—"}</td>
            <td className={td}>{humanize(r.decision_source)}</td>
            <td className={tdNum}>{r.decision_confidence === null ? "—" : num(r.decision_confidence).toFixed(2)}</td>
            <td className={tdNum}>{r.candidate_count ?? "—"} ({r.excluded_count ?? 0} excluded)</td>
          </tr>
        ))}
      </SubTable>

      <SubTable caption="Model attempts" headers={["#", "Model", "Outcome", "Fallback reason", "Input tokens", "Output tokens", "Latency"]} empty={t.attempts.length === 0}>
        {t.attempts.map((a, i) => {
          const est = a.usage_estimated !== false;
          return (
            <tr key={`${a.started_at}-${i}`}>
              <td className={tdNum}>{a.attempt_number ?? i + 1}</td>
              <td className={`${td} font-mono`}>{a.model ?? "—"}</td>
              <td className={td}>{a.failure_category ? <Badge tone="danger">{humanize(a.failure_category)}</Badge> : <StatusPill status={a.status.toUpperCase()} />}</td>
              <td className={td}>{a.fallback_reason ? humanize(a.fallback_reason) : "—"}</td>
              <td className={tdNum}>
                {est ? <>{fmtInt(a.estimated_input_tokens)}<EstimatedTag /></> : <>{fmtInt(a.prompt_tokens)} <span className="text-[10px] text-slate-600">provider</span></>}
              </td>
              <td className={tdNum}>
                {est ? <>{fmtInt(a.completion_tokens ?? a.estimated_output_tokens)}<EstimatedTag /></> : <>{fmtInt(a.completion_tokens)} <span className="text-[10px] text-slate-600">provider</span></>}
              </td>
              <td className={tdNum}>{a.latency_ms === null ? "—" : `${fmtInt(a.latency_ms)} ms`}</td>
            </tr>
          );
        })}
      </SubTable>

      <SubTable caption="Agents" headers={["Role", "Depth", "Status", "Model", "Started"]} empty={t.agents.length === 0}>
        {t.agents.map((a) => (
          <tr key={a.id}>
            <td className={td}>{humanize(a.role)}</td>
            <td className={tdNum}>{a.depth}</td>
            <td className={td}><StatusPill status={a.status.toUpperCase()} />{a.error_code ? <span className="ml-1 text-[11px] text-red-700">{a.error_code}</span> : null}</td>
            <td className={`${td} font-mono`}>{a.model ?? "—"}</td>
            <td className={td}>{fmtDateTime(a.started_at)}</td>
          </tr>
        ))}
      </SubTable>

      <SubTable caption="Evaluations" headers={["Model", "Outcome", "Score", "Method", "Security"]} empty={t.evaluations.length === 0}>
        {t.evaluations.map((e, i) => (
          <tr key={`${e.created_at}-${i}`}>
            <td className={`${td} font-mono`}>{e.model}</td>
            <td className={td}>{humanize(e.outcome)}</td>
            <td className={tdNum}>{e.quality_score ?? "—"}</td>
            <td className={td}>{humanize(e.method)}</td>
            <td className={td}>{e.security_violation ? <Badge tone="danger">Violation</Badge> : "None"}</td>
          </tr>
        ))}
      </SubTable>

      <SubTable caption="User feedback" headers={["Rating", "Reason", "When"]} empty={t.feedback.length === 0}>
        {t.feedback.map((f, i) => (
          <tr key={`${f.created_at}-${i}`}>
            <td className={td}>{f.rating > 0 ? "Good" : "Poor"}</td>
            <td className={td}>{humanize(f.reason)}</td>
            <td className={td}>{fmtDateTime(f.created_at)}</td>
          </tr>
        ))}
      </SubTable>

      {t.status === "COMPLETED" ? <Feedback task={t} onDone={detail.reload} /> : null}
    </div>
  );
}

export function TasksTab() {
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const filterId = useId();
  const tasks = useApiQuery(() => apiAiTasks({ status: status || undefined, limit: 100 }), [status]);

  return (
    <section>
      <SectionHeader
        as="h2"
        title="Task runs"
        subtitle="Each AI task this organization ran: the model the router chose, the budget it used and how it ended."
        action={(
          <div>
            <label htmlFor={filterId} className={labelClass}>Status</label>
            <select id={filterId} className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </div>
        )}
      />
      {tasks.loading && !tasks.data ? <LoadingState label="Loading tasks…" /> : null}
      {tasks.error ? <InlineError what="task runs" error={{ ...tasks.error, message: errorText(tasks.error) }} onRetry={tasks.reload} /> : null}
      {tasks.data && tasks.data.length === 0 ? <EmptyState title="No task runs" description={status ? `No ${humanize(status).toLowerCase()} tasks.` : "No AI tasks have run for this organization yet."} /> : null}
      {tasks.data && tasks.data.length > 0 ? (
        <TableContainer maxHeight={640}>
          <table className={table}>
            <caption className="sr-only">Task runs</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}>Task category</th>
                <th scope="col" className={th}>Feature</th>
                <th scope="col" className={th}>Selected model</th>
                <th scope="col" className={`${th} text-right`}>Tokens used</th>
                <th scope="col" className={`${th} text-right`}>Calls</th>
                <th scope="col" className={`${th} text-right`}>Agents</th>
                <th scope="col" className={th}>Started</th>
                <th scope="col" className={th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id}>
                  <td className={td}><StatusPill status={t.status} /></td>
                  <td className={td}>{humanize(t.task_type)}</td>
                  <td className={td}>{t.feature ?? "—"}</td>
                  <td className={`${td} font-mono`}>{t.selected_model ?? "—"}</td>
                  <td className={tdNum}>{fmtInt(t.tokens_used)}</td>
                  <td className={tdNum}>{fmtInt(t.calls_used)}</td>
                  <td className={tdNum}>{fmtInt(t.agents_used)}</td>
                  <td className={td}>{fmtDateTime(t.started_at)}</td>
                  <td className={td}>
                    <Button size="sm" aria-label={`Details for ${humanize(t.task_type)} task started ${fmtDateTime(t.started_at)}`} onClick={() => setOpenId(t.id)}>Details</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
      <Dialog open={openId !== null} onClose={() => setOpenId(null)} title="Task details" size="lg">
        {openId ? <TaskDetail id={openId} onChanged={tasks.reload} /> : null}
      </Dialog>
    </section>
  );
}
