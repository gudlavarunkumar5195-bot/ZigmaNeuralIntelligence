// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiGetDashboard: vi.fn(),
    apiGetCrawlSummary: vi.fn(),
    apiListSiteIssues: vi.fn(),
    apiListCrawlPages: vi.fn(),
    apiIgnoreSiteIssue: vi.fn(),
    apiReopenSiteIssue: vi.fn(),
    apiListSeoRules: vi.fn(),
    apiGetSiteIssue: vi.fn(),
    apiGetSiteIssueHistory: vi.fn(),
    apiStartCrawl: vi.fn(),
    apiGetScan: vi.fn(),
  };
});

import * as api from "../services/api";
import { TechnicalHealthPage } from "../pages/intelligence/TechnicalHealthPage";

// Response bodies below have the exact shape the backend returns (see
// server/src/tests/site-audit-api.integration.test.ts for the same contract
// asserted against PostgreSQL).
const summary = {
  scan_id: "scan-2", start_url: "https://one.example/", pages_crawled: 12, pages_discovered: 40, pages_blocked_by_robots: 1, max_pages: 12, max_depth: 5,
  truncated: true, truncated_reason: "page_limit", robots_status: "parsed", start_blocked_by_robots: false, sitemap_status: "found", sitemap_url_count: 30,
  status_counts: { "2xx": 10, "4xx": 2 }, issue_counts: {}, duration_ms: 1000, reconcilable: true, created_at: "2030-01-02T00:00:00Z", scan_status: "completed",
};
const previous = { ...summary, scan_id: "scan-1", pages_crawled: 9, status_counts: { "2xx": 6, "4xx": 3 }, created_at: "2030-01-01T00:00:00Z" };
const overviewMeta = (over: Record<string, unknown> = {}) => ({
  previous, changes: { detected: 2, fixed: 1, reopened: 0 },
  latestScan: { id: "scan-2", status: "completed", error: null, created_at: "2030-01-02T00:00:00Z", started_at: null, completed_at: null, crawl_options: null, crawl_module_status: "completed", crawl_module_error: null },
  ...over,
});
const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1", rule_id: "page_4xx", category: "status_codes", severity: "high", url: "https://one.example/gone", title: "Client error (404)", details: { status: 404 },
  status: "OPEN", first_seen_at: "2030-01-01T00:00:00Z", last_seen_at: "2030-01-02T00:00:00Z", fixed_at: null, ignored_at: null, ignore_reason: null, times_reopened: 0, ...over,
});
const rules = [
  { id: "page_4xx", category: "status_codes", severity: "high", title: "Pages return client errors", explanation: "e", remediation: "r", provenance: "MEASURED", source: "site_crawler" },
  { id: "img_alt_missing", category: "images", severity: "low", title: "Images missing alt attributes", explanation: "e", remediation: "r", provenance: "MEASURED", source: "site_crawler" },
];
const page = {
  url: "https://one.example/gone", final_url: "https://one.example/gone", status_code: 404, final_status_code: 404, redirect_chain: [], redirect_target: null,
  outcome: "http_error", depth: 1, title: null, indexable: false, indexability_reasons: ["http_error"], in_sitemap: true, inlinks: 3, fetch_error: null,
};

