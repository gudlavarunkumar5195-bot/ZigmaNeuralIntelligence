// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiLogin: vi.fn(),
    apiRegister: vi.fn(),
    apiListMonitoring: vi.fn(),
    apiListMonitoringChanges: vi.fn(),
    apiListAlerts: vi.fn(),
    apiListWebsites: vi.fn(),
  };
});

import * as api from "../services/api";
import { LoginPage } from "../pages/auth/LoginPage";
import { ChangesPage } from "../pages/monitoring/ChangesPage";
import { AlertsPage } from "../pages/monitoring/AlertsPage";
import { RouteError } from "../components/ui/RouteError";
import { router } from "../router";

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("__APP_VERSION__", "test");
  vi.mocked(api.apiListWebsites).mockResolvedValue({ data: [{ id: "w1", url: "https://w.example", domain: "w.example", verified: true }], error: null });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("LoginPage", () => {
  it("has no fabricated marketing metrics", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(document.body.textContent).not.toMatch(/92%|38ms|24\/7|SEO uplift/);
  });

  it("shows an error when sign-in succeeds without a token", async () => {
    vi.mocked(api.apiLogin).mockResolvedValue({ data: null, error: null });
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getAllByRole("button", { name: "Sign in" }).at(-1)!);
    expect((await screen.findByRole("alert")).textContent).toContain("did not return a session");
    expect(sessionStorage.getItem("zn_token")).toBeNull();
  });
});

describe("router", () => {
  const loaderOf = (path: string) => (router.routes.find((r) => r.path === path) as unknown as { loader: () => unknown }).loader;

  it("redirects already-authenticated users away from /login", () => {
    sessionStorage.setItem("zn_token", "t");
    const res = loaderOf("/login")() as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("lets unauthenticated users see /login and redirects them from /", () => {
    expect(loaderOf("/login")()).toBeNull();
    const res = loaderOf("/")() as Response;
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("has a root errorElement", () => {
    expect(router.routes.every((r) => !!r.errorElement)).toBe(true);
  });

  it("RouteError renders a friendly page for a thrown error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createMemoryRouter([{ path: "/", element: <Boom />, errorElement: <RouteError /> }]);
    render(<RouterProvider router={r} />);
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaput")).toBeTruthy();
  });
});
function Boom(): never { throw new Error("kaput"); }

describe("ChangesPage", () => {
  const cfg = { id: "m1", website_id: "w1", status: "ACTIVE", enabled: true, frequency: "daily", last_run_at: null, next_run_at: "2030-01-01", last_success_at: null, last_failure_at: null };
  it("shows domains and never calls /monitoring//changes for the empty placeholder", async () => {
    vi.mocked(api.apiListMonitoring).mockResolvedValue({ data: [cfg], error: null });
    vi.mocked(api.apiListMonitoringChanges).mockResolvedValue({ data: [], error: null });
    render(<ChangesPage />);
    expect(await screen.findByRole("option", { name: "w.example" })).toBeTruthy();
    expect(screen.queryByText("w1")).toBeNull();
    vi.mocked(api.apiListMonitoringChanges).mockClear();
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    expect(api.apiListMonitoringChanges).not.toHaveBeenCalled();
    expect(await screen.findByText("No detected changes")).toBeTruthy();
  });
});

describe("AlertsPage pagination", () => {
  it("loads the next page when the API reports a full page", async () => {
    const a = (id: string) => ({ id, severity: "low", title: `alert-${id}`, status: "RESOLVED", detected_at: "2030-01-01", monitoring_id: "m" });
    vi.mocked(api.apiListAlerts)
      .mockResolvedValueOnce({ data: [a("1")], error: null, meta: { page: 1, pageSize: 1 } })
      .mockResolvedValueOnce({ data: [a("2")], error: null, meta: { page: 2, pageSize: 1 } })
      .mockResolvedValue({ data: [], error: null, meta: { page: 3, pageSize: 1 } });
    render(<AlertsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.apiListAlerts).toHaveBeenLastCalledWith({ page: 2 }));
    expect(await screen.findByText("alert-2")).toBeTruthy();
    expect(screen.getByText("alert-1")).toBeTruthy();
  });

  it("hides Load more when the page is not full", async () => {
    vi.mocked(api.apiListAlerts).mockResolvedValue({ data: [], error: null, meta: { page: 1, pageSize: 25 } });
    render(<AlertsPage />);
    await screen.findByText("No alerts");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
