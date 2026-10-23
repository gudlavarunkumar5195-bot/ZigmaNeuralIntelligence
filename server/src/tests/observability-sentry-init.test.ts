import { afterAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import {
  __resetSentryForTests,
  captureException,
  flushSentry,
  initSentry,
  isSentryEnabled,
  parseSampleRate,
  readSentrySettings,
  shouldReportError,
  SentryTestError,
} from "../observability/sentry.js";
import { registerSentry } from "../observability/fastify.js";

// Unroutable local DSN: if anything were ever sent, it goes nowhere.
const LOCAL_DSN = "https://publickey@127.0.0.1:9/1";

describe("readSentrySettings", () => {
  it("is disabled without a DSN", () => {
    expect(readSentrySettings({})).toBeNull();
    expect(readSentrySettings({ SENTRY_DSN: "   " })).toBeNull();
  });

  it("rejects malformed DSNs", () => {
    expect(readSentrySettings({ SENTRY_DSN: "not-a-dsn" })).toBeNull();
    expect(readSentrySettings({ SENTRY_DSN: "http://key@o1.ingest.sentry.io/1" })).toBeNull();
  });

  it("derives defaults from NODE_ENV and commit env vars", () => {
    const s = readSentrySettings({ SENTRY_DSN: "https://abc@o123.ingest.us.sentry.io/456", NODE_ENV: "production", COMMIT_SHA: "0123abcd" });
    expect(s).toMatchObject({ environment: "production", release: "zigma-api@0123abcd", tracesSampleRate: 0.1, enableLogs: true });
    const d = readSentrySettings({ SENTRY_DSN: "https://abc@o123.ingest.us.sentry.io/456", NODE_ENV: "development", SENTRY_ENABLE_LOGS: "false" });
    expect(d).toMatchObject({ environment: "development", release: undefined, tracesSampleRate: 0, enableLogs: false });
    const e = readSentrySettings({ SENTRY_DSN: "https://abc@o123.ingest.us.sentry.io/456", SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "v1.2.3" });
    expect(e).toMatchObject({ environment: "staging", release: "v1.2.3" });
  });

  it("clamps sample rates", () => {
    expect(parseSampleRate("2", 0.1)).toBe(1);
    expect(parseSampleRate("-1", 0.1)).toBe(0);
    expect(parseSampleRate("abc", 0.1)).toBe(0.1);
    expect(parseSampleRate("0.25", 0.1)).toBe(0.25);
  });
});

describe("shouldReportError", () => {
  it("reports 5xx and unexpected errors only", () => {
    expect(shouldReportError(new Error("boom"))).toBe(true);
    expect(shouldReportError(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
    expect(shouldReportError(Object.assign(new Error("x"), { statusCode: 404 }))).toBe(false);
    expect(shouldReportError(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(false);
    expect(shouldReportError(Object.assign(new Error("x"), { validation: [{}] }))).toBe(false);
    expect(shouldReportError(new SentryTestError("req-1"))).toBe(true);
  });
});

describe("initSentry without SENTRY_DSN", () => {
  it("is a no-op", async () => {
    __resetSentryForTests();
    expect(initSentry({ NODE_ENV: "production" })).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
    expect(captureException(new Error("x"))).toBeUndefined();
    expect(await flushSentry(10)).toBe(false);

    const app = Fastify();
    registerSentry(app); // must not throw or add hooks
    app.get("/boom", async () => { throw new Error("boom"); });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe("initSentry with a DSN", () => {
  afterAll(async () => {
    await Sentry.close(100);
    __resetSentryForTests();
  });

  it("initialises once, never sends PII, and reports only 5xx with request tags", async () => {
    __resetSentryForTests();
    expect(initSentry({ SENTRY_DSN: LOCAL_DSN, NODE_ENV: "test", SENTRY_ENABLE_LOGS: "true" })).toBe(true);
    expect(initSentry({})).toBe(true); // idempotent
    const client = Sentry.getClient()!;
    expect(client.getOptions().sendDefaultPii).toBe(false);
    expect(client.getOptions().enableLogs).toBe(true);
    expect(client.getIntegrationByName("Pino")).toBeDefined();
    expect(client.getIntegrationByName("ConsoleLogs")).toBeDefined();
    expect(client.getIntegrationByName("Fastify")).toBeDefined();

    const sent: Sentry.Event[] = [];
    client.on("beforeEnvelope", (envelope) => {
      for (const [header, payload] of envelope[1] as [{ type: string }, unknown][]) {
        if (header.type === "event") sent.push(payload as Sentry.Event);
      }
    });

    const app = Fastify();
    registerSentry(app);
    const dbPassword = ["hun", "ter2"].join("");
    app.get("/boom", async () => { throw new Error(`db failed postgres://u:${dbPassword}@h/db`); });
    app.get("/missing", async () => { throw Object.assign(new Error("nope"), { statusCode: 404, code: "NOT_FOUND" }); });
    await app.ready();

    // Secret values are built at runtime so they never appear in captured source context lines.
    const tokenValue = ["secret", "token", "value"].join("-");
    const cookieValue = ["sid", "cookievalue"].join("=");
    const headers = { authorization: `Bearer ${tokenValue}`, cookie: cookieValue, "x-org-id": "11111111-1111-4111-8111-111111111111" };
    expect((await app.inject({ method: "GET", url: "/missing", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/boom?token=${tokenValue}`, headers })).statusCode).toBe(500);
    await Sentry.flush(500);
    await app.close();

    expect(sent).toHaveLength(1);
    const json = JSON.stringify(sent[0]);
    expect(json).toContain("[REDACTED]");
    for (const secret of [dbPassword, tokenValue, cookieValue]) expect(json).not.toContain(secret);
    expect(sent[0].tags).toMatchObject({ route: "/boom", org_id: "11111111-1111-4111-8111-111111111111" });
    expect(typeof sent[0].tags?.request_id).toBe("string");
  });
});

describe("sentryCspConnectSource", () => {
  it("adds only a valid Sentry ingest host", async () => {
    const { sentryCspConnectSource } = await import("../observability/csp.js");
    expect(sentryCspConnectSource({})).toBe("");
    expect(sentryCspConnectSource({ SENTRY_CSP_INGEST_HOST: "o123.ingest.us.sentry.io" })).toBe(" https://o123.ingest.us.sentry.io");
    expect(sentryCspConnectSource({ SENTRY_CSP_INGEST_HOST: "ingest.sentry.io" })).toBe(" https://ingest.sentry.io");
    expect(sentryCspConnectSource({ SENTRY_CSP_INGEST_HOST: "evil.example.com" })).toBe("");
    expect(sentryCspConnectSource({ SENTRY_CSP_INGEST_HOST: "x.ingest.sentry.io; script-src *" })).toBe("");
  });
});
