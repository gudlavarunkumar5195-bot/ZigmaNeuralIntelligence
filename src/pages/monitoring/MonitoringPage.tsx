import { useEffect, useState } from "react"
import { Activity } from "lucide-react"
import { useWebsites } from "../../lib/useWebsites"
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
        error?: { code: string; message: string }
      }
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      await load()
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
    <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8">
      <header className="hero-shell mb-6 rounded-[28px] border border-blue-100 p-6">
        <div className="brand-chip w-fit">
          <Activity size={12} /> Monitoring
        </div>
        <h2 className="mt-4 text-3xl font-800 tracking-[-0.05em] text-slate-950">
          Website monitoring
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Persisted schedules and run health.
        </p>
      </header>
      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {actionError}
        </div>
      )}
      <form
        className="card-panel mb-6 flex flex-wrap items-end gap-3 p-4"
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
            className="mt-1 block rounded border p-2"
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
            className="mt-1 block rounded border p-2"
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
          className="rounded bg-blue-700 px-4 py-2 font-700 text-white disabled:opacity-60"
        >
          Create monitoring
        </button>
      </form>
      {items?.length ? (
        <section className="data-grid">
          {(items ?? []).map((item) => (
            <article key={item.id} className="card-panel col-span-6 p-5">
              <div className="flex items-center justify-between">
                <h3 className="font-800 text-slate-900">{domainOf(item.website_id)}</h3>
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
                  className="rounded bg-slate-900 px-3 py-2 text-xs font-700 text-white"
                >
                  Run now
                </button>
                {item.status === "PAUSED" ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => apiResumeMonitoring(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => apiPauseMonitoring(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Pause
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disable monitoring for ${domainOf(item.website_id)}? Scheduled runs will stop.`,
                      )
                    )
                      void action(() => apiDisableMonitoring(item.id))
                  }}
                  className="rounded border border-red-200 px-3 py-2 text-xs font-700 text-red-700"
                >
                  Disable
                </button>
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
                  className="rounded border px-3 py-2 text-xs font-700"
                >
                  {FREQUENCIES.map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
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
          className="mt-4 rounded border px-4 py-2 text-sm font-700 disabled:opacity-60"
        >
          Load more
        </button>
      )}
    </div>
  )
}
