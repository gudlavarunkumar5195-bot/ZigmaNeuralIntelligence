/**
 * ZigmaNeural API client.
 *
 * In demo mode (VITE_APP_MODE=demo), functions return IntegrationRequired.
 * In production mode, all calls target VITE_API_BASE_URL.
 *
 * Auth token: stored in sessionStorage under "zn_token" after login.
 * Refresh token: HttpOnly cookie managed by server.
 */

import { config, IS_DEMO } from "../config/env";
import type { ApiResponse } from "../types";

// ─── Error Types ──────────────────────────────────────────────────────────────

export class IntegrationRequired extends Error {
  constructor(feature: string) {
    super(
      `[ZigmaNeural] Backend integration required for: ${feature}. ` +
        `Configure VITE_API_BASE_URL and VITE_APP_MODE=production.`
    );
    this.name = "IntegrationRequired";
  }
}

export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

// ─── Token Management ─────────────────────────────────────────────────────────

let _token: string | null = null;

function getSessionStorage(): Storage | null {
  if (typeof window !== "undefined" && window.sessionStorage) return window.sessionStorage;
  if (typeof globalThis !== "undefined" && "sessionStorage" in globalThis && globalThis.sessionStorage) {
    return globalThis.sessionStorage;
  }
  return null;
}

function getToken(): string | null {
  if (_token) return _token;
  const storage = getSessionStorage();
  _token = storage?.getItem("zn_token") ?? null;
  return _token;
}

function readTokenOrgId(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(normalized));
    const orgIds = Array.isArray(json?.orgIds) ? json.orgIds : [];
    return orgIds[0] ? String(orgIds[0]) : null;
  } catch {
    return null;
  }
}

export function getActiveOrgId(): string | null {
  const storage = getSessionStorage();
  const activeOrgId = storage?.getItem("zn_active_org_id");
  if (activeOrgId) return activeOrgId;

  const token = getToken();
  if (!token) return null;

  const orgId = readTokenOrgId(token);
  if (orgId) {
    storage?.setItem("zn_active_org_id", orgId);
  }
  return orgId;
}

export function setActiveOrgId(orgId?: string | null): void {
  const storage = getSessionStorage();
  if (!storage) return;
  if (orgId) {
    storage.setItem("zn_active_org_id", orgId);
    return;
  }
  storage.removeItem("zn_active_org_id");
}

export function setToken(token: string): void {
  _token = token;
  const storage = getSessionStorage();
  storage?.setItem("zn_token", token);

  const orgId = readTokenOrgId(token);
  if (orgId) {
    storage?.setItem("zn_active_org_id", orgId);
  }
}

export function clearToken(): void {
  _token = null;
  const storage = getSessionStorage();
  storage?.removeItem("zn_token");
  storage?.removeItem("zn_active_org_id");
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

export function buildRequestHeaders(baseHeaders: HeadersInit = {}): Headers {
  const headers = new Headers(baseHeaders);
  const orgId = getActiveOrgId();
  if (orgId) {
    headers.set("x-org-id", orgId);
  }
  return headers;
}

// ─── Base Fetch ───────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  if (IS_DEMO || !config.apiBaseUrl) {
    throw new IntegrationRequired(path);
  }

  const token = getToken();
  const url = `${config.apiBaseUrl}${path}`;

  let res: Response;
  try {
    const requestHeaders = buildRequestHeaders({
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    });

    res = await fetch(url, {
      ...options,
      credentials: "include",
      headers: requestHeaders,
    });
  } catch (err: unknown) {
    throw new ApiCallError(0, "NETWORK_ERROR", (err as Error).message);
  }

  // Auto-refresh on 401
  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const newToken = getToken();
      const retried = await fetch(url, {
        ...options,
        credentials: "include",
        headers: buildRequestHeaders({
          "Content-Type": "application/json",
          ...(newToken ? { Authorization: `Bearer ${newToken}` } : {}),
          ...options.headers,
        }),
      });
      if (retried.ok) {
        const body: { data: T } = await retried.json();
        return { data: body.data ?? (body as unknown as T), error: null };
      }
    }
    clearToken();
    window.location.hash = "/login";
    return { data: null, error: { code: "UNAUTHORIZED", message: "Session expired. Please sign in." } };
  }

  if (!res.ok) {
    let errorBody: { error?: { code?: string; message?: string } } = {};
    try { errorBody = await res.json(); } catch {}
    return {
      data: null,
      error: {
        code: errorBody.error?.code ?? String(res.status),
        message: errorBody.error?.message ?? res.statusText,
      },
    };
  }

  let body: { data: T };
  try { body = await res.json(); } catch {
    return { data: null, error: { code: "PARSE_ERROR", message: "Failed to parse response" } };
  }
  return { data: body.data ?? (body as unknown as T), error: null };
}

