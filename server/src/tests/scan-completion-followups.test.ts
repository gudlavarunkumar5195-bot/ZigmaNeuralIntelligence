import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://localhost/test",
    JWT_SECRET: "12345678901234567890123456789012",
    COOKIE_SECRET: "12345678901234567890123456789012",
    NODE_ENV: "test",
  },
}));

const { queryMock, auditMock, finalizeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  auditMock: vi.fn(),
  finalizeMock: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn(), createListenClient: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: auditMock }));
vi.mock("../services/monitoring.service.js", () => ({ finalizeMonitoringRun: finalizeMock }));
vi.mock("../scanner/seo.js", () => ({
  runSEOScanner: async () => ({ moduleName: "seo", status: "completed", durationMs: 1, findings: [] }),
}));
vi.mock("../ai/agents/scan-pipeline.js", () => ({
  runScanIntelligence: async () => ({ status: "COMPLETED", discoveryCount: 0 }),
}));

import { runScan } from "../services/scan.service.js";

describe("S7 scan_completed is never lost to follow-up failures", () => {
  beforeEach(() => {
    queryMock.mockReset();
    auditMock.mockReset();
    finalizeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  function wire() {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN websites"))
        return { rows: [{ scan_id: "s1", website_id: "w1", url: "https://example.test", org_id: "o1", modules: ["seo"] }] };
      if (sql.startsWith("SELECT status FROM scans")) return { rows: [{ status: "running" }] };
      if (sql.includes("UPDATE scan_modules") && sql.includes("RETURNING"))
        return { rows: [{ id: "m1", retry_count: 1, max_retries: 2 }] };
      if (sql.includes("UPDATE scans SET status = $2")) return { rows: [{ id: "s1" }] };
      if (sql.includes("INSERT INTO monitoring_snapshots")) throw new Error("snapshot db error");
      return { rows: [] };
    });
  }

  it("emits scan_completed and audits even when finalizeMonitoringRun and the snapshot throw", async () => {
    wire();
    finalizeMock.mockRejectedValue(new Error("finalize failed"));
    await expect(runScan("s1", "owner-1")).resolves.toBeUndefined();
    const emitted = queryMock.mock.calls
      .filter((c) => String(c[0]).includes("INSERT INTO scan_events"))
      .map((c) => c[1][1]);
    expect(emitted).toContain("scan_completed");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o1", action: "scan_completed" }));
    // terminal event precedes the fallible follow-ups
    const order = queryMock.mock.calls.map((c) => String(c[0]));
    const emitIdx = order.findIndex((q, i) => q.includes("INSERT INTO scan_events") && queryMock.mock.calls[i][1][1] === "scan_completed");
    const snapIdx = order.findIndex((q) => q.includes("INSERT INTO monitoring_snapshots"));
    expect(emitIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeLessThan(snapIdx);
  });

  it("scopes the snapshot and website lookups by org_id", async () => {
    wire();
    await runScan("s1", "owner-1");
    for (const needle of ["SELECT website_id FROM scans", "SELECT category, score FROM scan_scores"]) {
      const calls = queryMock.mock.calls.filter((c) => String(c[0]).includes(needle));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(String(c[0])).toContain("org_id");
    }
  });
});
