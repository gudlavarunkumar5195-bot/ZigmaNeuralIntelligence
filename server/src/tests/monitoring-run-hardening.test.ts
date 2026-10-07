import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://localhost/test",
    JWT_SECRET: "12345678901234567890123456789012",
    COOKIE_SECRET: "12345678901234567890123456789012",
    NODE_ENV: "test",
  },
}));

const { queryMock, txMock, auditMock, createScanMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  txMock: vi.fn(),
  auditMock: vi.fn(),
  createScanMock: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: txMock, createListenClient: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: auditMock }));
vi.mock("../services/scan.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/scan.service.js")>();
  return { ...actual, createScan: createScanMock };
});

import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { monitoringRoutes } from "../routes/monitoring.js";
import { MonitoringConfigInput, processNotificationDeliveries, runMonitoringNow } from "../services/monitoring.service.js";
import { ScanAdmissionError } from "../services/scan.service.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const MON = "55555555-5555-4555-8555-555555555555";
const WEB = "44444444-4444-4444-8444-444444444444";

const activeConfig = { id: MON, website_id: WEB, modules: ["seo"], status: "ACTIVE", enabled: true };

beforeEach(() => {
  queryMock.mockReset();
  txMock.mockReset();
  auditMock.mockReset();
  createScanMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM memberships")) return { rows: [{ role: "member" }] };
    if (sql.startsWith("SELECT * FROM monitoring_configs")) return { rows: [activeConfig] };
    if (sql.includes("INSERT INTO monitoring_runs")) return { rows: [{ id: "run-1" }] };
    return { rows: [] };
  });
});

describe("S8 runMonitoringNow admission ordering", () => {
  it("does not create a monitoring run when scan admission is rejected", async () => {
    createScanMock.mockRejectedValue(new ScanAdmissionError("Tenant scan concurrency limit reached"));
    await expect(runMonitoringNow(MON, ORG, "user-1")).rejects.toBeInstanceOf(ScanAdmissionError);
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes("INSERT INTO monitoring_runs"))).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("links the scan atomically when inserting the run and returns both ids", async () => {
    createScanMock.mockResolvedValue({ id: "scan-1" });
    await expect(runMonitoringNow(MON, ORG, "user-1")).resolves.toEqual({ monitoringRunId: "run-1", scanId: "scan-1" });
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO monitoring_runs"))!;
    expect(insert[1]).toContain("scan-1");
  });

  it("cancels the queued scan if the run cannot be recorded", async () => {
    createScanMock.mockResolvedValue({ id: "scan-1" });
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM monitoring_configs")) return { rows: [activeConfig] };
      if (sql.includes("INSERT INTO monitoring_runs")) throw new Error("db down");
      return { rows: [] };
    });
    await expect(runMonitoringNow(MON, ORG, "user-1")).rejects.toThrow("db down");
    const cancel = queryMock.mock.calls.find((c) => String(c[0]).includes("SET status='cancelled'"));
    expect(cancel?.[1]).toEqual(["scan-1", ORG]);
  });
});

describe("S8/S10 monitoring route", () => {
  async function build(): Promise<{ app: FastifyInstance; headers: Record<string, string> }> {
    const app = Fastify();
    await app.register(jwt, { secret: "12345678901234567890123456789012" });
    await app.register(monitoringRoutes, { prefix: "/api/v1/monitoring" });
    await app.ready();
    const token = app.jwt.sign({ sub: "user-1", email: "u@x.test", orgIds: [ORG] });
    return { app, headers: { authorization: `Bearer ${token}`, "x-org-id": ORG } };
  }

  it("maps ScanAdmissionError to 429 (not 500) with Retry-After", async () => {
    createScanMock.mockRejectedValue(new ScanAdmissionError("Tenant scan queue limit reached"));
    const { app, headers } = await build();
    const res = await app.inject({ method: "POST", url: `/api/v1/monitoring/${MON}/run`, headers });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.json().error.code).toBe("SCAN_LIMIT_REACHED");
    await app.close();
  });

  it("returns 400 for a non-UUID monitoring id on /run", async () => {
    const { app, headers } = await build();
    const res = await app.inject({ method: "POST", url: "/api/v1/monitoring/nope/run", headers });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 202 on success", async () => {
    createScanMock.mockResolvedValue({ id: "scan-1" });
    const { app, headers } = await build();
    const res = await app.inject({ method: "POST", url: `/api/v1/monitoring/${MON}/run`, headers });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("validates and de-duplicates modules on create", async () => {
    const bad = MonitoringConfigInput.safeParse({ websiteId: WEB, frequency: "daily", modules: ["seo", "evil"] });
    expect(bad.success).toBe(false);
    const dup = MonitoringConfigInput.parse({ websiteId: WEB, frequency: "daily", modules: ["seo", "seo", "ssl"] });
    expect(dup.modules).toEqual(["seo", "ssl"]);
    expect(MonitoringConfigInput.safeParse({ websiteId: WEB, frequency: "daily", modules: [] }).success).toBe(false);
    const { app, headers } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/monitoring",
      headers,
      payload: { websiteId: WEB, frequency: "daily", modules: ["bogus"] },
    });
    expect(res.statusCode).toBe(400);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/monitoring/${MON}`,
      headers: { ...headers, "x-org-id": ORG },
      payload: { modules: ["seo", "x"] },
    });
    expect([400, 403]).toContain(patch.statusCode); // member lacks admin; either way never reaches the DB write
    await app.close();
  });
});

describe("S9 notification delivery audit carries the tenant org", () => {
  it("audits with the delivery's org_id when called from the worker (no orgId arg)", async () => {
    txMock.mockImplementation(async (cb: (c: unknown) => unknown) =>
      cb({ query: async () => ({ rows: [{ id: "d1", alert_id: "a1", org_id: ORG }] }) }),
    );
    await processNotificationDeliveries();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, action: "notification_failed" }));
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes("UPDATE notification_deliveries"))!;
    expect(String(upd[0])).toContain("org_id=$2");
    expect(upd[1]).toEqual(["d1", ORG]);
  });
});
