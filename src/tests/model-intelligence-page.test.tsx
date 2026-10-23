// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    apiGetMe: vi.fn(),
    apiAiStatus: vi.fn(),
    apiAiModels: vi.fn(),
    apiAiSettings: vi.fn(),
    apiAiUpdateSettings: vi.fn(),
    apiAiQuotaSync: vi.fn(),
    apiAiFeasibility: vi.fn(),
    apiAiUsage: vi.fn(),
    apiAiTasks: vi.fn(),
    apiAiTask: vi.fn(),
    apiAiCancelTask: vi.fn(),
    apiAiTaskFeedback: vi.fn(),
    apiAiQuality: vi.fn(),
    apiAiSecurityEvents: vi.fn(),
    apiAiApprovals: vi.fn(),
    apiAiDecideApproval: vi.fn(),
  };
});

import * as api from "../services/api";
import { ModelIntelligence } from "../pages/agents/ModelIntelligence";
import { routeTitle } from "../components/layout/navigation";

// Response shapes follow server/src/routes/ai-router.ts. Synthetic values.
const ok = <T,>(data: T) => ({ data, error: null }) as never;
const fail = (status: number, code: string, message: string, issues?: string[]) => ({ data: null, error: { code, message, status, ...(issues ? { issues } : {}) } }) as never;

const ORG = "11111111-1111-4111-8111-111111111111";
const me = (role: "owner" | "admin" | "member" | "viewer", isPlatformAdmin = false) =>
  ok({ id: "u1", email: "me@example.org", orgIds: [ORG], isPlatformAdmin, memberships: [{ orgId: ORG, role }] });

const status = {
  providerConfigured: true,
  paidModelsAllowed: false,
  catalog: { lastRefreshAt: "2030-01-02T03:00:00Z", lastRefreshStatus: "success", stale: false, modelsByPricingClass: { FREE: 12, TRIAL: 2, PAID: 300 } },
  quotas: [
    { pool: "FREE", day: "2030-01-02", used: 17, limit: 50, remaining: 33, exhaustedUntil: null, providerLimit: 50, providerUsed: 15, providerSyncedAt: "2030-01-02T02:00:00Z" },
    { pool: "TRIAL", day: "2030-01-02", used: 20, limit: 20, remaining: 0, exhaustedUntil: "2030-01-03T00:00:00Z", providerLimit: null, providerUsed: null, providerSyncedAt: null },
  ],
  settings: { version: 3, updatedAt: "2030-01-01T00:00:00Z", trialsEnabled: true },
  tokenEstimate: "utf8-bytes/3 (approximate)",
};

const model = (over: Record<string, unknown>) => ({
  id: "m", openrouter_id: "vendor/model:free", display_name: "Model", provider: "vendor", pricing_class: "FREE", free_status: "FREE", status: "ACTIVE",
  eligibility_status: "ELIGIBLE", enabled: true, context_length: 131072, max_completion_tokens: 8192, reasoning_mandatory: false, supports_tool_calling: true,
  supports_structured_output: true, supports_json_schema: true, is_router: false, expires_at: null, pricing_checked_at: "2030-01-02T00:00:00Z", output_modalities: ["text"],
  evaluations: 0, pricingFresh: true, excludedByAdmin: false, health: null, qualityConfidence: "insufficient_data", ...over,
});

const settings = {
  trials: { enabled: true, dailyRequestCap: 20 },
  autoApproveFreeModels: true,
  quota: { freeDailyRequests: 50, freeRequestsPerMinute: 16, syncFromProvider: true },
  perOrg: { dailyRequests: 200, dailyTokens: 2_000_000 },
  perTask: { maxInputTokens: 48_000, maxOutputTokens: 4_096, maxTotalTokens: 120_000, maxCalls: 6, maxAgents: 5, maxDepth: 2, maxConcurrency: 2, maxRetriesPerModel: 2, maxFallbackModels: 3, maxWallClockMs: 240_000, maxReductionIterations: 3, maxEvaluationAttempts: 0, maxRepairAttempts: 1 },
  catalog: { refreshIntervalMinutes: 360, maxStaleHours: 24 },
  quality: { minQualityScore: 55, minSamples: 5, halfLifeDays: 14, explorationRate: 0.1 },
  models: { excluded: [], pins: {} },
  weights: { quality: 0.3, reliability: 0.2, structured: 0.1, latency: 0.05, context: 0.05, availability: 0.1, security: 0.1, resourceFit: 0.1 },
  retentionDays: 180,
};