const renderPage = () => render(<MemoryRouter><TechnicalHealthPage /></MemoryRouter>);

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.apiGetDashboard).mockResolvedValue({ data: { selectedWebsite: { id: "w1", domain: "one.example" } }, error: null } as never);
  vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: summary, error: null, meta: overviewMeta() } as never);
  vi.mocked(api.apiListSiteIssues).mockResolvedValue({ data: [issue()], error: null, meta: { limit: 25, nextCursor: null, total: 1, counts: { OPEN: 1, FIXED: 3, IGNORED: 0 } } } as never);
  vi.mocked(api.apiListCrawlPages).mockResolvedValue({ data: [page], error: null, meta: { limit: 50, nextCursor: null, scanId: "scan-2" } } as never);
  vi.mocked(api.apiListSeoRules).mockResolvedValue({ data: rules, error: null } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("TechnicalHealthPage", () => {
  it("shows the real crawl summary, a partial-crawl notice, the comparison with the previous crawl and the URL inventory", async () => {
    renderPage();
    expect(await screen.findByText("12 of 40 found")).toBeTruthy();
    expect(screen.getByText(/Partial crawl: stopped at the 12-page limit/)).toBeTruthy();
    expect(screen.getByText("This crawl: 2 new issues, 1 fixed, 0 reopened.")).toBeTruthy();
    expect(screen.getByText(/9 pages\s*\(\+3 now\);\s*4xx 3 → 2/)).toBeTruthy();
    expect(screen.getByText(/1 URLs disallowed/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open (1)", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fixed (3)" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Client error (404)" })).toBeTruthy();
    const table = await screen.findByRole("table");
    // Outcome column and indexing-signal reason both come from the measured outcome.
    expect(within(table).getByText("HTTP error")).toBeTruthy();
    expect(within(table).getByText("http error")).toBeTruthy();
    expect(within(table).getByText("In sitemap")).toBeTruthy();
    expect(vi.mocked(api.apiListSiteIssues)).toHaveBeenCalledWith("w1", expect.objectContaining({ status: "OPEN", cursor: null }));
  });

  it("filters issues by category, rule, severity and URL, and pages with the server cursor", async () => {
    vi.mocked(api.apiListSiteIssues).mockResolvedValueOnce({ data: [issue()], error: null, meta: { limit: 25, nextCursor: "CUR1", total: 2, counts: { OPEN: 2, FIXED: 0, IGNORED: 0 } } } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Client error (404)" });
    vi.mocked(api.apiListSiteIssues).mockResolvedValueOnce({ data: [issue({ id: "i2", url: "https://one.example/other", title: "Client error (410)" })], error: null, meta: { limit: 25, nextCursor: null, total: 2, counts: { OPEN: 2, FIXED: 0, IGNORED: 0 } } } as never);
    await userEvent.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(await screen.findByRole("heading", { name: "Client error (410)" })).toBeTruthy();
    expect(vi.mocked(api.apiListSiteIssues)).toHaveBeenLastCalledWith("w1", expect.objectContaining({ cursor: "CUR1" }));
    expect(screen.queryByRole("button", { name: "Load more issues" })).toBeNull();

    const filters = screen.getByRole("search", { name: "Filter issues" });
    await userEvent.selectOptions(within(filters).getByLabelText("Category"), "images");
    // Rule options follow the chosen category (from the server's rule catalog).
    expect(within(within(filters).getByLabelText("Rule")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Any rule", "Images missing alt attributes"]);
    await userEvent.selectOptions(within(filters).getByLabelText("Rule"), "img_alt_missing");
    await userEvent.selectOptions(within(filters).getByLabelText("Severity"), "low");
    await userEvent.type(within(filters).getByLabelText("URL contains"), "/blog");
    await userEvent.click(within(filters).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(vi.mocked(api.apiListSiteIssues)).toHaveBeenLastCalledWith("w1", expect.objectContaining({
      status: "OPEN", category: "images", rule: "img_alt_missing", severity: "low", url: "/blog", cursor: null,
    })));
  });

  it("opens issue details with guidance, evidence, occurrences and history, then returns focus on close", async () => {
    vi.mocked(api.apiGetSiteIssue).mockResolvedValue({ data: {
      ...issue(), rule: { id: "page_4xx", category: "status_codes", title: "Pages return client errors", explanation: "The final response was a 4xx error.", remediation: "Restore the pages or redirect them.", provenance: "MEASURED", source: "site_crawler" },
      occurrences: [{ scan_id: "scan-2-aaaaaaaa", observed_at: "2030-01-02T00:00:00Z", scan_status: "completed" }, { scan_id: "scan-1-bbbbbbbb", observed_at: "2030-01-01T00:00:00Z", scan_status: "completed" }],
      occurrenceCount: 2, latestCrawl: { scanId: "scan-2", crawledAt: "2030-01-02T00:00:00Z", page },
    }, error: null } as never);
    vi.mocked(api.apiGetSiteIssueHistory).mockResolvedValue({ data: [
      { id: 1, event: "DETECTED", scan_id: "scan-1-bbbbbbbb", actor_id: null, actor_name: null, note: null, created_at: "2030-01-01T00:00:00Z" },
      { id: 2, event: "IGNORED", scan_id: null, actor_id: "u1", actor_name: "Dana Admin", note: "Retired product", created_at: "2030-01-01T01:00:00Z" },
      { id: 3, event: "UNIGNORED", scan_id: null, actor_id: "u1", actor_name: "Dana Admin", note: null, created_at: "2030-01-01T02:00:00Z" },
    ], error: null } as never);
    renderPage();
    const opener = await screen.findByRole("button", { name: /Details Client error/ });
    await userEvent.click(opener);
    await waitFor(() => expect(document.activeElement?.id).toBe("issue-detail-heading"));
    const panel = document.getElementById("issue-detail-heading")!.closest("section")!;
    expect(within(panel).getByText("The final response was a 4xx error.")).toBeTruthy();
    expect(within(panel).getByText("Restore the pages or redirect them.")).toBeTruthy();
    expect(within(panel).getByText(/Measured by our crawler/)).toBeTruthy();
    // Evidence (stored details) and the latest crawl's status for the URL.
    expect(within(panel).getByText("status").nextElementSibling?.textContent).toBe("404");
    expect(within(panel).getByText(/Observed in 2 scans/)).toBeTruthy();
    expect(within(panel).getByText("Reason: Retired product")).toBeTruthy();
    expect(within(panel).getAllByText(/by Dana Admin/)).toHaveLength(2);
    await userEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Details Client error/ }));
  });

  it("requires a reason to ignore an issue and reports a forbidden role honestly", async () => {
    vi.mocked(api.apiIgnoreSiteIssue).mockResolvedValue({ data: null, error: { code: "INSUFFICIENT_ROLE", message: "no" } } as never);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Ignore… Client error/ }));
    const input = screen.getByLabelText("Reason");
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(vi.mocked(api.apiIgnoreSiteIssue)).not.toHaveBeenCalled();
    await userEvent.type(input, "Retired product");
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(vi.mocked(api.apiIgnoreSiteIssue)).toHaveBeenCalledWith("w1", "i1", "Retired product"));
    expect(await screen.findByText("Your role cannot change issue status.")).toBeTruthy();
  });

  it("asks for confirmation before reopening an ignored issue", async () => {
    vi.mocked(api.apiListSiteIssues).mockResolvedValue({ data: [issue({ status: "IGNORED", ignore_reason: "Intentional" })], error: null, meta: { limit: 25, nextCursor: null, total: 1, counts: { OPEN: 0, FIXED: 0, IGNORED: 1 } } } as never);
    vi.mocked(api.apiReopenSiteIssue).mockResolvedValue({ data: issue(), error: null } as never);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /^Reopen Client error/ }));
    expect(vi.mocked(api.apiReopenSiteIssue)).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm reopen" }));
    await waitFor(() => expect(vi.mocked(api.apiReopenSiteIssue)).toHaveBeenCalledWith("w1", "i1"));
    expect(await screen.findByText("Reopened: Client error (404).")).toBeTruthy();
  });

  it("starts a crawl with the chosen limits and an idempotency key, then announces progress until it finishes", async () => {
    vi.mocked(api.apiStartCrawl).mockResolvedValue({ data: { id: "scan-3", status: "queued" }, error: null, meta: undefined } as never);
    renderPage();
    const form = await screen.findByRole("form", { name: "Run a technical crawl" });
    await userEvent.clear(within(form).getByLabelText("Maximum pages"));
    await userEvent.type(within(form).getByLabelText("Maximum pages"), "50");
    await userEvent.clear(within(form).getByLabelText("Maximum link depth"));
    await userEvent.type(within(form).getByLabelText("Maximum link depth"), "2");

    const running = overviewMeta({ latestScan: { ...overviewMeta().latestScan, id: "scan-3", status: "running", crawl_module_status: "running" } });
    vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: summary, error: null, meta: running } as never);
    vi.mocked(api.apiGetScan).mockResolvedValueOnce({ data: { status: "running", crawl_progress: { pagesCrawled: 7, pagesDiscovered: 30 } }, error: null } as never);
    await userEvent.click(within(form).getByRole("button", { name: "Start crawl" }));

    await waitFor(() => expect(vi.mocked(api.apiStartCrawl)).toHaveBeenCalledWith("w1", { maxPages: 50, maxDepth: 2 }, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    expect(await screen.findByText("Crawling: 7 pages fetched, 30 URLs discovered so far.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crawl in progress" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: "View scan progress" }).getAttribute("href")).toBe("/websites/scan/scan-3");

    // The scan completes: data reloads and the outcome is announced.
    vi.mocked(api.apiGetScan).mockResolvedValue({ data: { status: "completed", crawl_progress: null }, error: null } as never);
    vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: summary, error: null, meta: overviewMeta() } as never);
    expect(await screen.findByText("Crawl finished: 2 new, 1 fixed, 0 reopened.", undefined, { timeout: 5_000 })).toBeTruthy();
  });

  it("keeps the same idempotency key when starting a crawl fails on the network, and explains server refusals", async () => {
    vi.mocked(api.apiStartCrawl)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ data: null, error: { code: "NOT_VERIFIED", message: "x" } } as never);
    renderPage();
    const form = await screen.findByRole("form", { name: "Run a technical crawl" });
    await userEvent.click(within(form).getByRole("button", { name: "Start crawl" }));
    expect(await within(form).findByRole("alert")).toBeTruthy();
    await userEvent.click(within(form).getByRole("button", { name: "Start crawl" }));
    expect(await within(form).findByText("Verify ownership of this website before crawling it.")).toBeTruthy();
    const keys = vi.mocked(api.apiStartCrawl).mock.calls.map((c) => c[2]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("explains a failed latest crawl and that it did not change issue states", async () => {
    vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: summary, error: null, meta: overviewMeta({
      latestScan: { ...overviewMeta().latestScan, id: "scan-9", status: "failed", crawl_module_status: "failed", crawl_module_error: "Start URL could not be fetched" },
    }) } as never);
    renderPage();
    const alert = await screen.findByText(/did not complete: Start URL could not be fetched/);
    expect(alert.closest("[role=alert]")).toBeTruthy();
    expect(alert.textContent).toMatch(/Issue states were not changed/);
  });

  it("filters the crawl inventory and pages it with the server cursor", async () => {
    vi.mocked(api.apiListCrawlPages).mockResolvedValueOnce({ data: [page], error: null, meta: { limit: 50, nextCursor: "P1", scanId: "scan-2" } } as never);
    renderPage();
    await screen.findByRole("table");
    vi.mocked(api.apiListCrawlPages).mockResolvedValueOnce({ data: [{ ...page, url: "https://one.example/zz", outcome: "blocked_by_robots", status_code: 0, indexability_reasons: ["blocked_by_robots"] }], error: null, meta: { limit: 50, nextCursor: null, scanId: "scan-2" } } as never);
    await userEvent.click(screen.getByRole("button", { name: "Load more URLs" }));
    expect((await screen.findAllByText("Blocked by robots.txt")).length).toBeGreaterThan(0);
    expect(vi.mocked(api.apiListCrawlPages)).toHaveBeenLastCalledWith("w1", expect.objectContaining({ cursor: "P1" }));

    const inv = screen.getByRole("search", { name: "Filter crawled URLs" });
    await userEvent.selectOptions(within(inv).getByLabelText("Outcome"), "redirect_loop");
    await userEvent.selectOptions(within(inv).getByLabelText("Indexing signals"), "no");
    await waitFor(() => expect(vi.mocked(api.apiListCrawlPages)).toHaveBeenLastCalledWith("w1", expect.objectContaining({ outcome: "redirect_loop", indexable: false, cursor: null })));
  });

  it("shows an honest empty state before any crawl", async () => {
    vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: null, error: null, meta: { previous: null, changes: null, latestScan: null } } as never);
    vi.mocked(api.apiListSiteIssues).mockResolvedValue({ data: [], error: null, meta: { limit: 25, nextCursor: null, total: 0, counts: { OPEN: 0, FIXED: 0, IGNORED: 0 } } } as never);
    renderPage();
    expect(await screen.findByText("No crawl yet")).toBeTruthy();
    expect(vi.mocked(api.apiListCrawlPages)).not.toHaveBeenCalled();
  });
});

describe("search data pages", () => {
  it("say plainly that ranking and backlink data are unavailable and show no figures", async () => {
    const pages = await import("../pages/search/SearchDataPages");
    // Keywords and Competitors are real pages now (keyword-research-pages.test.tsx).
    for (const Page of [pages.RankingsPage, pages.BacklinksPage]) {
      const { container, unmount } = render(<Page />);
      expect(screen.getByText("Unavailable: no data source connected")).toBeTruthy();
      expect(container.textContent).not.toMatch(/\d/);
      unmount();
    }
  });
});
