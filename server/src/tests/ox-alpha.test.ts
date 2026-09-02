import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the modules that depend on them.
// vi.mock is hoisted, so these run before any imports are resolved.
vi.mock("../config.js", () => ({
  config: {
    OX_ALPHA_MODEL: "default-test-model",
    OX_ALPHA_TIMEOUT_MS: 5_000,
    OX_ALPHA_MAX_RETRIES: 3,
    OX_ALPHA_MAX_OUTPUT_TOKENS: 4_096,
    OPENROUTER_API_KEY: undefined,
  },
}));
vi.mock("../db/client.js", () => ({
  query: vi.fn(async () => ({ rows: [{ id: "test-db-id" }] })),
}));
vi.mock("../services/audit.service.js", () => ({
  audit: vi.fn(async () => {}),
}));

import { OxAlphaExecutor } from "../ai/ox-alpha.js";
import { ProviderError } from "../ai/provider.js";
import { OpenRouterProvider } from "../ai/providers/openrouter.js";
import type { ModelProvider, ModelResponse } from "../ai/provider.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeResponse(content: string, model = "test-model"): ModelResponse {
  return {
    executionId: "test-exec-id",
    model,
    provider: "mock",
    content,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    durationMs: 100,
  };
}

function mockProvider(execute: () => Promise<ModelResponse>): ModelProvider {
  return {
    name: "mock",
    execute: vi.fn(execute),
    isAvailable: vi.fn(async () => true),
  };
}

const BASE_REQUEST = {
  messages: [{ role: "user" as const, content: "Hello" }],
};

// ─── Provider error types ─────────────────────────────────────────────────────

describe("ProviderError", () => {
  it("retryable flag is accessible", () => {
    const e = new ProviderError("RATE_LIMITED", "limited", true, 429);
    expect(e.retryable).toBe(true);
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.httpStatus).toBe(429);
    expect(e.name).toBe("ProviderError");
  });

  it("non-retryable flag is accessible", () => {
    const e = new ProviderError("INVALID_REQUEST", "bad", false, 400);
    expect(e.retryable).toBe(false);
  });
});

// ─── OX Alpha executor — happy path ──────────────────────────────────────────

describe("OxAlphaExecutor — success", () => {
  it("returns success on first attempt", async () => {
    const provider = mockProvider(async () => makeResponse("result"));
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute(BASE_REQUEST);

    expect(result.success).toBe(true);
    expect(result.response?.content).toBe("result");
    expect(result.attempts).toBe(1);
    expect(result.executionIds).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it("parses JSON when requireJson=true and response is valid", async () => {
    const provider = mockProvider(async () => makeResponse('{"score":95}'));
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, requireJson: true });

    expect(result.success).toBe(true);
    expect(result.parsedJson).toEqual({ score: 95 });
  });
});

// ─── Retry behavior ───────────────────────────────────────────────────────────

describe("OxAlphaExecutor — retries", () => {
  it("retries on retryable ProviderError and succeeds", async () => {
    let calls = 0;
    const provider = mockProvider(async () => {
      calls++;
      if (calls < 2) throw new ProviderError("RATE_LIMITED", "limited", true);
      return makeResponse("ok after retry");
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, maxRetries: 3 });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.response?.content).toBe("ok after retry");
  });

  it("does NOT retry on non-retryable ProviderError", async () => {
    const provider = mockProvider(async () => {
      throw new ProviderError("INVALID_REQUEST", "bad request", false);
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, maxRetries: 3 });

    expect(result.success).toBe(false);
    // Should have only made 1 attempt (non-retryable breaks immediately)
    expect(result.attempts).toBe(1);
  });

  it("exhausts retries and returns failure", async () => {
    const provider = mockProvider(async () => {
      throw new ProviderError("PROVIDER_ERROR", "always fails", true);
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, maxRetries: 2 });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(2);
  });

  it("retries on invalid JSON when requireJson=true", async () => {
    let calls = 0;
    const provider = mockProvider(async () => {
      calls++;
      return makeResponse(calls === 1 ? "not json" : '{"ok":true}');
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, requireJson: true, maxRetries: 3 });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.parsedJson).toEqual({ ok: true });
  });

  it("fails after max retries of invalid JSON", async () => {
    const provider = mockProvider(async () => makeResponse("not json at all"));
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({ ...BASE_REQUEST, requireJson: true, maxRetries: 2 });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
  });
});

