import { useEffect, useRef, useState } from "react";
import {
  apiGetSiteIssue,
  apiGetSiteIssueHistory,
  type SiteIssueDetail,
  type SiteIssueEvent,
} from "../../../services/api";
import { ErrorState, LoadingState } from "../../../components/ui/DataState";
import { CATEGORY_LABEL, EVENT_LABEL, INDEXABILITY_REASON, OUTCOME_LABEL, formatDate } from "./labels";

/** Renders the measured evidence stored on an issue without inventing anything. */
function Evidence({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0));
  if (entries.length === 0) return <p className="text-xs text-slate-600">The rule's condition itself is the evidence (no extra values recorded).</p>;
  const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase();
  return (
    <dl className="grid gap-2 text-xs">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="font-600 text-slate-700">{label(k)}</dt>
          <dd className="mt-0.5 break-all font-mono text-slate-700">
            {Array.isArray(v) ? (
              <ul className="list-disc pl-4">
                {v.slice(0, 20).map((item, i) => (
                  <li key={i}>{typeof item === "object" ? JSON.stringify(item) : String(item)}</li>
                ))}
              </ul>
            ) : typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Issue details: rule guidance, measured evidence, what the latest crawl saw
 * on the URL, which scans observed it, and the full state history. Focus
 * moves to the heading on open; Close (or Escape) returns it to the opener.
 */
export function IssueDetailPanel({ websiteId, issueId, onClose }: { websiteId: string; issueId: string; onClose: () => void }) {
  const [issue, setIssue] = useState<SiteIssueDetail | null>(null);
  const [history, setHistory] = useState<SiteIssueEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async () => {
    setError(null);
    setIssue(null);
    setHistory(null);
    try {
      const [d, h] = await Promise.all([apiGetSiteIssue(websiteId, issueId), apiGetSiteIssueHistory(websiteId, issueId)]);
      if (d.error || !d.data) throw new Error(d.error?.message ?? "Issue not found");
      if (h.error) throw new Error(h.error.message);
      setIssue(d.data);
      setHistory(h.data ?? []);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [websiteId, issueId]);
  useEffect(() => {
    if (issue) heading.current?.focus();
  }, [issue?.id]);

  const page = issue?.latestCrawl?.page ?? null;
  return (
    <section
      aria-labelledby="issue-detail-heading"
      className="mt-4 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      {error ? (
        <ErrorState title="Unable to load the issue" message={error} onRetry={load} />
      ) : !issue || !history ? (
        <LoadingState label="Loading issue details…" />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-blue-700">
                {CATEGORY_LABEL[issue.category] ?? issue.category} · {issue.rule_id}
              </p>
              <h4 id="issue-detail-heading" ref={heading} tabIndex={-1} className="mt-1 text-base font-800 text-slate-950 focus:outline-none">
                {issue.title}
              </h4>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">{issue.url}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
              Close details
            </button>
          </div>

          <p className="mt-3 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-700 text-emerald-800">
            Measured by our crawler ({issue.rule.source}), not estimated
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h5 className="text-xs font-700 uppercase tracking-wide text-slate-500">What we found</h5>
              <p className="mt-1 text-sm text-slate-800">{issue.rule.explanation}</p>
              <h5 className="mt-3 text-xs font-700 uppercase tracking-wide text-slate-500">How to fix it</h5>
              <p className="mt-1 text-sm text-slate-800">{issue.rule.remediation}</p>
            </div>
            <div>
              <h5 className="text-xs font-700 uppercase tracking-wide text-slate-500">Evidence</h5>
              <div className="mt-1"><Evidence details={issue.details} /></div>
            </div>
          </div>

          <div className="mt-4">
            <h5 className="text-xs font-700 uppercase tracking-wide text-slate-500">This URL in the latest crawl</h5>
            {!issue.latestCrawl ? (
              <p className="mt-1 text-xs text-slate-600">No crawl data is stored for this website yet.</p>
            ) : !page ? (
              <p className="mt-1 text-xs text-slate-600">The latest crawl ({formatDate(issue.latestCrawl.crawledAt)}) did not reach this URL, so it says nothing about it.</p>
            ) : (
              <dl className="mt-1 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <div><dt className="text-slate-500">Outcome</dt><dd className="font-600 text-slate-800">{page.outcome ? OUTCOME_LABEL[page.outcome] : "—"}</dd></div>
                <div><dt className="text-slate-500">Status</dt><dd className="font-mono text-slate-800">{page.status_code || "—"}{page.redirect_chain.length ? ` → ${page.final_status_code || "error"}` : ""}</dd></div>
                <div>
                  <dt className="text-slate-500">Indexing signals</dt>
                  <dd className="text-slate-800">{page.indexable ? "Eligible (not a claim it is indexed)" : (page.indexability_reasons ?? []).map((r) => INDEXABILITY_REASON[r] ?? r).join(", ") || "Not eligible"}</dd>
                </div>
                <div><dt className="text-slate-500">Crawled</dt><dd className="text-slate-800">{formatDate(issue.latestCrawl.crawledAt)}</dd></div>
              </dl>
            )}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h5 className="text-xs font-700 uppercase tracking-wide text-slate-500">Across scans</h5>
              <p className="mt-1 text-xs text-slate-700">
                Observed in {issue.occurrenceCount} scan{issue.occurrenceCount === 1 ? "" : "s"} · first seen {formatDate(issue.first_seen_at)} · last seen {formatDate(issue.last_seen_at)}
                {issue.fixed_at ? ` · fixed ${formatDate(issue.fixed_at)}` : ""}
                {issue.times_reopened ? ` · came back ${issue.times_reopened}×` : ""}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {issue.occurrences.map((o) => (
                  <li key={o.scan_id}><span className="font-mono">{o.scan_id.slice(0, 8)}</span> · {formatDate(o.observed_at)} · scan {o.scan_status}</li>
                ))}
              </ul>
            </div>
            <div>
              <h5 className="text-xs font-700 uppercase tracking-wide text-slate-500">History</h5>
              <ol className="mt-1 space-y-2 border-l border-slate-200 pl-3 text-xs">
                {history.map((e) => (
                  <li key={e.id}>
                    <span className="font-600 text-slate-800">{EVENT_LABEL[e.event] ?? e.event}</span>
                    <span className="text-slate-500"> · {formatDate(e.created_at)}</span>
                    {e.actor_id ? <span className="text-slate-600"> · by {e.actor_name ?? "a former member"}</span> : e.scan_id ? <span className="text-slate-600"> · by scan {e.scan_id.slice(0, 8)}</span> : null}
                    {e.note ? <p className="text-slate-700">Reason: {e.note}</p> : null}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