async function tryRefreshToken(): Promise<boolean> {
  if (!config.apiBaseUrl) return false;
  try {
    const res = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return false;
    const body: { data?: { token?: string } } = await res.json();
    if (body.data?.token) { setToken(body.data.token); return true; }
    return false;
  } catch { return false; }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function apiLogin(
  email: string,
  password: string
): Promise<ApiResponse<{ token: string; expiresIn: number; userId: string; orgIds: string[] }>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.login");
  return apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function apiRegister(
  email: string,
  password: string,
  fullName: string | undefined,
  orgName: string
): Promise<ApiResponse<{ token: string; expiresIn: number; userId: string; orgId: string }>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.register");
  return apiFetch("/auth/register", { method: "POST", body: JSON.stringify({ email, password, fullName, orgName }) });
}

export async function apiLogout(): Promise<void> {
  if (!IS_DEMO && config.apiBaseUrl) {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
  }
  clearToken();
}

export async function apiGetMe(): Promise<ApiResponse<{ id: string; email: string; orgIds: string[] }>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.me");
  return apiFetch("/auth/me");
}

export interface DashboardWebsite {
  id: string; url: string; domain: string; verified: boolean; created_at: string;
  latest_scan_id: string | null; latest_scan_status: string | null;
  started_at: string | null; completed_at: string | null; overall_score: number | null;
  finding_count: number; critical_count: number;
}
export interface DashboardData {
  websites: DashboardWebsite[]; selectedWebsite: DashboardWebsite | null;
  scores: Array<{ category: string; score: number | null; status: string; finding_count: number; critical_count: number }>;
  findings: Array<{ id: string; category: string; severity: string; title: string; description: string; recommendation: string; module_name: string; created_at: string }>;
  history: Array<{ captured_at: string; overall_score: number | null; seo_score: number | null; security_score: number | null; performance_score: number | null; accessibility_score: number | null; ssl_score: number | null }>;
  executions: Array<{ id: string; agent_type: string; model_id: string | null; status: string; started_at: string | null; completed_at: string | null; error: string | null; created_at: string }>;
}
export async function apiGetDashboard(websiteId?: string): Promise<ApiResponse<DashboardData>> {
  return apiFetch<DashboardData>(websiteId ? `/dashboard?websiteId=${encodeURIComponent(websiteId)}` : "/dashboard");
}

// ─── Websites ─────────────────────────────────────────────────────────────────

export async function apiListWebsites() {
  if (IS_DEMO) throw new IntegrationRequired("websites.list");
  return apiFetch("/websites");
}

export async function apiAddWebsite(url: string, verificationMethod: string, orgId?: string) {
  if (IS_DEMO) throw new IntegrationRequired("websites.add");
  return apiFetch("/websites", { method: "POST", body: JSON.stringify({ url, verificationMethod, orgId }) });
}

export async function apiVerifyOwnership(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("websites.verify");
  return apiFetch(`/websites/${websiteId}/verify`, { method: "POST" });
}

// ─── Scans ────────────────────────────────────────────────────────────────────

export async function apiCreateScan(websiteId: string, modules: string[]) {
  if (IS_DEMO) throw new IntegrationRequired("scans.create");
  return apiFetch("/scans", { method: "POST", body: JSON.stringify({ websiteId, modules }) });
}

