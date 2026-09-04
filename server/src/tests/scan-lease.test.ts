import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://localhost/test",
    JWT_SECRET: "12345678901234567890123456789012",
    COOKIE_SECRET: "12345678901234567890123456789012",
    NODE_ENV: "test",
  },
}));

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: vi.fn(), createListenClient: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn() }));

import {
  claimScanExecution,
  hasLostScanLease,
  renewScanExecution,
  SCAN_HEARTBEAT_MS,
  startScanLeaseHeartbeat,
  stopScanLeaseHeartbeat,
} from "../services/scan.service.js";

describe("scan lease heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ execution_owner: "owner-b" }] });
  });

  it("renews an active lease for its current owner", async () => {
    await expect(renewScanExecution("scan-1", "org-a", "owner-a")).resolves.toBe(true);
    expect(queryMock.mock.calls[0][0]).toContain("execution_owner=$3");
    expect(queryMock.mock.calls[0][0]).toContain("execution_lease_until > NOW()");
  });

  it("allows an expired lease to be reclaimed", async () => {
    await expect(claimScanExecution("scan-1", "org-a", "owner-b")).resolves.toBe("owner-b");
    expect(queryMock.mock.calls[0][0]).toContain("execution_lease_until < NOW()");
  });

  it("does not allow a stale owner to renew after reclaim", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(renewScanExecution("scan-1", "org-a", "owner-a")).resolves.toBe(false);
  });

  it("keeps a valid owner until the heartbeat renewal fails", async () => {
    startScanLeaseHeartbeat("scan-1", "org-a", "owner-a");
    await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("scan-1")).toBe(false);
    stopScanLeaseHeartbeat("scan-1");
  });

  it("marks the worker lease lost when renewal fails", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    startScanLeaseHeartbeat("scan-1", "org-a", "owner-a");
    await vi.advanceTimersByTimeAsync(SCAN_HEARTBEAT_MS);
    expect(hasLostScanLease("scan-1")).toBe(true);
    stopScanLeaseHeartbeat("scan-1");
  });
});
