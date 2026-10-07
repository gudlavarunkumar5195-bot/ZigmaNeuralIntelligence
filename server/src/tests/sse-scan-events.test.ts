import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://localhost/test",
    JWT_SECRET: "12345678901234567890123456789012",
    COOKIE_SECRET: "12345678901234567890123456789012",
    NODE_ENV: "test",
    SSE_MAX_STREAMS_PER_USER: 2,
    SSE_MAX_STREAMS_PER_ORG: 3,
    SSE_MAX_STREAMS_GLOBAL: 4,
    SSE_POLL_INTERVAL_MS: 1500,
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const SCAN = "33333333-3333-4333-8333-333333333333";
const WEBSITE = "44444444-4444-4444-8444-444444444444";

const state = {
  status: "running",
  events: [] as { id: number; type: string; payload: unknown }[],
  failEventsQuery: false,
  scanInserts: [] as unknown[][],
};
const { queryMock, txMock } = vi.hoisted(() => ({ queryMock: vi.fn(), txMock: vi.fn() }));
vi.mock("../db/client.js", () => ({ query: queryMock, withTransaction: txMock, createListenClient: vi.fn() }));
vi.mock("../services/audit.service.js", () => ({ audit: vi.fn() }));

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { scanRoutes, closeAllScanStreams, openScanStreamCount, resetScanStreamsForTests } from "../routes/scans.js";

let app: FastifyInstance;

function token(userId: string): string {
  return app.jwt.sign({ sub: userId, email: `${userId}@x.test`, orgIds: [ORG, ORG2] });
}

beforeEach(async () => {
  resetScanStreamsForTests();
  state.status = "running";
  state.events = [{ id: 1, type: "scan_queued", payload: { scanId: SCAN } }];
  state.failEventsQuery = false;
  state.scanInserts = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM memberships")) return { rows: [{ role: "member" }] };
    if (sql.startsWith("SELECT * FROM scans")) return { rows: [{ id: SCAN, org_id: ORG, status: state.status, website_id: WEBSITE }] };
    if (sql.startsWith("SELECT status FROM scans")) return { rows: [{ status: state.status }] };
    if (sql.includes("FROM scan_events")) {
      if (state.failEventsQuery) throw new Error("db down");
      return { rows: state.events.filter((e) => e.id > (params[1] as number)) };
    }
    if (sql.startsWith("SELECT * FROM websites")) return { rows: [{ id: WEBSITE, verified: true }] };
    return { rows: [] };
  });
  txMock.mockImplementation(async (cb: (c: unknown) => unknown) =>
    cb({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO scans")) state.scanInserts.push(params);
        return { rows: [{ id: SCAN, org_id: ORG, active_count: 0, queued_count: 0, recent_count: 0 }] };
      },
    }),
  );
  app = Fastify();
  await app.register(cors, { origin: ["http://allowed.test"], credentials: true });
  await app.register(jwt, { secret: "12345678901234567890123456789012" });
  await app.register(scanRoutes, { prefix: "/api/v1/scans" });
  await app.ready();
});

afterEach(async () => {
  closeAllScanStreams();
  await app.close();
});

const auth = (userId: string, org = ORG) => ({
  authorization: `Bearer ${token(userId)}`,
  "x-org-id": org,
  origin: "http://allowed.test",
});

function parseSse(body: string) {
  return body
    .split("\n\n")
    .filter((b) => b.includes("event:"))
    .map((b) => ({
      event: /event: (.*)/.exec(b)?.[1],
      data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? "null"),
    }));
}

