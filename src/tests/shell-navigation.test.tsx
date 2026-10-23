// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    apiGetMe: vi.fn(),
    apiListWebsites: vi.fn(),
    apiListAlerts: vi.fn(),
  };
});

import * as api from "../services/api";
import { Shell } from "../components/layout/Shell";
import { findRoute, NAV_GROUPS, routeTitle } from "../components/layout/navigation";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("__APP_VERSION__", "test");
  vi.mocked(api.apiGetMe).mockResolvedValue({ data: { id: "u", email: "me@example.org", orgIds: [] }, error: null });
  vi.mocked(api.apiListWebsites).mockResolvedValue({ data: [], error: null, meta: { page: 1, pageSize: 100 } });
  vi.mocked(api.apiListAlerts).mockResolvedValue({ data: [], error: null, meta: { page: 1, pageSize: 100 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const renderShell = (path = "/") => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="*" element={<Shell />}><Route path="*" element={<Where />} /></Route></Routes>
  </MemoryRouter>,
);

describe("navigation model", () => {
  it("matches the longest route prefix, so tabs inherit their module's title", () => {
    expect(findRoute("/search/backlinks/domains")?.item.label).toBe("Backlinks");
    expect(routeTitle("/monitoring/alerts")).toEqual({ group: "Monitoring", title: "Alerts" });
    expect(findRoute("/does-not-exist")).toBeNull();
  });

  it("hides administration from the model unless the group is admin-only", () => {
    const admin = NAV_GROUPS.filter((g) => g.adminOnly).map((g) => g.label);
    expect(admin).toEqual(["Administration"]);
  });
});

describe("Shell navigation", () => {
  it("shows a breadcrumb of group and page, marked as the current page", async () => {
    renderShell("/monitoring/alerts");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("Monitoring")).toBeTruthy();
    expect(within(crumbs).getByText("Alerts").getAttribute("aria-current")).toBe("page");
  });

  it("labels unavailable modules N/A instead of hiding or faking them", async () => {
    renderShell();
    const link = await screen.findByRole("link", { name: /Accessibility/ });
    expect(within(link).getByText("N/A")).toBeTruthy();
  });

  it("collapses groups with aria-expanded and remembers the choice", async () => {
    renderShell();
    const toggle = await screen.findByRole("button", { name: "Website Intelligence" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: /Accessibility/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("zn_sidebar_groups") ?? "{}").intelligence).toBe(false);
  });

  it("collapses the sidebar to an icon rail and persists it", async () => {
    renderShell();
    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    await userEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("link", { name: "SEO Research" })).toBeTruthy();
    expect(localStorage.getItem("zn_sidebar_collapsed")).toBe("true");
  });

  it("opens the mobile drawer as a modal and closes it with Escape", async () => {
    renderShell();
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  it("jumps to a page from the command launcher (Ctrl+K, type, Enter)", async () => {
    renderShell();
    await screen.findByText("me@example.org");
    expect(screen.queryByRole("listbox", { name: "Pages" })).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    const search = screen.getByRole("textbox", { name: "Search pages" });
    await userEvent.type(search, "referring");
    const options = within(screen.getByRole("listbox", { name: "Pages" })).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Backlinks");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/search/backlinks");
    expect(screen.queryByRole("listbox", { name: "Pages" })).toBeNull();
  });

  it("says when no page matches the search", async () => {
    renderShell();
    await userEvent.click((await screen.findAllByRole("button", { name: "Go to page" }))[0]);
    await userEvent.type(screen.getByRole("textbox", { name: "Search pages" }), "zzzz");
    expect(screen.getByText(/No page matches/)).toBeTruthy();
  });
});

describe("Shell keyboard support", () => {
  it("skip link focuses the main region without changing the route", async () => {
    renderShell("/monitoring/alerts");
    const skip = await screen.findByRole("link", { name: "Skip to content" });
    await userEvent.click(skip);
    expect(document.activeElement?.id).toBe("zn-main");
    expect(screen.getByTestId("where").textContent).toBe("/monitoring/alerts");
  });

  it("keeps Tab focus inside the open mobile drawer", async () => {
    renderShell();
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    const focusable = drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    focusable[focusable.length - 1].focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(focusable[0]);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });
});

describe("Shell role awareness", () => {
  it("tells a viewer up front that changes are disabled, and shows the role", async () => {
    sessionStorage.setItem("zn_active_org_id", "org-1");
    vi.mocked(api.apiGetMe).mockResolvedValue({ data: { id: "u", email: "me@example.org", orgIds: ["org-1"], memberships: [{ orgId: "org-1", role: "viewer" }] }, error: null });
    renderShell();
    expect((await screen.findByRole("note")).textContent).toMatch(/view-only access/);
    expect(screen.getAllByText(/VIEWER · VERSION/).length).toBeGreaterThan(0);
  });

  it("shows no view-only note to members", async () => {
    sessionStorage.setItem("zn_active_org_id", "org-1");
    vi.mocked(api.apiGetMe).mockResolvedValue({ data: { id: "u", email: "me@example.org", orgIds: ["org-1"], memberships: [{ orgId: "org-1", role: "member" }] }, error: null });
    renderShell();
    await screen.findAllByText(/MEMBER · VERSION/);
    expect(screen.queryByText(/view-only access/)).toBeNull();
  });
});
