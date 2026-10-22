/**
 * ZigmaNeural API client.
 *
 * In demo mode (VITE_APP_MODE=demo), functions return IntegrationRequired.
 * In production mode, all calls target VITE_API_BASE_URL.
 *
 * Auth token: stored in sessionStorage under "zn_token" after login.
 * Refresh token: HttpOnly cookie managed by server.
 */

import { config, IS_DEMO } from "../config/env"
import type { ApiResponse, PageMeta } from "../types"

// ─── Error Types ──────────────────────────────────────────────────────────────

export class IntegrationRequired extends Error {
  constructor(feature: string) {
    super(
      `[ZigmaNeural] Backend integration required for: ${feature}. ` +
        `Configure VITE_API_BASE_URL and VITE_APP_MODE=production.`,
    )
    this.name = "IntegrationRequired"
  }
}

export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiCallError"
  }
}

// ─── Token Management ─────────────────────────────────────────────────────────

let _token: string | null = null

function getSessionStorage(): Storage | null {
  if (typeof window !== "undefined" && window.sessionStorage)
    return window.sessionStorage
  if (
    typeof globalThis !== "undefined" &&
    "sessionStorage" in globalThis &&
    globalThis.sessionStorage
  ) {
    return globalThis.sessionStorage
  }
  return null
}

function getToken(): string | null {
  if (_token) return _token
  const storage = getSessionStorage()
  _token = storage?.getItem("zn_token") ?? null
  return _token
}

function readTokenOrgId(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const json = JSON.parse(atob(normalized))
    const orgIds = Array.isArray(json?.orgIds) ? json.orgIds : []
    return orgIds[0] ? String(orgIds[0]) : null
  } catch {
    return null
  }
}

export function getActiveOrgId(): string | null {
  const storage = getSessionStorage()
  const activeOrgId = storage?.getItem("zn_active_org_id")
  if (activeOrgId) return activeOrgId

  const token = getToken()
  if (!token) return null

  const orgId = readTokenOrgId(token)
  if (orgId) {
    storage?.setItem("zn_active_org_id", orgId)
  }
  return orgId
}

export function setActiveOrgId(orgId?: string | null): void {
  const storage = getSessionStorage()
  if (!storage) return
  if (orgId) {
    storage.setItem("zn_active_org_id", orgId)
    return
  }
  storage.removeItem("zn_active_org_id")
}

export function setToken(token: string): void {
  _token = token
  const storage = getSessionStorage()
  storage?.setItem("zn_token", token)

  const orgId = readTokenOrgId(token)
  if (orgId) {
    storage?.setItem("zn_active_org_id", orgId)
  }
}

export function clearToken(): void {
  _token = null
  const storage = getSessionStorage()
  storage?.removeItem("zn_token")
  storage?.removeItem("zn_active_org_id")
}

export function isAuthenticated(): boolean {
  return !!getToken()
}

export function buildRequestHeaders(baseHeaders: HeadersInit = {}): Headers {
  const headers = new Headers(baseHeaders)
  const orgId = getActiveOrgId()
  if (orgId) {
    headers.set("x-org-id", orgId)
  }
  return headers
}

// ─── Base Fetch ───────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  if (IS_DEMO || !config.apiBaseUrl) {
    throw new IntegrationRequired(path)
  }

  const url = `${config.apiBaseUrl}${path}`

  const send = async (): Promise<Response> => {
    const token = getToken()
    try {
      return await fetch(url, {
        ...options,
        credentials: "include",
        headers: buildRequestHeaders({
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        }),
      })
    } catch (err: unknown) {
      throw new ApiCallError(0, "NETWORK_ERROR", (err as Error).message)
    }
  }

  let res = await send()

  // Auto-refresh on 401 (single-flight; the retried response is handled by the
  // normal path so a 403/404/500 after refresh is NOT treated as a logout).
  const isAuthRequest =
    path.startsWith("/auth/login") ||
    path.startsWith("/auth/register") ||
    path.startsWith("/auth/refresh")
  if (res.status === 401 && !isAuthRequest) {
    if (await tryRefreshToken()) {
      res = await send()
    }
    if (res.status === 401) {
      clearToken()
      window.location.hash = "/login"
      return {
        data: null,
        error: {
          code: "UNAUTHORIZED",
          message: "Session expired. Please sign in.",
        },
      }
    }
  }

  if (!res.ok) {
    let errorBody: { error?: { code?: string; message?: string; details?: unknown } } = {}
    try {
      errorBody = await res.json()
    } catch {
      // Non-JSON error body (proxy/gateway page): fall back to the HTTP status.
    }
    return {
      data: null,
      error: {
        code: errorBody.error?.code ?? String(res.status),
        message:
          errorBody.error?.code === "PLATFORM_ADMIN_REQUIRED"
            ? "This changes platform-wide settings (shared by all organizations) and needs a platform administrator. Organization owners and admins cannot do this."
            : errorBody.error?.message ?? res.statusText,
        ...(errorBody.error?.details && typeof errorBody.error.details === "object" && !Array.isArray(errorBody.error.details)
          ? { details: errorBody.error.details as Record<string, unknown> }
          : {}),
      },
    }
  }

  if (res.status === 204) return { data: null as unknown as T, error: null }

  let body: { data?: T; meta?: PageMeta } | null
  try {
    body = await res.json()
  } catch {
    return {
      data: null,
      error: { code: "PARSE_ERROR", message: "Failed to parse response" },
    }
  }
  if (body && typeof body === "object" && "data" in body) {
    return body.meta
      ? { data: body.data as T, error: null, meta: body.meta }
      : { data: body.data as T, error: null }
  }
  return { data: body as unknown as T, error: null }
}

let refreshInFlight: Promise<boolean> | null = null

function tryRefreshToken(): Promise<boolean> {
  // Refresh tokens are single-use: concurrent 401s must share one refresh call.
  if (!refreshInFlight) {
    refreshInFlight = doRefreshToken().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function doRefreshToken(): Promise<boolean> {
  if (!config.apiBaseUrl) return false
  try {
    const res = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
    if (!res.ok) return false
    const body: { data?: { token?: string } } = await res.json()
    if (body.data?.token) {
      setToken(body.data.token)
      return true
    }
    return false
  } catch {
    return false
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function apiLogin(
  email: string,
  password: string,
): Promise<ApiResponse<{
  token: string
  expiresIn: number
  userId: string
  orgIds: string[]
}>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.login")
  return apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
}

export async function apiRegister(
  email: string,
  password: string,
  fullName: string | undefined,
  orgName: string,
): Promise<ApiResponse<{
  token: string
  expiresIn: number
  userId: string
  orgId: string
}>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.register")
  return apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, fullName, orgName }),
  })
}

export async function apiLogout(): Promise<void> {
  if (!IS_DEMO && config.apiBaseUrl) {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {})
  }
  clearToken()
}

export async function apiGetMe(): Promise<ApiResponse<{
  id: string
  email: string
  orgIds: string[]
  isPlatformAdmin?: boolean
}>> {
  if (IS_DEMO) throw new IntegrationRequired("auth.me")
  return apiFetch("/auth/me")
}

