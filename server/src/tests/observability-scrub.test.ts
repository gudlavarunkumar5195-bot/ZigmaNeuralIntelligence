import { describe, expect, it } from "vitest";
import {
  REDACTED,
  scrubBreadcrumb,
  scrubEvent,
  scrubHeaders,
  scrubLog,
  scrubQueryString,
  scrubString,
  scrubUrl,
  scrubValue,
} from "../observability/scrub.js";

// Synthetic, obviously fake secret-shaped fixtures (never real credentials).
const OPENROUTER = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const OPENAI = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0".repeat(2);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLWZha2U";
const AWS_ID = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("scrubString", () => {
  it.each([
    ["OpenRouter key", `provider failed with key ${OPENROUTER}`, OPENROUTER],
    ["OpenAI-style key", `key=${OPENAI}`, OPENAI],
    ["Bearer token", "Authorization: Bearer abc.def-ghi_jkl123456", "abc.def-ghi_jkl123456"],
    ["JWT", `token ${JWT} rejected`, JWT],
    ["AWS access key id", `using ${AWS_ID}`, AWS_ID],
    ["postgres URL password", "connect postgres://app_user:s3cr3t-pa55@db.neon.tech/zigma failed", "s3cr3t-pa55"],
    ["postgresql URL password", "postgresql://u:p%40ss@host:5432/db?sslmode=require", "p%40ss"],
    ["aws secret", "AWS_SECRET_ACCESS_KEY=abcdEFGHijklMNOPqrstUVWXyz0123456789abcd", "abcdEFGHijklMNOPqrstUVWXyz0123456789abcd"],
  ])("masks %s", (_name, input, secret) => {
    const out = scrubString(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("keeps the non-secret parts of a connection string", () => {
    expect(scrubString("postgres://app_user:hunter2@db.example.com:5432/zigma")).toBe(
      `postgres://app_user:${REDACTED}@db.example.com:5432/zigma`,
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "GET /api/v1/websites 500 in 12ms (inputTokens=120, maxTokens=4000)";
    expect(scrubString(text)).toBe(text);
  });
});

describe("scrubUrl / scrubQueryString", () => {
  it("redacts credential-like query params and keeps others", () => {
    const out = scrubUrl("https://app.example.com/api/v1/integrations/google/oauth/callback?code=4/0Abc&state=xyz&page=2");
    expect(out).toContain(`code=${REDACTED}`);
    expect(out).toContain(`state=${REDACTED}`);
    expect(out).toContain("page=2");
    expect(out).not.toContain("4/0Abc");
  });

  it.each(["token", "access_token", "api_key", "apiKey", "secret", "password", "client_secret", "x-amz-signature"])(
    "redacts %s",
    (name) => {
      expect(scrubQueryString(`${name}=very-secret-value&ok=1`)).toBe(`${name}=${REDACTED}&ok=1`);
    },
  );

  it("redacts tokens in hash fragments", () => {
    const out = scrubUrl("/reset#access_token=abc123secret&type=recovery");
    expect(out).not.toContain("abc123secret");
    expect(out).toContain("type=recovery");
  });

  it("returns URLs without query unchanged", () => {
    expect(scrubUrl("/api/v1/websites/42")).toBe("/api/v1/websites/42");
  });
});

describe("scrubHeaders", () => {
  it("drops auth and cookie headers case-insensitively", () => {
    const out = scrubHeaders({
      Authorization: `Bearer ${JWT}`,
      cookie: "sid=abc",
      "Set-Cookie": "sid=abc",
      "x-api-key": "k",
      "user-agent": "vitest",
    });
    expect(out).toEqual({ "user-agent": "vitest" });
  });
});

describe("scrubValue", () => {
  it("redacts secret-named keys but keeps token counters", () => {
    const out = scrubValue({
      password: "p",
      apiKey: "k",
      client_secret: "c",
      openrouterApiKey: "k2",
      inputTokens: 10,
      max_tokens: 20,
      nested: { refresh_token: "r", note: `uses ${OPENROUTER}` },
    }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.client_secret).toBe(REDACTED);
    expect(out.openrouterApiKey).toBe(REDACTED);
    expect(out.inputTokens).toBe(10);
    expect(out.max_tokens).toBe(20);
    expect(out.nested).toEqual({ refresh_token: REDACTED, note: `uses ${REDACTED}` });
  });

  it("drops bodies and survives cycles", () => {
    const a: Record<string, unknown> = { body: { password: "x" } };
    a.self = a;
    const out = scrubValue(a) as Record<string, unknown>;
    expect(out.body).toBe(REDACTED);
    expect(out.self).toBe("[Circular]");
  });

  it("does not mutate its input", () => {
    const input = { password: "p" };
    scrubValue(input);
    expect(input.password).toBe("p");
  });
});

describe("scrubEvent", () => {
  it("strips request bodies, cookies, auth headers, secret query params and user PII", () => {
    const event = {
      type: undefined,
      message: `upstream rejected ${OPENROUTER}`,
      request: {
        url: "https://app.example.com/api/v1/x?token=abc&page=1",
        method: "POST",
        data: { password: "hunter2" },
        cookies: { sid: "abc" },
        headers: { authorization: `Bearer ${JWT}`, cookie: "sid=abc", "user-agent": "ua" },
        query_string: "token=abc&page=1",
      },
      user: { id: "user-1", email: "person@example.com", ip_address: "1.2.3.4", username: "person" },
      exception: { values: [{ type: "Error", value: `connect postgres://u:pw123@h/db` }] },
      extra: { config: { DATABASE_URL: "postgres://u:pw@h/db", region: "nyc" } },
      breadcrumbs: [{ category: "http", data: { url: "/cb?code=one-time" } }],
      sdkProcessingMetadata: { keep: true },
    };
    const out = scrubEvent(event);
    const json = JSON.stringify({ ...out, sdkProcessingMetadata: undefined });
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toEqual({ "user-agent": "ua" });
    expect(out.request?.query_string).toBe(`token=${REDACTED}&page=1`);
    expect(out.request?.url).toContain(`token=${REDACTED}`);
    expect(out.user).toEqual({ id: "user-1" });
    for (const secret of [OPENROUTER, JWT, "hunter2", "pw123", "person@example.com", "1.2.3.4", "one-time", "postgres://u:pw@"]) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain("nyc");
    expect(out.sdkProcessingMetadata).toBe(event.sdkProcessingMetadata);
  });

  it("handles object query strings", () => {
    const out = scrubEvent({ request: { query_string: { code: "abc", page: "1" } } });
    expect(out.request.query_string).toEqual({ code: REDACTED, page: "1" });
  });
});

describe("scrubLog / scrubBreadcrumb", () => {
  it("scrubs log messages and attributes", () => {
    const out = scrubLog({
      level: "error",
      message: `ai_router_failure key=${OPENROUTER}`,
      attributes: { req: { headers: { authorization: "Bearer zzzzzzzzzz" } }, body: { token: "t" }, event: "ai_router_failure" },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(OPENROUTER);
    expect(json).not.toContain("zzzzzzzzzz");
    expect(out.attributes.body).toBe(REDACTED);
    expect(out.attributes.event).toBe("ai_router_failure");
  });

  it("scrubs breadcrumb URLs", () => {
    const out = scrubBreadcrumb({ category: "fetch", data: { url: "https://x.test/?api_key=123&a=b" } });
    expect(out.data.url).toBe(`https://x.test/?api_key=${REDACTED}&a=b`);
  });
});
