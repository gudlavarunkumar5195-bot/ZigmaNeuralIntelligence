import { useEffect, useState } from "react"
import { Activity } from "lucide-react"
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

export function MonitoringPage() {
  const [items, setItems] = useState<MonitoringConfig[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [websiteId, setWebsiteId] = useState("")
  const [frequency, setFrequency] = useState("daily")
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const result = await apiListMonitoring()
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      setItems(result.data ?? [])
    } catch (cause) {
      setError(cause as Error)
    }
  }
  const action = async (request: () => Promise<unknown>) => {
    setBusy(true)
    try {
      const result = (await request()) as {
        error?: { code: string message: string }
      }
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      await load()
    } catch (cause) {
      setError(cause as Error)
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
      {items?.length ? (
        <section className="data-grid">
          {items.map((item) => (
            <article
              key={item.id}
              className="card-panel col-span-6 p-5 sm:col-span-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-800 text-slate-900">{item.website_id}</h3>
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
            </article>
          ))}
        </section>
      ) : (
        <EmptyState
          title="No monitoring configurations"
          description="Create a monitoring configuration to begin persisted change detection."
        />
      )}
    </div>
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
      <form
        className="card-panel mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void action(() => apiCreateMonitoring({ websiteId, frequency }))
        }}
      >
        <label className="text-sm text-slate-700">
          Website ID
          <input
            required
            value={websiteId}
            onChange={(event) => setWebsiteId(event.target.value)}
            className="mt-1 block rounded border p-2"
          />
        </label>
        <label className="text-sm text-slate-700">
          Frequency
          <select
            value={frequency}
            onChange={(event) => setFrequency(event.target.value)}
            className="mt-1 block rounded border p-2"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button
          disabled={busy}
          className="rounded bg-blue-700 px-4 py-2 font-700 text-white"
        >
          Create monitoring
        </button>
      </form>
      {items?.length ? (
        <section className="data-grid">
          {items.map((item) => (
            <article key={item.id} className="card-panel col-span-6 p-5">
              <div className="flex items-center justify-between">
                <h3 className="font-800 text-slate-900">{item.website_id}</h3>
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
                  onClick={() =>
                    void action(() => apiDisableMonitoring(item.id))
                  }
                  className="rounded border border-red-200 px-3 py-2 text-xs font-700 text-red-700"
                >
                  Disable
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      apiUpdateMonitoring(item.id, {
                        frequency:
                          item.frequency === "daily" ? "weekly" : "daily",
                      }),
                    )
                  }
                  className="rounded border px-3 py-2 text-xs font-700"
                >
                  Change frequency
                </button>
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
    </div>
  )
}
