import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { NavLink } from "react-router"
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { AlertOctagon, AlertTriangle, BarChart3, CheckCircle2, Info, RefreshCw } from "lucide-react"
import { Card } from "../../components/ui/Card"
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState"
import {
  IntegrationRequired,
  apiGetAnalyticsAi,
  apiGetAnalyticsMonitoring,
  apiGetAnalyticsOverview,
  apiGetAnalyticsRouting,
  apiGetAnalyticsScans,
  type AiAggregate,
  type AnalyticsFilters,
  type KeyCount,
} from "../../services/api"
import type { ApiResponse } from "../../types"

// Organization scope is never sent from here: the API derives it from the
// verified x-org-id membership. Filters below only narrow within that org.

const NO_DATA = "No analytics data available yet"
const NOT_YET = "Not available yet"

// Reference data-viz palette (validated). Text never wears these colors.
const SERIES = "#2a78d6"
const SERIES_2 = "#eb6834"
const SEVERITY: Record<string, { color: string; icon: ReactNode }> = {
  critical: { color: "#d03b3b", icon: <AlertOctagon size={12} /> },
  high: { color: "#ec835a", icon: <AlertTriangle size={12} /> },
  medium: { color: "#fab219", icon: <AlertTriangle size={12} /> },
  low: { color: "#86b6ef", icon: <Info size={12} /> },
  info: { color: "#a3a29c", icon: <Info size={12} /> },
}
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]

// ─── Formatting ───────────────────────────────────────────────────────────────