export async function apiGetScan(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("scans.get");
  return apiFetch(`/scans/${scanId}`);
}

export async function apiCancelScan(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("scans.cancel");
  return apiFetch(`/scans/${scanId}/cancel`, { method: "POST" });
}

// ─── Findings ─────────────────────────────────────────────────────────────────

export async function apiGetFindings(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("findings.list");
  return apiFetch(`/scans/${scanId}/findings`);
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export async function apiGetReport(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("reports.get");
  return apiFetch(`/reports/${scanId}`);
}

// ─── Models ───────────────────────────────────────────────────────────────────

export async function apiListModels(params?: { freeOnly?: boolean; eligibility?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("models.list");
  const qs = new URLSearchParams();
  if (params?.freeOnly) qs.set("freeOnly", "true");
  if (params?.eligibility) qs.set("eligibility", params.eligibility);
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiFetch<RegistryModel[]>(`/models${suffix}`);
}

export async function apiGetModel(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.get");
  return apiFetch<RegistryModelDetail>(`/models/${id}`);
}

export async function apiRefreshCatalog() {
  if (IS_DEMO) throw new IntegrationRequired("models.catalog.refresh");
  return apiFetch(`/models/catalog/refresh`, { method: "POST" });
}

export async function apiGetCatalogStatus() {
  if (IS_DEMO) throw new IntegrationRequired("models.catalog.status");
  return apiFetch(`/models/catalog/status`);
}

export async function apiEnableModel(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.enable");
  return apiFetch(`/models/${id}/enable`, { method: "POST" });
}

export async function apiDisableModel(id: string, reason: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.disable");
  return apiFetch(`/models/${id}/disable`, { method: "POST", body: JSON.stringify({ reason }) });
}

// ─── Model types (frontend) ───────────────────────────────────────────────────

export interface RegistryModel {
  id: string;
  openrouter_id: string;
  display_name: string;
  provider: string;
  context_length: number | null;
  free_status: "FREE" | "PAID" | "UNKNOWN" | "CHANGED";
  status: string;
  eligibility_status: string;
  supports_tool_calling: boolean;
  supports_structured_output: boolean;
  supports_reasoning: boolean;
  supports_coding: boolean;
  supports_vision: boolean;
  enabled: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface RegistryModelDetail extends RegistryModel {
  description: string | null;
  benchmarks: Array<{
    task_type: string;
    score: number | null;
    evaluation_status: string;
    evaluated_at: string | null;
  }>;
  reliability: {
    total_requests: number;
    successful_requests: number;
    failed_requests: number;
    avg_latency_ms: number | null;
  } | null;
  history: Array<{
    event_type: string;
    old_value: unknown;
    new_value: unknown;
    reason: string | null;
    created_at: string;
  }>;
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export type TaskType =
  | "DISCOVERY" | "SEO_ANALYSIS" | "AEO_ANALYSIS" | "GEO_ANALYSIS"
  | "SECURITY_ANALYSIS" | "PERFORMANCE_ANALYSIS" | "ACCESSIBILITY_ANALYSIS"
  | "QA_ANALYSIS" | "SSL_ANALYSIS" | "REMEDIATION" | "CODE_GENERATION"
  | "REPORT_SYNTHESIS" | "EVIDENCE_SUMMARIZATION" | "STRUCTURED_EXTRACTION";

export type ModelCapability =
  | "REASONING" | "CODING" | "VISION" | "TOOL_CALLING" | "STRUCTURED_OUTPUT"
  | "LONG_CONTEXT" | "SEO" | "SECURITY" | "ACCESSIBILITY" | "PERFORMANCE";

export interface RoutingRequirements {
  taskType: TaskType;
  complexity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requiredCapabilities: ModelCapability[];
  preferredCapabilities: ModelCapability[];
  structuredOutputRequired: boolean;
  toolCallingRequired: boolean;
  visionRequired: boolean;
  freeOnly?: boolean;
  minimumContextLength?: number;
  minimumReliability?: number;
  excludedModels?: string[];
}

export interface RoutingDecisionSummary {
  id: string;
  taskType: string;
  complexity: string;
  riskLevel: string;
  selectedOpenrouterId: string | null;
  decisionConfidence: number | null;
  decisionSource: string;
  candidateCount: number;
  excludedCount: number;
  status: string;
  createdAt: string;
}

export interface RoutingPolicy {
  id: string;
  orgId: string | null;
  version: number;
  freeOnly: boolean;
  minReliability: number;
  minQuality: number;
  maxAttempts: number;
  requireCrossModelVerification: boolean;
  allowedProviders: string[] | null;
  excludedModels: string[] | null;
  weights: {
    benchmark: number;
    reliability: number;
    capability: number;
    historical: number;
    structuredOutput: number;
    latency: number;
    context: number;
    preference: number;
  };
  description: string | null;
  isActive: boolean;
}

export async function apiSimulateRouting(requirements: RoutingRequirements) {
  if (IS_DEMO) throw new IntegrationRequired("routing.simulate");
  return apiFetch<unknown>("/routing/simulate", {
    method: "POST",
    body: JSON.stringify(requirements),
  });
}

export async function apiGetRoutingDecisions(limit?: number) {
  if (IS_DEMO) throw new IntegrationRequired("routing.decisions");
  const qs = limit ? `?limit=${limit}` : "";
  return apiFetch<RoutingDecisionSummary[]>(`/routing/decisions${qs}`);
}

export async function apiGetRoutingDecision(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("routing.decisions.get");
  return apiFetch<unknown>(`/routing/decisions/${id}`);
}

export async function apiGetRoutingPolicy() {
  if (IS_DEMO) throw new IntegrationRequired("routing.policy");
  return apiFetch<RoutingPolicy>("/routing/policy");
}

export async function apiUpdateRoutingPolicy(update: Partial<RoutingPolicy>) {
  if (IS_DEMO) throw new IntegrationRequired("routing.policy.update");
  return apiFetch<RoutingPolicy>("/routing/policy", {
    method: "POST",
    body: JSON.stringify(update),
  });
}

// ─── Specialist Agents ────────────────────────────────────────────────────────

export type AgentType =
  | "DISCOVERY" | "SEO_ANALYSIS" | "AEO_ANALYSIS" | "GEO_ANALYSIS"
  | "SECURITY_ANALYSIS" | "PERFORMANCE_ANALYSIS" | "ACCESSIBILITY_ANALYSIS"
  | "QA_ANALYSIS" | "SSL_ANALYSIS" | "REMEDIATION" | "REPORT_SYNTHESIS";

export type AgentStatus = "ACTIVE" | "DISABLED" | "DEPRECATED" | "REQUIRES_REVIEW";
export type AgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PermissionLevel = "READ" | "ANALYZE" | "GENERATE" | "PROPOSE" | "EXECUTE";

export interface AgentTool {
  name: string;
  permissionLevel: PermissionLevel;
  description: string;
}

export interface AgentDependency {
  agentType: AgentType;
  dependencyType: "REQUIRED" | "OPTIONAL";
}

export interface AgentView {
  agentType: AgentType;
  name: string;
  description: string;
  version: string;
  status: AgentStatus;
  riskLevel: AgentRiskLevel;
  capabilities: string[];
  allowedTools: AgentTool[];
  dependencies: AgentDependency[];
  producesFindings: boolean;
  enabled: boolean;
  dbId?: string;
  dbUpdatedAt?: string;
}

export async function apiListAgents() {
  if (IS_DEMO) throw new IntegrationRequired("agents.list");
  return apiFetch<AgentView[]>("/agents");
}

export async function apiGetAgent(agentType: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.get");
  return apiFetch<AgentView & { versions: unknown[]; instructionProfileSummary: string }>(`/agents/${agentType}`);
}

export async function apiEnableAgent(agentType: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.enable");
  return apiFetch(`/agents/${agentType}/enable`, { method: "POST" });
}

export async function apiDisableAgent(agentType: string, reason: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.disable");
  return apiFetch(`/agents/${agentType}/disable`, { method: "POST", body: JSON.stringify({ reason }) });
}

export async function apiSimulateAgent(params: {
  agentType: AgentType;
  riskLevel?: AgentRiskLevel;
  evidenceReferences?: string[];
  context?: Record<string, unknown>;
  satisfiedDependencies?: string[];
}) {
  if (IS_DEMO) throw new IntegrationRequired("agents.simulate");
  return apiFetch<unknown>("/agents/simulate", { method: "POST", body: JSON.stringify(params) });
}

export async function apiPlanWorkflow(agentTypes: string[]) {
  if (IS_DEMO) throw new IntegrationRequired("agents.plan");
  return apiFetch<unknown>("/agents/plan", { method: "POST", body: JSON.stringify({ agentTypes }) });
}

// ─── Instruction Intelligence ───────────────────────────────────────────────

export interface InstructionProfileView {
  instructionProfileId: string;
  agentId: AgentType;
  agentVersion: string;
  version: string;
  status: "ACTIVE" | "DEPRECATED" | "ARCHIVED";
  instructions: Array<{ id: string; type: string; text: string; mandatory: boolean; source: string; version: string }>;
  requiredContext: string[];
  outputRequirements: Record<string, unknown>;
  validationRules: string[];
}

export async function apiListInstructionProfiles() {
  if (IS_DEMO) throw new IntegrationRequired("instructions.list");
  return apiFetch<InstructionProfileView[]>("/ai/instructions");
}

export async function apiSimulateInstructions(params: {
  agentType: AgentType; taskId: string; riskLevel: AgentRiskLevel; context?: Record<string, unknown>;
  evidenceReferences?: string[]; previousFailure?: string;
}) {
  if (IS_DEMO) throw new IntegrationRequired("instructions.simulate");
  return apiFetch<unknown>("/ai/instructions/simulate", { method: "POST", body: JSON.stringify(params) });
}

export async function apiGetTaskEvidence(taskId: string) {
  if (IS_DEMO) throw new IntegrationRequired("evidence.list");
  return apiFetch<Array<{ id: string; evidence_type: string; source_type: string; resource_reference: string | null; observed_at: string; freshness_status: string; status: string; content_hash: string }>>(`/ai/tasks/${encodeURIComponent(taskId)}/evidence`);
}

export async function apiGetTaskQuality(taskId: string) {
  if (IS_DEMO) throw new IntegrationRequired("quality.list");
  return apiFetch<unknown[]>(`/ai/tasks/${encodeURIComponent(taskId)}/quality`);
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

export async function apiGetMonitoringHistory(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("monitoring.history");
  return apiFetch(`/websites/${websiteId}/monitoring`);
}

// ─── Scan Progress via SSE ────────────────────────────────────────────────────

/**
 * Subscribe to real-time scan progress via Server-Sent Events.
 * Token is passed as a query param because EventSource doesn't support headers.
 * Server validates token and org membership before streaming.
 */
export function subscribeToScanProgress(
  scanId: string,
  onEvent: (event: { type: string; payload: unknown }) => void,
  onError: (err: Error) => void
): () => void {
  if (IS_DEMO || !config.apiBaseUrl) {
    onError(new IntegrationRequired("scans.progress_stream"));
    return () => {};
  }

  const token = getToken();
  const url = `${config.apiBaseUrl}/scans/${scanId}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url, { withCredentials: true });

  const EVENT_TYPES = ["scan_started", "module_started", "module_completed", "module_skipped",
    "scan_completed", "scan_failed", "scan_cancelled", "done", "log"];

  EVENT_TYPES.forEach((type) => {
    es.addEventListener(type, (e: MessageEvent) => {
      try { onEvent({ type, payload: JSON.parse(e.data) }); } catch {}
    });
  });

  es.onerror = () => {
    onError(new ApiCallError(0, "SSE_ERROR", "Scan progress stream disconnected"));
    es.close();
  };

  return () => es.close();
}
