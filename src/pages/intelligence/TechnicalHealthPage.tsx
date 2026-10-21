import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ApiCallError,
  apiGetCrawlSummary,
  apiGetDashboard,
  apiGetScan,
  apiIgnoreSiteIssue,
  apiListSeoRules,
  apiListSiteIssues,
  apiReopenSiteIssue,
  IntegrationRequired,
  type CrawlOverviewMeta,
  type CrawlSummary,
  type SeoRuleInfo,
  type SiteIssue,
  type SiteIssueStatus,
} from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { CATEGORY_LABEL, SEVERITIES, TRUNCATION_LABEL, formatDate } from "./technical-health/labels";
import { RunCrawlForm } from "./technical-health/RunCrawlForm";
import { IssueDetailPanel } from "./technical-health/IssueDetailPanel";
import { CrawlInventory } from "./technical-health/CrawlInventory";

const STATUS_TABS: SiteIssueStatus[] = ["OPEN", "FIXED", "IGNORED"];
const ACTIVE = new Set(["queued", "running"]);
const POLL_MS = 3_000;
const ROBOTS_LABEL: Record<CrawlSummary["robots_status"], string> = {
  parsed: "Found and applied",
  missing: "Not found (all paths crawlable)",
  unreachable: "Unreachable (crawl blocked)",
};
const SITEMAP_LABEL: Record<CrawlSummary["sitemap_status"], string> = {
  found: "Found",
  missing: "Not found",
  invalid: "Invalid XML",
  unsupported: "Gzipped (not read)",
};
const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-blue-50 text-blue-800",
  info: "bg-slate-100 text-slate-700",
};

const fail = (r: { error: { code: string; message: string } | null }) => {
  if (r.error) throw new ApiCallError(0, r.error.code, r.error.message);
};
const ROLE_ERROR = new Set(["FORBIDDEN", "INSUFFICIENT_ROLE"]);

interface IssueFilters {
  severity: string;
  category: string;
  rule: string;
  url: string;
}
const NO_FILTERS: IssueFilters = { severity: "", category: "", rule: "", url: "" };