const at = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/agents/model-intelligence" element={<ModelIntelligence />} />
      <Route path="/agents/model-intelligence/:tab" element={<ModelIntelligence />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem("zn_active_org_id", ORG);
  vi.mocked(api.apiGetMe).mockResolvedValue(me("owner"));
  vi.mocked(api.apiAiStatus).mockResolvedValue(ok(status));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Model Intelligence navigation", () => {
  it("is registered under AI Agents with its title, including tab sub-routes", () => {
    expect(routeTitle("/agents/model-intelligence")).toEqual({ group: "AI Agents", title: "Model Intelligence" });
    expect(routeTitle("/agents/model-intelligence/quality")).toEqual({ group: "AI Agents", title: "Model Intelligence" });
  });
});

describe("Overview", () => {
  it("shows provider, free-only policy, catalog counts and both quota pools from the API", async () => {
    at("/agents/model-intelligence");
    expect(await screen.findByText("Disabled — free models only")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Model Intelligence" })).toBeTruthy();
    expect(screen.getByText("OpenRouter configured")).toBeTruthy();
    expect(screen.getByText("12 models")).toBeTruthy();
    expect(screen.getByText("0 models")).toBeTruthy(); // UNKNOWN is absent from the API counts
    expect(screen.getByText("33 remaining today (UTC day 2030-01-02)")).toBeTruthy();
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(screen.getByText(/Exhausted until/)).toBeTruthy();
    expect(screen.getByText(/Version 3/)).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Free models — daily requests: used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("17");
    expect(bar.getAttribute("aria-valuemax")).toBe("50");
    // Not a platform admin: no sync control.
    expect(screen.queryByRole("button", { name: /Sync quota/ })).toBeNull();
  });

  it("offers the quota sync to platform admins and explains a 403", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("owner", true));
    vi.mocked(api.apiAiQuotaSync).mockResolvedValue(fail(403, "PLATFORM_ADMIN_REQUIRED", "needs a platform administrator"));
    at("/agents/model-intelligence");
    await userEvent.click(await screen.findByRole("button", { name: "Sync quota from OpenRouter" }));
    expect(await screen.findByText(/Only platform administrators can sync the quota/)).toBeTruthy();
    expect(api.apiAiQuotaSync).toHaveBeenCalledTimes(1);
  });

  it("hides admin-only sections from members and says why", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("member"));
    at("/agents/model-intelligence/models");
    expect(await screen.findByText(/Models is available to organization owners and admins/)).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Model Intelligence sections" });
    expect(within(tabs).queryByText("Models")).toBeNull();
    expect(within(tabs).getByText("Feasibility check")).toBeTruthy();
    expect(api.apiAiModels).not.toHaveBeenCalled();
  });
});

describe("Models", () => {
  it("shows a TRIAL model's expiry and marks PAID models as not used", async () => {
    vi.mocked(api.apiAiModels).mockResolvedValue(ok([
      model({ id: "1", display_name: "Free One", pricing_class: "FREE", evaluations: 9, qualityConfidence: "measured" }),
      model({ id: "2", display_name: "Trial One", openrouter_id: "vendor/trial", pricing_class: "TRIAL", expires_at: "2030-02-01T12:00:00Z",
        health: { coolingDown: true, cooldownUntil: "2030-01-02T05:00:00Z", consecutiveFailures: 2, lastFailureCategory: "RATE_LIMITED" } }),
      model({ id: "3", display_name: "Paid One", openrouter_id: "vendor/paid", pricing_class: "PAID", excludedByAdmin: true }),
    ]));
    at("/agents/model-intelligence/models");
    const table = await screen.findByRole("table", { name: "Model catalog" });
    const trialRow = within(table).getByText("Trial One").closest("tr")!;
    expect(within(trialRow).getByText(`Trial · expires ${new Date("2030-02-01T12:00:00Z").toLocaleDateString()}`)).toBeTruthy();
    expect(within(trialRow).getByText(/Cooling down until/)).toBeTruthy();
    expect(within(trialRow).getByText(/2 consecutive failures · last: Rate limited/)).toBeTruthy();
    const paidRow = within(table).getByText("Paid One").closest("tr")!;
    expect(within(paidRow).getByText("Paid · not used")).toBeTruthy();
    expect(within(paidRow).getByText("Excluded by admin")).toBeTruthy();
    const freeRow = within(table).getByText("Free One").closest("tr")!;
    expect(within(freeRow).getByText("Free")).toBeTruthy();
    expect(within(freeRow).getByText("Measured")).toBeTruthy();
    expect(within(paidRow).getByText("Insufficient data")).toBeTruthy();
  });

  it("filters by pricing class through the API", async () => {
    vi.mocked(api.apiAiModels).mockResolvedValue(ok([]));
    at("/agents/model-intelligence/models");
    await screen.findByText("No models");
    await userEvent.selectOptions(screen.getByLabelText("Pricing class"), "TRIAL");
    await waitFor(() => expect(api.apiAiModels).toHaveBeenLastCalledWith({ pricingClass: "TRIAL", limit: 500 }));
  });
});

