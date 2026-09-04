import { useEffect, useState } from "react"
import {
  EmptyState,
  ErrorState,
  IntegrationRequiredState,
  LoadingState,
} from "../../components/ui/DataState"
import {
  apiListMonitoring,
  apiListMonitoringChanges,
  ApiCallError,
  IntegrationRequired,
  MonitoringChange,
  MonitoringConfig,
} from "../../services/api"

export function ChangesPage() {
  const [items, setItems] = useState<MonitoringChange[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [selectedId, setSelectedId] = useState("")
  const [configs, setConfigs] = useState<MonitoringConfig[]>([])
  const load = async () => {
    try {
      const result = await apiListMonitoring()
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      const available = result.data ?? []
      setConfigs(available)
      const config = available[0]
      if (!config) {
        setItems([])
        return
      }
      setSelectedId(config.id)
      const changes = await apiListMonitoringChanges(config.id)
      if (changes.error)
        throw new ApiCallError(0, changes.error.code, changes.error.message)
      setItems(changes.data ?? [])
    } catch (cause) {
      setError(cause as Error)
    }
  }
  const loadSelected = async (id: string) => {
    setSelectedId(id)
    try {
      const result = await apiListMonitoringChanges(id)
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      setItems(result.data ?? [])
    } catch (cause) {
      setError(cause as Error)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  if (!items && !error) return <LoadingState label="Loading changes..." />
  if (error instanceof IntegrationRequired)
    return <IntegrationRequiredState feature="Change detection" />
  if (error)
    return (
      <ErrorState
        title="Unable to load changes"
        message={error.message}
        onRetry={load}
      />
    )
  return (
    <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8">
      <h2 className="mb-6 text-3xl font-800 tracking-[-0.05em] text-slate-950">
        Change detection
      </h2>
      <div className="card-panel mb-6 p-4">
        <label className="text-sm text-slate-700">
          Monitoring configuration
          <select
            value={selectedId}
            onChange={(event) => void loadSelected(event.target.value)}
            className="ml-3 rounded border p-2"
          >
            <option value="">Select monitoring</option>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.website_id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {items?.length ? (
        <section className="space-y-3">
          {items.map((item) => (
            <article key={item.id} className="card-panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-800 text-slate-900">
                  {item.change_type.replaceAll("_", " ")}
                </h3>
                <span className="text-xs font-700 uppercase text-blue-700">
                  {item.severity} · {item.domain}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-600">{item.impact}</p>
              <div className="mt-3 grid gap-3 text-xs text-slate-500 md:grid-cols-2">
                <pre className="overflow-auto rounded bg-slate-50 p-3">
                  Before: {JSON.stringify(item.before_value, null, 2)}
                </pre>
                <pre className="overflow-auto rounded bg-slate-50 p-3">
                  Current: {JSON.stringify(item.after_value, null, 2)}
                </pre>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {new Date(item.detected_at).toLocaleString()} ·{" "}
                {item.affected_urls.join(", ") || "No URL-specific scope"}
              </p>
            </article>
          ))}
        </section>
      ) : (
        <EmptyState
          title="No detected changes"
          description="Changes will appear after a valid monitoring baseline and a later completed scan."
        />
      )}
    </div>
  )
}