export interface DashboardWebsite {
  id: string
  url: string
  domain: string
  verified: boolean
  created_at: string
  latest_scan_id: string | null
  latest_scan_status: string | null
  started_at: string | null
  completed_at: string | null
  overall_score: number | null
  finding_count: number
  critical_count: number
}
export interface DashboardData {
  websites: DashboardWebsite[]
  selectedWebsite: DashboardWebsite | null
  scores: Array<{
    category: string
    score: number | null
    status: string
    finding_count: number
    critical_count: number
  }>
  findings: Array<{
    id: string
    category: string
    severity: string
    title: string
    description: string
    recommendation: string
    module_name: string
    created_at: string
  }>
  history: Array<{
    captured_at: string
    overall_score: number | null
    seo_score: number | null
    security_score: number | null
    performance_score: number | null
    accessibility_score: number | null
    ssl_score: number | null
  }>
  executions: Array<{
    id: string
    agent_type: string
    model_id: string | null
    status: string
    started_at: string | null
    completed_at: string | null
    error: string | null
    created_at: string
  }>
}
export async function apiGetDashboard(
  websiteId?: string,
): Promise<ApiResponse<DashboardData>> {
  return apiFetch<DashboardData>(
    websiteId
      ? `/dashboard?websiteId=${encodeURIComponent(websiteId)}`
      : "/dashboard",
  )
}

export interface MonitoringConfig {
  id: string
  website_id: string
  status: string
  enabled: boolean
  frequency: string
  last_run_at: string | null
  next_run_at: string
  last_success_at: string | null
  last_failure_at: string | null
}
export interface MonitoringChange {
  id: string
  change_type: string
  domain: string
  severity: string
  affected_urls: string[]
  before_value: unknown
  after_value: unknown
  impact: string
  detected_at: string
}
export interface MonitoringAlert {
  id: string
  severity: string
  title: string
  status: string
  detected_at: string
  monitoring_id: string
}
export interface MonitoringRule {
  id: string
  monitoring_id: string
  rule_type: string
  enabled: boolean
  threshold: number | null
}
export interface PageParams {
  page?: number
  pageSize?: number
}
function pageQuery(params?: PageParams): string {
  if (!params) return ""
  const qs = new URLSearchParams()
  if (params.page) qs.set("page", String(params.page))
  if (params.pageSize) qs.set("pageSize", String(params.pageSize))
  const text = qs.toString()
  return text ? `?${text}` : ""
}
export async function apiListMonitoring(
  params?: PageParams,
): Promise<ApiResponse<MonitoringConfig[]>> {
  return apiFetch(`/monitoring${pageQuery(params)}`)
}
export async function apiListMonitoringChanges(
  id: string,
): Promise<ApiResponse<MonitoringChange[]>> {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/changes`)
}
export async function apiListAlerts(
  params?: PageParams,
): Promise<ApiResponse<MonitoringAlert[]>> {
  return apiFetch(`/monitoring/alerts${pageQuery(params)}`)
}
export async function apiCreateMonitoring(input: {
  websiteId: string
  frequency: string
  modules?: string[]
  alertConfig?: Record<string, unknown>
}) {
  return apiFetch<MonitoringConfig>("/monitoring", {
    method: "POST",
    body: JSON.stringify(input),
  })
}
export async function apiUpdateMonitoring(
  id: string,
  input: {
    frequency?: string
    modules?: string[]
    alertConfig?: Record<string, unknown>
  },
) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}
export async function apiPauseMonitoring(id: string) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  })
}
export async function apiResumeMonitoring(id: string) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  })
}
export async function apiDisableMonitoring(id: string) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/disable`, {
    method: "POST",
  })
}
export async function apiRunMonitoring(id: string) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/run`, {
    method: "POST",
  })
}
export async function apiCreateMonitoringRule(
  id: string,
  input: { ruleType: string; threshold?: number | null },
) {
  return apiFetch(`/monitoring/${encodeURIComponent(id)}/rules`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}
export async function apiUpdateMonitoringRule(
  id: string,
  input: { enabled?: boolean; threshold?: number | null },
) {
  return apiFetch(`/monitoring/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}
