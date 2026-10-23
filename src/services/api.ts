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
import { setSelectedWebsiteId } from "../lib/selectedWebsite"
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

const RETURN_TO_KEY = "zn_return_to"

/**
 * Ends the session in this tab: the access token, the active organization and
 * the selected website, so nothing scoped to the previous user or tenant is
 * reused by the next sign-in. (The refresh cookie is cleared by /auth/logout.)
 */
export function clearSession(): void {
  clearToken()
  getSessionStorage()?.removeItem(RETURN_TO_KEY)
  setSelectedWebsiteId(null)
}

/** A same-app path to return to after signing in (not a secret; never an absolute URL). */
function safeReturnPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/login") || path.startsWith("/reset-password")) return null
  return path
}

export function rememberReturnPath(path: string): void {
  const safe = safeReturnPath(path)
  if (safe && safe !== "/") getSessionStorage()?.setItem(RETURN_TO_KEY, safe)
}

/** Reads and forgets the remembered path. */
export function takeReturnPath(): string | null {
  const storage = getSessionStorage()
  const path = safeReturnPath(storage?.getItem(RETURN_TO_KEY))
  storage?.removeItem(RETURN_TO_KEY)
  return path
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

const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 120_000

type FetchOptions = RequestInit & { timeoutMs?: number }

let ambientSignal: AbortSignal | undefined

/**
 * Runs `start` so that the requests it starts synchronously (every API
 * function issues its request before its first await) are cancelled when
 * `signal` aborts. Pages use it through useApiQuery, so a superseded request
 * is aborted on the network, not just ignored.
 */
export function withSignal<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  const previous = ambientSignal
  ambientSignal = signal
  try {
    return start()
  } finally {
    ambientSignal = previous
  }
}

const isAuthPath = (path: string) =>
  path.startsWith("/auth/login") || path.startsWith("/auth/register") || path.startsWith("/auth/refresh")

/**
 * Every API request goes through here: bearer token and organization header,
 * a timeout, caller cancellation, and one shared token refresh on 401. A 401
 * that survives the refresh ends the session (remembering where the user was).
 * Mutations are never retried except that single replay after a successful
 * refresh: a 401 is returned before any handler runs, so nothing was applied.
 */
async function authorizedFetch(path: string, options: FetchOptions = {}): Promise<Response> {
  if (IS_DEMO || !config.apiBaseUrl) {
    throw new IntegrationRequired(path)
  }
  const url = `${config.apiBaseUrl}${path}`
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: explicitSignal, ...init } = options
  const callerSignal = explicitSignal ?? ambientSignal
  const method = (init.method ?? "GET").toUpperCase()

  const send = async (): Promise<Response> => {
    const token = getToken()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    if (callerSignal?.aborted) controller.abort()
    else callerSignal?.addEventListener("abort", onAbort, { once: true })
    try {
      const headers = buildRequestHeaders({
        ...(init.body && !(typeof FormData !== "undefined" && init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      })
      // Caller headers may be a plain object, an array or a Headers instance.
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
      return await fetch(url, { ...init, signal: controller.signal, credentials: "include", headers })
    } catch {
      if (callerSignal?.aborted) throw new ApiCallError(0, "ABORTED", "The request was cancelled.")
      if (timedOut) {
        throw new ApiCallError(0, "TIMEOUT", method === "GET"
          ? "The server did not respond in time. Try again."
          : "The server did not respond in time. The change may still have been saved: refresh before trying again.")
      }
      throw new ApiCallError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again.")
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onAbort)
    }
  }

  let res = await send()
  if (res.status === 401 && !isAuthPath(path)) {
    const outcome = await tryRefreshToken()
    if (outcome === "unreachable") {
      throw new ApiCallError(0, "NETWORK_ERROR", "Could not renew your session because the server is unreachable. Check your connection and try again.")
    }
    if (outcome === "renewed") res = await send()
    if (res.status === 401) endSession()
  }
  return res
}

/** The session cannot be renewed: clear tenant-scoped state and go to sign-in, remembering the page. */
function endSession(): void {
  const here = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : ""
  // Several requests can fail at once: only the first one, made from the page
  // the user was on, decides where to return; later ones keep that choice.
  const alreadyEnded = here.startsWith("/login")
  const keep = alreadyEnded ? getSessionStorage()?.getItem(RETURN_TO_KEY) ?? null : null
  clearSession()
  if (keep) getSessionStorage()?.setItem(RETURN_TO_KEY, keep)
  else rememberReturnPath(here)
  if (typeof window !== "undefined" && !alreadyEnded) window.location.hash = "/login"
}

const isAbort = (e: unknown) => e instanceof ApiCallError && e.code === "ABORTED"
export { isAbort as isAbortedRequest }

