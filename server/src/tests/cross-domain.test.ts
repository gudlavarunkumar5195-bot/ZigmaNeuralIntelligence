import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { DATABASE_URL: "postgres://localhost/test", NODE_ENV: "test" } }));
vi.mock("../db/client.js", () => ({ query: vi.fn() }));
import {
  buildCrossDomainFinding,
  buildProposal,
  calculatePriority,
  CrossDomainFindingSchema,
  RemediationProposalSchema,
} from "../services/cross-domain.service.js";

const source = [
  { id: "11111111-1111-1111-1111-111111111111", category: "seo", module_name: "SEO_ANALYSIS", severity: "high", title: "Missing structured data", description: "Structured data is missing", recommendation: "Add valid structured data", affected_urls: ["https://example.test"], evidence_ids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] },
  { id: "22222222-2222-2222-2222-222222222222", category: "aiVisibility", module_name: "AEO_ANALYSIS", severity: "medium", title: "Weak entity clarity", description: "Entity signals are weak", recommendation: "Clarify entity content", affected_urls: ["https://example.test"], evidence_ids: ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"] },
];

describe("Phase 7 cross-domain intelligence", () => {
  it("correlates only multiple domains with evidence", () => {
    const result = buildCrossDomainFinding(source);
    expect(result?.domains).toEqual(["seo", "ai_visibility"]);
    expect(result?.sourceFindingIds).toHaveLength(2);
    expect(result?.evidenceIds).toHaveLength(2);
  });

  it("rejects unsupported or incomplete cross-domain output", () => {
    expect(() => CrossDomainFindingSchema.parse({ title: "unsupported", severity: "high", domains: ["seo", "unknown"], sourceFindingIds: [], evidenceIds: [], businessImpact: "x", technicalImpact: "x", confidence: 101, priority: "high", priorityScore: 90, priorityReason: {}, recommendation: "x" })).toThrow();
    expect(buildCrossDomainFinding([{ ...source[0], evidence_ids: [] }, { ...source[1], evidence_ids: [] }])).toBeNull();
  });

  it("calculates explainable priority from deterministic factors", () => {
    const result = calculatePriority({ severity: "high", confidence: 80, affectedScope: 2, domainCount: 2, security: false });
    expect(result.priority).toBe("high");
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toHaveProperty("severityScore");
    expect(result.reason).toHaveProperty("domainScore");
  });

  it("creates proposal-only remediation with uncertain root cause and approval", () => {
    const finding = buildCrossDomainFinding(source)!;
    const proposal = buildProposal(finding, source.map((item) => item.recommendation));
    expect(proposal.rootCause).toBe("Root cause requires further validation");
    expect(proposal.requiresHumanApproval).toBe(true);
    expect(proposal.approvalStatus).toBe("PROPOSED");
    expect(() => RemediationProposalSchema.parse({ ...proposal, requiresHumanApproval: false })).toThrow();
  });
});
