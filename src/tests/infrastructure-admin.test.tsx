// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiGetInfraStatus: vi.fn(),
    apiGetInfraConfiguration: vi.fn(),
    apiTestClickHouse: vi.fn(),
    apiTestPostgres: vi.fn(),
    apiGetEventPipeline: vi.fn(),
    apiGetInfraMigrations: vi.fn(),
  };
});

import * as api from "../services/api";
import type { InfraStatus } from "../services/api";
import {
  InfraClickHousePage,
  InfraConfigurationPage,
  InfraEventPipelinePage,
  InfraHealthPage,
} from "../pages/admin/InfrastructureAdmin";

const ok = <T,>(data: T) => ({ data, error: null });
const status = (ch: InfraStatus["clickhouse"]["status"]): InfraStatus => ({
  checkedAt: "2026-01-01T00:00:00Z",
  postgres: { configured: true, provider: "neon", region: "ap-southeast-1", database: "neondb", role: "neondb_owner", pooled: true, branch: "production", sslMode: "require", sslEnforced: true, certificateVerification: true, status: "connected", lastTest: null },
  clickhouse: { configured: true, provider: "clickhouse_cloud", region: "ap-southeast-1", protocol: "https", port: 8443, user: "default", database: "analytics", tls: true, certificateVerification: true, customCa: false, status: ch, lastTest: null },
  core: { status: "operational" },
  analytics: { status: ch === "connected" ? "available" : "unavailable" },
});
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Infrastructure admin", () => {
  beforeEach(() => vi.mocked(api.apiGetInfraStatus).mockResolvedValue(ok(status("not_verified"))));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("separates core operational from analytics unavailable when ClickHouse is down", async () => {
    vi.mocked(api.apiGetInfraStatus).mockResolvedValue(ok(status("unavailable")));
    wrap(<InfraHealthPage />);
    expect(await screen.findByText("Operational")).toBeTruthy();
    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(screen.getByText(/Analytics temporarily unavailable/)).toBeTruthy();
  });

  it("shows ClickHouse as Not verified rather than Connected before any test", async () => {
    wrap(<InfraClickHousePage />);
    expect(await screen.findByLabelText("Status: Not verified")).toBeTruthy();
    expect(screen.queryByLabelText("Status: Connected")).toBeNull();
  });

  it("reports TLS verification failure stage-by-stage and never offers a bypass", async () => {
    vi.mocked(api.apiTestClickHouse).mockResolvedValue(
      ok({
        status: "tls_error",
        summary: "ClickHouse TLS certificate verification failed.",
        latencyMs: null,
        checkedAt: "2026-01-01T00:00:00Z",
        steps: [
          { id: "config", label: "Configuration detected", status: "ok" },
          { id: "dns", label: "DNS resolution", status: "ok" },
          { id: "tls", label: "TLS connection", status: "ok" },
          { id: "certificate", label: "Certificate verification", status: "failed" },
          { id: "query", label: "Test query", status: "skipped" },
        ],
      }),
    );
    wrap(<InfraClickHousePage />);
    await userEvent.click(await screen.findByRole("button", { name: /Test Connection/ }));
    expect(await screen.findByText("TLS certificate verification failed")).toBeTruthy();
    expect(screen.getByText("Untrusted certificate authority")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/disable (ssl|tls)|skip verification/);
  });

  it("Test Query requests query mode", async () => {
    vi.mocked(api.apiTestClickHouse).mockResolvedValue(ok({ status: "connected", summary: "Connection healthy.", latencyMs: 12, checkedAt: "2026-01-01T00:00:00Z", steps: [] }));
    wrap(<InfraClickHousePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Test Query" }));
    await waitFor(() => expect(api.apiTestClickHouse).toHaveBeenCalledWith("query"));
  });

  it("shows an access-required state for non platform admins", async () => {
    vi.mocked(api.apiGetInfraStatus).mockResolvedValue({ data: null, error: { code: "PLATFORM_ADMIN_REQUIRED", message: "x" } });
    wrap(<InfraHealthPage />);
    expect(await screen.findByText("Administrator access required")).toBeTruthy();
  });

  it("shows Not available yet instead of fabricated pipeline metrics", async () => {
    vi.mocked(api.apiGetEventPipeline).mockResolvedValue(ok({ implemented: false, queued: null, processed: null, failed: null, lastSuccessAt: null, ingestionLatencyMs: null }));
    wrap(<InfraEventPipelinePage />);
    expect((await screen.findAllByText("Not available yet")).length).toBeGreaterThanOrEqual(5);
  });

  it("masks secret configuration values", async () => {
    vi.mocked(api.apiGetInfraConfiguration).mockResolvedValue(
      ok({
        postgres: [{ name: "DATABASE_URL", state: "MASKED", secret: true, required: true }],
        clickhouse: [
          { name: "CLICKHOUSE_PASSWORD", state: "NOT_SET", secret: true, required: true },
          { name: "CLICKHOUSE_PORT", state: "SET", secret: false, required: true, value: "8443" },
        ],
      }),
    );
    wrap(<InfraConfigurationPage />);
    expect(await screen.findByText("DATABASE_URL")).toBeTruthy();
    expect(screen.getByText("••••••••")).toBeTruthy();
    expect(screen.getByText("NOT SET")).toBeTruthy();
    expect(screen.getByText("8443")).toBeTruthy();
  });
});