describe("SSE terminal handling", () => {
  it.each(["scan_completed", "scan_failed", "scan_cancelled"])("ends with done after replayed %s", async (type) => {
    state.events.push({ id: 2, type, payload: { scanId: SCAN } });
    state.status = type === "scan_completed" ? "completed" : type === "scan_failed" ? "failed" : "cancelled";
    const res = await app.inject({ method: "GET", url: `/api/v1/scans/${SCAN}/events`, headers: auth("u1") });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(["scan_queued", type, "done"]);
    expect(events.at(-1)?.data).toEqual({ status: state.status });
  });

  it("S1: ends via status re-check when a failed scan never emitted a terminal event", async () => {
    state.status = "failed";
    const res = await app.inject({ method: "GET", url: `/api/v1/scans/${SCAN}/events`, headers: auth("u1") });
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(["scan_queued", "done"]);
    expect(events.at(-1)?.data).toEqual({ status: "failed" });
  });

  it("S2: a scan that completed between fetch and replay terminates the stream", async () => {
    // scan row read says running, but by replay time it completed with the event present
    let scanReads = 0;
    const base = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT * FROM scans")) {
        scanReads++;
        return { rows: [{ id: SCAN, org_id: ORG, status: "running", website_id: WEBSITE }] };
      }
      return base(sql, params ?? []);
    });
    state.events.push({ id: 2, type: "scan_completed", payload: {} });
    state.status = "completed";
    const res = await app.inject({ method: "GET", url: `/api/v1/scans/${SCAN}/events`, headers: auth("u1") });
    expect(scanReads).toBe(1);
    expect(parseSse(res.body).at(-1)?.event).toBe("done");
    expect(openScanStreamCount()).toBe(0);
  });

  it("S4: hijacked response keeps CORS headers and adds security headers", async () => {
    state.status = "completed";
    const res = await app.inject({ method: "GET", url: `/api/v1/scans/${SCAN}/events`, headers: auth("u1") });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBe("http://allowed.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 404 for a scan in another org without opening a stream", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM memberships")) return { rows: [{ role: "member" }] };
      return { rows: [] };
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/scans/${SCAN}/events`, headers: auth("u1", ORG2) });
    expect(res.statusCode).toBe(404);
    expect(openScanStreamCount()).toBe(0);
  });
});

describe("SSE stream lifecycle (real socket)", () => {
  async function listen() {
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as AddressInfo).port;
  }
  function open(port: number, userId: string, org = ORG) {
    return new Promise<{ status: number; req: http.ClientRequest; res: http.IncomingMessage; body: () => string }>((resolve, reject) => {
      let buf = "";
      const req = http.get(
        { host: "127.0.0.1", port, path: `/api/v1/scans/${SCAN}/events`, headers: auth(userId, org) },
        (res) => {
          res.on("data", (c) => (buf += c));
          res.on("error", () => undefined);
          resolve({ status: res.statusCode ?? 0, req, res, body: () => buf });
        },
      );
      req.on("error", reject);
    });
  }
  const waitFor = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  it("S3: client disconnect releases the stream and stops polling", async () => {
    const port = await listen();
    const s = await open(port, "u1");
    expect(s.status).toBe(200);
    await waitFor(() => openScanStreamCount() === 1);
    s.req.destroy();
    expect(await waitFor(() => openScanStreamCount() === 0)).toBe(true);
    const calls = queryMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1800));
    expect(queryMock.mock.calls.length).toBe(calls);
  });

  it("S3: DB errors during polling are logged and do not leak or crash", async () => {
    state.failEventsQuery = true;
    const port = await listen();
    const s = await open(port, "u1");
    expect(s.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(openScanStreamCount()).toBe(1);
    s.req.destroy();
    expect(await waitFor(() => openScanStreamCount() === 0)).toBe(true);
  });

  it("S5: enforces per-user, per-org and global caps with 429, and releases on close", async () => {
    const port = await listen();
    const a1 = await open(port, "u1");
    const a2 = await open(port, "u1");
    expect([a1.status, a2.status]).toEqual([200, 200]);
    const a3 = await open(port, "u1");
    expect(a3.status).toBe(429); // per user (2)
    const b1 = await open(port, "u2");
    expect(b1.status).toBe(200);
    const c1 = await open(port, "u3");
    expect(c1.status).toBe(429); // per org (3)
    // other org still allowed until global cap (4)
    const d1 = await open(port, "u4", ORG2);
    const d2 = await open(port, "u5", ORG2);
    expect(d1.status).toBe(200);
    expect(d2.status).toBe(429); // global (4)
    a1.req.destroy();
    await waitFor(() => openScanStreamCount() === 3);
    const again = await open(port, "u1");
    expect(again.status).toBe(200);
  });

  it("S5: closeAllScanStreams ends open streams and refuses new ones", async () => {
    const port = await listen();
    const s = await open(port, "u1");
    await waitFor(() => openScanStreamCount() === 1);
    const ended = new Promise<void>((r) => s.res.on("end", () => r()));
    expect(closeAllScanStreams()).toBe(1);
    await ended;
    expect(openScanStreamCount()).toBe(0);
    const refused = await open(port, "u1");
    expect(refused.status).toBe(429);
    await app.close(); // must not hang
    app = Fastify();
    await app.ready();
  });

  it("S5: poll interval is never below 1500ms", async () => {
    const port = await listen();
    const s = await open(port, "u1");
    await waitFor(() => openScanStreamCount() === 1);
    const eventQueries = () => queryMock.mock.calls.filter((c) => String(c[0]).includes("FROM scan_events")).length;
    await new Promise((r) => setTimeout(r, 100));
    const before = eventQueries();
    await new Promise((r) => setTimeout(r, 1000));
    expect(eventQueries()).toBe(before);
    s.req.destroy();
  });
});

describe("scan route validation", () => {
  it("S10: non-UUID scan ids return 400 instead of reaching the database", async () => {
    for (const path of ["/api/v1/scans/not-a-uuid", "/api/v1/scans/not-a-uuid/status", "/api/v1/scans/not-a-uuid/events", "/api/v1/scans/not-a-uuid/findings"]) {
      const res = await app.inject({ method: "GET", url: path, headers: auth("u1") });
      expect(res.statusCode).toBe(400);
    }
    const cancel = await app.inject({ method: "POST", url: "/api/v1/scans/not-a-uuid/cancel", headers: auth("u1") });
    expect(cancel.statusCode).toBe(400);
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes("FROM scans"))).toBe(false);
  });

  it("S10: rejects unknown module names", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/scans", headers: auth("u1"), payload: { websiteId: WEBSITE, modules: ["seo", "bogus"] } });
    expect(res.statusCode).toBe(400);
  });

  it("S10: de-duplicates modules before insert", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/scans", headers: auth("u1"), payload: { websiteId: WEBSITE, modules: ["seo", "seo", "ssl"] } });
    expect(res.statusCode).toBe(201);
    expect(state.scanInserts[0][3]).toEqual(["seo", "ssl"]);
  });
});
