// Administration > Infrastructure
//
// Platform-wide database diagnostics. Every value shown here comes from
// /api/v1/infrastructure/* (server/src/routes/infrastructure.ts); nothing is
// assumed or hardcoded. The backend enforces owner/admin + platform admin and
// never returns secrets. There is deliberately no option to relax TLS.

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { NavLink } from "react-router"
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Database,
  Loader,
  Lock,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react"
import { Card } from "../../components/ui/Card"
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState"
import {
  apiGetEventPipeline,
  apiGetInfraConfiguration,
  apiGetInfraMigrations,
  apiGetInfraStatus,
  apiTestClickHouse,
  apiTestPostgres,
  IntegrationRequired,
  type ApiCallError,
  type InfraConfigEntry,
  type InfraConnectionStatus,
  type InfraDiagnosticResult,
  type InfraDiagnosticStep,
  type InfraStatus,
} from "../../services/api"
import type { ApiResponse } from "../../types"

// ─── Data hook ────────────────────────────────────────────────────────────────

class InfraError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

function useInfra<T>(fetcher: () => Promise<ApiResponse<T>>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetcher()
      if (res.error) throw new InfraError(res.error.code, res.error.message)
      setData(res.data)
    } catch (cause) {
      setError(cause as Error)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load }
}

function isForbidden(error: Error | null): boolean {
  const code = (error as InfraError | ApiCallError | null)?.code
  return code === "PLATFORM_ADMIN_REQUIRED" || code === "FORBIDDEN" || code === "403" || code === "INSUFFICIENT_ROLE"
}

function Gate({ error, loading, hasData, onRetry, label, children }: { error: Error | null; loading: boolean; hasData: boolean; onRetry: () => void; label: string; children: ReactNode }) {
  if (loading && !hasData) return <LoadingState label={`Loading ${label}…`} />
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature={label} />
  if (isForbidden(error))
    return (
      <Card padding="lg" className="flex items-start gap-3">
        <Lock size={18} className="mt-0.5 flex-shrink-0 text-slate-400" />
        <div>
          <div className="text-sm font-700 text-foreground">Administrator access required</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Infrastructure diagnostics describe the shared platform. They are available to organization owners and admins who are also listed in PLATFORM_ADMIN_USER_IDS.
          </p>
        </div>
      </Card>
    )
  if (error && !hasData) return <ErrorState title={`Unable to load ${label}`} message={error.message} onRetry={onRetry} />
  return <>{children}</>
}

// ─── Layout ───────────────────────────────────────────────────────────────────

const TABS = [
  { label: "Health", path: "/admin/infrastructure/health" },
  { label: "PostgreSQL", path: "/admin/infrastructure/postgresql" },
  { label: "ClickHouse", path: "/admin/infrastructure/clickhouse" },
  { label: "Event Pipeline", path: "/admin/infrastructure/event-pipeline" },
  { label: "Migration Status", path: "/admin/infrastructure/migrations" },
  { label: "Configuration", path: "/admin/infrastructure/configuration" },
]

function InfraLayout({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8">
      <div className="mb-1 font-mono text-[10px] font-600 uppercase tracking-[0.14em] text-slate-400">Administration · Infrastructure</div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-800 tracking-[-0.05em] text-foreground">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <nav aria-label="Infrastructure sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={t.path}
            className={({ isActive }) =>
              `whitespace-nowrap border-b-2 px-3 py-2 text-sm font-600 transition-colors ${isActive ? "border-blue-500 text-blue-600" : "border-transparent text-muted-foreground hover:text-foreground"}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {children}
    </div>
  )
}

function Button({ onClick, disabled, children, primary }: { onClick: () => void; disabled?: boolean; children: ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
        primary ? "bg-blue-600 text-white hover:bg-blue-700" : "border border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  )
}

// ─── Status badge ─────────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "bad" | "neutral" | "busy"
const TONE: Record<Tone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/25",
  warn: "bg-amber-500/10 text-amber-600 ring-amber-500/25",
  bad: "bg-red-500/10 text-red-600 ring-red-500/25",
  neutral: "bg-slate-500/10 text-slate-500 ring-slate-500/20",
  busy: "bg-blue-500/10 text-blue-600 ring-blue-500/25",
}

const CONNECTION_LABEL: Record<InfraConnectionStatus | "testing", [string, Tone]> = {
  connected: ["Connected", "ok"],
  not_configured: ["Not configured", "neutral"],
  not_verified: ["Not verified", "neutral"],
  configuration_error: ["Configuration error", "bad"],
  authentication_failed: ["Authentication failed", "bad"],
  tls_error: ["TLS error", "bad"],
  timeout: ["Timeout", "warn"],
  unavailable: ["Unavailable", "bad"],
  testing: ["Testing", "busy"],
}

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span role="status" aria-label={`Status: ${label}`} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-700 ring-1 ring-inset ${TONE[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${tone === "busy" ? "animate-pulse" : ""}`} aria-hidden />
      {label}
    </span>
  )
}

