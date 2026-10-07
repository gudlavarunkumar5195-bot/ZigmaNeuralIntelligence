import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://localhost/test",
    JWT_SECRET: "12345678901234567890123456789012",
    COOKIE_SECRET: "12345678901234567890123456789012",
    NODE_ENV: "test",
  },
}));

const { queryMock, auditMock } = vi.hoisted(() => ({ queryMock: vi.fn(), auditMock: vi.fn() }));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn(), createListenClient: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: auditMock }));

import {
  SCAN_HEARTBEAT_MAX_FAILURES,
  SCAN_HEARTBEAT_MS,
  SCAN_MODULE_NAMES,
  ScanAdmissionError,
  hasLostScanLease,
  startScanLeaseHeartbeat,
  startScanWorker,
  stopScanLeaseHeartbeat,
  stopScanWorker,
} from "../services/scan.service.js";

describe("S6 heartbeat tolerates transient DB errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    stopScanLeaseHeartbeat("hb-1");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not mark the lease lost after one or two consecutive failures", async () => {
    queryMock.mockRejectedValue(new Error("connection reset"));
    startScanLeaseHeartbeat("hb-1", "org", "owner");
    for (let i = 0; i < SCAN_HEARTBEAT_MAX_FAILURES; i++) await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("hb-1")).toBe(false);
  });

  it("declares the lease lost after more than the tolerated consecutive failures", async () => {
    queryMock.mockRejectedValue(new Error("connection reset"));
    startScanLeaseHeartbeat("hb-1", "org", "owner");
    for (let i = 0; i <= SCAN_HEARTBEAT_MAX_FAILURES; i++) await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("hb-1")).toBe(true);
  });

  it("resets the failure count after a successful renewal", async () => {
    queryMock
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ rows: [{ execution_owner: "owner" }] })
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue({ rows: [{ execution_owner: "owner" }] });
    startScanLeaseHeartbeat("hb-1", "org", "owner");
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("hb-1")).toBe(false);
  });

  it("still declares the lease lost immediately when renewal is refused", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    startScanLeaseHeartbeat("hb-1", "org", "owner");
    await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("hb-1")).toBe(true);
  });
});

describe("S1/S9 worker crash path", () => {
  beforeEach(() => {
    queryMock.mockReset();
    auditMock.mockReset();
    auditMock.mockResolvedValue(undefined);
  });

  it("emits scan_failed and audits with the org when the worker crashes (incl. SCAN_DEADLINE_EXCEEDED); logs startup recovery failure", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let claimed = false;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("status = 'queued'") && sql.includes("RETURNING id, org_id")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: "scan-crash", org_id: "org-crash" }] };
      }
      if (sql.includes("JOIN websites")) throw new Error("SCAN_DEADLINE_EXCEEDED");
      if (sql.startsWith("UPDATE scans SET status = 'failed'")) return { rows: [{ id: "scan-crash" }] };
      return { rows: [] };
    });

    const timer = startScanWorker(10);
    const deadline = Date.now() + 2000;
    while (!queryMock.mock.calls.some((c) => String(c[0]).includes("INSERT INTO scan_events")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await stopScanWorker(1000);
    clearInterval(timer);

    const emit = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO scan_events"));
    expect(emit).toBeTruthy();
    expect(emit![1][0]).toBe("scan-crash");
    expect(emit![1][1]).toBe("scan_failed");
    expect(JSON.parse(emit![1][2])).toMatchObject({ scanId: "scan-crash", reason: "scan_deadline_exceeded" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-crash", action: "scan_failed", resourceId: "scan-crash", metadata: { reason: "scan_deadline_exceeded" } }),
    );
    expect(errors.some((e) => e.includes("startup_lease_recovery_failed"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("S8/S10 shared definitions", () => {
  it("ScanAdmissionError maps to HTTP 429", () => {
    expect(new ScanAdmissionError("x").statusCode).toBe(429);
  });
  it("exposes the known runner names", () => {
    expect([...SCAN_MODULE_NAMES].sort()).toEqual(["performance", "security", "seo", "ssl"]);
  });
});