/** Technical health: real multi-page crawl results and persistent issues for the selected website. */
export function TechnicalHealthPage() {
  const selectedId = useSelectedWebsiteId();
  const [site, setSite] = useState<{ id: string; domain: string } | null | undefined>(undefined);
  const [summary, setSummary] = useState<CrawlSummary | null>(null);
  const [overview, setOverview] = useState<CrawlOverviewMeta | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [rules, setRules] = useState<SeoRuleInfo[]>([]);

  const [tab, setTab] = useState<SiteIssueStatus>("OPEN");
  const [filters, setFilters] = useState<IssueFilters>(NO_FILTERS);
  const [urlInput, setUrlInput] = useState("");
  const [issues, setIssues] = useState<SiteIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<Record<SiteIssueStatus, number>>({ OPEN: 0, FIXED: 0, IGNORED: 0 });

  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState<string | null>(null);
  const [confirmReopen, setConfirmReopen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());

  const loadOverview = async (websiteId: string) => {
    const s = await apiGetCrawlSummary(websiteId);
    fail(s);
    setSummary(s.data ?? null);
    setOverview(s.meta ?? null);
    return s.meta ?? null;
  };

  const loadSite = async () => {
    setError(null);
    setSite(undefined);
    try {
      const dashboard = await apiGetDashboard(selectedId);
      fail(dashboard);
      const chosen = dashboard.data?.selectedWebsite;
      if (!chosen) {
        setSite(null);
        return;
      }
      setSite({ id: chosen.id, domain: chosen.domain });
      await loadOverview(chosen.id);
      const r = await apiListSeoRules(chosen.id).catch(() => null);
      if (r?.data) setRules(r.data);
    } catch (cause) {
      setError(cause as Error);
    }
  };

  const fetchIssues = (websiteId: string, after: string | null) =>
    apiListSiteIssues(websiteId, {
      status: tab,
      severity: filters.severity || undefined,
      category: filters.category || undefined,
      rule: filters.rule || undefined,
      url: filters.url || undefined,
      cursor: after,
    });

  const loadIssues = async (websiteId: string) => {
    setIssues(null);
    setIssuesError(null);
    try {
      const r = await fetchIssues(websiteId, null);
      fail(r);
      setIssues(r.data ?? []);
      setCursor(r.meta?.nextCursor ?? null);
      setTotal(r.meta?.total ?? (r.data ?? []).length);
      if (r.meta?.counts) setCounts(r.meta.counts);
    } catch (cause) {
      setIssuesError((cause as Error).message);
    }
  };

  const loadMore = async () => {
    if (!site || !cursor) return;
    setLoadingMore(true);
    try {
      const r = await fetchIssues(site.id, cursor);
      fail(r);
      setIssues((prev) => [...(prev ?? []), ...(r.data ?? [])]);
      setCursor(r.meta?.nextCursor ?? null);
    } catch (cause) {
      setIssuesError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadSite();
  }, [selectedId]);
  useEffect(() => {
    if (site?.id) void loadIssues(site.id);
  }, [site?.id, tab, filters]);

  // While a crawl scan is queued or running, poll it and announce progress;
  // when it ends, reload everything and announce the outcome.
  const latestScan = overview?.latestScan ?? null;
  const crawlActive = !!latestScan && ACTIVE.has(latestScan.status);
  useEffect(() => {
    if (!site?.id || !latestScan || !ACTIVE.has(latestScan.status)) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const scan = await apiGetScan(latestScan.id);
        const data = scan.data as { status?: string; crawl_progress?: { pagesCrawled?: number; pagesDiscovered?: number } | null } | null;
        if (stopped || !data) return;
        if (data.status && ACTIVE.has(data.status)) {
          const p = data.crawl_progress;
          setProgress(p ? `Crawling: ${p.pagesCrawled ?? 0} pages fetched, ${p.pagesDiscovered ?? 0} URLs discovered so far.` : "Crawl queued or starting…");
          timer = window.setTimeout(() => void tick(), POLL_MS);
          return;
        }
        const meta = await loadOverview(site.id);
        await loadIssues(site.id);
        const c = meta?.changes;
        setProgress(
          data.status === "completed"
            ? `Crawl finished${c ? `: ${c.detected} new, ${c.fixed} fixed, ${c.reopened} reopened.` : "."}`
            : `Crawl ${data.status}. Issues were left unchanged.`,
        );
      } catch {
        if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [site?.id, latestScan?.id, latestScan?.status]);

  const closeDetail = () => {
    const id = selected;
    setSelected(null);
    if (id) openers.current.get(id)?.focus();
  };

  const act = async (issue: SiteIssue, action: "ignore" | "reopen") => {
    if (!site || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = action === "ignore" ? await apiIgnoreSiteIssue(site.id, issue.id, reason.trim()) : await apiReopenSiteIssue(site.id, issue.id);
      if (r.error) {
        setNotice(ROLE_ERROR.has(r.error.code) ? "Your role cannot change issue status." : r.error.message);
        return;
      }
      setNotice(action === "ignore" ? `Ignored: ${issue.title}. It stays ignored across scans until reopened.` : `Reopened: ${issue.title}.`);
      setIgnoring(null);
      setConfirmReopen(null);
      setReason("");
      if (selected === issue.id) setSelected(null);
      await loadIssues(site.id);
    } finally {
      setBusy(false);
    }
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Technical health" />;
  if (error) return <ErrorState title="Unable to load technical health" message={error.message} onRetry={loadSite} />;
  if (site === undefined) return <LoadingState label="Loading technical health..." />;
  if (site === null) return <EmptyState title="No website selected" description="Add and verify a website, then run a scan." />;

  const previous = overview?.previous ?? null;
  const changes = overview?.changes ?? null;
  const failedScan = latestScan && !ACTIVE.has(latestScan.status) && (latestScan.status === "failed" || latestScan.crawl_module_status === "failed")
    && (!summary || latestScan.id !== summary.scan_id || latestScan.crawl_module_status === "failed")
    ? latestScan : null;
  const filtersActive = filters.severity || filters.category || filters.rule || filters.url;

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Technical health</p>
      <h2 className="mt-2 text-2xl font-800 text-slate-950">{site.domain}</h2>

      <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-700">{progress}</p>

      <div className="mt-4">
        <RunCrawlForm
          websiteId={site.id}
          disabled={crawlActive}
          onStarted={(_scanId, message) => {
            setProgress(message);
            void loadOverview(site.id);
          }}
        />
      </div>
      {crawlActive && latestScan ? (
        <p className="mt-2 text-xs text-slate-600">
          A crawl is {latestScan.status}. <Link to={`/websites/scan/${latestScan.id}`} className="font-600 text-blue-700 underline">Open scan progress</Link>
        </p>
      ) : null}
      {failedScan ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          The latest crawl ({formatDate(failedScan.created_at)}) did not complete: {failedScan.crawl_module_error ?? failedScan.error ?? "unknown error"}.
          Issue states were not changed by it.
        </p>
      ) : null}

      {!summary ? (
        <EmptyState title="No crawl yet" description="Start a crawl above to audit every reachable page of this site." />
      ) : (
        <section aria-labelledby="crawl-summary" className="mt-6">
          <h3 id="crawl-summary" className="text-sm font-700 text-slate-900">Latest crawl</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Pages crawled" value={`${summary.pages_crawled} of ${summary.pages_discovered} found`} />
            <Stat label="robots.txt" value={`${ROBOTS_LABEL[summary.robots_status]}${summary.pages_blocked_by_robots ? ` · ${summary.pages_blocked_by_robots} URLs disallowed` : ""}`} />
            <Stat label="Sitemap" value={`${SITEMAP_LABEL[summary.sitemap_status]}${summary.sitemap_url_count ? ` · ${summary.sitemap_url_count} URLs` : ""}`} />
            <Stat label="Crawled" value={new Date(summary.created_at).toLocaleString()} />
          </dl>
          <p className="mt-3 text-xs text-slate-600">
            Status codes: {["2xx", "3xx", "4xx", "5xx", "error", "blocked"].filter((k) => k !== "blocked" || summary.status_counts.blocked).map((k) => `${k} ${summary.status_counts[k] ?? 0}`).join(" · ")}
          </p>
          {summary.truncated && summary.truncated_reason ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Partial crawl: stopped at {summary.truncated_reason === "page_limit" ? `the ${summary.max_pages}-page limit` : TRUNCATION_LABEL[summary.truncated_reason]}. Issues on pages it did not reach are kept as they were.
            </p>
          ) : null}
          {changes || previous ? (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <h4 className="font-700 text-slate-800">Compared with the previous crawl</h4>
              {changes ? <p className="mt-1">This crawl: {changes.detected} new issue{changes.detected === 1 ? "" : "s"}, {changes.fixed} fixed, {changes.reopened} reopened.</p> : null}
              {previous ? (
                <p className="mt-1">
                  Previous crawl {formatDate(previous.created_at)}: {previous.pages_crawled} pages
                  ({summary.pages_crawled - previous.pages_crawled >= 0 ? "+" : ""}{summary.pages_crawled - previous.pages_crawled} now);
                  4xx {previous.status_counts["4xx"] ?? 0} → {summary.status_counts["4xx"] ?? 0}, 5xx {previous.status_counts["5xx"] ?? 0} → {summary.status_counts["5xx"] ?? 0}.
                </p>
              ) : <p className="mt-1">This is the first crawl of this site.</p>}
            </div>
          ) : null}
        </section>
      )}

      <section aria-labelledby="issues-heading" className="mt-8">
        <h3 id="issues-heading" className="text-sm font-700 text-slate-900">Issues</h3>
        <div role="group" aria-label="Filter issues by status" className="mt-3 flex gap-2">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={tab === s}
              onClick={() => setTab(s)}
              className={`rounded-full border px-3 py-1 text-xs font-600 ${tab === s ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`}
            >
              {s[0] + s.slice(1).toLowerCase()} ({counts[s] ?? 0})
            </button>
          ))}
        </div>
        <form
          role="search"
          aria-label="Filter issues"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); setFilters((f) => ({ ...f, url: urlInput.trim() })); }}
        >
          <label className="text-xs text-slate-700">
            Severity
            <select value={filters.severity} onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
              <option value="">Any severity</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-700">
            Category
            <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, rule: "" }))} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs">
              <option value="">Any category</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-700">
            Rule
            <select value={filters.rule} onChange={(e) => setFilters((f) => ({ ...f, rule: e.target.value }))} className="mt-1 block max-w-56 rounded border border-slate-300 px-2 py-1 text-xs">
              <option value="">Any rule</option>
              {rules.filter((r) => !filters.category || r.category === filters.category).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-700">
            URL contains
            <input value={urlInput} maxLength={200} onChange={(e) => setUrlInput(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-xs" />
          </label>
          <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">Apply</button>
          {filtersActive ? (
            <button type="button" onClick={() => { setFilters(NO_FILTERS); setUrlInput(""); }} className="text-xs font-600 text-blue-700 underline">Clear filters</button>
          ) : null}
        </form>
        <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-600">{notice}</p>

        {issuesError ? (
          <ErrorState title="Unable to load issues" message={issuesError} onRetry={() => void loadIssues(site.id)} />
        ) : !issues ? (
          <LoadingState label="Loading issues..." />
        ) : issues.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No {tab.toLowerCase()} issues{filtersActive ? " match these filters" : ""}.</p>
        ) : (
          <>
            <p className="text-xs text-slate-500">Showing {issues.length} of {total}</p>
            <ul className="mt-2 space-y-2">
              {issues.map((issue) => (
                <li key={issue.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-700 text-slate-900">{issue.title}</h4>
                    <span className="flex gap-1">
                      <span className="rounded-full bg-white px-2 py-1 text-[10px] font-700 text-slate-600">{CATEGORY_LABEL[issue.category] ?? issue.category}</span>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-700 uppercase ${SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.info}`}>{issue.severity}</span>
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-[11px] text-slate-600">{issue.url}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    First seen {new Date(issue.first_seen_at).toLocaleDateString()} · last seen {new Date(issue.last_seen_at).toLocaleDateString()}
                    {issue.fixed_at ? ` · fixed ${new Date(issue.fixed_at).toLocaleDateString()}` : ""}
                    {issue.times_reopened ? ` · reopened ${issue.times_reopened}×` : ""}
                  </p>
                  {issue.ignore_reason ? <p className="mt-1 text-[11px] text-slate-600">Ignored: {issue.ignore_reason}</p> : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      ref={(el) => { openers.current.set(issue.id, el); }}
                      aria-expanded={selected === issue.id}
                      onClick={() => setSelected(selected === issue.id ? null : issue.id)}
                      className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700"
                    >
                      {selected === issue.id ? "Hide details" : "Details"} <span className="sr-only">{issue.title}</span>
                    </button>
                    {issue.status === "IGNORED" ? (
                      confirmReopen === issue.id ? (
                        <span className="flex items-center gap-2 text-xs">
                          <span>Reopen this issue?</span>
                          <button type="button" disabled={busy} onClick={() => void act(issue, "reopen")} className="rounded bg-slate-900 px-2 py-1 font-600 text-white">Confirm reopen</button>
                          <button type="button" onClick={() => setConfirmReopen(null)} className="text-slate-600">Cancel</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmReopen(issue.id)} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
                          Reopen <span className="sr-only">{issue.title}</span>
                        </button>
                      )
                    ) : ignoring === issue.id ? (
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onKeyDown={(e) => { if (e.key === "Escape") setIgnoring(null); }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (reason.trim()) void act(issue, "ignore");
                        }}
                      >
                        <label htmlFor={`reason-${issue.id}`} className="text-xs text-slate-700">Reason</label>
                        <input
                          id={`reason-${issue.id}`}
                          value={reason}
                          maxLength={500}
                          required
                          autoFocus
                          aria-describedby={`reason-help-${issue.id}`}
                          onChange={(e) => setReason(e.target.value)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                        <span id={`reason-help-${issue.id}`} className="sr-only">Ignored issues stay ignored in later scans until someone reopens them.</span>
                        <button type="submit" disabled={busy} className="rounded bg-slate-900 px-2 py-1 text-xs font-600 text-white">Ignore</button>
                        <button type="button" onClick={() => setIgnoring(null)} className="text-xs text-slate-600">Cancel</button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => { setIgnoring(issue.id); setReason(""); }} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
                        Ignore… <span className="sr-only">{issue.title}</span>
                      </button>
                    )}
                  </div>
                  {selected === issue.id ? <IssueDetailPanel websiteId={site.id} issueId={issue.id} onClose={closeDetail} /> : null}
                </li>
              ))}
            </ul>
            {cursor ? (
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="mt-3 rounded border border-slate-300 px-3 py-1 text-xs font-600 text-slate-700 disabled:opacity-50">
                {loadingMore ? "Loading…" : "Load more issues"}
              </button>
            ) : null}
          </>
        )}
      </section>

      {summary ? <CrawlInventory websiteId={site.id} scanId={summary.scan_id} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-700 text-slate-900">{value}</dd>
    </div>
  );
}