describe("Quality", () => {
  it("shows an honest empty state with the API's minimum sample count", async () => {
    vi.mocked(api.apiAiQuality).mockResolvedValue(ok({ data: [], minSamples: 7 }));
    at("/agents/model-intelligence/quality");
    expect(await screen.findByText("No evaluations yet")).toBeTruthy();
    expect(screen.getByText(/quality rankings need at least 7 evaluated results/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("distinguishes measured from insufficient data", async () => {
    vi.mocked(api.apiAiQuality).mockResolvedValue(ok({ minSamples: 5, data: [
      { model: "a/one:free", taskType: "SUMMARIZATION", evaluations: 12, orgEvaluations: 4, averageScore: 81.5, passRate: 91.7, securityViolations: 0, userRatings: 2, lastEvaluatedAt: "2030-01-01T00:00:00Z", confidence: "measured" },
      { model: "b/two:free", taskType: "SEO_ANALYSIS", evaluations: 2, orgEvaluations: 2, averageScore: 60, passRate: 50, securityViolations: 1, userRatings: 0, lastEvaluatedAt: "2030-01-01T00:00:00Z", confidence: "insufficient_data" },
    ] }));
    at("/agents/model-intelligence/quality");
    const table = await screen.findByRole("table", { name: "Quality by model and task category" });
    expect(within(within(table).getByText("a/one:free").closest("tr")!).getByText("Measured")).toBeTruthy();
    expect(within(within(table).getByText("b/two:free").closest("tr")!).getByText("Insufficient data")).toBeTruthy();
    expect(within(table).getByText("91.7%")).toBeTruthy();
  });
});

describe("Security and tool approvals", () => {
  const pending = { id: "22222222-2222-4222-8222-222222222222", tool_id: "alerts.acknowledge", risk: "HIGH", status: "PENDING", args_preview: { alertId: "x" }, requested_by: "u1", decided_by: null, decided_at: null, expires_at: "2030-01-02T01:00:00Z", used_at: null, created_at: "2030-01-02T00:30:00Z" };

  it("approves a pending request through the API and shows the API's 403 message", async () => {
    vi.mocked(api.apiAiSecurityEvents).mockResolvedValue(ok([]));
    vi.mocked(api.apiAiApprovals).mockResolvedValue(ok([pending]));
    vi.mocked(api.apiAiDecideApproval).mockResolvedValue(fail(403, "FORBIDDEN", "You cannot approve your own request"));
    at("/agents/model-intelligence/security");
    expect(await screen.findByText("No security events")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Approve alerts.acknowledge" }));
    expect(api.apiAiDecideApproval).toHaveBeenCalledWith(pending.id, true);
    expect((await screen.findByRole("alert")).textContent).toBe("You cannot approve your own request");
    expect(api.apiAiApprovals).toHaveBeenCalledWith({ status: "PENDING", limit: 100 });
  });

  it("reloads the list after a successful decision", async () => {
    vi.mocked(api.apiAiSecurityEvents).mockResolvedValue(ok([]));
    vi.mocked(api.apiAiApprovals).mockResolvedValueOnce(ok([pending])).mockResolvedValue(ok([]));
    vi.mocked(api.apiAiDecideApproval).mockResolvedValue(ok({ status: "DENIED" }));
    at("/agents/model-intelligence/security");
    await userEvent.click(await screen.findByRole("button", { name: "Deny alerts.acknowledge" }));
    expect(api.apiAiDecideApproval).toHaveBeenCalledWith(pending.id, false);
    expect(await screen.findByText("No approvals")).toBeTruthy();
  });
});

describe("Settings", () => {
  const stored = { settings, version: 3, updatedAt: "2030-01-01T00:00:00Z", updatedBy: "u0", source: "stored", paidModelsAllowed: false, taskTypes: [] };

  it("is read-only for organization admins who are not platform admins", async () => {
    vi.mocked(api.apiAiSettings).mockResolvedValue(ok(stored));
    at("/agents/model-intelligence/settings");
    expect(await screen.findByText(/only platform administrators can change them/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByText(/api key/i)).toBeNull();
  });

  it("blocks saving while the weights do not sum to 1.00", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("owner", true));
    vi.mocked(api.apiAiSettings).mockResolvedValue(ok(stored));
    at("/agents/model-intelligence/settings");
    const quality = await screen.findByLabelText("Quality");
    expect(screen.getByText(/Sum: 1.00 — OK/)).toBeTruthy();
    await userEvent.clear(quality);
    await userEvent.type(quality, "0.5");
    expect(screen.getByText(/Sum: 1.20 — the weights must sum to 1.00/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.click(save);
    expect(api.apiAiUpdateSettings).not.toHaveBeenCalled();
  });

  it("enforces the server's bounds and shows the API's validation issues", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("owner", true));
    vi.mocked(api.apiAiSettings).mockResolvedValue(ok(stored));
    vi.mocked(api.apiAiUpdateSettings).mockResolvedValue(fail(400, "INVALID_SETTINGS", "Invalid router settings", ["models.pins.SUMMARIZATION: Invalid"]));
    at("/agents/model-intelligence/settings");
    const perMinute = await screen.findByLabelText("Free requests per minute");
    expect(perMinute.getAttribute("max")).toBe("20");
    await userEvent.clear(perMinute);
    await userEvent.type(perMinute, "25");
    expect(screen.getByText("Must be between 1 and 20.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.apiAiUpdateSettings).not.toHaveBeenCalled();
    await userEvent.clear(perMinute);
    await userEvent.type(perMinute, "18");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.apiAiUpdateSettings).toHaveBeenCalledTimes(1));
    const [sent, version] = vi.mocked(api.apiAiUpdateSettings).mock.calls[0];
    expect(version).toBe(3);
    expect(sent.quota.freeRequestsPerMinute).toBe(18);
    expect(sent).not.toHaveProperty("paidModelsAllowed");
    expect(await screen.findByText("models.pins.SUMMARIZATION: Invalid")).toBeTruthy();
  });

  it("asks to reload on a 409 conflict", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("owner", true));
    vi.mocked(api.apiAiSettings).mockResolvedValue(ok(stored));
    vi.mocked(api.apiAiUpdateSettings).mockResolvedValue(fail(409, "INVALID_SETTINGS", "Settings were changed by someone else; reload and try again"));
    at("/agents/model-intelligence/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    await waitFor(() => expect(api.apiAiSettings).toHaveBeenCalledTimes(2));
  });
});

describe("Routing & tasks", () => {
  const task = { id: "33333333-3333-4333-8333-333333333333", task_type: "SUMMARIZATION", feature: "seo_workspace_summary", status: "COMPLETED", feasibility: "FEASIBLE", selected_model: "a/one:free", error_code: null, tokens_used: "1834", tokens_reserved: "6000", calls_used: 2, agents_used: 1, started_at: "2030-01-02T00:00:00Z", completed_at: "2030-01-02T00:00:09Z" };
  const detail = {
    ...task,
    attempts: [
      { model: "b/two:free", attempt_number: 1, status: "failed", failure_category: "RATE_LIMITED", fallback_reason: "RATE_LIMITED", pricing_class: "FREE", latency_ms: 300, estimated_input_tokens: "900", estimated_output_tokens: "1024", prompt_tokens: null, completion_tokens: null, usage_estimated: true, cost_usd: "0", started_at: "2030-01-02T00:00:01Z" },
      { model: "a/one:free", attempt_number: 2, status: "completed", failure_category: null, fallback_reason: null, pricing_class: "FREE", latency_ms: 4200, estimated_input_tokens: "900", estimated_output_tokens: "1024", prompt_tokens: "880", completion_tokens: "410", usage_estimated: false, cost_usd: "0", started_at: "2030-01-02T00:00:02Z" },
    ],
    agents: [],
    evaluations: [],
    routing: [{ id: "r1", selected_openrouter_id: "b/two:free", fallback_openrouter_ids: ["a/one:free"], decision_reason: "Highest score among eligible free models", decision_source: "SCORER", decision_confidence: "0.82", candidate_count: 9, excluded_count: 4 }],
    feedback: [],
  };

  it("opens task details and handles an already-rated (409) result", async () => {
    vi.mocked(api.apiAiTasks).mockResolvedValue(ok([task]));
    vi.mocked(api.apiAiTask).mockResolvedValue(ok(detail));
    vi.mocked(api.apiAiTaskFeedback).mockResolvedValue(fail(409, "ALREADY_RATED", "You already rated this result"));
    at("/agents/model-intelligence/tasks");
    const table = await screen.findByRole("table", { name: "Task runs" });
    expect(within(table).getByText("1,834")).toBeTruthy();
    await userEvent.click(within(table).getByRole("button", { name: /Details for Summarization task/ }));
    expect(await screen.findByText("Highest score among eligible free models")).toBeTruthy();
    const attempts = screen.getByRole("table", { name: "Model attempts" });
    expect(within(attempts).getAllByText("estimated").length).toBeGreaterThan(0);
    expect(within(attempts).getByText("880")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Good result" }));
    expect(api.apiAiTaskFeedback).toHaveBeenCalledWith(task.id, 1, undefined);
    expect(await screen.findByText(/You have already rated this result/)).toBeTruthy();
  });

  it("offers cancel for a running task", async () => {
    const running = { ...task, status: "RUNNING", completed_at: null };
    vi.mocked(api.apiAiTasks).mockResolvedValue(ok([running]));
    vi.mocked(api.apiAiTask).mockResolvedValue(ok({ ...detail, ...running }));
    vi.mocked(api.apiAiCancelTask).mockResolvedValue(ok({ cancelRequested: true }));
    at("/agents/model-intelligence/tasks");
    await userEvent.click(await screen.findByRole("button", { name: /Details for Summarization task/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
    expect(api.apiAiCancelTask).toHaveBeenCalledWith(task.id);
    expect(screen.queryByRole("button", { name: "Good result" })).toBeNull();
  });
});

describe("Usage and feasibility", () => {
  it("labels estimated and provider-reported figures and shows the org token budget", async () => {
    vi.mocked(api.apiAiUsage).mockResolvedValue(ok({
      days: 7, orgTokensUsed24h: 50_000, orgTokenLimit24h: 2_000_000, note: "Provider figures are reported by OpenRouter; estimated figures use a conservative approximation and are labelled as such.",
      byModel: [{ model: "a/one:free", attempts: "5", completed: "4", failed: "1", estimated_input: "4000", reserved_output: "5000", provider_input: "3500", provider_output: "1200", estimated_only: "1", reported_cost_usd: "0", pricing_class: "FREE" }],
      reservations: [],
    }));
    at("/agents/model-intelligence/usage");
    const table = await screen.findByRole("table", { name: /Usage by model/ });
    expect(within(table).getByText("Input (estimated)")).toBeTruthy();
    expect(within(table).getByText("Input (provider)")).toBeTruthy();
    expect(within(table).getByText("$0.0000")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Organization tokens used in the last 24 hours" }).getAttribute("aria-valuenow")).toBe("50000");
    await userEvent.selectOptions(screen.getByLabelText("Period"), "30");
    await waitFor(() => expect(api.apiAiUsage).toHaveBeenLastCalledWith(30));
  });

  it("runs a feasibility check and shows the plain-language result", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(me("member"));
    vi.mocked(api.apiAiFeasibility).mockResolvedValue(ok({
      feasibility: "SPLIT_REQUIRED", message: "This task is too large for any available free model. Split it into smaller parts.", taskCategory: "CONTENT_GENERATION",
      estimatedInputTokens: 200_000, reservedOutputTokens: 4096, estimate: "utf8-bytes/3 (approximate)", selectedModel: null, fallbacks: [], reason: null,
      exclusions: { CONTEXT_TOO_SHORT: 4 }, budget: { orgTokensUsed24h: 0, orgTokenLimit24h: 2_000_000, freeRequestsRemaining: 40 },
    }));
    at("/agents/model-intelligence/feasibility");
    const size = await screen.findByLabelText("Approximate input size (characters)");
    await userEvent.clear(size);
    await userEvent.type(size, "600000");
    await userEvent.click(screen.getByRole("button", { name: "Check feasibility" }));
    expect(api.apiAiFeasibility).toHaveBeenCalledWith({ feature: "content_brief", inputChars: 600000, requireJson: false });
    expect(await screen.findByText("Split required")).toBeTruthy();
    expect(screen.getByText(/too large for any available free model/)).toBeTruthy();
    expect(screen.getByText("Context too short: 4")).toBeTruthy();
  });
});