export async function apiGetAlert(id: string) {
  return apiFetch<MonitoringAlert>(
    `/monitoring/alert/${encodeURIComponent(id)}`,
  )
}
export async function apiAcknowledgeAlert(id: string) {
  return apiFetch(`/monitoring/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
  })
}
export async function apiResolveAlert(id: string) {
  return apiFetch(`/monitoring/alerts/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
  })
}
export async function apiDismissAlert(id: string) {
  return apiFetch(`/monitoring/alerts/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
  })
}

// ─── Websites ─────────────────────────────────────────────────────────────────

export interface WebsiteRecord {
  id: string
  url: string
  domain: string
  verified: boolean
  verification_method?: string | null
  verification_token?: string | null
}

export async function apiListWebsites(
  params?: PageParams,
): Promise<ApiResponse<WebsiteRecord[]>> {
  if (IS_DEMO) throw new IntegrationRequired("websites.list")
  return apiFetch<WebsiteRecord[]>(`/websites${pageQuery(params)}`)
}

export async function apiAddWebsite(
  url: string,
  verificationMethod: string,
  orgId?: string,
) {
  if (IS_DEMO) throw new IntegrationRequired("websites.add")
  return apiFetch("/websites", {
    method: "POST",
    body: JSON.stringify({ url, verificationMethod, orgId }),
  })
}

export async function apiVerifyOwnership(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("websites.verify")
  return apiFetch(`/websites/${websiteId}/verify`, { method: "POST" })
}

export async function apiQaVerifyWebsite(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("websites.qaVerify")
  return apiFetch(`/websites/${websiteId}/qa-verify`, { method: "POST" })
}

// ─── Scans ────────────────────────────────────────────────────────────────────

export async function apiCreateScan(websiteId: string, modules: string[]) {
  if (IS_DEMO) throw new IntegrationRequired("scans.create")
  return apiFetch<{ id: string }>("/scans", {
    method: "POST",
    body: JSON.stringify({ websiteId, modules }),
  })
}

export async function apiGetScan(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("scans.get")
  return apiFetch(`/scans/${scanId}`)
}

export async function apiCancelScan(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("scans.cancel")
  return apiFetch(`/scans/${scanId}/cancel`, { method: "POST" })
}

// ─── Findings ─────────────────────────────────────────────────────────────────

export async function apiGetFindings(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("findings.list")
  return apiFetch(`/scans/${scanId}/findings`)
}

// ─── Technical site audit (crawl + persistent issues) ─────────────────────────

export type SiteIssueStatus = "OPEN" | "FIXED" | "IGNORED"
export type SeoCategory =
  | "crawlability"
  | "status_codes"
  | "links"
  | "redirects"
  | "content"
  | "canonicalization"
  | "indexability"
  | "sitemaps"
  | "images"
export type CrawlOutcome =
  | "ok"
  | "redirect"
  | "redirect_out_of_scope"
  | "redirect_loop"
  | "http_error"
  | "fetch_error"
  | "too_large"
  | "non_html"
  | "blocked_by_robots"
export type TruncatedReason = "page_limit" | "time_limit" | "depth_limit" | "discovery_limit" | "cancelled"

export interface CrawlSummary {
  scan_id: string
  start_url: string
  pages_crawled: number
  pages_discovered: number
  pages_blocked_by_robots?: number
  max_pages: number
  max_depth?: number | null
  truncated: boolean
  truncated_reason: TruncatedReason | null
  robots_status: "parsed" | "missing" | "unreachable"
  start_blocked_by_robots: boolean
  sitemap_status: "found" | "missing" | "invalid" | "unsupported"
  sitemap_url_count: number
  status_counts: Record<string, number>
  issue_counts: Record<string, number>
  duration_ms: number
  reconcilable?: boolean | null
  created_at: string
  scan_status: string
}

export interface LatestCrawlScan {
  id: string
  status: string
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  crawl_options: { maxPages?: number; maxDepth?: number } | null
  crawl_module_status: string | null
  crawl_module_error: string | null
}

export interface CrawlOverviewMeta {
  previous: CrawlSummary | null
  changes: { detected: number; fixed: number; reopened: number } | null
  latestScan: LatestCrawlScan | null
}

export interface SiteIssue {
  id: string
  rule_id: string
  category: SeoCategory
  severity: string
  url: string
  title: string
  details: Record<string, unknown>
  status: SiteIssueStatus
  first_seen_at: string
  last_seen_at: string
  fixed_at: string | null
  ignored_at: string | null
  ignored_by?: string | null
  ignore_reason: string | null
  times_reopened: number
  first_seen_scan_id?: string | null
  last_seen_scan_id?: string | null
  fixed_in_scan_id?: string | null
}

export interface SeoRuleInfo {
  id: string
  category: SeoCategory
  severity: string
  title: string
  explanation: string
  remediation: string
  provenance: "MEASURED"
  source: string
}

export interface CrawlPageRow {
  url: string
  final_url: string
  status_code: number
  final_status_code: number
  redirect_chain: Array<{ url: string; status: number }>
  redirect_target?: string | null
  outcome?: CrawlOutcome | null
  depth?: number
  title: string | null
  meta_description?: string | null
  canonicals?: string[]
  robots_meta?: string | null
  x_robots_tag?: string | null
  h1_count?: number | null
  images_total?: number | null
  images_missing_alt?: number | null
  images_missing_alt_sample?: string[]
  indexable: boolean
  indexability_reasons?: string[]
  in_sitemap: boolean
  inlinks?: number
  fetch_error: string | null
}

export interface SiteIssueDetail extends SiteIssue {
  rule: { id: string; category: SeoCategory; title: string; explanation: string; remediation: string; provenance: "MEASURED"; source: string }
  occurrences: Array<{ scan_id: string; observed_at: string; scan_status: string }>
  occurrenceCount: number
  latestCrawl: { scanId: string; crawledAt: string; page: CrawlPageRow | null } | null
}

export interface SiteIssueEvent {
  id: number
  event: "DETECTED" | "FIXED" | "REOPENED" | "IGNORED" | "UNIGNORED"
  scan_id: string | null
  actor_id: string | null
  actor_name: string | null
  note: string | null
  created_at: string
}

export interface CursorMeta {
  limit: number
  nextCursor: string | null
}

type WithMeta<T, M> = Promise<ApiResponse<T> & { meta?: M }>

const sitePath = (websiteId: string) => `/websites/${encodeURIComponent(websiteId)}`
const queryString = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") q.set(key, String(value))
  const text = q.toString()
  return text ? `?${text}` : ""
}

export async function apiGetCrawlSummary(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("crawl.summary")
  return apiFetch<CrawlSummary | null>(`${sitePath(websiteId)}/crawl`) as WithMeta<CrawlSummary | null, CrawlOverviewMeta>
}

export async function apiListCrawlPages(
  websiteId: string,
  params: { status?: string; outcome?: string; indexable?: boolean; url?: string; cursor?: string | null; limit?: number } = {},
) {
  if (IS_DEMO) throw new IntegrationRequired("crawl.pages")
  return apiFetch<CrawlPageRow[]>(
    `${sitePath(websiteId)}/crawl/pages${queryString({ ...params, limit: params.limit ?? 50 })}`,
  ) as WithMeta<CrawlPageRow[], CursorMeta & { scanId: string | null }>
}

export async function apiListSiteIssues(
  websiteId: string,
  params: { status?: SiteIssueStatus; severity?: string; category?: string; rule?: string; url?: string; cursor?: string | null; limit?: number } = {},
) {
  if (IS_DEMO) throw new IntegrationRequired("issues.list")
  return apiFetch<SiteIssue[]>(
    `${sitePath(websiteId)}/issues${queryString({ ...params, limit: params.limit ?? 25 })}`,
  ) as WithMeta<SiteIssue[], CursorMeta & { counts?: Record<SiteIssueStatus, number>; total?: number }>
}

export async function apiListSeoRules(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("issues.rules")
  return apiFetch<SeoRuleInfo[]>(`${sitePath(websiteId)}/issues/rules`)
}

export async function apiGetSiteIssue(websiteId: string, issueId: string) {
  if (IS_DEMO) throw new IntegrationRequired("issues.get")
  return apiFetch<SiteIssueDetail>(`${sitePath(websiteId)}/issues/${encodeURIComponent(issueId)}`)
}

export async function apiGetSiteIssueHistory(websiteId: string, issueId: string) {
  if (IS_DEMO) throw new IntegrationRequired("issues.history")
  return apiFetch<SiteIssueEvent[]>(`${sitePath(websiteId)}/issues/${encodeURIComponent(issueId)}/history`)
}

export async function apiIgnoreSiteIssue(websiteId: string, issueId: string, reason: string) {
  if (IS_DEMO) throw new IntegrationRequired("issues.ignore")
  return apiFetch<SiteIssue>(`${sitePath(websiteId)}/issues/${encodeURIComponent(issueId)}/ignore`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export async function apiReopenSiteIssue(websiteId: string, issueId: string) {
  if (IS_DEMO) throw new IntegrationRequired("issues.reopen")
  return apiFetch<SiteIssue>(`${sitePath(websiteId)}/issues/${encodeURIComponent(issueId)}/reopen`, { method: "POST" })
}

/**
 * Starts a crawl-only scan. The Idempotency-Key makes a retried submit (double
 * click, network retry) return the same scan instead of creating another.
 */
export async function apiStartCrawl(websiteId: string, crawl: { maxPages?: number; maxDepth?: number }, idempotencyKey: string) {
  if (IS_DEMO) throw new IntegrationRequired("scans.create")
  return apiFetch<{ id: string; status: string }>("/scans", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ websiteId, modules: ["crawl"], crawl }),
  }) as WithMeta<{ id: string; status: string }, { deduplicated?: boolean; idempotentReplay?: boolean }>
}

// ─── Google Search Console ────────────────────────────────────────────────────

export interface IntegrationRecord {
  id: string
  provider: "google_search_console"
  account_email: string | null
  scopes: string[]
  status: "active" | "reauth_required" | "error"
  status_reason: string | null
  connected_at: string
  connected_by_name: string | null
  properties: Array<{ websiteId: string; siteUrl: string; status: string; domain: string }>
}

export interface GoogleConfigStatus {
  configured: boolean
  missing: string[]
}

export interface GscPropertyOption {
  siteUrl: string
  permissionLevel: string
  propertyType: "domain" | "url_prefix"
  canReadData: boolean
  linkedWebsiteIds: string[]
}

export interface GscSyncJob {
  id: string
  kind: "initial" | "incremental" | "manual"
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled"
  date_from: string
  date_to: string
  units_total: number
  units_done: number
  units_failed: number
  rows_written?: number
  quota_pauses?: number
  error_code: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  run_after?: string
}

export interface GscLinkStatus {
  property: {
    id: string
    site_url: string
    property_type: "domain" | "url_prefix"
    permission_level: string
    status: "active" | "access_lost"
    status_reason: string | null
    last_sync_success_at: string | null
    last_synced_through: string | null
    first_incomplete_date: string | null
    next_sync_at: string | null
    integration_id: string
  }
  integration: { id: string; account_email: string | null; status: string; status_reason: string | null } | null
  activeJob: GscSyncJob | null
  recentJobs: GscSyncJob[]
  freshness: { latestFinalDay: string | null; latestDay: string | null; firstIncompleteDate: string | null }
}

export interface SearchMetrics {
  clicks: number | null
  impressions: number | null
  ctr: number | null
  position: number | null
}

export interface SearchSeriesPoint extends SearchMetrics {
  date: string
  state: "complete" | "fresh" | "missing" | "not_returned"
}

export interface SearchPerformanceRange {
  dimensionSet: string
  totals: SearchMetrics
  coverage: { days: number; daysWithData: number; daysMissing: number; daysFresh: number; daysNotReturned: number }
  series: SearchSeriesPoint[]
}

export interface SearchPerformance {
  current: SearchPerformanceRange
  previous: SearchPerformanceRange | null
  comparison: Record<"clicks" | "impressions" | "ctr" | "position", { change: number | null; changePct: number | null }> | null
}

export interface SearchTopRow {
  key: string
  clicks: number
  impressions: number
  ctr: number | null
  position: number | null
  daysWithRows: number
}

export type SearchDimension = "query" | "page" | "country" | "device" | "searchAppearance"

const gscPath = (websiteId: string) => `/websites/${encodeURIComponent(websiteId)}/search-console`

export async function apiListIntegrations() {
  if (IS_DEMO) throw new IntegrationRequired("integrations.list")
  return apiFetch<IntegrationRecord[]>("/integrations") as WithMeta<IntegrationRecord[], { googleSearchConsole: GoogleConfigStatus }>
}

export async function apiStartGoogleConnect(returnTo: "/settings/integrations" | "/search/performance" = "/settings/integrations") {
  if (IS_DEMO) throw new IntegrationRequired("integrations.connect")
  return apiFetch<{ authorizationUrl: string }>("/integrations/google/oauth/start", { method: "POST", body: JSON.stringify({ returnTo }) }) as Promise<
    ApiResponse<{ authorizationUrl: string }> & { error: (ApiResponse<unknown>["error"] & { missing?: string[] }) | null }
  >
}

export async function apiListGscProperties(integrationId: string) {
  if (IS_DEMO) throw new IntegrationRequired("integrations.properties")
  return apiFetch<GscPropertyOption[]>(`/integrations/${encodeURIComponent(integrationId)}/properties`)
}

export async function apiDisconnectIntegration(integrationId: string) {
  if (IS_DEMO) throw new IntegrationRequired("integrations.disconnect")
  return apiFetch<{ revokedAtGoogle: boolean }>(`/integrations/${encodeURIComponent(integrationId)}`, { method: "DELETE" })
}

export async function apiGetSearchConsoleStatus(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.status")
  return apiFetch<GscLinkStatus | null>(gscPath(websiteId)) as WithMeta<GscLinkStatus | null, { websiteVerified: boolean }>
}

export async function apiLinkSearchConsole(websiteId: string, integrationId: string, siteUrl: string) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.link")
  return apiFetch<{ propertyType: string; permissionLevel: string }>(gscPath(websiteId), { method: "PUT", body: JSON.stringify({ integrationId, siteUrl }) })
}

export async function apiUnlinkSearchConsole(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.unlink")
  return apiFetch<null>(gscPath(websiteId), { method: "DELETE" })
}

export async function apiStartSearchConsoleSync(websiteId: string, range?: { from: string; to: string }) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.sync")
  return apiFetch<GscSyncJob>(`${gscPath(websiteId)}/sync`, { method: "POST", body: JSON.stringify(range ?? {}) }) as WithMeta<GscSyncJob, { deduplicated: boolean }>
}

export async function apiCancelSearchConsoleSync(websiteId: string, jobId: string) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.cancel")
  return apiFetch<GscSyncJob>(`${gscPath(websiteId)}/sync-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" })
}

export async function apiListSearchConsoleJobs(websiteId: string, cursor?: string | null) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.jobs")
  return apiFetch<GscSyncJob[]>(`${gscPath(websiteId)}/sync-jobs${queryString({ limit: 10, cursor })}`) as WithMeta<GscSyncJob[], CursorMeta>
}