async function apiFetch<T>(
  path: string,
  options: FetchOptions = {},
): Promise<ApiResponse<T>> {
  const res = await authorizedFetch(path, options)
  const requestId = res.headers.get("x-request-id") ?? undefined

  if (res.status === 401 && !isAuthPath(path)) {
    return {
      data: null,
      error: { code: "UNAUTHORIZED", message: "Session expired. Please sign in.", status: 401, requestId },
    }
  }

  if (!res.ok) {
    let errorBody: { error?: { code?: string; message?: string; details?: unknown } } = {}
    try {
      errorBody = await res.json()
    } catch {
      // Non-JSON error body (proxy/gateway page): fall back to the HTTP status.
    }
    const fallback =
      res.status === 429 ? "Too many requests. Wait a moment and try again."
      : res.status >= 500 ? `The server could not complete the request (HTTP ${res.status}). Try again later.`
      : res.statusText || `Request failed (HTTP ${res.status})`
    return {
      data: null,
      error: {
        code: errorBody.error?.code ?? String(res.status),
        message:
          errorBody.error?.code === "PLATFORM_ADMIN_REQUIRED"
            ? "This changes platform-wide settings (shared by all organizations) and needs a platform administrator. Organization owners and admins cannot do this."
            : errorBody.error?.message ?? fallback,
        status: res.status,
        requestId,
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
      error: { code: "PARSE_ERROR", message: "The server returned an unreadable response.", status: res.status, requestId },
    }
  }
  if (body && typeof body === "object" && "data" in body) {
    return body.meta
      ? { data: body.data as T, error: null, meta: body.meta }
      : { data: body.data as T, error: null }
  }
  return { data: body as unknown as T, error: null }
}

/**
 * Authenticated file download (a bearer token cannot ride on a plain link).
 * Same refresh and session handling as apiFetch; a transport failure becomes a
 * readable error response so every download reports it instead of throwing.
 */
async function downloadResponse(path: string): Promise<Response> {
  try {
    return await authorizedFetch(path, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
  } catch (e) {
    if (e instanceof IntegrationRequired) throw e
    const message = e instanceof Error ? e.message : "The download failed."
    return new Response(JSON.stringify({ error: { message } }), { status: 503, statusText: message, headers: { "content-type": "application/json" } })
  }
}

type RefreshOutcome = "renewed" | "rejected" | "unreachable"
const REFRESH_TIMEOUT_MS = 15_000
let refreshInFlight: Promise<RefreshOutcome> | null = null

function tryRefreshToken(): Promise<RefreshOutcome> {
  // Refresh tokens are single-use: concurrent 401s must share one refresh call.
  if (!refreshInFlight) {
    refreshInFlight = doRefreshToken().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/**
 * "rejected": the server refused the refresh cookie, so the session is over.
 * "unreachable": network failure, timeout or a 5xx; the session may still be
 * valid, so the caller reports a connection error instead of signing out.
 */
async function doRefreshToken(): Promise<RefreshOutcome> {
  const first = await refreshOnce()
  // Another tab rotated the shared refresh cookie a moment ago: the browser now
  // holds the new one, so one short retry renews this tab's session too.
  if (first === "rotated") {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await refreshOnce()
    return second === "rotated" ? "rejected" : second
  }
  return first
}

async function refreshOnce(): Promise<RefreshOutcome | "rotated"> {
  if (!config.apiBaseUrl) return "rejected"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  try {
    const res = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
    if (res.status >= 500) return "unreachable"
    if (res.status === 401) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      if (body?.error?.code === "REFRESH_TOKEN_ROTATED") return "rotated"
    }
    if (!res.ok) return "rejected"
    const body: { data?: { token?: string } } = await res.json()
    if (body.data?.token) {
      setToken(body.data.token)
      return "renewed"
    }
    return "rejected"
  } catch {
    return "unreachable"
  } finally {
    clearTimeout(timer)
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
    // Best effort: the server clears the refresh cookie; the tab is signed out either way.
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {})
  }
  clearSession()
}

export async function apiGetMe(): Promise<ApiResponse<{
  id: string
  email: string
  orgIds: string[]
  isPlatformAdmin?: boolean
  /** The caller's roles; the server enforces them on every write. */
  memberships?: Array<{ orgId: string; role: "owner" | "admin" | "member" | "viewer" }>
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

export interface MonitoringAlertRule {
  id: string
  monitoring_id: string
  rule_type: string
  enabled: boolean
  threshold: number | null
}

export async function apiListMonitoringRules(id: string) {
  return apiFetch<MonitoringAlertRule[]>(`/monitoring/${encodeURIComponent(id)}/rules`)
}
export async function apiGetAlert(id: string) {
  return apiFetch<MonitoringAlert>(
    `/monitoring/alert/${encodeURIComponent(id)}`,
  )
}
export async function apiAcknowledgeAlert(id: string) {
  return apiFetch<{ updated: boolean }>(`/monitoring/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
  })
}
export async function apiResolveAlert(id: string) {
  return apiFetch<{ updated: boolean }>(`/monitoring/alerts/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
  })
}
export async function apiDismissAlert(id: string) {
  return apiFetch<{ updated: boolean }>(`/monitoring/alerts/${encodeURIComponent(id)}/dismiss`, {
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
) {
  if (IS_DEMO) throw new IntegrationRequired("websites.add")
  return apiFetch("/websites", {
    method: "POST",
    body: JSON.stringify({ url, verificationMethod }),
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
  const res = await downloadResponse(`/keyword-research/runs/${encodeURIComponent(runId)}/export`)
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

export interface KeywordListDetail {
  id: string
  name: string
  created_at: string
  items: Array<{ keyword_key: string; keyword: string; source_run_id: string | null; added_at: string }>
}

export async function apiGetKeywordList(listId: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.lists.get")
  return apiFetch<KeywordListDetail>(`/keyword-research/lists/${encodeURIComponent(listId)}`)
}

export async function apiRemoveKeywordListItem(listId: string, keyword: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.lists.remove")
  return apiFetch<null>(`/keyword-research/lists/${encodeURIComponent(listId)}/items${queryString({ keyword })}`, { method: "DELETE" })
}

export async function apiDeleteKeywordList(listId: string) {
  if (IS_DEMO) throw new IntegrationRequired("research.lists.delete")
  return apiFetch<null>(`/keyword-research/lists/${encodeURIComponent(listId)}`, { method: "DELETE" })
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
  const res = await downloadResponse(`/admin/diagnostics/export`)
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

// ─── Backlink intelligence (/websites/:id/backlinks) ─────────────────────────
// Imported datasets and our own live checks only; no estimated metrics.

export type BacklinkLinkType = "follow" | "nofollow" | "sponsored" | "ugc"
export type BacklinkLinkState = "verified_live" | "lost_verified" | "provider_reported_lost" | "verification_missing_once" | "unverified_check_failed" | "unverified"
export type BacklinkChangeType = "new" | "lost" | "potentially_lost" | "anchor_changed" | "target_changed" | "attributes_changed"

export interface BacklinkSource {
  id: string
  name: string
  kind: "import" | "first_party" | "licensed" | "verification"
  status: "available" | "not_configured" | "not_supported"
  capabilities: string[]
  explanation: string
  setup: string | null
  costNote: string
}

export interface BacklinkDataset {
  id: string
  website_id: string
  subject_kind: "own" | "competitor"
  subject_domain: string
  source: string
  source_label: string
  coverage: "complete" | "partial" | "unknown"
  exported_at: string | null
  retrieved_at: string
  observed_from: string | null
  observed_to: string | null
  filename: string | null
  rows_total: number
  rows_accepted: number
  rows_rejected: number
  rows_duplicate: number
  rows_skipped: number
  rejected_samples: Array<{ row: number; reason: string }>
  column_mapping: Record<string, string>
  referring_domains: number
  created_at: string
  stale: boolean
}

export interface BacklinkSummary {
  siteDomain: string
  own: null | { dataset: BacklinkDataset; links: number; referringDomains: number; linkTypes: Record<string, number>; states: Partial<Record<BacklinkLinkState, number>> }
  competitors: Array<{ dataset: BacklinkDataset }>
  changesLast90Days: Partial<Record<BacklinkChangeType, number>>
  latestVerification: null | { id: string; status: string; links_total: number; links_checked: number; created_at: string; finished_at: string | null; error: string | null }
  staleAfterDays: number
}

export interface BacklinkLink {
  id: string
  source_url: string
  source_domain: string
  target_url: string | null
  anchor: string | null
  link_type: BacklinkLinkType | null
  first_seen: string | null
  last_seen: string | null
  provider_lost: boolean | null
  state: BacklinkLinkState
  checked_at: string | null
  check_outcome: string | null
  check_http_status: number | null
  observed_link_type: BacklinkLinkType | null
  observed_anchor: string | null
}

export interface BacklinkReferringDomain {
  source_domain: string
  links: number
  follow: number
  not_followed: number
  attributes_unknown: number
  first_seen: string | null
  last_seen: string | null
  verified_live: number
}

export interface BacklinkChange {
  id: string
  change_type: BacklinkChangeType
  source_url: string
  target_url: string | null
  evidence: string
  details: Record<string, unknown>
  detected_at: string
}

export interface BacklinkDatasetBrief {
  id: string
  subject: string
  sourceLabel: string
  coverage: string
  exportedAt: string | null
  retrievedAt: string
  observedFrom: string | null
  observedTo: string | null
  links: number
  stale: boolean
}

export interface BacklinkGap {
  datasets: BacklinkDatasetBrief[]
  missingCompetitors: string[]
  warnings: string[]
  counts: { shared: number; competitor_only: number; own_only: number }
  rows: Array<{ domain: string; category: "shared" | "competitor_only" | "own_only"; competitors: string[] }>
  total: number
  sharedAnchors: Array<{ anchor: string; own: number; competitors: number }>
}

export interface BacklinkSignal {
  id: string
  weight: number
  value: number | null
  explanation: string
}

export interface BacklinkOpportunity {
  domain: string
  kind: "competitor_only" | "reclaim"
  competitors: string[]
  links: number
  sampleUrls: string[]
  score: number
  basis: number
  signals: BacklinkSignal[]
  why: string
}

export interface BacklinkOpportunities {
  datasets: BacklinkDatasetBrief[]
  missingCompetitors: string[]
  warnings: string[]
  topics: { terms: string[]; source: "input" | "search_console" | null }
  total: number
  opportunities: BacklinkOpportunity[]
}

export interface BacklinkImportPreview {
  subjectDomain: string
  delimiter: string
  columns: Record<string, string>
  unmappedColumns: string[]
  missingRequired: string[]
  rowLimitExceeded: boolean
  rows: { total: number; accepted: number; rejected: number; duplicate: number; skipped: number }
  rejectedSamples: Array<{ row: number; reason: string }>
  warnings: string[]
  observed: { from: string | null; to: string | null }
  sample: Array<{ sourceUrl: string; targetUrl: string | null; anchor: string | null; linkType: BacklinkLinkType | null; firstSeen: string | null; lastSeen: string | null }>
}

export interface BacklinkImportInput {
  csv: string
  subject: "own" | "competitor"
  competitorDomain?: string
  filename?: string
  sourceLabel: string
  coverage: "complete" | "partial" | "unknown"
  exportedAt?: string
}

const blPath = (websiteId: string, path: string) => `${sitePath(websiteId)}/backlinks${path}`

export async function apiBacklinkSources(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.sources")
  return apiFetch<{ sources: BacklinkSource[]; scoreWeights: Record<string, number>; limits: { maxRows: number; maxBytes: number; staleAfterDays: number; verifyMaxLinks: number } }>(blPath(websiteId, "/sources"))
}

export async function apiBacklinkSummary(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.summary")
  return apiFetch<BacklinkSummary>(blPath(websiteId, "/summary"))
}

export async function apiBacklinkDatasets(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.datasets")
  return apiFetch<BacklinkDataset[]>(blPath(websiteId, "/datasets"))
}

export async function apiBacklinkLinks(websiteId: string, params: { subject?: string; linkType?: string; state?: string; domain?: string; search?: string; sort?: string; order?: "asc" | "desc"; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.links")
  return apiFetch<{ dataset: BacklinkDataset | null; links: BacklinkLink[] }>(blPath(websiteId, `/links${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<{ dataset: BacklinkDataset | null; links: BacklinkLink[] }, { nextCursor: string | null }>
}

export async function apiBacklinkReferringDomains(websiteId: string, params: { subject?: string; search?: string; sort?: string; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.domains")
  return apiFetch<{ dataset: BacklinkDataset | null; domains: BacklinkReferringDomain[] }>(blPath(websiteId, `/referring-domains${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<{ dataset: BacklinkDataset | null; domains: BacklinkReferringDomain[] }, { total: number; offset: number; limit: number }>
}

export async function apiBacklinkChanges(websiteId: string, params: { type?: string; subject?: string; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.changes")
  return apiFetch<BacklinkChange[]>(blPath(websiteId, `/changes${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<BacklinkChange[], { nextCursor: string | null }>
}

export async function apiBacklinkGap(websiteId: string, params: { competitors?: string; category?: string; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.gap")
  return apiFetch<BacklinkGap>(blPath(websiteId, `/gap${queryString({ ...params, limit: params.limit ?? 100 })}`))
}

export async function apiBacklinkOpportunities(websiteId: string, params: { competitors?: string; topics?: string; kind?: string; minScore?: number; linkType?: "follow" | "any"; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.opportunities")
  return apiFetch<BacklinkOpportunities>(blPath(websiteId, `/opportunities${queryString({ ...params, limit: params.limit ?? 50 })}`))
}

export async function apiBacklinkPreview(websiteId: string, body: Pick<BacklinkImportInput, "csv" | "subject" | "competitorDomain">) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.preview")
  return apiFetch<BacklinkImportPreview>(blPath(websiteId, "/imports/preview"), { method: "POST", body: JSON.stringify(body) })
}

export async function apiBacklinkImport(websiteId: string, body: BacklinkImportInput) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.import")
  return apiFetch<{ dataset: BacklinkDataset; duplicateImport: boolean; changes: number; warnings?: string[] }>(blPath(websiteId, "/imports"), { method: "POST", body: JSON.stringify(body) })
}

export async function apiBacklinkVerify(websiteId: string, datasetId: string) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.verify")
  return apiFetch<{ job: { id: string; status: string; links_total: number; links_checked: number }; deduplicated: boolean; capped: boolean }>(blPath(websiteId, "/verifications"), { method: "POST", body: JSON.stringify({ datasetId }) })
}

export async function apiBacklinkVerification(websiteId: string, jobId: string) {
  if (IS_DEMO) throw new IntegrationRequired("backlinks.verification")
  return apiFetch<{ id: string; dataset_id: string; status: string; links_total: number; links_checked: number; error: string | null; created_at: string; finished_at: string | null }>(blPath(websiteId, `/verifications/${encodeURIComponent(jobId)}`))
}

/** CSV export: an authenticated download. */
export async function apiBacklinkExport(websiteId: string, kind: "links" | "referring_domains" | "opportunities" | "changes", params: { subject?: string; competitors?: string } = {}): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("backlinks.export")
  const res = await downloadResponse(`${blPath(websiteId, `/export${queryString({ kind, ...params })}`)}`)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export backlink data." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `backlinks-${kind}.csv` }
}

// ─── Rank tracking (/rank-tracking) ──────────────────────────────────────────
// Observations come from imported ranking reports or a configured provider.

export type RankStatus = "ranked" | "not_in_results" | "no_data" | "failed"
export type RankChangeKind = "improved" | "declined" | "unchanged" | "entered" | "dropped_out" | "unavailable"

export interface RankProject {
  id: string
  website_id: string
  website_domain: string
  name: string
  search_engine: "google" | "bing"
  country: string | null
  language: string | null
  device: "desktop" | "mobile" | null
  location: string | null
  timezone: string
  frequency: "manual" | "daily" | "weekly"
  status: "active" | "paused" | "archived"
  created_at: string
  keywords?: number
  last_observed?: string | null
}

export interface RankSource {
  id: string
  name: string
  status: "available" | "not_configured" | "not_supported"
  explanation: string
  setup: string | null
  costNote: string
}

export interface RankSources {
  sources: RankSource[]
  usage: { day: string; limit: number; used: number }
  features: string[]
  limits: { keywordsPerProject: number; competitorsPerProject: number; requestsPerDay: number; importRows: number; importBytes: number }
}

export interface RankKeyword {
  id: string
  keyword: string
  group_name: string | null
  landing_page: string | null
  status: "active" | "paused"
  source: string
  created_at: string
}

export interface RankObservation {
  id: string
  keyword_id: string
  subject_domain: string
  observed_date: string
  status: RankStatus
  position: number | null
  result_depth: number | null
  ranking_url: string | null
  source: string
  source_label: string
  serp_features: string[]
  owned_features: string[]
  result_type: string | null
  error_code: string | null
}

export interface RankRow {
  keywordId: string
  keyword: string
  group: string | null
  status: string
  landingPage: string | null
  latest: RankObservation | null
  previous: RankObservation | null
  change: { kind: RankChangeKind; delta: number | null; reason: string }
}

export interface RankDashboard {
  keywords: { tracked: number; active: number; paused: number; withObservations: number }
  changes: Record<RankChangeKind, number>
  distribution: Record<string, number>
  topPages: Array<{ url: string; keywords: number; averagePosition: number; bestPosition: number }>
  top10Trend: Array<{ day: string; source: string; share: number | null; top10: number; conclusive: number; excluded: number }>
  range: { from: string; to: string }
  activity: {
    lastImport: null | { created_at: string; source_label: string; rows_accepted: number }
    lastJob: null | { id: string; status: string; provider: string; keywords_total: number; keywords_done: number; keywords_failed: number; error: string | null; created_at: string; finished_at: string | null }
    usageToday: { limit: number; used: number }
  }
}

export interface RankCompetitorComparison {
  competitors: Array<{
    competitor: string
    counts: Record<string, number>
    keywords: Array<{
      keywordId: string
      keyword: string
      date: string | null
      relation: "both_ranked" | "own_only" | "competitor_only" | "neither" | "not_comparable"
      ahead: "own" | "competitor" | "tie" | null
      reason: string
      own: null | { position: number | null; status: RankStatus; url: string | null; ownedFeatures: string[] }
      competitor: null | { position: number | null; status: RankStatus; url: string | null; ownedFeatures: string[] }
      competitorMovement: { kind: RankChangeKind; delta: number | null; reason: string }
    }>
  }>
  note: string
}

export interface RankAlertRule {
  id: string
  rule_type: "threshold_cross" | "position_change" | "url_change" | "became_unavailable" | "competitor_overtake" | "collection_failures"
  params: Record<string, unknown>
  keyword_id: string | null
  enabled: boolean
  notify: "in_app" | "none"
  created_at: string
}

export interface RankAlertEvent {
  id: string
  rule_id: string
  rule_type: string
  keyword_id: string
  keyword: string
  message: string
  evidence: Record<string, unknown>
  created_at: string
  acknowledged_at: string | null
}

export interface RankImportPreview {
  columns: Record<string, string>
  unmappedColumns: string[]
  missingRequired: string[]
  rowLimitExceeded: boolean
  rows: { total: number; accepted: number; rejected: number; duplicate: number; skipped: number }
  rejectedSamples: Array<{ row: number; reason: string }>
  warnings: string[]
  newKeywords: number
  statuses: Record<string, number>
}

const rt = (path: string) => `/rank-tracking${path}`
const rp = (projectId: string, path = "") => rt(`/projects/${encodeURIComponent(projectId)}${path}`)
const jsonBody = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export async function apiRankSources() {
  if (IS_DEMO) throw new IntegrationRequired("rank.sources")
  return apiFetch<RankSources>(rt("/sources"))
}
export async function apiRankProjects() {
  if (IS_DEMO) throw new IntegrationRequired("rank.projects")
  return apiFetch<RankProject[]>(rt("/projects"))
}
export async function apiRankCreateProject(body: { websiteId: string; name: string; searchEngine: "google" | "bing"; country?: string | null; language?: string | null; device?: "desktop" | "mobile" | null; location?: string | null; timezone: string; frequency: "manual" | "daily" | "weekly" }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.project.create")
  return apiFetch<RankProject>(rt("/projects"), jsonBody("POST", body))
}
export async function apiRankUpdateProject(projectId: string, body: { name?: string; frequency?: string; status?: "active" | "paused" | "archived"; timezone?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.project.update")
  return apiFetch<RankProject>(rp(projectId), jsonBody("PATCH", body))
}
export async function apiRankKeywords(projectId: string, params: { search?: string; group?: string; status?: string; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("rank.keywords")
  return apiFetch<RankKeyword[]>(rp(projectId, `/keywords${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<RankKeyword[], { nextCursor: string | null; groups: string[] }>
}
export async function apiRankAddKeywords(projectId: string, keywords: Array<{ keyword: string; group?: string | null; landingPage?: string | null }>) {
  if (IS_DEMO) throw new IntegrationRequired("rank.keywords.add")
  return apiFetch<{ added: number; restored: number; alreadyTracked: number; invalid: Array<{ keyword: string; reason: string }>; warnings: string[]; limit: number }>(rp(projectId, "/keywords"), jsonBody("POST", { keywords }))
}
export async function apiRankImportKeywords(projectId: string, csv: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.keywords.import")
  return apiFetch<{ added: number; restored: number; alreadyTracked: number; invalid: Array<{ keyword: string; reason: string }>; warnings: string[] }>(rp(projectId, "/keywords/import"), jsonBody("POST", { csv }))
}
export async function apiRankUpdateKeyword(projectId: string, keywordId: string, body: { group?: string | null; landingPage?: string | null; status?: "active" | "paused" }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.keyword.update")
  return apiFetch<{ updated: boolean }>(rp(projectId, `/keywords/${encodeURIComponent(keywordId)}`), jsonBody("PATCH", body))
}
export async function apiRankRemoveKeyword(projectId: string, keywordId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.keyword.remove")
  return apiFetch<{ removed: boolean }>(rp(projectId, `/keywords/${encodeURIComponent(keywordId)}`), jsonBody("DELETE", { confirm: true }))
}
export async function apiRankCompetitors(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.competitors")
  return apiFetch<Array<{ domain: string; created_at: string }>>(rp(projectId, "/competitors"))
}
export async function apiRankAddCompetitor(projectId: string, domain: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.competitor.add")
  return apiFetch<{ domain: string; added: boolean }>(rp(projectId, "/competitors"), jsonBody("POST", { domain }))
}
export async function apiRankRemoveCompetitor(projectId: string, domain: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.competitor.remove")
  return apiFetch<{ removed: boolean }>(rp(projectId, `/competitors/${encodeURIComponent(domain)}`), { method: "DELETE" })
}
export async function apiRankPreviewObservations(projectId: string, csv: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.observations.preview")
  return apiFetch<RankImportPreview>(rp(projectId, "/observations/preview"), jsonBody("POST", { csv }))
}
export async function apiRankImportObservations(projectId: string, body: { csv: string; filename?: string; sourceLabel: string; createMissingKeywords: boolean }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.observations.import")
  return apiFetch<{ importId: string; duplicateImport: boolean; inserted: number; alreadyObserved: number; keywordsCreated: number; rejected: number; duplicates: number; alertsCreated: number; warnings: string[] }>(rp(projectId, "/observations/import"), jsonBody("POST", body))
}
export async function apiRankImports(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.imports")
  return apiFetch<Array<{ id: string; source_label: string; filename: string | null; rows_total: number; rows_accepted: number; rows_rejected: number; rows_duplicate: number; rows_skipped: number; keywords_created: number; created_at: string }>>(rp(projectId, "/imports"))
}
export async function apiRankDashboard(projectId: string, params: { group?: string; from?: string; to?: string } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("rank.dashboard")
  return apiFetch<RankDashboard>(rp(projectId, `/dashboard${queryString(params)}`))
}
export async function apiRankRankings(projectId: string, params: { group?: string; change?: string; search?: string; sort?: string; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("rank.rankings")
  return apiFetch<RankRow[]>(rp(projectId, `/rankings${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<RankRow[], { total: number; limit: number; offset: number }>
}
export async function apiRankHistory(projectId: string, keywordId: string, params: { from?: string; to?: string } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("rank.history")
  return apiFetch<{ keyword: { id: string; keyword: string }; observations: RankObservation[] }>(rp(projectId, `/keywords/${encodeURIComponent(keywordId)}/history${queryString(params)}`))
}
export async function apiRankSerpFeatures(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.features")
  return apiFetch<{ keywordsObserved: number; keywordsWithFeatureData: number; features: Array<{ feature: string; present: number; owned: number; keywords: Array<{ keyword: string; owned: boolean }> }> }>(rp(projectId, "/serp-features"))
}
export async function apiRankCompetitorComparison(projectId: string, competitor?: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.comparison")
  return apiFetch<RankCompetitorComparison>(rp(projectId, `/competitor-comparison${queryString({ competitor })}`))
}
export async function apiRankRefresh(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.refresh")
  return apiFetch<{ job: { id: string; status: string; keywords_total: number }; deduplicated: boolean }>(rp(projectId, "/refresh"), jsonBody("POST"))
}
export async function apiRankJobs(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.jobs")
  return apiFetch<Array<{ id: string; status: string; provider: string; trigger: string; observed_date: string; keywords_total: number; keywords_done: number; keywords_failed: number; error: string | null; created_at: string; finished_at: string | null }>>(rp(projectId, "/jobs"))
}
export async function apiRankAlertRules(projectId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.alert-rules")
  return apiFetch<RankAlertRule[]>(rp(projectId, "/alert-rules"))
}
export async function apiRankCreateAlertRule(projectId: string, body: { type: RankAlertRule["rule_type"]; params: Record<string, unknown>; keywordId?: string | null; notify?: "in_app" | "none" }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.alert-rule.create")
  return apiFetch<RankAlertRule>(rp(projectId, "/alert-rules"), jsonBody("POST", body))
}
export async function apiRankUpdateAlertRule(projectId: string, ruleId: string, body: { enabled?: boolean; notify?: "in_app" | "none" }) {
  if (IS_DEMO) throw new IntegrationRequired("rank.alert-rule.update")
  return apiFetch<{ updated: boolean }>(rp(projectId, `/alert-rules/${encodeURIComponent(ruleId)}`), jsonBody("PATCH", body))
}
export async function apiRankAlerts(projectId: string, params: { unacknowledged?: boolean; cursor?: string | null } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("rank.alerts")
  return apiFetch<RankAlertEvent[]>(rp(projectId, `/alerts${queryString({ unacknowledged: params.unacknowledged ? "true" : undefined, cursor: params.cursor ?? undefined })}`)) as WithMeta<RankAlertEvent[], { nextCursor: string | null }>
}
export async function apiRankAcknowledge(projectId: string, eventId: string) {
  if (IS_DEMO) throw new IntegrationRequired("rank.alert.ack")
  return apiFetch<{ acknowledged: boolean }>(rp(projectId, `/alerts/${encodeURIComponent(eventId)}/acknowledge`), jsonBody("POST"))
}
export async function apiRankExport(projectId: string, kind: "rankings" | "history" | "keywords"): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("rank.export")
  const res = await downloadResponse(`${rp(projectId, `/export${queryString({ kind })}`)}`)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export ranking data." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `rank-${kind}.csv` }
}

// ─── Content intelligence (/websites/:id/content) ────────────────────────────
// Inventory from the crawler, metrics from Search Console; nothing estimated.

export type ContentSeverity = "high" | "medium" | "low" | "info"

export interface ContentRule {
  id: string
  category: string
  severity: ContentSeverity
  heuristic: boolean
  title: string
}

export interface ContentOverview {
  inventory: { total: number; byState: Record<string, number>; lastCrawledAt: string | null }
  findingsOpen: Partial<Record<ContentSeverity, number>>
  topOpportunities: Array<{ id: string; kind: string; title: string; priority: number; confidence: string; effort: string; status: string }>
  runs: ContentRun[]
  coverage: { searchConsole: boolean; pagesWithSearchMetrics: number | null; pagesAnalyzable: number }
  ai: { available: boolean }
  rules: ContentRule[]
  rulesVersion: string
  thresholds: Record<string, number>
}

export interface ContentRun {
  id: string
  scan_id: string | null
  trigger: "crawl" | "manual"
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  rules_version: string
  pages_analyzed: number
  findings_open: number
  findings_new: number
  findings_resolved: number
  opportunities: number
  error: string | null
  created_at: string
  finished_at: string | null
}

export interface ContentPageRow {
  id: string
  url: string
  crawl_state: string
  http_status: number | null
  indexable: boolean | null
  title: string | null
  h1: string | null
  word_count: number | null
  inlinks: number | null
  last_crawled_at: string
  content_changed_at: string | null
  crawl_error: string | null
  open_findings: number
  search: null | { clicks: number; impressions: number; position: number | null; noRows?: boolean }
}

export interface ContentFinding {
  id: string
  page_id: string | null
  url: string | null
  rule_id: string
  rule_version: string
  ruleTitle: string | null
  category: string
  severity: ContentSeverity
  heuristic: boolean
  status: "open" | "in_progress" | "resolved" | "ignored"
  evidence: Record<string, unknown>
  explanation: string
  recommendation: string
  ignore_reason: string | null
  first_detected_at: string
  last_detected_at: string
  resolved_at: string | null
}

export interface ContentFactor {
  name: string
  weight: number
  value: number | null
  explanation: string
}

export interface ContentOpportunity {
  id: string
  kind: string
  page_id: string | null
  url: string | null
  topic_id: string | null
  topic: string | null
  title: string
  evidence: Record<string, unknown>
  problem: string
  action: string
  priority: number
  priority_factors: ContentFactor[]
  confidence: "high" | "medium" | "low"
  confidence_basis: string
  missing_data: string[]
  effort: "small" | "medium" | "large"
  status: "open" | "in_progress" | "done" | "dismissed" | "obsolete"
  first_detected_at: string
  last_detected_at: string
  completed_at: string | null
}

export interface ContentTopic {
  id: string
  name: string
  nameLocked: boolean
  source: string
  terms: string[]
  pages: number
  coveringPages: number
  queries: number
  queryImpressions: number
  competitorGaps: number
}

export interface ContentBriefBody {
  targetTopic: string
  intent: { value: string | null; rule: string | null; note: string }
  primaryKeyword: string | null
  relatedKeywords: string[]
  existingPages: Array<{ url: string; title: string | null }>
  suggestedTitle: string
  suggestedMetaDescription: string
  h1: string
  outline: Array<{ heading: string; points: string[] }>
  questions: string[]
  internalLinks: Array<{ url: string; anchorHint: string }>
  sources: Array<{ label: string; url: string | null }>
  missingEvidence: string[]
  researchQuestions: string[]
  checklist: Array<{ item: string; done: boolean }>
}

export interface ContentBrief {
  brief: { id: string; title: string; status: "draft" | "in_review" | "approved"; current_revision: number; page_url: string | null; topic: string | null; approved_at: string | null; updated_at: string }
  body: ContentBriefBody
  source: "deterministic" | "ai_suggestion" | "edit"
  aiModel: string | null
  revisions: Array<{ revision: number; source: string; ai_model: string | null; note: string | null; created_at: string }>
}

const ct = (websiteId: string, path: string) => `${sitePath(websiteId)}/content${path}`
const cj = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export async function apiContentOverview(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.overview")
  return apiFetch<ContentOverview>(ct(websiteId, "/overview"))
}
export async function apiContentPages(websiteId: string, params: { search?: string; state?: string; indexable?: "true" | "false"; severity?: string; sort?: string; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("content.pages")
  return apiFetch<ContentPageRow[]>(ct(websiteId, `/pages${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<ContentPageRow[], { total: number; offset: number; limit: number; searchConsole: boolean }>
}
export async function apiContentPage(websiteId: string, pageId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.page")
  return apiFetch<{ page: Record<string, unknown> & { url: string; headings: Array<{ level: number; text: string }> }; findings: ContentFinding[]; opportunities: Array<{ id: string; kind: string; title: string; priority: number; status: string }>; topics: Array<{ id: string; name: string; assignment: string }> }>(ct(websiteId, `/pages/${encodeURIComponent(pageId)}`))
}
export async function apiContentRuns(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.runs")
  return apiFetch<ContentRun[]>(ct(websiteId, "/runs"))
}
export async function apiContentStartRun(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.run")
  return apiFetch<{ run: ContentRun; deduplicated: boolean }>(ct(websiteId, "/runs"), cj("POST"))
}
export async function apiContentFindings(websiteId: string, params: { status?: string; severity?: string; category?: string; pageId?: string; cursor?: string | null; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("content.findings")
  return apiFetch<ContentFinding[]>(ct(websiteId, `/findings${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<ContentFinding[], { nextCursor: string | null }>
}
export async function apiContentUpdateFinding(websiteId: string, findingId: string, body: { status: "open" | "in_progress" | "ignored"; reason?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("content.finding.update")
  return apiFetch<{ from: string; to: string }>(ct(websiteId, `/findings/${encodeURIComponent(findingId)}`), cj("PATCH", body))
}
export async function apiContentFindingHistory(websiteId: string, findingId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.finding.history")
  return apiFetch<Array<{ event: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string }>>(ct(websiteId, `/findings/${encodeURIComponent(findingId)}/history`))
}
export async function apiContentOpportunities(websiteId: string, params: { status?: string; kind?: string; minPriority?: number; offset?: number; limit?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("content.opportunities")
  return apiFetch<ContentOpportunity[]>(ct(websiteId, `/opportunities${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<ContentOpportunity[], { total: number }>
}
export async function apiContentOpportunity(websiteId: string, id: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.opportunity")
  return apiFetch<{ opportunity: ContentOpportunity & { baseline: Record<string, unknown> | null }; events: Array<{ event: string; from_status: string | null; to_status: string | null; feedback: string | null; note: string | null; created_at: string }>; outcome: null | { note: string; baseline: Record<string, unknown>; latest: Record<string, unknown> | null; enoughTimePassed: boolean } }>(ct(websiteId, `/opportunities/${encodeURIComponent(id)}`))
}
export async function apiContentUpdateOpportunity(websiteId: string, id: string, body: { status?: "open" | "in_progress" | "done" | "dismissed"; feedback?: "useful" | "not_useful"; note?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("content.opportunity.update")
  return apiFetch<Awaited<ReturnType<typeof apiContentOpportunity>>["data"]>(ct(websiteId, `/opportunities/${encodeURIComponent(id)}`), cj("PATCH", body))
}
export async function apiContentTopics(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.topics")
  return apiFetch<ContentTopic[]>(ct(websiteId, "/topics"))
}

export async function apiContentCreateTopic(websiteId: string, name: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.topics.create")
  return apiFetch<ContentTopic>(ct(websiteId, "/topics"), jsonBody("POST", { name }))
}
export async function apiContentTopic(websiteId: string, topicId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.topic")
  return apiFetch<{ topic: { id: string; name: string; name_locked: boolean; terms: string[] }; coverage: null | { queryImpressions: number; queries: Array<{ query: string; impressions: number; clicks: number }>; pages: Array<{ pageId: string; url: string; title: string | null; covers: boolean }>; competitorGaps: Array<{ keyword: string; competitor: string; position: number; date: string }> }; members: Array<{ member_type: string; member_key: string; assignment: string; excluded: boolean }>; overlap: null | { pages: string[]; note: string } }>(ct(websiteId, `/topics/${encodeURIComponent(topicId)}`))
}
export async function apiContentRenameTopic(websiteId: string, topicId: string, name: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.topic.rename")
  return apiFetch<{ renamed: boolean }>(ct(websiteId, `/topics/${encodeURIComponent(topicId)}`), cj("PATCH", { name }))
}
export async function apiContentTopicMember(websiteId: string, topicId: string, body: { memberType: "page" | "query"; memberKey: string; action: "assign" | "exclude" }) {
  if (IS_DEMO) throw new IntegrationRequired("content.topic.member")
  return apiFetch<{ assigned?: boolean; excluded?: boolean }>(ct(websiteId, `/topics/${encodeURIComponent(topicId)}/members`), cj("POST", body))
}
export async function apiContentBriefs(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.briefs")
  return apiFetch<Array<{ id: string; title: string; status: string; current_revision: number; page_url: string | null; topic: string | null; updated_at: string }>>(ct(websiteId, "/briefs"))
}
export async function apiContentCreateBrief(websiteId: string, body: { pageId?: string; topicId?: string; opportunityId?: string; title?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("content.brief.create")
  return apiFetch<ContentBrief>(ct(websiteId, "/briefs"), cj("POST", body))
}
export async function apiContentBrief(websiteId: string, briefId: string) {
  if (IS_DEMO) throw new IntegrationRequired("content.brief")
  return apiFetch<ContentBrief>(ct(websiteId, `/briefs/${encodeURIComponent(briefId)}`))
}
export async function apiContentSaveBrief(websiteId: string, briefId: string, body: { baseRevision: number; body: ContentBriefBody; title?: string; note?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("content.brief.save")
  return apiFetch<ContentBrief>(ct(websiteId, `/briefs/${encodeURIComponent(briefId)}`), cj("PUT", body))
}
export async function apiContentBriefStatus(websiteId: string, briefId: string, status: "draft" | "in_review" | "approved") {
  if (IS_DEMO) throw new IntegrationRequired("content.brief.status")
  return apiFetch<ContentBrief>(ct(websiteId, `/briefs/${encodeURIComponent(briefId)}/status`), cj("POST", { status }))
}
export async function apiContentBriefAi(websiteId: string, briefId: string, baseRevision: number) {
  if (IS_DEMO) throw new IntegrationRequired("content.brief.ai")
  return apiFetch<ContentBrief>(ct(websiteId, `/briefs/${encodeURIComponent(briefId)}/ai-suggestions`), cj("POST", { baseRevision }))
}
export async function apiContentExport(websiteId: string, kind: "pages" | "findings" | "opportunities", params: { status?: string; severity?: string } = {}): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("content.export")
  const res = await downloadResponse(`${ct(websiteId, `/export${queryString({ kind, ...params })}`)}`)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export content data." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `content-${kind}.csv` }
}

// ─── AI search visibility (server/src/routes/ai-visibility.ts) ───────────────

export type AivProviderStatus = "available" | "not_configured" | "requires_approval" | "model_not_allowed" | "manual_import_only"

export interface AivProvider {
  id: string
  name: string
  surface: string
  collection: "provider_api" | "manual_import"
  capabilities: Record<string, boolean | string>
  explanation: string
  limitations: string[]
  costNote: string
  status: AivProviderStatus
  detail: string
  model: string | null
}

export interface AivMetricDefinition { label: string; numerator: string; denominator: string; missing: string }

export interface AivUsage { day: string; limit: number; used: number; remaining: number }

export interface AivProviders {
  providers: AivProvider[]
  usage: AivUsage
  surfaces: Record<string, string>
  importSurfaces: string[]
  promptVersion: string
  metricDefinitions: Record<string, AivMetricDefinition>
  priorityFormula: string
  ai: { available: boolean }
  limits: Record<string, number>
}

export interface AivBrand {
  id: string
  kind: "target" | "competitor"
  parent_id: string | null
  website_id: string | null
  website_domain: string | null
  name: string
  domains: string[]
  aliases: string[]
  products: string[]
  exclude_terms: string[]
  disambiguation: string | null
  topics: string[]
  locations: string[]
  language: string | null
  country: string | null
  status: "active" | "disabled" | "archived"
  owner_id: string | null
  schedule: "off" | "weekly"
  schedule_provider: string | null
  schedule_repeats: number | null
  schedule_max_requests: number | null
  schedule_approved_at: string | null
  config_version: number
  created_at: string
  updated_at: string
  competitors?: number
  active_queries?: number
  observations?: number
  last_observed_at?: string | null
}

export interface AivBrandInput {
  name?: string
  domains?: string[]
  aliases?: string[]
  products?: string[]
  excludeTerms?: string[]
  disambiguation?: string | null
  topics?: string[]
  locations?: string[]
  language?: string | null
  country?: string | null
  websiteId?: string | null
  status?: "active" | "disabled" | "archived"
}

export interface AivQuery {
  id: string
  text: string
  topic: string | null
  language: string | null
  country: string | null
  providers: string[]
  status: "active" | "paused" | "archived"
  version: number
  source: "manual" | "import"
  last_run_at: string | null
  last_observed_at: string | null
  created_at: string
  observations: number
  answered: number
  mentioned: number
}

export interface AivMetric { value: number | null; numerator: number; denominator: number; smallSample: boolean }
export interface AivGroupKey { method: "provider_api" | "manual_import"; provider: string; surface: string; model: string | null }

export interface AivGroupMetrics {
  key: AivGroupKey
  sample: { observations: number; answered: number; unanswered: number; queries: number; withCitations: number; firstObservedAt: string | null; lastObservedAt: string | null; languages: string[]; countries: string[] }
  brands: Array<{ brandId: string; name: string; kind: "target" | "competitor"; mentionRate: AivMetric; queryCoverage: AivMetric; mentionShare: AivMetric; citationRate: AivMetric; citationShare: AivMetric; firstMentionAt: string | null; lastMentionAt: string | null }>
  coMentions: Array<{ brandId: string; name: string; rate: AivMetric }>
  sources: { citations: number; distinctHosts: number; topHosts: Array<{ host: string; observations: number }>; topSourceShare: AivMetric }
  consistency: AivMetric
  trend: Array<{ period: string; answered: number; mentioned: number; rate: number | null }>
}

export interface AivMetrics {
  window: { from: string; to: string | null }
  brands: Array<{ id: string; name: string; kind: "target" | "competitor" }>
  groups: AivGroupMetrics[]
  definitions: Record<string, AivMetricDefinition>
  minSample: number
  surfaces: Record<string, string>
  observations: number
  truncated: boolean
  staleMentions: number
  note: string
}

export interface AivRun {
  id: string
  provider: string
  model: string | null
  trigger: "manual" | "scheduled"
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled"
  repeats: number
  items_total: number
  items_done: number
  items_failed: number
  schedule_slot: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface AivRunDetail extends AivRun {
  items: Array<{ query_id: string; query_text: string; query_version: number; repeat_index: number; status: "pending" | "done" | "failed"; attempts: number; error_code: string | null; observation_id: string | null }>
}

export interface AivRunPreview {
  provider: { id: string; name: string; status: AivProviderStatus; detail: string; costNote: string; limitations: string[] }
  model: string | null
  queries: number
  repeats: number
  requests: number
  usage: AivUsage
  maxRequestsPerRun: number
  costEstimate: string | null
  canRun: boolean
  blockers: string[]
}

export interface AivOverview {
  brand: AivBrand
  competitors: number
  counts: { active_queries: number; queries_observed: number; observations: number; api_observations: number; imported_observations: number; excluded_observations: number; last_observed_at: string | null }
  providers: Array<{ id: string; name: string; status: AivProviderStatus; detail: string; collection: string }>
  usage: AivUsage
  runs: AivRun[]
  metrics: AivMetrics
  changes: Array<{ key: AivGroupKey; from: { period: string; answered: number; rate: number | null }; to: { period: string; answered: number; rate: number | null }; delta: number }>
  topOpportunities: Array<{ id: string; kind: string; title: string; priority: number; confidence: string; status: string }>
}

export interface AivMentionRef { brandId: string; name: string; kind: "target" | "competitor"; count: number }

export interface AivObservationRow {
  id: string
  query_id: string
  query_text: string
  query_version: number
  provider: string
  surface: string
  model: string | null
  collection_method: "provider_api" | "manual_import"
  observed_at: string
  language: string | null
  country: string | null
  web_grounded: boolean | null
  answer_status: "answered" | "truncated" | "empty" | "refused"
  response_retention: "full" | "truncated" | "none"
  excerpt: string | null
  excluded_at: string | null
  mentions: AivMentionRef[]
  citations: number
}

export interface AivCitation {
  id: string
  position: number | null
  original_url: string
  title: string | null
  kind: "provider_annotation" | "provider_citation_list" | "inline_text_url" | "imported"
  cited_brand_id: string | null
  cited_brand: string | null
  source_id: string
  normalized_url: string
  host: string
  registrable_domain: string | null
  idn: boolean
  verification_status: string
  verified_at: string | null
}

export interface AivObservation extends Omit<AivObservationRow, "excerpt" | "mentions" | "citations"> {
  response_text: string | null
  response_chars: number
  response_sha256: string
  provider_request_id: string | null
  usage: Record<string, number> | null
  prompt_version: string | null
  notes: string | null
  run_id: string | null
  run_trigger: string | null
  import_id: string | null
  import_label: string | null
  import_filename: string | null
  exclusion_reason: string | null
  detector_version: number
  mentionsCurrent: boolean
  mentions: Array<{ brand_id: string; name: string; kind: string; match_count: number; matched_terms: string[]; matched_by: string[]; excerpt: string | null }>
  citations: AivCitation[]
  events: Array<{ event: string; detail: Record<string, unknown>; created_at: string }>
}

export interface AivSource {
  id: string
  normalized_url: string
  host: string
  registrable_domain: string | null
  idn: boolean
  title: string | null
  first_observed_at: string
  last_observed_at: string
  verification_status: string
  verification_http_status: number | null
  verified_at: string | null
  cited_brand: string | null
  cited_brand_kind: string | null
  observations: number
  queries: number
  kinds: string[]
}

export interface AivDomains {
  window: { from: string; to: string | null }
  domains: Array<{ host: string; registrable_domain: string | null; cited_brand: string | null; cited_brand_kind: string | null; observations: number; queries: number; urls: number; first_observed_at: string; last_observed_at: string; imported_observations: number }>
  diversity: Array<{ week: string; hosts: number; observations: number }>
}

export interface AivQueryEvidence { queryId: string; query: string | null; observationIds: string[] }

export interface AivComparison {
  window: { from: string; to: string | null }
  target: { id: string; name: string }
  competitors: Array<{ id: string; name: string }>
  minSample: number
  truncated: boolean
  note: string
  groups: Array<{
    key: AivGroupKey
    sample: { answered: number; queries: number; languages: string[]; countries: string[]; firstObservedAt: string | null; lastObservedAt: string | null }
    competitors: Array<{
      brandId: string
      name: string
      target: { mentioned: number; rate: AivMetric; cited: number }
      competitor: { mentioned: number; rate: AivMetric; cited: number }
      competitorOnlyQueries: AivQueryEvidence[]
      targetOnlyQueries: AivQueryEvidence[]
      bothQueries: number
      sharedSourceHosts: string[]
      history: { status: "ok" | "insufficient"; splitAt: string | null; earlier: { answered: number; targetRate: number | null; competitorRate: number | null } | null; later: { answered: number; targetRate: number | null; competitorRate: number | null } | null }
    }>
  }>
}

export interface AivOpportunity {
  id: string
  kind: string
  title: string
  explanation: string
  action: string
  evidence: { observationIds: string[]; queryIds: string[]; brandIds: string[]; hosts: string[]; urls: string[]; counts: Record<string, number> }
  limitations: string[]
  priority: number
  priority_factors: Array<{ name: string; weight: number; value: number | null; explanation: string }>
  confidence: "high" | "medium" | "low"
  status: "open" | "in_progress" | "done" | "dismissed" | "obsolete"
  owner_id: string | null
  first_detected_at: string
  last_detected_at: string
  resolved_at: string | null
}

export interface AivOpportunityDetail extends AivOpportunity {
  formula: string
  events: Array<{ event: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string }>
  observations: Array<{ id: string; observed_at: string; query_text: string; provider: string; surface: string; collection_method: string; excluded_at: string | null }>
  queries: Array<{ id: string; text: string }>
}

export interface AivImportPreview {
  format: "csv" | "json"
  rowsTotal: number
  accepted: number
  duplicatesInFile: number
  duplicatesExisting: number
  rejected: number
  rejectedSamples: Array<{ line: number; reason: string }>
  newQueries: number
  truncated: boolean
  mapping: Record<string, string>
  sample: Array<{ line: number; query: string; surface: string; model: string | null; observedAt: string; citations: number; responseChars: number }>
  note: string
}

export interface AivImportResult { importId: string; duplicateImport: boolean; inserted: number; duplicates: number; rejected: number; rejectedSamples?: Array<{ line: number; reason: string }>; queriesCreated: number }

export interface AivImportRecord { id: string; format: string; source_label: string; filename: string | null; rows_total: number; rows_accepted: number; rows_rejected: number; rows_duplicate: number; queries_created: number; created_at: string }

export interface AivAiSummary {
  id: string
  model: string
  body: { summary: string; patterns: Array<{ statement: string; observationIds: string[] }>; sourceCategories: Array<{ host: string; category: string }>; caveats: string[] }
  observation_ids: string[]
  created_at: string
  dropped?: number
}

export type AivWindow = { from?: string; to?: string; provider?: string; surface?: string; method?: "provider_api" | "manual_import"; queryId?: string }

const aiv = (path = "") => `/ai-visibility${path}`
const ab = (brandId: string, path = "") => aiv(`/brands/${encodeURIComponent(brandId)}${path}`)

/** Re-runs brand and competitor matching over stored observations (after names or aliases change). */
export async function apiAivReprocess(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.reprocess")
  return apiFetch<{ reprocessed: number; remaining: number }>(ab(brandId, "/reprocess"), jsonBody("POST"))
}
const aj = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export async function apiAivProviders() {
  if (IS_DEMO) throw new IntegrationRequired("aiv.providers")
  return apiFetch<AivProviders>(aiv("/providers"))
}
export async function apiAivBrands(includeArchived = false) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.brands")
  return apiFetch<AivBrand[]>(aiv(`/brands${queryString({ includeArchived: includeArchived || undefined })}`))
}
export async function apiAivCreateBrand(input: AivBrandInput & { name: string }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.brand.create")
  return apiFetch<AivBrand>(aiv("/brands"), aj("POST", input))
}
export async function apiAivUpdateBrand(brandId: string, patch: AivBrandInput) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.brand.update")
  return apiFetch<AivBrand>(ab(brandId), aj("PATCH", patch))
}
export async function apiAivOverview(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.overview")
  return apiFetch<AivOverview>(ab(brandId, "/overview"))
}
export async function apiAivSetSchedule(brandId: string, body: { schedule: "off" } | { schedule: "weekly"; provider: string; repeats: number; maxRequests: number; confirm: true }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.schedule")
  return apiFetch<AivBrand>(ab(brandId, "/schedule"), aj("PUT", body))
}
export async function apiAivCompetitors(brandId: string, includeArchived = false) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.competitors")
  return apiFetch<AivBrand[]>(ab(brandId, `/competitors${queryString({ includeArchived: includeArchived || undefined })}`))
}
export async function apiAivAddCompetitor(brandId: string, input: AivBrandInput & { name: string }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.competitor.add")
  return apiFetch<AivBrand>(ab(brandId, "/competitors"), aj("POST", input))
}
export async function apiAivUpdateCompetitor(brandId: string, competitorId: string, patch: AivBrandInput) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.competitor.update")
  return apiFetch<AivBrand>(ab(brandId, `/competitors/${encodeURIComponent(competitorId)}`), aj("PATCH", patch))
}
export async function apiAivQueries(brandId: string, params: { status?: string; topic?: string; search?: string; limit?: number; offset?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.queries")
  return apiFetch<AivQuery[]>(ab(brandId, `/queries${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<AivQuery[], { total: number; topics: string[]; limit: number; offset: number }>
}
export async function apiAivAddQueries(brandId: string, queries: Array<{ text: string; topic?: string | null; language?: string | null; country?: string | null; providers?: string[] }>) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.queries.add")
  return apiFetch<{ added: number; alreadyExists: number; invalid: Array<{ text: string; reason: string }> }>(ab(brandId, "/queries"), aj("POST", { queries }))
}
export async function apiAivUpdateQuery(brandId: string, queryId: string, patch: { text?: string; topic?: string | null; providers?: string[]; status?: "active" | "paused" | "archived" }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.query.update")
  return apiFetch<AivQuery & { versionCreated: boolean }>(ab(brandId, `/queries/${encodeURIComponent(queryId)}`), aj("PATCH", patch))
}
export async function apiAivQueryVersions(brandId: string, queryId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.query.versions")
  return apiFetch<Array<{ version: number; text: string; topic: string | null; created_at: string }>>(ab(brandId, `/queries/${encodeURIComponent(queryId)}/versions`))
}
export async function apiAivPreviewRun(brandId: string, body: { provider: string; queryIds?: string[]; repeats: number }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.run.preview")
  return apiFetch<AivRunPreview>(ab(brandId, "/runs/preview"), aj("POST", body))
}
export async function apiAivStartRun(brandId: string, body: { provider: string; queryIds?: string[]; repeats: number; idempotencyKey: string }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.run.start")
  return apiFetch<{ run: AivRun; deduplicated: boolean }>(ab(brandId, "/runs"), aj("POST", { ...body, confirm: true }))
}
export async function apiAivRuns(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.runs")
  return apiFetch<AivRun[]>(ab(brandId, "/runs"))
}
export async function apiAivRun(brandId: string, runId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.run")
  return apiFetch<AivRunDetail>(ab(brandId, `/runs/${encodeURIComponent(runId)}`))
}
export async function apiAivCancelRun(brandId: string, runId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.run.cancel")
  return apiFetch<{ cancelled: boolean }>(ab(brandId, `/runs/${encodeURIComponent(runId)}/cancel`), aj("POST", {}))
}
export async function apiAivObservations(brandId: string, params: AivWindow & { mentions?: string; notMentioned?: boolean; hasCitations?: boolean; includeExcluded?: boolean; limit?: number; cursor?: string } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.observations")
  return apiFetch<AivObservationRow[]>(ab(brandId, `/observations${queryString({ ...params, notMentioned: params.notMentioned || undefined, includeExcluded: params.includeExcluded || undefined })}`)) as WithMeta<AivObservationRow[], { nextCursor: string | null }>
}
export async function apiAivObservation(brandId: string, observationId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.observation")
  return apiFetch<AivObservation>(ab(brandId, `/observations/${encodeURIComponent(observationId)}`))
}
export async function apiAivSetExcluded(brandId: string, observationId: string, exclude: boolean, reason?: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.observation.exclude")
  return apiFetch<{ changed: boolean }>(ab(brandId, `/observations/${encodeURIComponent(observationId)}/${exclude ? "exclude" : "include"}`), aj("POST", exclude ? { reason } : {}))
}
export async function apiAivSources(brandId: string, params: { host?: string; search?: string; verification?: string; owner?: string; from?: string; to?: string; sort?: string; limit?: number; offset?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.sources")
  return apiFetch<AivSource[]>(ab(brandId, `/sources${queryString({ ...params, limit: params.limit ?? 50 })}`)) as WithMeta<AivSource[], { total: number; limit: number; offset: number }>
}
export async function apiAivDomains(brandId: string, params: AivWindow = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.domains")
  return apiFetch<AivDomains>(ab(brandId, `/domains${queryString(params)}`))
}
export async function apiAivVerifySource(brandId: string, sourceId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.source.verify")
  return apiFetch<{ sourceId: string; url: string; status: string; httpStatus: number | null }>(ab(brandId, `/sources/${encodeURIComponent(sourceId)}/verify`), aj("POST", {}))
}
export async function apiAivMetrics(brandId: string, params: AivWindow = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.metrics")
  return apiFetch<AivMetrics>(ab(brandId, `/metrics${queryString(params)}`))
}
export async function apiAivComparison(brandId: string, params: AivWindow = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.comparison")
  return apiFetch<AivComparison>(ab(brandId, `/competitor-comparison${queryString(params)}`))
}
export async function apiAivOpportunities(brandId: string, params: { status?: string; kind?: string } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.opportunities")
  return apiFetch<AivOpportunity[]>(ab(brandId, `/opportunities${queryString(params)}`)) as WithMeta<AivOpportunity[], { formula: string }>
}
export async function apiAivOpportunity(brandId: string, id: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.opportunity")
  return apiFetch<AivOpportunityDetail>(ab(brandId, `/opportunities/${encodeURIComponent(id)}`))
}
export async function apiAivUpdateOpportunity(brandId: string, id: string, patch: { status?: "open" | "in_progress" | "done" | "dismissed"; note?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.opportunity.update")
  return apiFetch<{ updated: boolean }>(ab(brandId, `/opportunities/${encodeURIComponent(id)}`), aj("PATCH", patch))
}
export async function apiAivPreviewImport(brandId: string, body: { content: string; format?: "csv" | "json" }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.import.preview")
  return apiFetch<AivImportPreview>(ab(brandId, "/imports/preview"), aj("POST", body))
}
export async function apiAivImport(brandId: string, body: { content: string; format?: "csv" | "json"; filename?: string; sourceLabel: string; createMissingQueries: boolean }) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.import")
  return apiFetch<AivImportResult>(ab(brandId, "/imports"), aj("POST", body))
}
export async function apiAivImports(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.imports")
  return apiFetch<AivImportRecord[]>(ab(brandId, "/imports"))
}
export async function apiAivAiSummaries(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.ai.list")
  return apiFetch<AivAiSummary[]>(ab(brandId, "/ai/summaries")) as WithMeta<AivAiSummary[], { available: boolean }>
}
export async function apiAivCreateAiSummary(brandId: string) {
  if (IS_DEMO) throw new IntegrationRequired("aiv.ai.create")
  return apiFetch<AivAiSummary>(ab(brandId, "/ai/summaries"), aj("POST", {}))
}
export async function apiAivExport(brandId: string, kind: "observations" | "sources" | "metrics"): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("aiv.export")
  const res = await downloadResponse(`${ab(brandId, `/export${queryString({ kind })}`)}`)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export AI visibility data." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ai-visibility-${kind}.csv` }
}

// ─── Unified SEO workspace (server/src/routes/seo-workspace.ts) ──────────────

export type WsRangePreset = "7d" | "28d" | "90d" | "custom"
export interface WsRangeParams { preset: WsRangePreset; from?: string; to?: string; compare: "previous" | "none" }
export interface WsRange { preset: WsRangePreset; from: string; to: string; days: number; previous: { from: string; to: string } | null; timezone: string; notes: string[] }
export interface WsFreshness { state: "fresh" | "stale" | "never"; lastUpdatedAt: string | null; ageHours: number | null; staleAfterHours: number }
export type WsSectionStatus = "ok" | "partial" | "no_data" | "not_configured" | "auth_expired" | "error" | "timeout"
export interface WsSection<T> { module: string; status: WsSectionStatus; freshness: WsFreshness | null; range: { support: "full" | "events_only" | "snapshot"; note: string }; notes: string[]; link: string; data: T | null }
export interface WsMetrics { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }
export interface WsChange { change: number | null; changePct: number | null }
export interface WsSearch {
  siteUrl: string
  current: WsMetrics
  previous: WsMetrics | null
  comparison: { clicks: WsChange; impressions: WsChange; ctr: WsChange; position: WsChange } | null
  coverage: { current: { days: number; daysWithData: number; daysMissing: number; daysFresh: number }; previous: { days: number; daysWithData: number; daysMissing: number } | null }
  series: Array<{ date: string; clicks: number | null; impressions: number | null; state: string }>
  topPages: Array<{ key: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>
  topQueries: Array<{ key: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>
  movers: Array<{ dimension: "page" | "query"; key: string; clicks: number | null; previousClicks: number | null; change: number | null }>
  latestFinalDay: string | null
  firstIncompleteDate: string | null
}
export interface WsTechnical {
  latestCrawl: { scanId: string; crawledAt: string | null; pagesCrawled: number; pagesDiscovered: number; truncated: boolean; truncatedReason: string | null; statusCounts: Record<string, number>; maxPages: number | null }
  indexability: { indexable: number; not_indexable: number; unknown: number }
  openBySeverity: Record<string, number>
  brokenInternalLinks: number
  canonicalIssues: number
  inRange: { detected: number; fixed: number }
  previousRange: { detected: number; fixed: number } | null
  topIssues: Array<{ id: string; rule_id: string; severity: string; url: string; title: string }>
  history: Array<{ scanId: string; crawledAt: string | null; pagesCrawled: number; truncated: boolean; issues: Record<string, number> }>
}
export interface WsRankings {
  projects: Array<{ id: string; name: string; frequency: string }>
  tracked: number
  observedInRange: number
  changes: Record<string, number>
  movers: Array<{ keyword: string; change: string; position: number | null; previousPosition: number | null; observedDate: string | null }>
  nearTop: Array<{ keyword: string; position: number; url: string | null; observedDate: string | null }>
  serpFeatures: Record<string, number>
  competitors: Array<{ domain: string; ahead: number; behind: number }>
  latestObservedDate: string | null
}
export interface WsBacklinks {
  dataset: { id: string; sourceLabel: string; coverage: string; exportedAt: string | null; retrievedAt: string | null; stale: boolean }
  links: number
  referringDomains: number
  changesInRange: { new: number; lost: number; other: number }
  topLinkedPages: Array<{ target_url: string; links: number; domains: number }>
  competitors: Array<{ domain: string; referringDomains: number; coverage: string }>
  gap: { total: number; top: Array<{ domain: string; kind: string; score: number; competitors: string[] }> } | null
}
export interface WsContent {
  inventory: { total: number; byState: Record<string, number>; lastCrawledAt: string | null }
  possiblyStalePages: number
  findingsOpen: Record<string, number>
  findingsInRange: { detected: number; resolved: number }
  opportunitiesOpen: Record<string, number>
  topicGaps: number
  briefs: Record<string, number>
  topOpportunities: Array<{ id: string; title: string; priority: number }>
  lastAnalysis: { status: string; at: string | null } | null
}
export interface WsAiVisibility {
  brands: Array<{ brandId: string; name: string; observations: number; openOpportunities: number; minSample: number; groups: Array<{ key: AivGroupKey; sample: { answered: number; queries: number }; mentionRate: AivMetric | null; citationRate: AivMetric | null; topHosts: Array<{ host: string; observations: number }> }> }>
  providers: Array<{ id: string; name: string; status: string }>
}
export interface WsAction {
  key: string
  source: string
  sourceRef: string
  sourceStatus: string
  category: string
  title: string
  detail: string
  recommendedAction: string
  evidence: string[]
  priority: number
  priorityBasis: string
  effort: "small" | "medium" | "large"
  link: string
  detectedAt: string | null
  state: { status: "open" | "in_progress" | "completed" | "dismissed"; ownerId: string | null; dueDate: string | null; note: string | null; updatedAt: string | null }
}
export interface WsInsightRow { id: string; rule_id: string; title: string; priority: number; confidence: string; status: string; modules: string[]; last_detected_at: string }
export interface WsOverview {
  website: { id: string; domain: string; verified: boolean }
  range: WsRange
  generatedAt: string
  summary: string[]
  sections: { search: WsSection<WsSearch>; technical: WsSection<WsTechnical>; rankings: WsSection<WsRankings>; backlinks: WsSection<WsBacklinks>; content: WsSection<WsContent>; aiVisibility: WsSection<WsAiVisibility>; keywords: WsSection<{ runs: Array<{ id: string; kind: string; status: string; finished_at: string | null }> }> }
  completeness: Record<string, { status: WsSectionStatus; freshness: string | null; lastUpdatedAt: string | null }>
  jobs: Array<{ module: string; id: string; status: string; created_at: string; finished_at: string | null; error: string | null }>
  topInsights: WsInsightRow[]
  insightsOpen: number
  insightsEvaluatedAt: string | null
  topActions: WsAction[]
  actionsTotal: number
}
export interface WsEvidence { module: string; kind: string; id?: string; url?: string; label: string; observedAt?: string | null; link?: string }
export interface WsInsight {
  id: string
  rule_id: string
  entity_type: string
  entity_value: string
  title: string
  explanation: string
  action: string
  evidence: WsEvidence[]
  modules: string[]
  observed_from: string | null
  observed_to: string | null
  limitations: string[]
  priority: number
  priority_factors: Array<{ name: string; weight: number; value: number | null; explanation: string }>
  confidence: "high" | "medium" | "low"
  status: "open" | "in_progress" | "resolved" | "dismissed" | "obsolete"
  first_detected_at: string
  last_detected_at: string
  events?: Array<{ event: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string }>
}
export interface WsInsightsMeta { total: number; lastRun: { evaluated_at: string | null; window_from: string; window_to: string; detected: number; skipped_rules: Array<{ ruleId: string; reason: string }> } | null; rules: Record<string, { title: string; modules: string[]; description: string }>; formula: string }
export interface WsHealth { id: string; name: string; state: "healthy" | "stale" | "configuration_required" | "auth_expired" | "provider_unavailable" | "recent_job_failed" | "not_supported" | "unknown"; detail: string; lastSuccessAt: string | null; lastFailureAt: string | null; link: string }
export interface WsReport { title: string; range: WsRange; generatedAt: string; sections: string[]; summary: string[]; completeness: WsOverview["completeness"]; actions: WsAction[] | null; sources: WsHealth[] | null; definitions: string[]; limitations: string[] }

const ws = (websiteId: string, path: string) => `${sitePath(websiteId)}/seo-workspace${path}`
const wsRange = (r: WsRangeParams) => ({ preset: r.preset, from: r.preset === "custom" ? r.from : undefined, to: r.preset === "custom" ? r.to : undefined, compare: r.compare })

export async function apiWsOverview(websiteId: string, range: WsRangeParams) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.overview")
  return apiFetch<WsOverview>(ws(websiteId, `/overview${queryString(wsRange(range))}`)) as WithMeta<WsOverview, { ai: { available: boolean } }>
}
export async function apiWsIntegrations(websiteId: string) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.integrations")
  return apiFetch<WsHealth[]>(ws(websiteId, "/integrations"))
}
export async function apiWsInsights(websiteId: string, params: { status?: string; module?: string; search?: string; limit?: number; offset?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.insights")
  return apiFetch<WsInsight[]>(ws(websiteId, `/insights${queryString({ ...params, limit: params.limit ?? 25 })}`)) as WithMeta<WsInsight[], WsInsightsMeta>
}
export async function apiWsInsight(websiteId: string, insightId: string) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.insight")
  return apiFetch<WsInsight & { formula: string }>(ws(websiteId, `/insights/${encodeURIComponent(insightId)}`))
}
export async function apiWsRefreshInsights(websiteId: string, range: WsRangeParams) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.insights.refresh")
  return apiFetch<{ detected: number; skipped: Array<{ ruleId: string; reason: string }> }>(ws(websiteId, "/insights/refresh"), { method: "POST", body: JSON.stringify(wsRange(range)) })
}
export async function apiWsUpdateInsight(websiteId: string, insightId: string, patch: { status?: string; note?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.insight.update")
  return apiFetch<{ updated: boolean }>(ws(websiteId, `/insights/${encodeURIComponent(insightId)}`), { method: "PATCH", body: JSON.stringify(patch) })
}
export async function apiWsActions(websiteId: string, params: { status?: string; category?: string; source?: string; search?: string; limit?: number; offset?: number } = {}) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.actions")
  return apiFetch<WsAction[]>(ws(websiteId, `/actions${queryString({ ...params, limit: params.limit ?? 25 })}`)) as WithMeta<WsAction[], { total: number; openByCategory: Record<string, number>; effortNote: string }>
}
export async function apiWsUpdateAction(websiteId: string, body: { source: string; sourceRef: string; status?: string; ownerId?: string | null; dueDate?: string | null; note?: string }) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.action.update")
  return apiFetch<{ key: string }>(ws(websiteId, "/actions"), { method: "PATCH", body: JSON.stringify(body) })
}
export async function apiWsActionHistory(websiteId: string, source: string, sourceRef: string) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.action.history")
  return apiFetch<Array<{ event: string; from_value: string | null; to_value: string | null; note: string | null; created_at: string }>>(ws(websiteId, `/actions/history${queryString({ source, sourceRef })}`))
}
export async function apiWsReport(websiteId: string, range: WsRangeParams, sections: string[]) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.report")
  return apiFetch<WsReport>(ws(websiteId, `/report${queryString({ ...wsRange(range), sections: sections.join(",") })}`))
}
export async function apiWsAiSummary(websiteId: string, range: WsRangeParams) {
  if (IS_DEMO) throw new IntegrationRequired("workspace.summary")
  return apiFetch<{ model: string; ai: { summary: string; points: Array<{ statement: string; sources: string[] }>; insufficientEvidence: string[] }; dropped: number; sources: Record<string, string> }>(ws(websiteId, "/summary"), { method: "POST", body: JSON.stringify(wsRange(range)) })
}
/** Downloads a CSV export or the Markdown report. */
export async function apiWsDownload(websiteId: string, kind: { dataset: string } | { report: string[] }, range: WsRangeParams): Promise<{ blob: Blob; filename: string } | { error: string }> {
  if (IS_DEMO || !config.apiBaseUrl) throw new IntegrationRequired("workspace.export")
  const path = "dataset" in kind ? ws(websiteId, `/export${queryString({ ...wsRange(range), dataset: kind.dataset })}`) : ws(websiteId, `/report.md${queryString({ ...wsRange(range), sections: kind.report.join(",") })}`)
  const res = await downloadResponse(`${path}`)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      /* non-JSON error */
    }
    return { error: res.status === 403 ? "Your role cannot export from the SEO workspace." : message }
  }
  const disposition = res.headers.get("content-disposition") ?? ""
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "seo-export" }
}
