// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiListMonitoring: vi.fn(),
    apiListWebsites: vi.fn(),
    apiCreateMonitoring: vi.fn(),
    apiRunMonitoring: vi.fn(),
    apiPauseMonitoring: vi.fn(),
    apiResumeMonitoring: vi.fn(),
    apiDisableMonitoring: vi.fn(),
    apiUpdateMonitoring: vi.fn(),
  };
});

import * as api from "../services/api";
import { MonitoringPage } from "../pages/monitoring/MonitoringPage";

const item = {
  id: "m1",
  website_id: "site-1",
  status: "ACTIVE",
  enabled: true,
  frequency: "daily",
  last_run_at: null,
  next_run_at: "2030-01-01T00:00:00Z",
  last_success_at: null,
  last_failure_at: null,
};
const ok = <T,>(data: T) => ({ data, error: null });

describe("MonitoringPage", () => {
  beforeEach(() => {
    vi.mocked(api.apiListMonitoring).mockResolvedValue(ok([item]));
    vi.mocked(api.apiListWebsites).mockResolvedValue(
      ok([
        { id: "site-1", url: "https://one.example", domain: "one.example", verified: true },
        { id: "site-9", url: "https://nine.example", domain: "nine.example", verified: true },
      ]),
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows loading then renders controls", async () => {
    render(<MonitoringPage />);
    expect(screen.getByText("Loading monitoring...")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Create monitoring" })).toBeTruthy();
    expect(await screen.findByText("one.example", { selector: "h3" })).toBeTruthy();
    expect(screen.queryByText("site-1")).toBeNull();
    for (const name of ["Run now", "Pause", "Disable"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("shows the empty state with the create form", async () => {
    vi.mocked(api.apiListMonitoring).mockResolvedValue(ok([]));
    render(<MonitoringPage />);
    expect(await screen.findByText("No monitoring configurations")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create monitoring" })).toBeTruthy();
  });

  it("shows a load error with retry", async () => {
    vi.mocked(api.apiListMonitoring).mockResolvedValue({ data: null, error: { code: "500", message: "Boom" } });
    render(<MonitoringPage />);
    expect(await screen.findByText("Unable to load monitoring")).toBeTruthy();
    expect(screen.getByText("Boom")).toBeTruthy();
  });

  it("creates monitoring through the api", async () => {
    vi.mocked(api.apiCreateMonitoring).mockResolvedValue(ok(item));
    render(<MonitoringPage />);
    await screen.findByRole("option", { name: "nine.example" });
    await userEvent.selectOptions(await screen.findByLabelText("Website"), "site-9");
    await userEvent.selectOptions(screen.getByLabelText("Frequency"), "weekly");
    await userEvent.click(screen.getByRole("button", { name: "Create monitoring" }));
    await waitFor(() => expect(api.apiCreateMonitoring).toHaveBeenCalledWith({ websiteId: "site-9", frequency: "weekly" }));
  });

  it("runs, pauses, disables and changes frequency", async () => {
    for (const fn of [api.apiRunMonitoring, api.apiPauseMonitoring, api.apiDisableMonitoring, api.apiUpdateMonitoring]) {
      (fn as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok({}));
    }
    render(<MonitoringPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(api.apiRunMonitoring).toHaveBeenCalledWith("m1"));
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.apiPauseMonitoring).toHaveBeenCalledWith("m1"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(api.apiDisableMonitoring).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.apiDisableMonitoring).toHaveBeenCalledWith("m1"));
    confirm.mockRestore();
    await userEvent.selectOptions(screen.getByLabelText("Change frequency for one.example"), "monthly");
    await waitFor(() => expect(api.apiUpdateMonitoring).toHaveBeenCalledWith("m1", { frequency: "monthly" }));
  });

  it("offers 'Load more' when the API reports a full page", async () => {
    vi.mocked(api.apiListMonitoring)
      .mockResolvedValueOnce({ data: [item], error: null, meta: { page: 1, pageSize: 1 } })
      .mockResolvedValueOnce({ data: [{ ...item, id: "m2" }], error: null, meta: { page: 2, pageSize: 1 } });
    vi.mocked(api.apiListMonitoring).mockResolvedValue({ data: [], error: null, meta: { page: 3, pageSize: 1 } });
    render(<MonitoringPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.apiListMonitoring).toHaveBeenLastCalledWith({ page: 2 }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Run now" })).toHaveLength(2));
  });

  it("offers Resume for paused monitors", async () => {
    vi.mocked(api.apiListMonitoring).mockResolvedValue(ok([{ ...item, status: "PAUSED" }]));
    vi.mocked(api.apiResumeMonitoring).mockResolvedValue(ok({}) as never);
    render(<MonitoringPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.apiResumeMonitoring).toHaveBeenCalledWith("m1"));
  });

  it("shows a safe message on 403 without dropping the page", async () => {
    vi.mocked(api.apiRunMonitoring).mockResolvedValue({
      data: null,
      error: { code: "INSUFFICIENT_ROLE", message: "This action requires one of: owner, admin" },
    });
    render(<MonitoringPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have permission to perform this action.");
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  });
});
