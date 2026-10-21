import { useEffect, useState } from "react";
import {
  ApiCallError,
  apiGetCrawlSummary,
  apiGetDashboard,
  apiIgnoreSiteIssue,
  apiListCrawlPages,
  apiListSiteIssues,
  apiReopenSiteIssue,
  IntegrationRequired,
  type CrawlPageRow,
  type CrawlSummary,
  type SiteIssue,
  type SiteIssueStatus,
} from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";

const STATUS_TABS: SiteIssueStatus[] = ["OPEN", "FIXED", "IGNORED"];
const PAGE_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "2xx", label: "2xx OK" },
  { value: "3xx", label: "3xx Redirect" },
  { value: "4xx", label: "4xx Client error" },
  { value: "5xx", label: "5xx Server error" },
  { value: "error", label: "Fetch error" },
];
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

const fail = (r: { error: { code: string; message: string } | null }) => {
  if (r.error) throw new ApiCallError(0, r.error.code, r.error.message);
};

/** Technical health: real multi-page crawl results and persistent issues for the selected website. */
export function TechnicalHealthPage() {
  const selectedId = useSelectedWebsiteId();
  const [site, setSite] = useState<{ id: string; domain: string } | null | undefined>(undefined);
  const [summary, setSummary] = useState<CrawlSummary | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tab, setTab] = useState<SiteIssueStatus>("OPEN");
  const [issues, setIssues] = useState<SiteIssue[] | null>(null);
  const [counts, setCounts] = useState<Record<SiteIssueStatus, number>>({ OPEN: 0, FIXED: 0, IGNORED: 0 });
  const [pageFilter, setPageFilter] = useState("");
  const [pages, setPages] = useState<CrawlPageRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const loadSite = async () => {
    setError(null);
    setSite(undefined);
    try {
      const dashboard = await apiGetDashboard(selectedId);
      fail(dashboard);
      const selected = dashboard.data?.selectedWebsite;
      if (!selected) {
        setSite(null);
        return;
      }
      setSite({ id: selected.id, domain: selected.domain });
      const s = await apiGetCrawlSummary(selected.id);
      fail(s);
      setSummary(s.data ?? null);
    } catch (cause) {
      setError(cause as Error);
    }
  };

  const loadIssues = async (websiteId: string, status: SiteIssueStatus) => {
    setIssues(null);
    try {
      const r = await apiListSiteIssues(websiteId, { status });
      fail(r);
      setIssues(r.data ?? []);
      if (r.meta?.counts) setCounts(r.meta.counts);
    } catch (cause) {
      setError(cause as Error);
    }
  };

  const loadPages = async (websiteId: string, status: string) => {
    setPages(null);
    try {
      const r = await apiListCrawlPages(websiteId, { status: status || undefined });
      fail(r);
      setPages(r.data ?? []);
    } catch (cause) {
      setError(cause as Error);
    }
  };

  useEffect(() => {
    void loadSite();
  }, [selectedId]);
  useEffect(() => {
    if (site?.id) void loadIssues(site.id, tab);
  }, [site?.id, tab]);
  useEffect(() => {
    if (site?.id && summary) void loadPages(site.id, pageFilter);
  }, [site?.id, summary?.scan_id, pageFilter]);

  const act = async (issue: SiteIssue, action: "ignore" | "reopen") => {
    if (!site) return;
    setNotice(null);
    const r = action === "ignore" ? await apiIgnoreSiteIssue(site.id, issue.id, reason.trim()) : await apiReopenSiteIssue(site.id, issue.id);
    if (r.error) {
      setNotice(r.error.code === "FORBIDDEN" ? "Your role cannot change issue status." : r.error.message);
      return;
    }
    setNotice(action === "ignore" ? `Ignored: ${issue.title}` : `Reopened: ${issue.title}`);
    setIgnoring(null);
    setReason("");
    await loadIssues(site.id, tab);
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Technical health" />;
  if (error) return <ErrorState title="Unable to load technical health" message={error.message} onRetry={loadSite} />;
  if (site === undefined) return <LoadingState label="Loading technical health..." />;
  if (site === null) return <EmptyState title="No website selected" description="Add and verify a website, then run a scan." />;

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Technical health</p>
      <h2 className="mt-2 text-2xl font-800 text-slate-950">{site.domain}</h2>

      {!summary ? (
        <EmptyState title="No crawl yet" description="Run a scan with the crawl module to audit every reachable page." />
      ) : (
        <section aria-labelledby="crawl-summary" className="mt-6">
          <h3 id="crawl-summary" className="sr-only">Latest crawl</h3>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Pages crawled" value={`${summary.pages_crawled} of ${summary.pages_discovered} found`} />
            <Stat label="robots.txt" value={ROBOTS_LABEL[summary.robots_status]} />
            <Stat label="Sitemap" value={`${SITEMAP_LABEL[summary.sitemap_status]}${summary.sitemap_url_count ? ` · ${summary.sitemap_url_count} URLs` : ""}`} />
            <Stat label="Crawled" value={new Date(summary.created_at).toLocaleString()} />
          </dl>
          <p className="mt-3 text-xs text-slate-600">
            Status codes: {["2xx", "3xx", "4xx", "5xx", "error"].map((k) => `${k} ${summary.status_counts[k] ?? 0}`).join(" · ")}
          </p>
          {summary.truncated ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Partial crawl: stopped at the {summary.truncated_reason === "time_limit" ? "time" : `${summary.max_pages}-page`} limit. Issues on pages it did not reach are kept as they were.
            </p>
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
        <p aria-live="polite" className="mt-2 min-h-4 text-xs text-slate-600">{notice}</p>
        {!issues ? (
          <LoadingState label="Loading issues..." />
        ) : issues.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No {tab.toLowerCase()} issues.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {issues.map((issue) => (
              <li key={issue.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-700 text-slate-900">{issue.title}</h4>
                  <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-700 uppercase text-blue-700">{issue.severity}</span>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] text-slate-600">{issue.url}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  First seen {new Date(issue.first_seen_at).toLocaleDateString()} · last seen {new Date(issue.last_seen_at).toLocaleDateString()}
                  {issue.fixed_at ? ` · fixed ${new Date(issue.fixed_at).toLocaleDateString()}` : ""}
                  {issue.times_reopened ? ` · reopened ${issue.times_reopened}×` : ""}
                </p>
                {issue.ignore_reason ? <p className="mt-1 text-[11px] text-slate-600">Ignored: {issue.ignore_reason}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {issue.status === "IGNORED" ? (
                    <button type="button" onClick={() => act(issue, "reopen")} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
                      Reopen <span className="sr-only">{issue.title}</span>
                    </button>
                  ) : ignoring === issue.id ? (
                    <form
                      className="flex flex-wrap items-center gap-2"
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
                        onChange={(e) => setReason(e.target.value)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      <button type="submit" className="rounded bg-slate-900 px-2 py-1 text-xs font-600 text-white">Ignore</button>
                      <button type="button" onClick={() => setIgnoring(null)} className="text-xs text-slate-600">Cancel</button>
                    </form>
                  ) : (
                    <button type="button" onClick={() => { setIgnoring(issue.id); setReason(""); }} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
                      Ignore… <span className="sr-only">{issue.title}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {summary ? (
        <section aria-labelledby="pages-heading" className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="pages-heading" className="text-sm font-700 text-slate-900">Crawled pages</h3>
            <label className="text-xs text-slate-700">
              Status{" "}
              <select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} className="ml-1 rounded border border-slate-300 px-2 py-1 text-xs">
                {PAGE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
          </div>
          {!pages ? (
            <LoadingState label="Loading pages..." />
          ) : pages.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No pages with this status in the latest crawl.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Pages from the latest crawl (first 50)</caption>
                <thead className="text-slate-500">
                  <tr><th scope="col" className="py-2 pr-3">Status</th><th scope="col" className="py-2 pr-3">URL</th><th scope="col" className="py-2 pr-3">Title</th><th scope="col" className="py-2">Inlinks</th></tr>
                </thead>
                <tbody>
                  {pages.map((p) => (
                    <tr key={p.url} className="border-t border-slate-100 align-top">
                      <td className="py-2 pr-3 font-mono">
                        {p.status_code === 0 ? "error" : p.status_code}
                        {p.redirect_chain.length > 0 ? ` → ${p.final_status_code || "error"} (${p.redirect_chain.length} hop${p.redirect_chain.length > 1 ? "s" : ""})` : ""}
                      </td>
                      <td className="break-all py-2 pr-3 font-mono">{p.url}</td>
                      <td className="py-2 pr-3">{p.title ?? "—"}</td>
                      <td className="py-2">{p.inlinks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
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
