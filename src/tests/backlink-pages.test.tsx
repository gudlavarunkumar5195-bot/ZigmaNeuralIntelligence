// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiListWebsites: vi.fn(),
    apiBacklinkSummary: vi.fn(),
    apiBacklinkSources: vi.fn(),
    apiBacklinkDatasets: vi.fn(),
    apiBacklinkLinks: vi.fn(),
    apiBacklinkReferringDomains: vi.fn(),
    apiBacklinkChanges: vi.fn(),
    apiBacklinkGap: vi.fn(),
    apiBacklinkOpportunities: vi.fn(),
    apiBacklinkPreview: vi.fn(),
    apiBacklinkImport: vi.fn(),
    apiBacklinkVerify: vi.fn(),
    apiBacklinkVerification: vi.fn(),
    apiBacklinkExport: vi.fn(),
  };
});

import * as api from "../services/api";
import { BacklinkIntelligencePage } from "../pages/search/backlinks/BacklinkIntelligencePage";

// Shapes match server/src/tests/backlinks.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string) => ({ data: null, error: { code, message } }) as never;

const dataset = (over: Record<string, unknown> = {}) => ({
  id: "d1", website_id: "w1", subject_kind: "own", subject_domain: "one.example", source: "csv_import", source_label: "Google Search Console", coverage: "partial",
  exported_at: "2026-10-01", retrieved_at: "2026-10-02T00:00:00Z", observed_from: "2026-01-01", observed_to: "2026-09-30", filename: "links.csv",
  rows_total: 12, rows_accepted: 10, rows_rejected: 1, rows_duplicate: 1, rows_skipped: 0, rejected_samples: [], column_mapping: {}, referring_domains: 4, created_at: "2026-10-02T00:00:00Z", stale: false, ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  siteDomain: "one.example",
  own: { dataset: dataset(), links: 10, referringDomains: 4, linkTypes: { follow: 6, nofollow: 2, unknown: 2 }, states: { unverified: 7, verified_live: 2, lost_verified: 1 } },
  competitors: [{ dataset: dataset({ id: "d2", subject_kind: "competitor", subject_domain: "rival.example" }) }],
  changesLast90Days: { new: 3, potentially_lost: 1 },
  latestVerification: null,
  staleAfterDays: 30,
  ...over,
});
const link = (over: Record<string, unknown> = {}) => ({
  id: "l1", source_url: "https://blog.example/post", source_domain: "blog.example", target_url: null, anchor: "running shoes", link_type: null, first_seen: null, last_seen: "2026-09-01",
  provider_lost: null, state: "unverified", checked_at: null, check_outcome: null, check_http_status: null, observed_link_type: null, observed_anchor: null, ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.apiListWebsites).mockResolvedValue(ok([{ id: "w1", domain: "one.example" }]));
  vi.mocked(api.apiBacklinkSummary).mockResolvedValue(ok(summary()));
  vi.mocked(api.apiBacklinkSources).mockResolvedValue(ok({ sources: [], scoreWeights: {}, limits: { maxRows: 50000, maxBytes: 10_000_000, staleAfterDays: 30, verifyMaxLinks: 200 } }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search/backlinks" element={<BacklinkIntelligencePage />} />
        <Route path="/search/backlinks/:tab" element={<BacklinkIntelligencePage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("Backlink overview", () => {
  it("shows loading, then measured counts with the dataset's source, date and coverage", async () => {
    at("/search/backlinks");
    expect(screen.getByText("Loading websites…")).toBeTruthy();
    const tiles = await screen.findByRole("region", { name: "Backlink overview" });
    expect(tiles.textContent).toMatch(/Backlinks10/);
    expect(tiles.textContent).toMatch(/Verified live2/);
    expect(tiles.textContent).toMatch(/Unverified7/);
    expect(screen.getByText(/Google Search Console/).closest("div")!.textContent).toMatch(/exported 2026-10-01.*partial \(a sample\)/);
    expect(screen.getByText(/not stated: 2/)).toBeTruthy();
  });

  it("without data explains what to import and links to the importer", async () => {
    vi.mocked(api.apiBacklinkSummary).mockResolvedValue(ok(summary({ own: null, competitors: [] })));
    at("/search/backlinks");
    expect(await screen.findByText("No backlink data for this website yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import backlinks" }).getAttribute("href")).toBe("/search/backlinks/imports");
    expect(screen.queryByRole("region", { name: "Backlink overview" })).toBeNull();
  });

  it("flags stale data", async () => {
    vi.mocked(api.apiBacklinkSummary).mockResolvedValue(ok(summary({ own: { ...summary().own, dataset: dataset({ stale: true }) } })));
    at("/search/backlinks");
    expect(await screen.findByText(/Older than 30 days: import a fresh export/)).toBeTruthy();
  });

  it("shows an error with retry", async () => {
    vi.mocked(api.apiBacklinkSummary).mockResolvedValueOnce(fail("INTERNAL_ERROR", "An unexpected error occurred"));
    at("/search/backlinks");
    expect(await screen.findByText("Unable to load backlink data")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Backlink overview" })).toBeTruthy();
  });

  it("starts a live check and reports progress", async () => {
    vi.mocked(api.apiBacklinkVerify).mockResolvedValue(ok({ job: { id: "j1", status: "queued", links_total: 10, links_checked: 0 }, deduplicated: false, capped: false }));
    vi.mocked(api.apiBacklinkVerification).mockResolvedValue(ok({ id: "j1", dataset_id: "d1", status: "completed", links_total: 10, links_checked: 10, error: null, created_at: "x", finished_at: "y" }));
    at("/search/backlinks");
    await userEvent.click(await screen.findByRole("button", { name: "Check links now" }));
    expect(api.apiBacklinkVerify).toHaveBeenCalledWith("w1", "d1");
    expect(await screen.findByText(/Last check: completed · 10\/10 checked/)).toBeTruthy();
  });
});

describe("Backlinks list", () => {
  it("shows unknown values as unknown, filters and sorts on the server, and pages by cursor", async () => {
    vi.mocked(api.apiBacklinkLinks)
      .mockResolvedValueOnce(ok({ dataset: dataset(), links: [link()] }, { nextCursor: "c1" }))
      .mockResolvedValue(ok({ dataset: dataset(), links: [link({ id: "l2", source_url: "https://news.example/a", source_domain: "news.example", link_type: "follow", state: "verified_live", checked_at: "2026-10-03T00:00:00Z" })] }, { nextCursor: null }));
    at("/search/backlinks/links");
    const table = await screen.findByRole("table");
    const row = within(table).getByText("https://blog.example/post").closest("tr")!;
    expect(row.textContent).toMatch(/not supplied/);
    expect(row.textContent).toMatch(/not stated/);
    expect(row.textContent).toMatch(/Unverified \(imported\)/);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(api.apiBacklinkLinks).toHaveBeenLastCalledWith("w1", expect.objectContaining({ cursor: "c1" }));
    expect(await within(table).findByText("https://news.example/a")).toBeTruthy();
    expect(within(table).getByText("https://news.example/a").closest("tr")!.textContent).toMatch(/Verified live/);
    await userEvent.selectOptions(screen.getByLabelText("Status"), "lost_verified");
    await waitFor(() => expect(api.apiBacklinkLinks).toHaveBeenLastCalledWith("w1", expect.objectContaining({ state: "lost_verified" })));
    await userEvent.click(await screen.findByRole("button", { name: "Last seen" }));
    await waitFor(() => expect(api.apiBacklinkLinks).toHaveBeenLastCalledWith("w1", expect.objectContaining({ sort: "last_seen", order: "desc" })));
  });

  it("reports an export the role cannot perform", async () => {
    vi.mocked(api.apiBacklinkLinks).mockResolvedValue(ok({ dataset: dataset(), links: [link()] }, { nextCursor: null }));
    vi.mocked(api.apiBacklinkExport).mockResolvedValue({ error: "Your role cannot export backlink data." });
    at("/search/backlinks/links");
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Your role cannot export backlink data.")).toBeTruthy();
  });
});

describe("Competitor gap", () => {
  it("shows the compared datasets, their limitations and the meaning of 'competitor only'", async () => {
    vi.mocked(api.apiBacklinkGap).mockResolvedValue(ok({
      datasets: [{ id: "d1", subject: "one.example", sourceLabel: "Ahrefs", coverage: "partial", exportedAt: "2026-10-01", retrievedAt: "x", observedFrom: null, observedTo: null, links: 10, stale: false }],
      missingCompetitors: [], warnings: ["Not declared complete: one.example. \"Competitor only\" means not observed in your data, not absent."],
      counts: { shared: 1, competitor_only: 2, own_only: 3 }, rows: [{ domain: "reviews.example", category: "competitor_only", competitors: ["rival.example"] }], total: 1, sharedAnchors: [],
    }));
    at("/search/backlinks/gap");
    expect(await screen.findByText("reviews.example")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Competitor only (2)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/It is not proof that the domain does not link to you/)).toBeTruthy();
    expect(screen.getByText(/Not declared complete: one\.example/)).toBeTruthy();
  });

  it("explains incompatible datasets and missing data instead of showing numbers", async () => {
    vi.mocked(api.apiBacklinkGap).mockResolvedValue(fail("DATASETS_INCOMPATIBLE", "The datasets were exported 300 days apart (more than 180); refresh the older ones first."));
    at("/search/backlinks/gap");
    expect(await screen.findByText("These datasets cannot be compared fairly")).toBeTruthy();
    cleanup();
    vi.mocked(api.apiBacklinkGap).mockResolvedValue(fail("COMPETITOR_DATASET_MISSING", "Import a backlink export for at least one competitor first."));
    at("/search/backlinks/gap");
    expect(await screen.findByText("Not enough data to compare")).toBeTruthy();
  });
});

describe("Opportunities", () => {
  it("shows the score with its basis and every signal, including unavailable ones", async () => {
    vi.mocked(api.apiBacklinkOpportunities).mockResolvedValue(ok({
      datasets: [], missingCompetitors: [], warnings: [], topics: { terms: [], source: null }, total: 1,
      opportunities: [{
        domain: "reviews.example", kind: "competitor_only", competitors: ["rival.example"], links: 2, sampleUrls: ["https://reviews.example/top"], score: 64, basis: 0.55,
        why: "Linked to rival.example; not observed in your latest data (partial coverage).",
        signals: [
          { id: "competitor_linking", weight: 0.3, value: 1, explanation: "Links to 1 of 1 compared competitor(s)." },
          { id: "topical_relevance", weight: 0.2, value: null, explanation: "Unavailable: no topic terms given." },
        ],
      }],
    }));
    at("/search/backlinks/opportunities");
    expect(await screen.findByText("reviews.example")).toBeTruthy();
    expect(screen.getByText(/based on 55% of signal weight/)).toBeTruthy();
    expect(screen.getByText(/not a search-engine ranking factor/)).toBeTruthy();
    expect(screen.getByText(/none, so topical relevance is unavailable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show signals" }));
    const signals = screen.getByRole("table", { name: "Signals for reviews.example" });
    expect(signals.textContent).toMatch(/topical relevance20%unavailableUnavailable: no topic terms given\./);
    await userEvent.type(screen.getByLabelText("Topics"), "running shoes");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.apiBacklinkOpportunities).toHaveBeenLastCalledWith("w1", expect.objectContaining({ topics: "running shoes" })));
  });
});

describe("Imports", () => {
  const file = (text: string, name = "links.csv") => new File([text], name, { type: "text/csv" });
  const preview = (over: Record<string, unknown> = {}) => ({
    subjectDomain: "one.example", delimiter: ",", columns: { source_url: "Linking page" }, unmappedColumns: ["Last crawled"], missingRequired: [], rowLimitExceeded: false,
    rows: { total: 5, accepted: 3, rejected: 1, duplicate: 1, skipped: 0 }, rejectedSamples: [{ row: 4, reason: "Missing or invalid source URL" }],
    warnings: ["No link attribute columns: follow/nofollow is unknown for every link."], observed: { from: null, to: null }, sample: [], ...over,
  });
  beforeEach(() => vi.mocked(api.apiBacklinkDatasets).mockResolvedValue(ok([dataset()])));

  it("previews a file, reports accepted/rejected/duplicate rows accurately, then imports", async () => {
    vi.mocked(api.apiBacklinkPreview).mockResolvedValue(ok(preview()));
    vi.mocked(api.apiBacklinkImport).mockResolvedValue(ok({ dataset: dataset({ rows_accepted: 3, referring_domains: 2, rows_rejected: 1, rows_duplicate: 1 }), duplicateImport: false, changes: 2 }));
    at("/search/backlinks/imports");
    await userEvent.upload(await screen.findByLabelText("File"), file("Linking page\nhttps://a.example/"));
    const importButton = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true); // preview first
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const region = await screen.findByRole("region", { name: "Import preview" });
    expect(region.textContent).toMatch(/3 link\(s\) will be imported · 1 rejected · 1 duplicate · 0 blank \(of 5 rows\)/);
    expect(region.textContent).toMatch(/row 4: Missing or invalid source URL/);
    expect(region.textContent).toMatch(/follow\/nofollow is unknown/);
    expect(importButton.disabled).toBe(true); // source label still required
    await userEvent.type(screen.getByLabelText("Source of the export"), "Google Search Console");
    await userEvent.click(importButton);
    expect(api.apiBacklinkImport).toHaveBeenCalledWith("w1", expect.objectContaining({ subject: "own", filename: "links.csv", sourceLabel: "Google Search Console", coverage: "partial" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Imported 3 link\(s\) from 2 domain\(s\): 1 rejected, 1 duplicate, 0 blank\. 2 change\(s\) detected\./);
  });

  it("blocks import when no source URL column is recognised, and rejects non-CSV files", async () => {
    vi.mocked(api.apiBacklinkPreview).mockResolvedValue(ok(preview({ missingRequired: ["source_url"], columns: {}, unmappedColumns: ["Domain", "Links"], rows: { total: 1, accepted: 0, rejected: 0, duplicate: 0, skipped: 0 } })));
    at("/search/backlinks/imports");
    await userEvent.upload(await screen.findByLabelText("File"), file("Domain,Links\nx.example,4"));
    await userEvent.type(screen.getByLabelText("Source of the export"), "Ahrefs");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findAllByRole("alert"))[0].textContent).toMatch(/No source URL column was recognised\. Columns found: Domain, Links/);
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    at("/search/backlinks/imports");
    await userEvent.upload(await screen.findByLabelText("File"), file("x", "links.xlsx"), { applyAccept: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a \.csv file/);
  });

  it("lists import history with counts and freshness", async () => {
    vi.mocked(api.apiBacklinkDatasets).mockResolvedValue(ok([dataset({ stale: true, subject_kind: "competitor", subject_domain: "rival.example" })]));
    at("/search/backlinks/imports");
    const table = await screen.findByRole("table", { name: "Imported datasets" });
    expect(table.textContent).toMatch(/rival\.example \(competitor\)/);
    expect(table.textContent).toMatch(/1 \/ 1 \/ 0/);
    expect(table.textContent).toMatch(/stale/);
  });
});

describe("Data sources", () => {
  it("shows real availability, never a fake connected state", async () => {
    vi.mocked(api.apiBacklinkSources).mockResolvedValue(ok({ sources: [
      { id: "csv_import", name: "CSV import of an authorized export", kind: "import", status: "available", capabilities: ["link_list"], explanation: "Upload…", setup: null, costNote: "No cost." },
      { id: "licensed_backlink_index", name: "Licensed backlink index", kind: "licensed", status: "not_configured", capabilities: [], explanation: "No licensed backlink provider is integrated.", setup: "Choose a provider and approve its cost.", costNote: "Paid; requires explicit approval." },
    ], scoreWeights: {}, limits: { maxRows: 1, maxBytes: 1, staleAfterDays: 30, verifyMaxLinks: 1 } }));
    at("/search/backlinks/sources");
    const licensed = await screen.findByRole("listitem", { name: "Licensed backlink index" });
    expect(licensed.textContent).toMatch(/not configured/);
    expect(licensed.textContent).toMatch(/Next step: Choose a provider and approve its cost\./);
  });
});
