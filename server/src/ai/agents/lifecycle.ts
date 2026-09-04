import type { IntelligenceStatus } from "../../types.js";

export type { IntelligenceStatus } from "../../types.js";
export type ReportStatus = "GENERATING" | "READY" | "FAILED";

export function intelligenceStatusFor(result: { status: "completed" | "unavailable" | "failed" }): IntelligenceStatus {
  if (result.status === "completed") return "COMPLETED";
  if (result.status === "unavailable") return "FAILED";
  return "FAILED";
}

export function reportStatusFor(input: { intelligenceStatus: IntelligenceStatus; qualityAccepted: boolean }): ReportStatus {
  return input.intelligenceStatus === "COMPLETED" && input.qualityAccepted ? "READY" : "FAILED";
}