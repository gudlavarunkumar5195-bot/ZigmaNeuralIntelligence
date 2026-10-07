import { describe, expect, it } from "vitest";

const INTEGRATION = !!process.env.DATABASE_URL && process.env.RUN_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("AI org budget count (integration)", () => {
  it("counts zero model attempts for an organization with no executions", async () => {
    const { countOrgAiExecutions } = await import("../ai/budget.js");
    expect(await countOrgAiExecutions("00000000-0000-4000-8000-000000000000")).toBe(0);
  });
});
