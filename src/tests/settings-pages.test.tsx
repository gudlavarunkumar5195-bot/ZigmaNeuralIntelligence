// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return { ...actual, apiGetMe: vi.fn(async () => ({ data: { id: "u1", email: "real@example.org", orgIds: ["org-1"] }, error: null })) };
});

import { SettingsTeam } from "../pages/settings/SettingsTeam";
import { SettingsSecurity } from "../pages/settings/SettingsSecurity";
import { SettingsIntegrations } from "../pages/settings/SettingsIntegrations";
import { SettingsWorkspace } from "../pages/settings/SettingsWorkspace";

afterEach(cleanup);
const wrap = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe("settings pages", () => {
  it.each([
    ["team", SettingsTeam],
    ["security", SettingsSecurity],
    ["integrations", SettingsIntegrations],
  ])("%s shows an honest unavailable state and no fabricated data", (_n, Page) => {
    wrap(<Page />);
    expect(screen.getByTestId("settings-unavailable").textContent).toContain("Not available yet");
    expect(document.body.textContent).not.toMatch(/Ava Thompson|12 active|Enabled for owners|Rate limiting|200\/min/);
  });

  it("workspace shows real account data from /auth/me", async () => {
    wrap(<SettingsWorkspace />);
    expect(await screen.findByText("real@example.org")).toBeTruthy();
    expect(screen.getByTestId("settings-unavailable")).toBeTruthy();
  });
});
