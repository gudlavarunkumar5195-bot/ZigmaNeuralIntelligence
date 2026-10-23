import { useEffect, useState } from "react"
import { PageHeader } from "../../components/ui/Card";
import { btn, btnDanger, buttonClass, input } from "../../components/ui/styles";
import { useWebsites } from "../../lib/useWebsites"
import { AlertRules } from "./AlertRules"
import {
  EmptyState,
  ErrorState,
  IntegrationRequiredState,
  LoadingState,
} from "../../components/ui/DataState"
import {
  apiCreateMonitoring,
  apiDisableMonitoring,
  apiListMonitoring,
  apiPauseMonitoring,
  apiResumeMonitoring,
  apiRunMonitoring,
  apiUpdateMonitoring,
  ApiCallError,
  IntegrationRequired,
  MonitoringConfig,
} from "../../services/api"

const FREQUENCIES = ["daily", "weekly", "monthly"] as const

function safeActionMessage(cause: unknown): string {
  if (cause instanceof IntegrationRequired)
    return "Monitoring requires a connected backend."
  if (cause instanceof ApiCallError) {
    if (
      cause.status === 403 ||
      ["FORBIDDEN", "INSUFFICIENT_ROLE", "403"].includes(cause.code)
    )
      return "You do not have permission to perform this action."
    return cause.message || "The request failed. Please try again."
  }
  return "The request failed. Please try again."
}

export function MonitoringPage() {
  const [items, setItems] = useState<MonitoringConfig[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const { websites, domainOf } = useWebsites()
  const [websiteId, setWebsiteId] = useState("")
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [frequency, setFrequency] = useState("daily")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rulesFor, setRulesFor] = useState<string | null>(null)
  const fetchPage = async (target: number) => {
    const result = await apiListMonitoring({ page: target })
    if (result.error)
      throw new ApiCallError(0, result.error.code, result.error.message)
    const rows = result.data ?? []
    setPage(target)
    setHasMore(rows.length >= (result.meta?.pageSize ?? Number.POSITIVE_INFINITY))
    return rows
  }
  const load = async () => {
    setError(null)
    try {
      setItems(await fetchPage(1))
    } catch (cause) {
      setError(cause as Error)
    }
  }
  // Re-read every page already shown, so an action does not collapse "Load more".
  const reloadShown = async () => {
    const shown = page
    const rows: MonitoringConfig[] = []
    for (let p = 1; p <= shown; p++) rows.push(...(await fetchPage(p)))
    setItems(rows)
  }
  const loadMore = async () => {
    setBusy(true)
    setActionError(null)
    try {
      const rows = await fetchPage(page + 1)
      setItems((current) => [...(current ?? []), ...rows])
    } catch (cause) {
      setActionError(safeActionMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const action = async (request: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    try {
      const result = (await request()) as {
        error?: { code: string; message: string; status?: number }
      }
      if (result.error)
        throw new ApiCallError(result.error.status ?? 0, result.error.code, result.error.message)
      await reloadShown()
    } catch (cause) {
      setActionError(safeActionMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  if (!items && !error) return <LoadingState label="Loading monitoring..." />
  if (error instanceof IntegrationRequired)
    return <IntegrationRequiredState feature="Monitoring" />
  if (error)
    return (
      <ErrorState
        title="Unable to load monitoring"
        message={error.message}
        onRetry={load}
      />
    )
  return (
    <div className="animate-slide-in">
      <PageHeader eyebrow="Monitoring" title="Website monitoring" subtitle="Persisted schedules and run health." />
      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {actionError}
        </div>
      )}
      <form
        className="rounded-xl border border-slate-200 bg-white shadow-sm mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void action(() => apiCreateMonitoring({ websiteId, frequency }))
        }}
      >
        <label className="text-sm text-slate-700">
          Website
          <select
            required
            value={websiteId}
            onChange={(event) => setWebsiteId(event.target.value)}
            className={input}
          >
            <option value="">
              {websites.length ? "Select a website" : "No websites available"}
            </option>
            {websites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.domain}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Frequency
          <select
            value={frequency}
            onChange={(event) => setFrequency(event.target.value)}
            className={input}
          >
            {FREQUENCIES.map((value) => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !websiteId}
          className={buttonClass("primary", "md")}
        >
          Create monitoring
        </button>
      </form>
      {items?.length ? (
        <section className="data-grid">
          {(items ?? []).map((item) => (
            <article key={item.id} className="rounded-xl border border-slate-200 bg-white shadow-sm col-span-6 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-card-title text-slate-900">{domainOf(item.website_id)}</h3>
                <span className="text-xs font-700 uppercase text-blue-700">
                  {item.status}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                {item.frequency} · {item.enabled ? "Enabled" : "Disabled"}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Next run: {new Date(item.next_run_at).toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Last success:{" "}
                {item.last_success_at
                  ? new Date(item.last_success_at).toLocaleString()
                  : "Not run"}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  onClick={() => void action(() => apiRunMonitoring(item.id))}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 text-white shadow-sm hover:bg-blue-700 font-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 h-8 px-3 text-xs"
                >
                  Run now
                </button>
                {item.status === "PAUSED" || item.status === "DISABLED" ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => apiResumeMonitoring(item.id))
                    }
                    className={btn}
                  >
                    {item.status === "DISABLED" ? "Re-enable" : "Resume"}
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => apiPauseMonitoring(item.id))
                    }
                    className={btn}
                  >
                    Pause
                  </button>
                )}
                {item.status !== "DISABLED" ? <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disable monitoring for ${domainOf(item.website_id)}? Scheduled runs will stop.`,
                      )
                    )
                      void action(() => apiDisableMonitoring(item.id))
                  }}
                  className={btnDanger}
                >
                  Disable
                </button> : null}
                <select
                  disabled={busy}
                  aria-label={`Change frequency for ${domainOf(item.website_id)}`}
                  value={item.frequency}
                  onChange={(event) =>
                    void action(() =>
                      apiUpdateMonitoring(item.id, {
                        frequency: event.target.value,
                      }),
                    )
                  }
                  className={btn}
                >
                  {FREQUENCIES.map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="mt-3 text-xs font-600 text-blue-700 underline" aria-expanded={rulesFor === item.id} onClick={() => setRulesFor(rulesFor === item.id ? null : item.id)}>
                {rulesFor === item.id ? "Hide alert rules" : "Alert rules"}
              </button>
              {rulesFor === item.id ? <AlertRules monitoringId={item.id} domain={domainOf(item.website_id)} /> : null}
            </article>
          ))}
        </section>
      ) : (
        <EmptyState
          title="No monitoring configurations"
          description="Create a monitoring configuration to begin persisted change detection."
        />
      )}
      {hasMore && (
        <button
          disabled={busy}
          onClick={() => void loadMore()}
          className={`${buttonClass("secondary", "md")} mt-4`}
        >
          Load more
        </button>
      )}
    </div>
  )
}
