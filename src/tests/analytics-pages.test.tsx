// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return { ...actual, apiGetAnalyticsOverview: vi.fn(), apiGetAnalyticsAi: vi.fn(), apiGetAnalyticsMonitoring: vi.fn() };
});

import * as api from "../services/api";
import { AnalyticsAiPage, AnalyticsMonitoringPage, AnalyticsOverviewPage } from "../pages/analytics/AnalyticsPages";

const ok = <T,>(data: T) => ({ data, error: null });
const emptyAgg = { executions: 0, completed: 0, failed: 0, failureRate: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: null, p95LatencyMs: null, costUsd: null };
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Analytics pages", () => {
  it("shows honest empty states instead of fake values", async () => {
    vi.mocked(api.apiGetAnalyticsOverview).mockResolvedValue(
      ok({ source: "postgres", days: 30, scans: { today: 0, week: 0, month: 0, failedMonth: 0 }, scanDaily: [], findingsBySeverity: [], ai: emptyAgg, aiDaily: [], monitoring: { availability: null, runs: 0, openIncidents: 0 } }),
    );
    wrap(<AnalyticsOverviewPage />);
    expect((await screen.findAllByText("No analytics data available yet")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not available yet").length).toBeGreaterThan(0);
  });

  it("never sends an organization id; changing range refetches with days", async () => {
    vi.mocked(api.apiGetAnalyticsAi).mockResolvedValue(ok({ source: "postgres", totals: emptyAgg, daily: [], byProvider: [], byModel: [], byAgent: [], pricingNote: "" }));
    wrap(<AnalyticsAiPage />);
    await screen.findByText("No analytics data available yet");
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(api.apiGetAnalyticsAi).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7 })));
    for (const call of vi.mocked(api.apiGetAnalyticsAi).mock.calls) expect(JSON.stringify(call)).not.toMatch(/org/i);
  });

  it("reports unmeasured monitoring signals as not available", async () => {
    vi.mocked(api.apiGetAnalyticsMonitoring).mockResolvedValue(
      ok({ source: "postgres", runs: 4, completed: 3, failed: 1, availability: 0.75, failureRate: 0.25, sslScore: null, responseTimeMs: null, dnsHealth: null, httpHealth: null, daily: [], incidentsBySeverity: [], openIncidents: 0 }),
    );
    wrap(<AnalyticsMonitoringPage />);
    expect(await screen.findByText("75.0%")).toBeTruthy();
    expect(screen.getAllByText("Not available yet").length).toBeGreaterThanOrEqual(4);
  });
});