const fmtInt = (n: number) => n.toLocaleString()
const fmtPct = (r: number | null) => (r === null ? NOT_YET : `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1)}%`)
const fmtMs = (n: number | null) => (n === null ? NOT_YET : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`)
const fmtCost = (n: number | null) => (n === null ? NOT_YET : `$${n.toFixed(2)}`)
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

/** Backend returns only days with activity; fill gaps so the time axis is honest. */
function fillDays<T extends { date: string }>(rows: T[], days: number, empty: Omit<T, "date">): T[] {
  const by = new Map(rows.map((r) => [r.date, r]))
  const out: T[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i))
    const key = d.toISOString().slice(0, 10)
    out.push(by.get(key) ?? ({ ...empty, date: key } as T))
  }
  return out
}
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

// ─── Data hook ────────────────────────────────────────────────────────────────

function useAnalytics<T>(fetcher: (f: AnalyticsFilters) => Promise<ApiResponse<T>>, filters: AnalyticsFilters) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(filters)
  const seq = useRef(0)
  const load = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetcher(JSON.parse(key) as AnalyticsFilters)
      if (id !== seq.current) return
      if (res.error) throw new Error(res.error.message)
      setData(res.data)
    } catch (cause) {
      if (id === seq.current) setError(cause as Error)
    } finally {
      if (id === seq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load }
}

function Gate({ state, label, children }: { state: { data: unknown; error: Error | null; loading: boolean; reload: () => void }; label: string; children: ReactNode }) {
  if (state.loading && !state.data) return <LoadingState label={`Loading ${label}…`} />
  if (state.error instanceof IntegrationRequired) return <IntegrationRequiredState feature={label} />
  if (state.error && !state.data) return <ErrorState title={`Unable to load ${label}`} message={state.error.message} onRetry={state.reload} />
  return <div className={state.loading ? "opacity-60 transition-opacity" : "transition-opacity"}>{children}</div>
}

// ─── Layout ───────────────────────────────────────────────────────────────────

const TABS = [
  { label: "Overview", path: "/analytics/overview" },
  { label: "AI Usage", path: "/analytics/ai" },
  { label: "Model Routing", path: "/analytics/routing" },
  { label: "Scans", path: "/analytics/scans" },
  { label: "Monitoring", path: "/analytics/monitoring" },
]

function Layout({ title, description, filters, onRefresh, loading, children }: { title: string; description: string; filters: ReactNode; onRefresh: () => void; loading: boolean; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8">
      <div className="mb-1 font-mono text-[10px] font-600 uppercase tracking-[0.14em] text-slate-400">Analytics</div>
      <div className="mb-5">
        <h2 className="text-3xl font-800 tracking-[-0.05em] text-foreground">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <nav aria-label="Analytics sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
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
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {filters}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-600 text-foreground hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-white/5"
        >
          <RefreshCw size={12} className={loading ? "animate-spin-slow" : ""} /> Refresh
        </button>
      </div>
      {children}
    </div>
  )
}

const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
]

function RangeControl({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.days}
          type="button"
          aria-pressed={days === r.days}
          onClick={() => onChange(r.days)}
          className={`rounded-md px-2.5 py-1 text-xs font-600 transition-colors ${days === r.days ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "text-muted-foreground hover:text-foreground"}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

function SelectFilter({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[12rem] bg-transparent text-xs font-600 text-foreground outline-none">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Remembers every option seen so a filter does not shrink its own choices. */
function useOptions(keys: string[] | undefined) {
  const [seen, setSeen] = useState<string[]>([])
  useEffect(() => {
    if (!keys?.length) return
    setSeen((prev) => {
      const next = [...new Set([...prev, ...keys])].sort()
      return next.length === prev.length ? prev : next
    })
  }, [keys])
  return seen.map((k) => ({ value: k, label: k }))
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  const muted = value === NOT_YET
  return (
    <Card padding="md">
      <div className="text-[11px] font-600 uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={`mt-1.5 tabular-nums ${muted ? "text-sm font-600 text-muted-foreground" : "text-2xl font-800 tracking-[-0.03em] text-foreground"}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  )
}

function Panel({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <Card padding="lg" className={className}>
      <div className="mb-4">
        <div className="text-sm font-700 text-foreground">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </Card>
  )
}

function NoData({ description }: { description?: string }) {
  return <EmptyState icon={<BarChart3 size={18} className="text-slate-400" />} title={NO_DATA} description={description} />
}

function ChartTooltip({ active, payload, label, rows }: { active?: boolean; payload?: { payload: Record<string, number | string> }[]; label?: string; rows: { key: string; label: string; color?: string; fmt?: (n: number) => string }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-700 text-foreground">{label ? shortDate(label) : ""}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-muted-foreground">
          {r.color && <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />}
          <span>{r.label}</span>
          <span className="ml-auto pl-3 font-600 tabular-nums text-foreground">{(r.fmt ?? fmtInt)(Number(p[r.key] ?? 0))}</span>
        </div>
      ))}
    </div>
  )
}

const axis = { stroke: "currentColor", tick: { fontSize: 11, fill: "currentColor" }, tickLine: false, axisLine: false } as const

function DailyBars({ data, dataKey, label, tooltipRows }: { data: Record<string, number | string>[]; dataKey: string; label: string; tooltipRows?: { key: string; label: string; color?: string }[] }) {
  return (
    <div className="h-56 text-slate-400" role="img" aria-label={`${label} per day`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="date" {...axis} tickFormatter={shortDate} minTickGap={24} />
          <YAxis {...axis} allowDecimals={false} width={44} />
          <Tooltip cursor={{ fill: "currentColor", fillOpacity: 0.08 }} content={<ChartTooltip rows={tooltipRows ?? [{ key: dataKey, label, color: SERIES }]} />} />
          <Bar dataKey={dataKey} fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function DailyLines({ data, lines }: { data: Record<string, number | string>[]; lines: { key: string; label: string; color: string }[] }) {
  return (
    <>
      {lines.length > 1 && (
        <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
          {lines.map((l) => (
            <span key={l.key} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="h-56 text-slate-400" role="img" aria-label={lines.map((l) => l.label).join(" and ") + " per day"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeOpacity={0.15} />
            <XAxis dataKey="date" {...axis} tickFormatter={shortDate} minTickGap={24} />
            <YAxis {...axis} allowDecimals={false} width={44} />
            <Tooltip cursor={{ stroke: "currentColor", strokeOpacity: 0.3 }} content={<ChartTooltip rows={lines} />} />
            {lines.map((l) => (
              <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card, #fff)" }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

/** Ranked horizontal bars in HTML: readable labels, a value on every row, one hue. */
function RankedBars({ rows, fmt = fmtInt, colorOf }: { rows: { key: string; label?: string; value: number }[]; fmt?: (n: number) => string; colorOf?: (key: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label ?? r.key}: ${fmt(r.value)}`} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-foreground">{r.label ?? r.key}</span>
            <span className="font-600 tabular-nums text-muted-foreground group-hover:text-foreground">{fmt(r.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 dark:bg-white/5">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${(r.value / max) * 100}%`, background: colorOf?.(r.key) ?? SERIES }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function SeverityBars({ rows }: { rows: KeyCount[] }) {
  const by = new Map(rows.map((r) => [r.key, r.count]))
  const total = rows.reduce((s, r) => s + r.count, 0)
  if (!total) return <NoData description="No findings recorded in this period." />
  return (
    <>
      <div className="mb-4 flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Findings by severity">
        {SEVERITY_ORDER.filter((s) => by.get(s)).map((s) => (
          <div key={s} title={`${s}: ${by.get(s)}`} style={{ flexGrow: by.get(s), background: SEVERITY[s].color }} />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
        {SEVERITY_ORDER.map((s) => (
          <li key={s} className="text-xs">
            <div className="flex items-center gap-1.5 capitalize text-muted-foreground">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded text-white" style={{ background: SEVERITY[s].color }}>
                {SEVERITY[s].icon}
              </span>
              {s}
            </div>
            <div className="mt-0.5 text-lg font-800 tabular-nums text-foreground">{fmtInt(by.get(s) ?? 0)}</div>
          </li>
        ))}
      </ul>
    </>
  )
}

function DataTable({ columns, rows }: { columns: { key: string; label: string; align?: "right" }[]; rows: Record<string, ReactNode>[] }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-2 py-2 font-600 ${c.align === "right" ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0 hover:bg-slate-50 dark:hover:bg-white/5">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-2 ${c.align === "right" ? "text-right tabular-nums" : "max-w-[18rem] truncate font-mono text-[11px]"} text-foreground`}>
                  {r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SourceNote({ children }: { children?: ReactNode }) {
  return (
    <p className="mt-6 text-xs text-muted-foreground">
      Computed from PostgreSQL (the system of record) for your organization only. {children}
    </p>
  )
}

const EMPTY_AI: Omit<AiAggregate, never> = { executions: 0, completed: 0, failed: 0, failureRate: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: null, p95LatencyMs: null, costUsd: null }

// ─── Overview ─────────────────────────────────────────────────────────────────

export function AnalyticsOverviewPage() {
  const [days, setDays] = useState(30)
  const state = useAnalytics(apiGetAnalyticsOverview, { days })
  const d = state.data
  const scanDaily = useMemo(() => (d ? fillDays(d.scanDaily, days, { scans: 0, failed: 0 }) : []), [d, days])
  const aiDaily = useMemo(() => (d ? fillDays(d.aiDaily, days, { executions: 0, failed: 0, totalTokens: 0 }) : []), [d, days])
  return (
    <Layout title="Overview" description="Scans, findings, AI executions and monitoring for your organization." filters={<RangeControl days={days} onChange={setDays} />} onRefresh={state.reload} loading={state.loading}>
      <Gate state={state} label="analytics overview">
        {d && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Scans today" value={fmtInt(d.scans.today)} hint={`${fmtInt(d.scans.week)} this week · ${fmtInt(d.scans.month)} in 30 days`} />
              <Stat label="AI executions" value={fmtInt(d.ai.executions)} hint={d.ai.executions ? `${fmtPct(d.ai.failureRate)} failure rate` : undefined} />
              <Stat label="Tokens" value={d.ai.executions ? fmtTokens(d.ai.totalTokens) : NOT_YET} />
              <Stat label="Monitoring availability" value={fmtPct(d.monitoring.availability)} hint={d.monitoring.runs ? `${fmtInt(d.monitoring.openIncidents)} open incidents` : undefined} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Panel title="Scans per day" subtitle={`Last ${days} days`}>
                {d.scanDaily.length ? <DailyBars data={scanDaily} dataKey="scans" label="Scans" tooltipRows={[{ key: "scans", label: "Scans", color: SERIES }, { key: "failed", label: "Failed" }]} /> : <NoData />}
              </Panel>
              <Panel title="AI executions per day" subtitle={`Last ${days} days`}>
                {d.aiDaily.length ? <DailyLines data={aiDaily} lines={[{ key: "executions", label: "Executions", color: SERIES }, { key: "failed", label: "Failed", color: SERIES_2 }]} /> : <NoData />}
              </Panel>
              <Panel title="Findings by severity" subtitle={`Last ${days} days`} className="lg:col-span-2">
                <SeverityBars rows={d.findingsBySeverity} />
              </Panel>
            </div>
            <SourceNote />
          </>
        )}
      </Gate>
    </Layout>
  )
}

// ─── AI Usage ─────────────────────────────────────────────────────────────────

export function AnalyticsAiPage() {
  const [days, setDays] = useState(30)
  const [provider, setProvider] = useState("")
  const [model, setModel] = useState("")
  const [agent, setAgent] = useState("")
  const state = useAnalytics(apiGetAnalyticsAi, { days, provider, model, agent })
  const d = state.data
  const providers = useOptions(useMemo(() => d?.byProvider.map((r) => r.key), [d]))
  const models = useOptions(useMemo(() => d?.byModel.map((r) => r.key), [d]))
  const agents = useOptions(useMemo(() => d?.byAgent.map((r) => r.key), [d]))
  const daily = useMemo(() => (d ? fillDays(d.daily, days, EMPTY_AI) : []), [d, days])
  const t = d?.totals
  return (
    <Layout
      title="AI Usage"
      description="Executions, tokens, latency and failures across providers, models and agents."
      onRefresh={state.reload}
      loading={state.loading}
      filters={
        <>
          <RangeControl days={days} onChange={setDays} />
          <SelectFilter label="Provider" value={provider} options={providers} onChange={setProvider} />
          <SelectFilter label="Model" value={model} options={models} onChange={setModel} />
          <SelectFilter label="Agent" value={agent} options={agents} onChange={setAgent} />
        </>
      }
    >
      <Gate state={state} label="AI usage">
        {d && t && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Executions" value={fmtInt(t.executions)} />
              <Stat label="Total tokens" value={t.executions ? fmtTokens(t.totalTokens) : NOT_YET} hint={t.executions ? `${fmtTokens(t.promptTokens)} in · ${fmtTokens(t.completionTokens)} out` : undefined} />
              <Stat label="Estimated cost" value={fmtCost(t.costUsd)} hint={t.costUsd === null && t.executions ? "Pricing not recorded" : undefined} />
              <Stat label="Avg latency" value={fmtMs(t.avgLatencyMs)} hint={t.p95LatencyMs !== null ? `p95 ${fmtMs(t.p95LatencyMs)}` : undefined} />
              <Stat label="Failure rate" value={fmtPct(t.failureRate)} hint={t.executions ? `${fmtInt(t.failed)} failed` : undefined} />
            </div>
            {t.executions === 0 ? (
              <Card padding="lg" className="mt-4">
                <NoData description="AI executions appear here once scans run AI analysis." />
              </Card>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <Panel title="Executions per day" className="lg:col-span-2">
                  <DailyLines data={daily} lines={[{ key: "executions", label: "Executions", color: SERIES }, { key: "failed", label: "Failed", color: SERIES_2 }]} />
                </Panel>
                <Panel title="Tokens by model">
                  <RankedBars rows={d.byModel.map((r) => ({ key: r.key, value: r.totalTokens }))} fmt={fmtTokens} />
                </Panel>
                <Panel title="Executions by provider">
                  <RankedBars rows={d.byProvider.map((r) => ({ key: r.key, value: r.executions }))} />
                </Panel>
                <Panel title="By agent" className="lg:col-span-2">
                  <DataTable
                    columns={[
                      { key: "key", label: "Agent" },
                      { key: "executions", label: "Executions", align: "right" },
                      { key: "tokens", label: "Tokens", align: "right" },
                      { key: "latency", label: "Avg latency", align: "right" },
                      { key: "failure", label: "Failure rate", align: "right" },
                      { key: "cost", label: "Cost", align: "right" },
                    ]}
                    rows={d.byAgent.map((r) => ({ key: r.key, executions: fmtInt(r.executions), tokens: fmtTokens(r.totalTokens), latency: fmtMs(r.avgLatencyMs), failure: fmtPct(r.failureRate), cost: fmtCost(r.costUsd) }))}
                  />
                </Panel>
              </div>
            )}
            <SourceNote>{d.pricingNote}</SourceNote>
          </>
        )}
      </Gate>
    </Layout>
  )
}

// ─── Model routing ────────────────────────────────────────────────────────────

export function AnalyticsRoutingPage() {
  const [days, setDays] = useState(30)
  const state = useAnalytics(apiGetAnalyticsRouting, { days })
  const d = state.data
  const t = d?.totals
  return (
    <Layout title="Model Routing" description="Which models the router selected, how often it fell back, and how those models performed." filters={<RangeControl days={days} onChange={setDays} />} onRefresh={state.reload} loading={state.loading}>
      <Gate state={state} label="routing analytics">
        {d && t && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Routing decisions" value={fmtInt(t.decisions)} />
              <Stat label="Resolved" value={t.decisions ? fmtInt(t.resolved) : NOT_YET} />
              <Stat label="Fallback rate" value={fmtPct(t.fallbackRate)} hint={t.decisions ? `${fmtInt(t.fallbacks)} fallbacks` : undefined} />
              <Stat label="Avg decision time" value={fmtMs(t.avgDecisionMs)} />
            </div>
            <Panel title="Selected models" subtitle="Execution outcomes are joined per model for the same period." className="mt-4">
              {d.models.length ? (
                <DataTable
                  columns={[
                    { key: "model", label: "Model" },
                    { key: "decisions", label: "Selected", align: "right" },
                    { key: "fallbacks", label: "Fallbacks", align: "right" },
                    { key: "success", label: "Success rate", align: "right" },
                    { key: "latency", label: "Avg latency", align: "right" },
                    { key: "tokens", label: "Tokens", align: "right" },
                    { key: "cost", label: "Cost", align: "right" },
                  ]}
                  rows={d.models.map((m) => ({ model: m.model, decisions: fmtInt(m.decisions), fallbacks: fmtInt(m.fallbacks), success: fmtPct(m.successRate), latency: fmtMs(m.avgLatencyMs), tokens: m.executions ? fmtTokens(m.tokens) : NOT_YET, cost: fmtCost(m.costUsd) }))}
                />
              ) : (
                <NoData description="Routing decisions appear once AI tasks are routed." />
              )}
            </Panel>
            <SourceNote>Costs come from the backend model registry; prices are never set in the browser.</SourceNote>
          </>
        )}
      </Gate>
    </Layout>
  )
}

// ─── Scans ────────────────────────────────────────────────────────────────────

export function AnalyticsScansPage() {
  const [days, setDays] = useState(30)
  const [severity, setSeverity] = useState("")
  const [module, setModule] = useState("")
  const [websiteId, setWebsiteId] = useState("")
  const state = useAnalytics(apiGetAnalyticsScans, { days, severity, module, websiteId })
  const d = state.data
  const modules = useOptions(useMemo(() => d?.findingsByModule.map((r) => r.key), [d]))
  const [sites, setSites] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    if (!d?.findingsByWebsite.length) return
    setSites((prev) => {
      const m = new Map(prev.map((s) => [s.value, s]))
      for (const w of d.findingsByWebsite) m.set(w.key, { value: w.key, label: w.label ?? w.key })
      return [...m.values()]
    })
  }, [d])
  const daily = useMemo(() => (d ? fillDays(d.daily, days, { scans: 0, failed: 0 }) : []), [d, days])
  return (
    <Layout
      title="Scans"
      description="Scan volume and what the scans found, by severity, category, website and module."
      onRefresh={state.reload}
      loading={state.loading}
      filters={
        <>
          <RangeControl days={days} onChange={setDays} />
          <SelectFilter label="Severity" value={severity} options={SEVERITY_ORDER.map((s) => ({ value: s, label: s }))} onChange={setSeverity} />
          <SelectFilter label="Module" value={module} options={modules} onChange={setModule} />
          <SelectFilter label="Website" value={websiteId} options={sites} onChange={setWebsiteId} />
        </>
      }
    >
      <Gate state={state} label="scan analytics">
        {d && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Today" value={fmtInt(d.counts.today)} />
              <Stat label="This week" value={fmtInt(d.counts.week)} />
              <Stat label="Last 30 days" value={fmtInt(d.counts.month)} />
              <Stat label="Failed (30 days)" value={fmtInt(d.counts.failedMonth)} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Panel title="Scans per day" className="lg:col-span-2">
                {d.daily.length ? <DailyBars data={daily} dataKey="scans" label="Scans" tooltipRows={[{ key: "scans", label: "Scans", color: SERIES }, { key: "failed", label: "Failed" }]} /> : <NoData />}
              </Panel>
              <Panel title="Findings by severity" className="lg:col-span-2">
                <SeverityBars rows={d.findingsBySeverity} />
              </Panel>
              <Panel title="Findings by category">{d.findingsByCategory.length ? <RankedBars rows={d.findingsByCategory.map((r) => ({ key: r.key, value: r.count }))} /> : <NoData />}</Panel>
              <Panel title="Findings by module">{d.findingsByModule.length ? <RankedBars rows={d.findingsByModule.map((r) => ({ key: r.key, value: r.count }))} /> : <NoData />}</Panel>
              <Panel title="Findings by website" className="lg:col-span-2">
                {d.findingsByWebsite.length ? <RankedBars rows={d.findingsByWebsite.map((r) => ({ key: r.key, label: r.label, value: r.count }))} /> : <NoData />}
              </Panel>
            </div>
            <SourceNote />
          </>
        )}
      </Gate>
    </Layout>
  )
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

export function AnalyticsMonitoringPage() {
  const [days, setDays] = useState(30)
  const state = useAnalytics(apiGetAnalyticsMonitoring, { days })
  const d = state.data
  const daily = useMemo(() => (d ? fillDays(d.daily, days, { completed: 0, failed: 0 }) : []), [d, days])
  return (
    <Layout title="Monitoring" description="Availability of scheduled monitoring runs, SSL health and incidents." filters={<RangeControl days={days} onChange={setDays} />} onRefresh={state.reload} loading={state.loading}>
      <Gate state={state} label="monitoring analytics">
        {d && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Availability" value={fmtPct(d.availability)} hint={d.runs ? `${fmtInt(d.completed)} of ${fmtInt(d.completed + d.failed)} runs succeeded` : undefined} />
              <Stat label="Failure rate" value={fmtPct(d.failureRate)} />
              <Stat label="Avg SSL score" value={d.sslScore === null ? NOT_YET : `${d.sslScore}/100`} />
              <Stat label="Open incidents" value={d.runs || d.incidentsBySeverity.length ? fmtInt(d.openIncidents) : NOT_YET} />
              <Stat label="Response time" value={fmtMs(d.responseTimeMs)} hint="Not measured by the monitoring engine yet" />
              <Stat label="DNS health" value={d.dnsHealth === null ? NOT_YET : fmtPct(d.dnsHealth)} />
              <Stat label="HTTP health" value={d.httpHealth === null ? NOT_YET : fmtPct(d.httpHealth)} />
              <Stat label="Monitoring runs" value={fmtInt(d.runs)} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
              <Panel title="Runs per day">
                {d.daily.length ? <DailyLines data={daily} lines={[{ key: "completed", label: "Completed", color: SERIES }, { key: "failed", label: "Failed", color: SERIES_2 }]} /> : <NoData description="Enable monitoring on a website to start collecting runs." />}
              </Panel>
              <Panel title="Incidents by severity">
                {d.incidentsBySeverity.length ? (
                  <RankedBars rows={[...d.incidentsBySeverity].sort((a, b) => SEVERITY_ORDER.indexOf(a.key) - SEVERITY_ORDER.indexOf(b.key)).map((i) => ({ key: i.key, label: `${i.key} · ${i.open} open`, value: i.count }))} colorOf={(k) => SEVERITY[k]?.color ?? SERIES} />
                ) : (
                  <EmptyState icon={<CheckCircle2 size={18} className="text-slate-400" />} title="No incidents in this period" />
                )}
              </Panel>
            </div>
            <SourceNote />
          </>
        )}
      </Gate>
    </Layout>
  )
}