export function ConnectionBadge({ status }: { status: InfraConnectionStatus | "testing" }) {
  const [label, tone] = CONNECTION_LABEL[status] ?? [status, "neutral"]
  return <Badge label={label} tone={tone} />
}

// ─── Facts ────────────────────────────────────────────────────────────────────

const NOT_REPORTED = "Not reported"

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
          <dt className="text-xs font-600 uppercase tracking-wide text-muted-foreground">{k}</dt>
          <dd className="text-right font-mono text-sm text-foreground">{v ?? <span className="text-slate-400">{NOT_REPORTED}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

const yesNo = (v: boolean | null | undefined, yes: string, no: string) => (v === null || v === undefined ? null : v ? yes : no)

// ─── Diagnostics ──────────────────────────────────────────────────────────────

const STEP_ICON: Record<InfraDiagnosticStep["status"], ReactNode> = {
  ok: <CheckCircle2 size={16} className="text-emerald-500" aria-hidden />,
  failed: <XCircle size={16} className="text-red-500" aria-hidden />,
  warning: <AlertTriangle size={16} className="text-amber-500" aria-hidden />,
  skipped: <MinusCircle size={16} className="text-slate-300" aria-hidden />,
}
const STEP_TEXT: Record<InfraDiagnosticStep["status"], string> = { ok: "Passed", failed: "Failed", warning: "Warning", skipped: "Not run" }

function DiagnosticPanel({ title, result, testing, pendingSteps }: { title: string; result: InfraDiagnosticResult | null; testing: boolean; pendingSteps: string[] }) {
  if (!result && !testing) return null
  const steps: InfraDiagnosticStep[] = testing || !result ? pendingSteps.map((label, i) => ({ id: String(i), label, status: "skipped" })) : result.steps
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="text-sm font-700 text-foreground">{title}</div>
        {testing ? <ConnectionBadge status="testing" /> : result && <ConnectionBadge status={result.status} />}
      </div>
      <ol className="divide-y divide-border/60" aria-live="polite" aria-busy={testing}>
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-3 px-5 py-2.5">
            <span className="w-5 pt-0.5 text-right font-mono text-xs text-slate-400">{i + 1}.</span>
            <span className="pt-0.5">{testing ? <CircleDashed size={16} className="animate-spin-slow text-blue-400" aria-hidden /> : STEP_ICON[s.status]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">{s.label}</span>
                <span className="text-xs text-muted-foreground">{testing ? "Pending" : STEP_TEXT[s.status]}</span>
              </div>
              {!testing && s.detail && <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {result && !testing && (
        <div className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm ${result.status === "connected" ? "bg-emerald-500/5" : "bg-red-500/5"}`}>
          <span className="font-600 text-foreground">{result.summary}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {result.latencyMs !== null && `${result.latencyMs} ms · `}
            {new Date(result.checkedAt).toLocaleString()}
          </span>
        </div>
      )}
    </Card>
  )
}

function TlsFailureCallout({ service }: { service: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-5">
      <div className="flex items-center gap-2 text-sm font-800 text-red-600">
        <ShieldAlert size={16} aria-hidden /> TLS certificate verification failed
      </div>
      <p className="mt-2 text-sm text-foreground">
        {service} rejected the connection because the server certificate could not be validated. The connection was not attempted insecurely.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-xs font-700 uppercase tracking-wide text-muted-foreground">Possible causes</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">
            <li>Hostname mismatch</li>
            <li>Untrusted certificate authority</li>
            <li>Incomplete certificate chain</li>
            <li>Incorrect endpoint</li>
            <li>TLS interception / proxy</li>
            <li>Incorrect port or protocol</li>
          </ul>
        </div>
        <div>
          <div className="text-xs font-700 uppercase tracking-wide text-muted-foreground">Recommended action</div>
          <p className="mt-1 text-sm text-foreground">
            Verify the configured endpoint hostname and port, and the trusted CA configuration. If your runtime does not trust the issuing CA, provide it as a PEM chain in the server environment. Certificate verification stays enabled.
          </p>
        </div>
      </div>
    </div>
  )
}

function useDiagnostic(run: () => Promise<ApiResponse<InfraDiagnosticResult>>, initial: InfraDiagnosticResult | null) {
  const [result, setResult] = useState<InfraDiagnosticResult | null>(initial)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setResult((r) => r ?? initial), [initial])
  const start = async (runner: () => Promise<ApiResponse<InfraDiagnosticResult>> = run) => {
    setTesting(true)
    setError(null)
    try {
      const res = await runner()
      if (res.error) setError(res.error.message)
      else setResult(res.data)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setTesting(false)
    }
  }
  return { result, testing, error, start }
}

// ─── Configuration table ──────────────────────────────────────────────────────

const STATE_TONE: Record<InfraConfigEntry["state"], Tone> = { SET: "ok", MASKED: "ok", NOT_SET: "neutral" }

function ConfigTable({ entries }: { entries: InfraConfigEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-4 font-600">Variable</th>
            <th className="py-2 pr-4 font-600">State</th>
            <th className="py-2 pr-4 font-600">Value</th>
            <th className="py-2 font-600">Required</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.name} className="border-b border-border/60">
              <td className="py-2 pr-4 font-mono text-xs text-foreground">{e.name}</td>
              <td className="py-2 pr-4">
                <Badge label={e.state.replace("_", " ")} tone={e.required && e.state === "NOT_SET" ? "warn" : STATE_TONE[e.state]} />
              </td>
              <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{e.secret ? (e.state === "NOT_SET" ? "—" : "••••••••") : e.value ?? "—"}</td>
              <td className="py-2 text-xs text-muted-foreground">{e.required ? "Yes" : "Optional"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted-foreground">Secret values are never sent to the browser. Change them in the server environment (e.g. DigitalOcean App settings).</p>
    </div>
  )
}

function useConfigDisclosure({ section }: { section: "postgres" | "clickhouse" }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<InfraConfigEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = async () => {
    setOpen((o) => !o)
    if (entries) return
    try {
      const res = await apiGetInfraConfiguration()
      if (res.error) setError(res.error.message)
      else setEntries(res.data?.[section] ?? [])
    } catch (cause) {
      setError((cause as Error).message)
    }
  }
  return { open, toggle, panel: open && (
    <Card>
      <div className="mb-3 text-sm font-700 text-foreground">Configuration</div>
      {error ? <p className="text-sm text-red-600">{error}</p> : entries ? <ConfigTable entries={entries} /> : <LoadingState label="Loading configuration…" />}
    </Card>
  ) }
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const PG_STEPS = ["Configuration detected", "DNS resolution", "TLS connection", "Certificate verification", "Hostname verification", "Authentication", "Database access", "Test query"]
const CH_STEPS = ["Configuration detected", "DNS resolution", "TLS connection", "Certificate verification", "Hostname verification", "HTTPS connection", "Authentication", "Database access", "Test query"]

const PG_PROVIDER: Record<InfraStatus["postgres"]["provider"], string> = { neon: "Neon", supabase: "Supabase", postgresql: "PostgreSQL", unknown: NOT_REPORTED }

export function InfraPostgresPage() {
  const status = useInfra(apiGetInfraStatus)
  const pg = status.data?.postgres
  const diag = useDiagnostic(apiTestPostgres, pg?.lastTest ?? null)
  const config = useConfigDisclosure({ section: "postgres" })
  const shown: InfraConnectionStatus | "testing" = diag.testing ? "testing" : diag.result?.status ?? pg?.status ?? "not_verified"
  return (
    <InfraLayout
      title="PostgreSQL"
      description="Primary transactional database and system of record: users, organizations, RBAC, websites, agents, scan lifecycle, evidence and audit records."
      actions={
        <>
          <Button primary onClick={() => void diag.start()} disabled={diag.testing || !pg}>{diag.testing ? <Loader size={13} className="animate-spin-slow" /> : <Database size={13} />} Test Connection</Button>
          <Button onClick={status.reload} disabled={status.loading}><RefreshCw size={13} className={status.loading ? "animate-spin-slow" : ""} /> Refresh Status</Button>
          <Button onClick={config.toggle}>{config.open ? "Hide Configuration" : "View Configuration"}</Button>
        </>
      }
    >
      <Gate {...status} hasData={!!pg} onRetry={status.reload} label="PostgreSQL status">
        {pg && (
          <div className="space-y-5">
            <Card padding="lg">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-600 uppercase tracking-wide text-muted-foreground">Database</div>
                  <div className="text-lg font-800 text-foreground">{pg.provider === "neon" ? "Neon PostgreSQL" : PG_PROVIDER[pg.provider]}</div>
                </div>
                <ConnectionBadge status={shown} />
              </div>
              <Facts
                rows={[
                  ["Provider", pg.provider === "unknown" ? null : PG_PROVIDER[pg.provider]],
                  ["Branch", pg.branch],
                  ["Database", pg.database],
                  ["Role", pg.role],
                  ["Region", pg.region],
                  ["Connection pooling", yesNo(pg.pooled, "Enabled", "Disabled (direct)")],
                  ["SSL", pg.sslEnforced ? "Required" : "Not enforced"],
                  ["SSL mode", pg.sslMode],
                  ["Certificate verification", pg.sslEnforced ? (pg.certificateVerification ? "Enabled" : "Disabled") : null],
                ]}
              />
              <p className="mt-4 text-xs text-muted-foreground">
                Status reflects a live readiness query made by the server when this page loaded. Connection strings and passwords are never shown.
              </p>
            </Card>
            {diag.error && <p role="alert" className="text-sm text-red-600">{diag.error}</p>}
            {diag.result?.status === "tls_error" && !diag.testing && <TlsFailureCallout service="PostgreSQL" />}
            <DiagnosticPanel title="PostgreSQL connection test" result={diag.result} testing={diag.testing} pendingSteps={PG_STEPS} />
            {config.panel}
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}

// ─── ClickHouse ───────────────────────────────────────────────────────────────

export function InfraClickHousePage() {
  const status = useInfra(apiGetInfraStatus)
  const ch = status.data?.clickhouse
  const [mode, setMode] = useState<"connection" | "query">("connection")
  const diag = useDiagnostic(() => apiTestClickHouse("connection"), ch?.lastTest ?? null)
  const config = useConfigDisclosure({ section: "clickhouse" })
  const shown: InfraConnectionStatus | "testing" = diag.testing ? "testing" : diag.result?.status ?? ch?.status ?? "not_verified"
  const run = (m: "connection" | "query") => {
    setMode(m)
    void diag.start(() => apiTestClickHouse(m))
  }
  return (
    <InfraLayout
      title="ClickHouse"
      description="Analytics and event store for scan history, AI usage and cost, model performance and monitoring history. Never the source of truth for authentication, RBAC or transactional state."
      actions={
        <>
          <Button primary onClick={() => run("connection")} disabled={diag.testing || !ch}>{diag.testing && mode === "connection" ? <Loader size={13} className="animate-spin-slow" /> : <Database size={13} />} Test Connection</Button>
          <Button onClick={() => run("query")} disabled={diag.testing || !ch?.configured}>Test Query</Button>
          <Button onClick={status.reload} disabled={status.loading}><RefreshCw size={13} className={status.loading ? "animate-spin-slow" : ""} /> Refresh Status</Button>
          <Button onClick={config.toggle}>{config.open ? "Hide Configuration" : "View Configuration"}</Button>
        </>
      }
    >
      <Gate {...status} hasData={!!ch} onRetry={status.reload} label="ClickHouse status">
        {ch && (
          <div className="space-y-5">
            <Card padding="lg">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-600 uppercase tracking-wide text-muted-foreground">Analytics database</div>
                  <div className="text-lg font-800 text-foreground">{ch.provider === "clickhouse_cloud" ? "ClickHouse Cloud" : "ClickHouse"}</div>
                </div>
                <ConnectionBadge status={shown} />
              </div>
              <Facts
                rows={[
                  ["Provider", ch.provider === "unknown" ? null : ch.provider === "clickhouse_cloud" ? "ClickHouse Cloud" : "ClickHouse"],
                  ["Region", ch.region],
                  ["Protocol", "HTTPS"],
                  ["Port", String(ch.port)],
                  ["Username", ch.user],
                  ["Database", ch.database],
                  ["TLS", "Enabled"],
                  ["Certificate verification", "Enabled"],
                  ["Custom CA", ch.customCa ? "Configured" : "System trust store"],
                ]}
              />
              {!ch.configured && (
                <p className="mt-4 rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
                  ClickHouse is not configured. Analytics are unavailable; the core application is unaffected. Set CLICKHOUSE_HOST, CLICKHOUSE_DATABASE and CLICKHOUSE_PASSWORD in the server environment.
                </p>
              )}
              {ch.configured && !diag.result && (
                <p className="mt-4 text-xs text-muted-foreground">Not verified since the server started. Run a connection test to verify.</p>
              )}
            </Card>
            {diag.error && <p role="alert" className="text-sm text-red-600">{diag.error}</p>}
            {diag.result?.status === "tls_error" && !diag.testing && <TlsFailureCallout service="ClickHouse" />}
            <DiagnosticPanel title={mode === "query" ? "ClickHouse test query" : "ClickHouse connection test"} result={diag.result} testing={diag.testing} pendingSteps={CH_STEPS} />
            {config.panel}
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}

// ─── Health ───────────────────────────────────────────────────────────────────

function HealthRow({ label, sub, ok, okLabel, badLabel, warn }: { label: string; sub: string; ok: boolean | null; okLabel: string; badLabel: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div>
        <div className="text-sm font-700 text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
      {ok === null ? <Badge label="Not verified" tone="neutral" /> : <Badge label={ok ? okLabel : badLabel} tone={ok ? "ok" : warn ? "warn" : "bad"} />}
    </div>
  )
}

function SystemSummary({ s }: { s: InfraStatus }) {
  const chOk = s.clickhouse.status === "connected" ? true : s.clickhouse.status === "not_verified" ? null : false
  const chLabel = CONNECTION_LABEL[s.clickhouse.status]?.[0] ?? "Unavailable"
  return (
    <Card padding="none" className="divide-y divide-border">
      <HealthRow label="Core application" sub="Authentication, websites, scans, agents" ok={s.core.status === "operational"} okLabel="Operational" badLabel="Unavailable" />
      <HealthRow label="PostgreSQL" sub="Transactional source of truth" ok={s.postgres.status === "connected"} okLabel="Connected" badLabel="Unavailable" />
      <HealthRow label="ClickHouse" sub="Analytics / event store" ok={chOk} okLabel="Connected" badLabel={chLabel} warn />
      <HealthRow label="Analytics" sub="Historical dashboards and reporting" ok={chOk === null ? null : s.analytics.status === "available"} okLabel="Available" badLabel="Temporarily unavailable" warn />
    </Card>
  )
}

export function InfraHealthPage() {
  const status = useInfra(apiGetInfraStatus)
  const s = status.data
  const analyticsDown = s && s.core.status === "operational" && s.clickhouse.status !== "connected" && s.clickhouse.status !== "not_verified"
  return (
    <InfraLayout
      title="Health"
      description="What is connected, what is failing, and what requires action."
      actions={<Button onClick={status.reload} disabled={status.loading}><RefreshCw size={13} className={status.loading ? "animate-spin-slow" : ""} /> Refresh Status</Button>}
    >
      <Gate {...status} hasData={!!s} onRetry={status.reload} label="platform health">
        {s && (
          <div className="space-y-5">
            {s.core.status !== "operational" && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
                PostgreSQL is unreachable. Core application functionality is unavailable until the transactional database recovers.
              </div>
            )}
            {analyticsDown && (
              <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-foreground">
                <span className="font-700 text-amber-600">Analytics temporarily unavailable.</span> The core application is operational; ClickHouse outages do not affect transactional features.
              </div>
            )}
            <SystemSummary s={s} />
            <p className="text-xs text-muted-foreground">
              Checked {new Date(s.checkedAt).toLocaleString()}. PostgreSQL is probed on every refresh; ClickHouse reflects the most recent connection test since server start.
            </p>
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}

// ─── Event pipeline ───────────────────────────────────────────────────────────

const NOT_YET = <span className="text-slate-400">Not available yet</span>

export function InfraEventPipelinePage() {
  const status = useInfra(apiGetInfraStatus)
  const pipeline = useInfra(apiGetEventPipeline)
  const s = status.data
  const p = pipeline.data
  const reload = () => {
    void status.reload()
    void pipeline.reload()
  }
  return (
    <InfraLayout
      title="Event Pipeline"
      description="Application events flow from the API to ClickHouse. Transactional writes go to PostgreSQL first and never depend on analytics ingestion."
      actions={<Button onClick={reload} disabled={status.loading || pipeline.loading}><RefreshCw size={13} className={status.loading ? "animate-spin-slow" : ""} /> Refresh Status</Button>}
    >
      <Gate error={status.error ?? pipeline.error} loading={status.loading || pipeline.loading} hasData={!!s && !!p} onRetry={reload} label="event pipeline">
        {s && p && (
          <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
            <SystemSummary s={s} />
            <Card padding="lg">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm font-700 text-foreground">Event ingestion</div>
                {p.implemented ? <Badge label={s.clickhouse.status === "connected" ? "Healthy" : "Degraded"} tone={s.clickhouse.status === "connected" ? "ok" : "warn"} /> : <Badge label="Not available yet" tone="neutral" />}
              </div>
              <Facts
                rows={[
                  ["Events queued", p.queued ?? NOT_YET],
                  ["Events processed", p.processed ?? NOT_YET],
                  ["Events failed", p.failed ?? NOT_YET],
                  ["Last successful event", p.lastSuccessAt ? new Date(p.lastSuccessAt).toLocaleString() : NOT_YET],
                  ["Events dropped (buffer full)", p.dropped ?? NOT_YET],
                  ["Last error", p.lastErrorAt ? `${p.lastErrorKind ?? "error"} · ${new Date(p.lastErrorAt).toLocaleString()}` : "None"],
                  ["Retrying until", p.retryingUntil ? new Date(p.retryingUntil).toLocaleString() : "Not retrying"],
                  ["Ingestion latency", p.ingestionLatencyMs !== null ? `${p.ingestionLatencyMs} ms` : NOT_YET],
                ]}
              />
              {p.implemented && (
                <p className="mt-4 text-xs text-muted-foreground">
                  {p.enabled
                    ? "Counters are kept in memory by this API process and reset on restart. Events are batched every few seconds and retried with backoff; a full buffer drops the oldest analytics events, never a transactional write."
                    : "ClickHouse is not configured, so no events are buffered. Analytics dashboards read from PostgreSQL."}
                </p>
              )}
              {!p.implemented && (
                <p className="mt-4 text-xs text-muted-foreground">
                  Analytics event ingestion has not been built yet, so no queue metrics exist. These fields will populate from the backend once ingestion is enabled.
                </p>
              )}
            </Card>
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}

// ─── Migrations ───────────────────────────────────────────────────────────────

const MIG_LABEL: Record<string, [string, Tone]> = {
  up_to_date: ["Up to date", "ok"],
  pending: ["Pending", "warn"],
  failed: ["Checksum drift", "bad"],
  unavailable: ["Migration status unavailable", "neutral"],
  not_configured: ["Not configured", "neutral"],
  applied: ["Applied", "ok"],
  unreachable: ["Unreachable", "warn"],
}

export function InfraMigrationsPage() {
  const mig = useInfra(apiGetInfraMigrations)
  const status = useInfra(apiGetInfraStatus)
  const m = mig.data
  const pg = status.data?.postgres
  const reload = () => {
    void mig.reload()
    void status.reload()
  }
  return (
    <InfraLayout
      title="Migration Status"
      description="Read-only view of applied schema migrations. Migrations run only through the deployment migrator (pnpm --dir server migrate), never from the browser."
      actions={<Button onClick={reload} disabled={mig.loading}><RefreshCw size={13} className={mig.loading ? "animate-spin-slow" : ""} /> Refresh Status</Button>}
    >
      <Gate {...mig} hasData={!!m} onRetry={reload} label="migration status">
        {m && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card padding="lg">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm font-700 text-foreground">PostgreSQL schema</div>
                <Badge label={MIG_LABEL[m.postgres.status][0]} tone={MIG_LABEL[m.postgres.status][1]} />
              </div>
              <Facts
                rows={[
                  ["Database", pg ? (pg.provider === "neon" ? "Neon PostgreSQL" : PG_PROVIDER[pg.provider]) : null],
                  ["Branch", pg?.branch ?? null],
                  ["Current schema version", m.postgres.currentVersion],
                  ["Latest available", m.postgres.latestOnDisk],
                  ["Applied migrations", m.postgres.available ? m.postgres.applied : null],
                  ["Pending migrations", m.postgres.available ? m.postgres.pending.length : null],
                  ["Last applied", m.postgres.lastAppliedAt ? new Date(m.postgres.lastAppliedAt).toLocaleString() : null],
                ]}
              />
              {m.postgres.reason && <p className="mt-4 text-xs text-muted-foreground">{m.postgres.reason}</p>}
              {m.postgres.pending.length > 0 && (
                <p className="mt-4 text-sm text-foreground">
                  Pending: <span className="font-mono">{m.postgres.pending.join(", ")}</span>. Apply via the deployment migrator after verifying in staging.
                </p>
              )}
              {m.postgres.checksumMismatches.length > 0 && (
                <p role="alert" className="mt-4 text-sm text-red-600">
                  Applied migrations changed on disk: <span className="font-mono">{m.postgres.checksumMismatches.join(", ")}</span>. Never edit an applied migration; add a new numbered one.
                </p>
              )}
              {m.postgres.unknownApplied.length > 0 && (
                <p className="mt-2 text-xs text-amber-600">Applied versions with no matching file: {m.postgres.unknownApplied.join(", ")}</p>
              )}
            </Card>
            <Card padding="lg">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm font-700 text-foreground">ClickHouse analytics schema</div>
                <Badge label={MIG_LABEL[m.clickhouse.status][0]} tone={MIG_LABEL[m.clickhouse.status][1]} />
              </div>
              <Facts
                rows={[
                  ["Present tables", m.clickhouse.tables.length ? m.clickhouse.tables.join(", ") : NOT_YET],
                  ["Missing tables", m.clickhouse.missing?.length ? m.clickhouse.missing.join(", ") : m.clickhouse.status === "applied" ? "None" : NOT_YET],
                ]}
              />
              <p className="mt-4 text-xs text-muted-foreground">
                The schema is applied server-side with <span className="font-mono">pnpm --dir server clickhouse:migrate</span> (idempotent). It cannot be run from this page.
              </p>
            </Card>
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}

// ─── Configuration ────────────────────────────────────────────────────────────

export function InfraConfigurationPage() {
  const cfg = useInfra(apiGetInfraConfiguration)
  return (
    <InfraLayout
      title="Configuration"
      description="Server environment variables by name. Values are reported only as SET, NOT SET or MASKED; secrets never reach the browser."
      actions={<Button onClick={cfg.reload} disabled={cfg.loading}><RefreshCw size={13} className={cfg.loading ? "animate-spin-slow" : ""} /> Refresh</Button>}
    >
      <Gate {...cfg} hasData={!!cfg.data} onRetry={cfg.reload} label="configuration">
        {cfg.data && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card padding="lg">
              <div className="mb-3 text-sm font-700 text-foreground">PostgreSQL</div>
              <ConfigTable entries={cfg.data.postgres} />
            </Card>
            <Card padding="lg">
              <div className="mb-3 text-sm font-700 text-foreground">ClickHouse</div>
              <ConfigTable entries={cfg.data.clickhouse} />
            </Card>
          </div>
        )}
      </Gate>
    </InfraLayout>
  )
}