export async function apiGetSearchPerformance(
  websiteId: string,
  params: { from: string; to: string; compareFrom?: string; compareTo?: string } & Partial<Record<SearchDimension, string>>,
) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.performance")
  return apiFetch<SearchPerformance>(`${gscPath(websiteId)}/performance${queryString(params)}`) as WithMeta<
    SearchPerformance,
    { source: string; siteUrl: string; searchType: string; firstIncompleteDate: string | null; lastSyncSuccessAt: string | null }
  >
}

export async function apiGetSearchTop(
  websiteId: string,
  dimension: SearchDimension,
  params: { from: string; to: string; sort?: string; order?: "asc" | "desc"; search?: string; cursor?: string | null; limit?: number },
) {
  if (IS_DEMO) throw new IntegrationRequired("gsc.top")
  return apiFetch<SearchTopRow[]>(`${gscPath(websiteId)}/top/${dimension}${queryString({ ...params, limit: params.limit ?? 25 })}`) as WithMeta<
    SearchTopRow[],
    CursorMeta & { coverage: { days: number; daysFetched: number; daysTruncated: number }; firstIncompleteDate: string | null }
  >
}

// ─── Keyword research ─────────────────────────────────────────────────────────

export type ResearchKind = "overview" | "ideas" | "related" | "organic" | "gap"
export type ResearchMetric = "search_volume" | "keyword_difficulty" | "cpc" | "competition" | "clicks" | "impressions" | "ctr" | "position"
export type ResearchIntent = "informational" | "navigational" | "commercial" | "transactional"

export interface ResearchProviderInfo {
  id: string
  name: string
  kind: "first_party" | "licensed"
  capabilities: string[]
  unsupported: string[]
  metrics: ResearchMetric[]
  metricScope: string
  targeting: { countries: string[] | "all"; languages: string[] | "all"; devices: string[] | "all"; note?: string }
  caching: { allowed: boolean; maxAgeMinutes: number }
  attribution: string
  costNote: string
  configured: boolean
  missingConfiguration: string[]
}

export interface ResearchCapabilities {
  providers: ResearchProviderInfo[]
  capabilities: string[]
  metrics: ResearchMetric[]
  limits: { maxResults: number; runsPerDay: number; maxCompetitors: number; maxOverviewKeywords: number }
}

export interface ResearchRun {
  id: string
  website_id: string
  kind: ResearchKind
  provider: string
  capability: string
  params: Record<string, unknown>
  status: "running" | "completed" | "partial" | "failed"
  result_count: number
  sample: boolean
  observed_through: string | null
  notes: string[]
  summary: {
    counts?: { shared: number; missing: number; unique: number }
    datasets?: Array<{ id: string; label: string; role: string; complete: boolean; observedAt: string | null; keywords: number }>
    unavailable?: Array<{ domain: string; reason: string }>
  }
  error_code: string | null
  error: string | null
  created_at: string
  finished_at: string | null
}

