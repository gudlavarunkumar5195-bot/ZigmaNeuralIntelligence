import { describe, expect, it } from "vitest";
import { intelligenceStatusFor, reportStatusFor } from "../ai/agents/lifecycle.js";

describe("Intelligence and report lifecycle", () => {
  it("keeps deterministic and intelligence completion distinct", () => {
    expect(intelligenceStatusFor({ status: "completed" })).toBe("COMPLETED");
    expect(intelligenceStatusFor({ status: "unavailable" })).toBe("FAILED");
  });

  it("only marks a report ready after completed intelligence and accepted quality", () => {
    expect(reportStatusFor({ intelligenceStatus: "COMPLETED", qualityAccepted: true })).toBe("READY");
    expect(reportStatusFor({ intelligenceStatus: "FAILED", qualityAccepted: true })).toBe("FAILED");
    expect(reportStatusFor({ intelligenceStatus: "COMPLETED", qualityAccepted: false })).toBe("FAILED");
  });

  it("preserves score rows as an array contract", () => {
    const payload = { scores: [{ category: "seo" }, { category: "security" }] };
    expect(Array.isArray(payload.scores)).toBe(true);
    expect(payload.scores).toHaveLength(2);
  });
});