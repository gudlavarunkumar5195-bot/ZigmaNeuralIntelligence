// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  };
});

import * as api from "../services/api";
import { TechnicalHealthPage } from "../pages/intelligence/TechnicalHealthPage";

const summary = {
  scan_id: "scan-1", start_url: "https://one.example/", pages_crawled: 12, pages_discovered: 40, max_pages: 12, truncated: true,
  truncated_reason: "page_limit", robots_status: "parsed", start_blocked_by_robots: false, sitemap_status: "found", sitemap_url_count: 30,
  status_counts: { "2xx": 10, "4xx": 2 }, issue_counts: {}, duration_ms: 1000, created_at: "2030-01-01T00:00:00Z", scan_status: "completed",
};
const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1", rule_id: "page_4xx", severity: "high", url: "https://one.example/gone", title: "Client error (404)", details: {}, status: "OPEN",
  first_seen_at: "2030-01-01T00:00:00Z", last_seen_at: "2030-01-02T00:00:00Z", fixed_at: null, ignored_at: null, ignore_reason: null, times_reopened: 0, ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.apiGetDashboard).mockResolvedValue({ data: { selectedWebsite: { id: "w1", domain: "one.example" } }, error: null } as never);
  vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: summary, error: null } as never);
  vi.mocked(api.apiListSiteIssues).mockResolvedValue({ data: [issue()], error: null, meta: { counts: { OPEN: 1, FIXED: 3, IGNORED: 0 } } } as never);
  vi.mocked(api.apiListCrawlPages).mockResolvedValue({ data: [{ url: "https://one.example/gone", final_url: "https://one.example/gone", status_code: 404, final_status_code: 404, redirect_chain: [], title: null, indexable: false, in_sitemap: true, inlinks: 3, fetch_error: null }], error: null } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TechnicalHealthPage", () => {
  it("shows the real crawl summary, a partial-crawl notice, issue counts and the page inventory", async () => {
    render(<TechnicalHealthPage />);
    expect(await screen.findByText("12 of 40 found")).toBeTruthy();
    expect(screen.getByText(/Partial crawl: stopped at the 12-page limit/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open (1)", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fixed (3)" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Client error (404)" })).toBeTruthy();
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(vi.mocked(api.apiListSiteIssues)).toHaveBeenCalledWith("w1", { status: "OPEN" });
  });

  it("requires a reason to ignore an issue and reports a forbidden role honestly", async () => {
    vi.mocked(api.apiIgnoreSiteIssue).mockResolvedValue({ data: null, error: { code: "FORBIDDEN", message: "no" } } as never);
    render(<TechnicalHealthPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Ignore… Client error/ }));
    const input = screen.getByLabelText("Reason");
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(vi.mocked(api.apiIgnoreSiteIssue)).not.toHaveBeenCalled();
    await userEvent.type(input, "Retired product");
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(vi.mocked(api.apiIgnoreSiteIssue)).toHaveBeenCalledWith("w1", "i1", "Retired product"));
    expect(await screen.findByText("Your role cannot change issue status.")).toBeTruthy();
  });

  it("shows an honest empty state before any crawl", async () => {
    vi.mocked(api.apiGetCrawlSummary).mockResolvedValue({ data: null, error: null } as never);
    vi.mocked(api.apiListSiteIssues).mockResolvedValue({ data: [], error: null, meta: { counts: { OPEN: 0, FIXED: 0, IGNORED: 0 } } } as never);
    render(<TechnicalHealthPage />);
    expect(await screen.findByText("No crawl yet")).toBeTruthy();
    expect(vi.mocked(api.apiListCrawlPages)).not.toHaveBeenCalled();
  });
});

describe("search data pages", () => {
  it("say plainly that keyword, ranking, backlink and competitor data are unavailable and show no figures", async () => {
    const pages = await import("../pages/search/SearchDataPages");
    for (const Page of [pages.KeywordsPage, pages.RankingsPage, pages.BacklinksPage, pages.CompetitorsPage]) {
      const { container, unmount } = render(<Page />);
      expect(screen.getByText("Unavailable: no data source connected")).toBeTruthy();
      expect(container.textContent).not.toMatch(/\d/);
      unmount();
    }
  });
});