export interface ResearchResult {
  seq: number
  keyword_key: string
  keyword: string
  metrics: Partial<Record<ResearchMetric, number>>
  intent: ResearchIntent | null
  intent_rule: string | null
  gap_category: "shared" | "missing" | "unique" | null
  absence_from_sample: boolean | null
  competitors_present: number | null
  observations: Record<string, { position: number | null; clicks: number | null; impressions: number | null }> | null
}

export interface ResearchInsight {
  status: "completed" | "failed"
  model: string | null
  summary: string | null
  items: Array<{ keyword: string; keywordKey: string; priority: "high" | "medium" | "low"; rationale: string; intentNote: string | null; evidence: string[]; missingData: string[] }>
  error: string | null
  created_at: string
}

export interface KeywordListSummary {
  id: string
  name: string
  created_at: string
  items: number
}

type ResearchError = { code: string; message: string; details?: Record<string, unknown>; runId?: string }

export async function apiResearchCapabilities() {
  if (IS_DEMO) throw new IntegrationRequired("research.capabilities")
  return apiFetch<ResearchCapabilities>("/keyword-research/capabilities")
}

export async function apiRunResearch(kind: ResearchKind, body: Record<string, unknown>) {
  if (IS_DEMO) throw new IntegrationRequired("research.run")
  return apiFetch<{ run: ResearchRun; results: ResearchResult[] }>(`/keyword-research/${kind}`, { method: "POST", body: JSON.stringify(body) }) as Promise<
    Omit<ApiResponse<{ run: ResearchRun; results: ResearchResult[] }>, "error"> & { error: ResearchError | null; meta?: { reused: "cache" | "in_progress" | null; nextCursor: string | null } }
  >
}

