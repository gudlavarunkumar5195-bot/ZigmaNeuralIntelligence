import { describe, expect, it } from "vitest";
import { planRegeneration } from "../ai/regeneration/supervisor.js";
const assessment = (status: "ACCEPT" | "NEEDS_IMPROVEMENT" | "BLOCK", codes: string[] = []) => ({ qualityAssessmentId: "q", overallScore: 70, status, reasonCodes: codes, qualityConfidence: 90 }) as any;
describe("Adaptive Regeneration", () => { it("collects evidence before regeneration", () => expect(planRegeneration(assessment("NEEDS_IMPROVEMENT", ["EVIDENCE_MISSING"]), []).strategy).toBe("COLLECT_MORE_EVIDENCE")); it("never overrides a deterministic block", () => expect(planRegeneration(assessment("BLOCK"), []).status).toBe("BLOCKED")); it("stops after acceptance", () => expect(planRegeneration(assessment("ACCEPT"), []).strategy).toBe("STOP")); });