// ─── Fallback model behavior ──────────────────────────────────────────────────

describe("OxAlphaExecutor — fallback models", () => {
  it("falls back to second model when first is unavailable", async () => {
    let calls = 0;
    const provider = mockProvider(async (req) => {
      calls++;
      if (req.model === "model-a") {
        throw new ProviderError("MODEL_UNAVAILABLE", "model-a not available", false);
      }
      return makeResponse("from model-b", "model-b");
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({
      ...BASE_REQUEST,
      model: "model-a",
      fallbackModels: ["model-b"],
      maxRetries: 1,
    });

    expect(result.success).toBe(true);
    expect(result.response?.model).toBe("model-b");
    expect(result.attempts).toBe(2);
  });

  it("fails when all models are unavailable", async () => {
    const provider = mockProvider(async () => {
      throw new ProviderError("MODEL_UNAVAILABLE", "not available", false);
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({
      ...BASE_REQUEST,
      model: "model-a",
      fallbackModels: ["model-b", "model-c"],
      maxRetries: 1,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

describe("OxAlphaExecutor — timeout", () => {
  it("aborts and records failure when timeout fires", async () => {
    const provider = mockProvider(async (req) => {
      // Simulate a slow provider by checking the signal
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }))
        );
        setTimeout(() => reject(new Error("should have been aborted")), 5_000);
      });
      return makeResponse("never");
    });
    const executor = new OxAlphaExecutor(provider);

    const result = await executor.execute({
      ...BASE_REQUEST,
      maxRetries: 1,
      timeoutMs: 50, // very short for test
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|timeout|cancel/i);
  });
});

// ─── OpenRouter provider (unit, mocked fetch) ─────────────────────────────────

describe("OpenRouterProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws MODEL_UNAVAILABLE when no API key", async () => {
    const provider = new OpenRouterProvider("");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toThrow(ProviderError);
  });

  it("isAvailable returns false when no key", async () => {
    const provider = new OpenRouterProvider("");
    expect(await provider.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when key present", async () => {
    const provider = new OpenRouterProvider("sk-test-key");
    expect(await provider.isAvailable()).toBe(true);
  });

  it("throws RATE_LIMITED on HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 }))
    );
    const provider = new OpenRouterProvider("sk-key");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [],
      })
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    vi.unstubAllGlobals();
  });

  it("throws MODEL_UNAVAILABLE on HTTP 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    const provider = new OpenRouterProvider("sk-key");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [],
      })
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    vi.unstubAllGlobals();
  });

  it("throws MALFORMED_RESPONSE when choices is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    const provider = new OpenRouterProvider("sk-key");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [],
      })
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    vi.unstubAllGlobals();
  });

  it("returns a well-formed ModelResponse on success", async () => {
    const mockBody = {
      model: "resolved-model",
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    const provider = new OpenRouterProvider("sk-key");
    const response = await provider.execute({
      executionId: "eid",
      correlationId: "cid",
      model: "requested-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.content).toBe("hello world");
    expect(response.model).toBe("resolved-model");
    expect(response.provider).toBe("openrouter");
    expect(response.finishReason).toBe("stop");
    expect(response.usage?.totalTokens).toBe(8);
    vi.unstubAllGlobals();
  });

  it("handles model-level error embedded in 200 response", async () => {
    const mockBody = { error: { message: "Model not found", code: 503 } };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    const provider = new OpenRouterProvider("sk-key");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [],
      })
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    vi.unstubAllGlobals();
  });

  it("throws CANCELLED when request is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })
    );
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenRouterProvider("sk-key");
    await expect(
      provider.execute({
        executionId: "x",
        correlationId: "y",
        model: "m",
        messages: [],
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    vi.unstubAllGlobals();
  });
});