export async function apiListResearchRuns(params: { websiteId?: string; kind?: ResearchKind; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("research.runs")
  return apiFetch<ResearchRun[]>(`/keyword-research/runs${queryString({ ...params, limit: params.limit ?? 10 })}`) as WithMeta<ResearchRun[], CursorMeta>
}

export async function apiGetResearchRun(
  runId: string,
  params: { sort?: string; order?: "asc" | "desc"; intent?: string; gap?: string; search?: string; cursor?: string | null; limit?: number } = {},
) {
  if (IS_DEMO) throw new IntegrationRequired("research.run.get")
  return apiFetch<{ run: ResearchRun; results: ResearchResult[]; insight: ResearchInsight | null }>(
    `/keyword-research/runs/${encodeURIComponent(runId)}${queryString({ ...params, limit: params.limit ?? 50 })}`,
  ) as WithMeta<{ run: ResearchRun; results: ResearchResult[]; insight: ResearchInsight | null }, CursorMeta & { provider: ResearchProviderInfo | null }>
}

export async function apiCompareResearchRuns(runId: string, otherId: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.compare")
  return apiFetch<{ older: { id: string; createdAt: string }; newer: { id: string; createdAt: string }; added: string[]; removed: string[]; changed: Array<{ key: string; changes: Record<string, { from: number | null; to: number | null }> }> }>(
    `/keyword-research/runs/${encodeURIComponent(runId)}/compare/${encodeURIComponent(otherId)}`,
  )
}

export async function apiResearchInsights(runId: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.insights")
  return apiFetch<ResearchInsight>(`/keyword-research/runs/${encodeURIComponent(runId)}/insights`, { method: "POST" })
}

/** CSV export: an authenticated download (the bearer token cannot ride on a plain link). */
export async function apiExportResearchCsv(runId: string): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("research.export")
  const res = await fetch(`${config.apiBaseUrl}/keyword-research/runs/${encodeURIComponent(runId)}/export`, { credentials: "include", headers: buildRequestHeaders(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export research results." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "keyword-research.csv" }
}

export async function apiListKeywordLists() {
  if (IS_DEMO) throw new IntegrationRequired("research.lists")
  return apiFetch<KeywordListSummary[]>("/keyword-research/lists")
}

export async function apiCreateKeywordList(name: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.lists.create")
  return apiFetch<KeywordListSummary>("/keyword-research/lists", { method: "POST", body: JSON.stringify({ name }) })
}

export async function apiAddToKeywordList(listId: string, runId: string, keywords: string[]) {
  if (IS_DEMO) throw new IntegrationRequired("research.lists.add")
  return apiFetch<{ added: number }>(`/keyword-research/lists/${encodeURIComponent(listId)}/items`, { method: "POST", body: JSON.stringify({ runId, keywords }) })
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export async function apiGetReport(scanId: string) {
  if (IS_DEMO) throw new IntegrationRequired("reports.get")
  return apiFetch(`/reports/${scanId}`)
}

// ─── Models ───────────────────────────────────────────────────────────────────

export async function apiListModels(params?: {
  freeOnly?: boolean
  eligibility?: string
}) {
  if (IS_DEMO) throw new IntegrationRequired("models.list")
  const qs = new URLSearchParams()
  if (params?.freeOnly) qs.set("freeOnly", "true")
  if (params?.eligibility) qs.set("eligibility", params.eligibility)
  const suffix = qs.toString() ? `?${qs}` : ""
  return apiFetch<RegistryModel[]>(`/models${suffix}`)
}

export async function apiGetModel(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.get")
  return apiFetch<RegistryModelDetail>(`/models/${id}`)
}

export async function apiRefreshCatalog() {
  if (IS_DEMO) throw new IntegrationRequired("models.catalog.refresh")
  return apiFetch(`/models/catalog/refresh`, { method: "POST" })
}

export async function apiGetCatalogStatus() {
  if (IS_DEMO) throw new IntegrationRequired("models.catalog.status")
  return apiFetch(`/models/catalog/status`)
}

export async function apiEnableModel(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.enable")
  return apiFetch(`/models/${id}/enable`, { method: "POST" })
}

export async function apiDisableModel(id: string, reason: string) {
  if (IS_DEMO) throw new IntegrationRequired("models.disable")
  return apiFetch(`/models/${id}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// ─── Model types (frontend) ───────────────────────────────────────────────────

export interface RegistryModel {
  id: string
  openrouter_id: string
  display_name: string
  provider: string
  context_length: number | null
  free_status: "FREE" | "PAID" | "UNKNOWN" | "CHANGED"
  status: string
  eligibility_status: string
  supports_tool_calling: boolean
  supports_structured_output: boolean
  supports_reasoning: boolean
  supports_coding: boolean
  supports_vision: boolean
  enabled: boolean
  first_seen_at: string
  last_seen_at: string
}

export interface RegistryModelDetail extends RegistryModel {
  description: string | null
  benchmarks: Array<{
    task_type: string
    score: number | null
    evaluation_status: string
    evaluated_at: string | null
  }>
  reliability: {
    total_requests: number
    successful_requests: number
    failed_requests: number
    avg_latency_ms: number | null
  } | null
  history: Array<{
    event_type: string
    old_value: unknown
    new_value: unknown
    reason: string | null
    created_at: string
  }>
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export type TaskType = "DISCOVERY" | "SEO_ANALYSIS" | "AEO_ANALYSIS" | "GEO_ANALYSIS" | "SECURITY_ANALYSIS" | "PERFORMANCE_ANALYSIS" | "ACCESSIBILITY_ANALYSIS" | "QA_ANALYSIS" | "SSL_ANALYSIS" | "REMEDIATION" | "CODE_GENERATION" | "REPORT_SYNTHESIS" | "EVIDENCE_SUMMARIZATION" | "STRUCTURED_EXTRACTION"

export type ModelCapability = "REASONING" | "CODING" | "VISION" | "TOOL_CALLING" | "STRUCTURED_OUTPUT" | "LONG_CONTEXT" | "SEO" | "SECURITY" | "ACCESSIBILITY" | "PERFORMANCE"

export interface RoutingRequirements {
  taskType: TaskType
  complexity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  requiredCapabilities: ModelCapability[]
  preferredCapabilities: ModelCapability[]
  structuredOutputRequired: boolean
  toolCallingRequired: boolean
  visionRequired: boolean
  freeOnly?: boolean
  minimumContextLength?: number
  minimumReliability?: number
  excludedModels?: string[]
}

export interface RoutingDecisionSummary {
  id: string
  taskType: string
  complexity: string
  riskLevel: string
  selectedOpenrouterId: string | null
  decisionConfidence: number | null
  decisionSource: string
  candidateCount: number
  excludedCount: number
  status: string
  createdAt: string
}

export interface RoutingPolicy {
  id: string
  orgId: string | null
  version: number
  freeOnly: boolean
  minReliability: number
  minQuality: number
  maxAttempts: number
  requireCrossModelVerification: boolean
  allowedProviders: string[] | null
  excludedModels: string[] | null
  weights: {
    benchmark: number
    reliability: number
    capability: number
    historical: number
    structuredOutput: number
    latency: number
    context: number
    preference: number
  }
  description: string | null
  isActive: boolean
}

export async function apiSimulateRouting(requirements: RoutingRequirements) {
  if (IS_DEMO) throw new IntegrationRequired("routing.simulate")
  return apiFetch<unknown>("/routing/simulate", {
    method: "POST",
    body: JSON.stringify(requirements),
  })
}

export async function apiGetRoutingDecisions(limit?: number) {
  if (IS_DEMO) throw new IntegrationRequired("routing.decisions")
  const qs = limit ? `?limit=${limit}` : ""
  return apiFetch<RoutingDecisionSummary[]>(`/routing/decisions${qs}`)
}

export async function apiGetRoutingDecision(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("routing.decisions.get")
  return apiFetch<unknown>(`/routing/decisions/${id}`)
}

export async function apiGetRoutingPolicy() {
  if (IS_DEMO) throw new IntegrationRequired("routing.policy")
  return apiFetch<RoutingPolicy>("/routing/policy")
}

// ─── Specialist Agents ────────────────────────────────────────────────────────

export type AgentType = "DISCOVERY" | "SEO_ANALYSIS" | "AEO_ANALYSIS" | "GEO_ANALYSIS" | "SECURITY_ANALYSIS" | "PERFORMANCE_ANALYSIS" | "ACCESSIBILITY_ANALYSIS" | "QA_ANALYSIS" | "SSL_ANALYSIS" | "REMEDIATION" | "REPORT_SYNTHESIS"

export type AgentStatus = "ACTIVE" | "DISABLED" | "DEPRECATED" | "REQUIRES_REVIEW"
export type AgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
export type PermissionLevel = "READ" | "ANALYZE" | "GENERATE" | "PROPOSE" | "EXECUTE"

export interface AgentTool {
  name: string
  permissionLevel: PermissionLevel
  description: string
}

export interface AgentDependency {
  agentType: AgentType
  dependencyType: "REQUIRED" | "OPTIONAL"
}

export interface AgentView {
  agentType: AgentType
  name: string
  description: string
  version: string
  status: AgentStatus
  riskLevel: AgentRiskLevel
  capabilities: string[]
  allowedTools: AgentTool[]
  dependencies: AgentDependency[]
  producesFindings: boolean
  enabled: boolean
  dbId?: string
  dbUpdatedAt?: string
}

export async function apiListAgents() {
  if (IS_DEMO) throw new IntegrationRequired("agents.list")
  return apiFetch<AgentView[]>("/agents")
}

export async function apiGetAgent(agentType: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.get")
  return apiFetch<AgentView & {
    versions: unknown[]
    instructionProfileSummary: string
  }>(`/agents/${agentType}`)
}

export async function apiEnableAgent(agentType: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.enable")
  return apiFetch(`/agents/${agentType}/enable`, { method: "POST" })
}

export async function apiDisableAgent(agentType: string, reason: string) {
  if (IS_DEMO) throw new IntegrationRequired("agents.disable")
  return apiFetch(`/agents/${agentType}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export async function apiSimulateAgent(params: {
  agentType: AgentType
  riskLevel?: AgentRiskLevel
  evidenceReferences?: string[]
  context?: Record<string, unknown>
  satisfiedDependencies?: string[]
}) {
  if (IS_DEMO) throw new IntegrationRequired("agents.simulate")
  return apiFetch<unknown>("/agents/simulate", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

// ─── Instruction Intelligence ───────────────────────────────────────────────

export interface InstructionProfileView {
  instructionProfileId: string
  agentId: AgentType
  agentVersion: string
  version: string
  status: "ACTIVE" | "DEPRECATED" | "ARCHIVED"
  instructions: Array<{
    id: string
    type: string
    text: string
    mandatory: boolean
    source: string
    version: string
  }>
  requiredContext: string[]
  outputRequirements: Record<string, unknown>
  validationRules: string[]
}

export async function apiListInstructionProfiles() {
  if (IS_DEMO) throw new IntegrationRequired("instructions.list")
  return apiFetch<InstructionProfileView[]>("/ai/instructions")
}

export async function apiSimulateInstructions(params: {
  agentType: AgentType
  taskId: string
  riskLevel: AgentRiskLevel
  context?: Record<string, unknown>
  evidenceReferences?: string[]
  previousFailure?: string
}) {
  if (IS_DEMO) throw new IntegrationRequired("instructions.simulate")
  return apiFetch<unknown>("/ai/instructions/simulate", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function apiGetTaskEvidence(taskId: string) {
  if (IS_DEMO) throw new IntegrationRequired("evidence.list")
  return apiFetch<Array<{
    id: string
    evidence_type: string
    source_type: string
    resource_reference: string | null
    observed_at: string
    freshness_status: string
    status: string
    content_hash: string
  }>>(`/ai/tasks/${encodeURIComponent(taskId)}/evidence`)
}

export async function apiGetTaskQuality(taskId: string) {
  if (IS_DEMO) throw new IntegrationRequired("quality.list")
  return apiFetch<unknown[]>(`/ai/tasks/${encodeURIComponent(taskId)}/quality`)
}

// ─── Platform Infrastructure (Administration > Infrastructure) ────────────────
// Backend: server/src/routes/infrastructure.ts. Platform-admin only. Responses
// never contain secrets; configuration is reported as SET / NOT_SET / MASKED.

export type InfraConnectionStatus =
  | "connected"
  | "not_configured"
  | "not_verified"
  | "configuration_error"
  | "authentication_failed"
  | "tls_error"
  | "timeout"
  | "unavailable"

export interface InfraDiagnosticStep {
  id: string
  label: string
  status: "ok" | "failed" | "skipped" | "warning"
  detail?: string
}

export interface InfraDiagnosticResult {
  status: InfraConnectionStatus
  summary: string
  steps: InfraDiagnosticStep[]
  latencyMs: number | null
  checkedAt: string
}

export interface InfraStatus {
  checkedAt: string
  postgres: {
    configured: boolean
    provider: "neon" | "supabase" | "postgresql" | "unknown"
    region: string | null
    database: string | null
    role: string | null
    pooled: boolean | null
    branch: string | null
    sslMode: string | null
    sslEnforced: boolean
    certificateVerification: boolean
    status: InfraConnectionStatus
    lastTest: InfraDiagnosticResult | null
  }
  clickhouse: {
    configured: boolean
    provider: "clickhouse_cloud" | "clickhouse" | "unknown"
    region: string | null
    protocol: "https"
    port: number
    user: string
    database: string | null
    tls: boolean
    certificateVerification: boolean
    customCa: boolean
    status: InfraConnectionStatus
    lastTest: InfraDiagnosticResult | null
  }
  core: { status: "operational" | "unavailable" }
  analytics: { status: "available" | "unavailable" }
}

export interface InfraConfigEntry {
  name: string
  state: "SET" | "NOT_SET" | "MASKED"
  secret: boolean
  required: boolean
  value?: string
}

export interface InfraMigrations {
  postgres: {
    available: boolean
    reason?: string
    latestOnDisk: string | null
    currentVersion: string | null
    applied: number
    pending: string[]
    checksumMismatches: string[]
    unknownApplied: string[]
    status: "up_to_date" | "pending" | "failed" | "unavailable"
    lastAppliedAt: string | null
  }
  clickhouse: { status: "applied" | "pending" | "unreachable" | "not_configured"; tables: string[]; missing?: string[]; implemented: boolean }
}

export interface InfraEventPipeline {
  implemented: boolean
  queued: number | null
  processed: number | null
  failed: number | null
  lastSuccessAt: string | null
  ingestionLatencyMs: number | null
  enabled?: boolean
  dropped?: number
  capacity?: number
  lastErrorAt?: string | null
  lastErrorKind?: string | null
  retryingUntil?: string | null
}

export async function apiGetInfraStatus() {
  return apiFetch<InfraStatus>("/infrastructure/status")
}

export async function apiGetInfraConfiguration() {
  return apiFetch<{ postgres: InfraConfigEntry[]; clickhouse: InfraConfigEntry[] }>("/infrastructure/configuration")
}

export async function apiTestPostgres() {
  return apiFetch<InfraDiagnosticResult>("/infrastructure/postgres/test", { method: "POST" })
}

export async function apiTestClickHouse(mode: "connection" | "query" = "connection") {
  return apiFetch<InfraDiagnosticResult>(`/infrastructure/clickhouse/test?mode=${mode}`, { method: "POST" })
}

export async function apiGetInfraMigrations() {
  return apiFetch<InfraMigrations>("/infrastructure/migrations")
}

export async function apiGetEventPipeline() {
  return apiFetch<InfraEventPipeline>("/infrastructure/event-pipeline")
}

// ─── Analytics (org-scoped; the backend derives organization from x-org-id) ──

export interface AnalyticsFilters {
  days?: number
  provider?: string
  model?: string
  agent?: string
  websiteId?: string
  severity?: string
  module?: string
}

export interface AiAggregate {
  executions: number
  completed: number
  failed: number
  failureRate: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  costUsd: number | null
}
export interface KeyCount { key: string; count: number; label?: string }

export interface AiAnalytics {
  source: string
  totals: AiAggregate
  daily: (AiAggregate & { date: string })[]
  byProvider: (AiAggregate & { key: string })[]
  byModel: (AiAggregate & { key: string })[]
  byAgent: (AiAggregate & { key: string })[]
  pricingNote: string
}
export interface RoutingAnalytics {
  source: string
  totals: { decisions: number; resolved: number; fallbacks: number; fallbackRate: number | null; avgDecisionMs: number | null }
  models: { model: string; decisions: number; fallbacks: number; executions: number; successRate: number | null; avgLatencyMs: number | null; tokens: number; costUsd: number | null }[]
}
export interface ScanAnalytics {
  source: string
  counts: { today: number; week: number; month: number; failedMonth: number }
  daily: { date: string; scans: number; failed: number }[]
  findingsBySeverity: KeyCount[]
  findingsByCategory: KeyCount[]
  findingsByModule: KeyCount[]
  findingsByWebsite: KeyCount[]
}
export interface MonitoringAnalytics {
  source: string
  runs: number
  completed: number
  failed: number
  availability: number | null
  failureRate: number | null
  sslScore: number | null
  responseTimeMs: number | null
  dnsHealth: number | null
  httpHealth: number | null
  daily: { date: string; completed: number; failed: number }[]
  incidentsBySeverity: { key: string; count: number; open: number }[]
  openIncidents: number
}
export interface OverviewAnalytics {
  source: string
  days: number
  scans: ScanAnalytics["counts"]
  scanDaily: ScanAnalytics["daily"]
  findingsBySeverity: KeyCount[]
  ai: AiAggregate
  aiDaily: { date: string; executions: number; failed: number; totalTokens: number }[]
  monitoring: { availability: number | null; runs: number; openIncidents: number }
}

function analyticsQuery(f: AnalyticsFilters): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ""
}
export const apiGetAnalyticsOverview = (f: AnalyticsFilters = {}) => apiFetch<OverviewAnalytics>(`/analytics/overview${analyticsQuery(f)}`)
export const apiGetAnalyticsAi = (f: AnalyticsFilters = {}) => apiFetch<AiAnalytics>(`/analytics/ai${analyticsQuery(f)}`)
export const apiGetAnalyticsRouting = (f: AnalyticsFilters = {}) => apiFetch<RoutingAnalytics>(`/analytics/routing${analyticsQuery(f)}`)
export const apiGetAnalyticsScans = (f: AnalyticsFilters = {}) => apiFetch<ScanAnalytics>(`/analytics/scans${analyticsQuery(f)}`)
export const apiGetAnalyticsMonitoring = (f: AnalyticsFilters = {}) => apiFetch<MonitoringAnalytics>(`/analytics/monitoring${analyticsQuery(f)}`)

// ─── Admin Control Center (platform administrators; /api/v1/admin) ────────────
// The backend enforces platform-admin access on every call and never returns
// a stored secret; these types carry status only.

export type AdminCheckStatus = "valid" | "invalid" | "permission_denied" | "quota_exceeded" | "rate_limited" | "unavailable" | "timeout" | "not_configured" | "error"

export interface AdminCheckResult {
  status: AdminCheckStatus
  message: string
  details: Record<string, unknown>
}

export interface AdminIntegration {
  id: string
  name: string
  purpose: string
  management: "admin" | "deployment" | "oauth" | "unsupported"
  docsUrl: string | null
  setup: string
  envVars: Array<{ name: string; set: boolean }>
  capabilities: string[]
  configured: boolean
  canTest: boolean
  featureEnabled: boolean
  credential: null | {
    source: "admin" | "environment" | null
    stored: boolean
    suffix: string | null
    enabled: boolean
    validatedAt: string | null
    status: string | null
    error: string | null
    updatedAt: string | null
    decryptError: string | null
    envFallback: boolean
  }
  lastCheck: null | { status: AdminCheckStatus; message: string | null; checkedAt: string; trigger: string }
  lastSuccessAt: string | null
  details: Record<string, unknown>
}

export interface AdminUser {
  id: string
  email: string
  full_name: string | null
  active: boolean
  created_at: string
  last_login_at: string | null
  active_sessions: number
  isPlatformAdmin: boolean
  memberships: Array<{ orgId: string; orgName: string; role: "owner" | "admin" | "member" | "viewer" }>
}

export interface AdminFailedJob {
  kind: "scan" | "gsc_sync" | "monitoring_run" | "notification" | "analytics_outbox"
  id: string
  orgId: string | null
  at: string
  error: string | null
  retryable: boolean
  retryNote: string
}

export interface AdminDiagnostics {
  generatedAt: string
  process: { uptimeSeconds: number; node: string; environment: string; memoryRssMb: number }
  database: { status: "ok" | "failed"; latencyMs: number; error?: string }
  migrations: { status: string; currentVersion?: string | null; latestOnDisk?: string | null; pending?: string[]; checksumMismatches?: string[]; error?: string }
  worker: { running: boolean; startedAt: string | null; lastTickAt: string | null; status: string; lastError: null | { errorClass: string; at: string | null } }
  jobs: Record<string, unknown>
  failedJobs: AdminFailedJob[]
  integrations: Array<{ id: string; name: string; management: string; configured: boolean; featureEnabled: boolean; lastCheck: AdminIntegration["lastCheck"]; lastSuccessAt: string | null }>
  serverErrors: { errors: Array<{ at: string; requestId: string; method: string; route: string; statusCode: number; errorClass: string }>; totalSinceStart: number; capacity: number }
  configurationWarnings: Array<{ severity: "warning" | "info"; message: string }>
  adminEvents: Array<{ timestamp: string; action: string; result: string; user_id: string | null; resource_type: string | null; request_id: string | null }>
}

const adminJson = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export async function apiAdminIntegrations() {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations")
  return apiFetch<AdminIntegration[]>("/admin/integrations")
}

export async function apiAdminSaveCredential(provider: string, secret: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations.save")
  return apiFetch<{ result: AdminCheckResult; integration: AdminIntegration }>(`/admin/integrations/${encodeURIComponent(provider)}/credential`, adminJson("PUT", { secret }))
}

export async function apiAdminTestIntegration(provider: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations.test")
  return apiFetch<{ result: AdminCheckResult; integration: AdminIntegration }>(`/admin/integrations/${encodeURIComponent(provider)}/test`, adminJson("POST"))
}

export async function apiAdminSetIntegrationEnabled(provider: string, enabled: boolean) {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations.toggle")
  return apiFetch<AdminIntegration>(`/admin/integrations/${encodeURIComponent(provider)}/${enabled ? "enable" : "disable"}`, adminJson("POST"))
}

export async function apiAdminRemoveCredential(provider: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations.remove")
  return apiFetch<{ removed: boolean; integration: AdminIntegration }>(`/admin/integrations/${encodeURIComponent(provider)}/credential`, adminJson("DELETE", { confirm: true }))
}

export async function apiAdminReencryptCredentials() {
  if (IS_DEMO) throw new IntegrationRequired("admin.integrations.reencrypt")
  return apiFetch<{ reencrypted: number; alreadyCurrent: number; failed: number }>("/admin/integrations/encryption/reencrypt", adminJson("POST", { confirm: true }))
}

export async function apiAdminUsers(params: { search?: string; status?: "active" | "inactive"; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("admin.users")
  return apiFetch<AdminUser[]>(`/admin/users${queryString({ ...params, limit: params.limit ?? 25 })}`) as WithMeta<AdminUser[], CursorMeta>
}

export async function apiAdminUser(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.user")
  return apiFetch<{ user: AdminUser; events: Array<{ timestamp: string; action: string; result: string; byUser: "self" | "admin" | null; request_id: string | null }> }>(`/admin/users/${encodeURIComponent(id)}`)
}

export async function apiAdminSetUserActive(id: string, active: boolean) {
  if (IS_DEMO) throw new IntegrationRequired("admin.user.active")
  return apiFetch<{ revokedSessions: number }>(`/admin/users/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`, adminJson("POST", { confirm: true }))
}

export async function apiAdminRevokeSessions(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.user.sessions")
  return apiFetch<{ revokedSessions: number }>(`/admin/users/${encodeURIComponent(id)}/revoke-sessions`, adminJson("POST", { confirm: true }))
}

export async function apiAdminChangeRole(id: string, orgId: string, role: AdminUser["memberships"][number]["role"]) {
  if (IS_DEMO) throw new IntegrationRequired("admin.user.role")
  return apiFetch<{ from: string; to: string }>(`/admin/users/${encodeURIComponent(id)}/memberships/${encodeURIComponent(orgId)}`, adminJson("PATCH", { role, confirm: true }))
}

export async function apiAdminSendPasswordReset(id: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.user.reset")
  return apiFetch<{ sent: boolean }>(`/admin/users/${encodeURIComponent(id)}/password-reset`, adminJson("POST", { confirm: true }))
}

export async function apiAdminCredentialAccount() {
  if (IS_DEMO) throw new IntegrationRequired("admin.credentials.status")
  return apiFetch<{ email: string; exists: boolean; active: boolean | null; lastLoginAt: string | null }>("/admin/account-credentials")
}

/** The generated password is in this response only; never store it in the browser. */
export async function apiAdminGenerateCredentials(email: string, confirmReset: boolean) {
  if (IS_DEMO) throw new IntegrationRequired("admin.credentials.generate")
  return apiFetch<{ email: string; password: string; created: boolean; accountActive: boolean; revokedSessions: number }>("/admin/account-credentials", adminJson("POST", { email, confirmReset }))
}

export async function apiAdminDiagnostics() {
  if (IS_DEMO) throw new IntegrationRequired("admin.diagnostics")
  return apiFetch<AdminDiagnostics>("/admin/diagnostics")
}

export async function apiAdminRetryJob(kind: "gsc_sync" | "analytics_outbox", id: string) {
  if (IS_DEMO) throw new IntegrationRequired("admin.diagnostics.retry")
  return apiFetch<{ kind: string; result: Record<string, unknown> }>(`/admin/diagnostics/jobs/${kind}/${encodeURIComponent(id)}/retry`, adminJson("POST"))
}

/** Redacted diagnostic report as a file (authenticated download). */
export async function apiAdminExportDiagnostics(): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("admin.diagnostics.export")
  const res = await fetch(`${config.apiBaseUrl}/admin/diagnostics/export`, { credentials: "include", headers: buildRequestHeaders(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "zigmaneural-diagnostics.json" }
}

export async function apiAdminAudit(limit = 50) {
  if (IS_DEMO) throw new IntegrationRequired("admin.audit")
  return apiFetch<Array<{ timestamp: string; action: string; result: string; resource_type: string | null; resource_id: string | null; org_id: string | null; request_id: string | null; metadata: Record<string, unknown> | null; actor_email: string | null }>>(`/admin/audit${queryString({ limit })}`)
}

export async function apiRequestPasswordReset(email: string) {
  if (IS_DEMO) throw new IntegrationRequired("auth.reset.request")
  return apiFetch<{ message: string }>("/auth/password-reset/request", adminJson("POST", { email }))
}

export async function apiConfirmPasswordReset(token: string, password: string) {
  if (IS_DEMO) throw new IntegrationRequired("auth.reset.confirm")
  return apiFetch<{ message: string }>("/auth/password-reset/confirm", adminJson("POST", { token, password }))
}
