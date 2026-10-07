import { useEffect, useState } from "react"
import {
  EmptyState,
  ErrorState,
  IntegrationRequiredState,
  LoadingState,
} from "../../components/ui/DataState"
import {
  apiAcknowledgeAlert,
  apiDismissAlert,
  apiListAlerts,
  apiResolveAlert,
  ApiCallError,
  IntegrationRequired,
  MonitoringAlert,
} from "../../services/api"

export function AlertsPage() {
  const [items, setItems] = useState<MonitoringAlert[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const fetchPage = async (target: number) => {
    const result = await apiListAlerts({ page: target })
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
    setLoadingMore(true)
    setActionError(null)
    try {
      const rows = await fetchPage(page + 1)
      setItems((current) => [...(current ?? []), ...rows])
    } catch (cause) {
      setActionError((cause as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }
  const act = async (id: string, request: () => Promise<unknown>) => {
    try {
      const result = (await request()) as {
        error?: { code: string; message: string }
      }
      if (result.error)
        throw new ApiCallError(0, result.error.code, result.error.message)
      setActionError(null)
      await load()
    } catch (cause) {
      // Keep the list visible; a rejected action (e.g. viewer role) is not a load failure.
      setActionError((cause as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  if (!items && !error) return <LoadingState label="Loading alerts..." />
  if (error instanceof IntegrationRequired)
    return <IntegrationRequiredState feature="Alerts" />
  if (error)
    return (
      <ErrorState
        title="Unable to load alerts"
        message={error.message}
        onRetry={load}
      />
    )
  return (
    <div className="mx-auto max-w-6xl animate-slide-in p-6 md:p-8">
      <h2 className="mb-6 text-3xl font-800 tracking-[-0.05em] text-slate-950">
        Alerts
      </h2>
      {actionError && (
        <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </p>
      )}
      {items?.length ? (
        <section className="space-y-3">
          {items.map((item) => (
            <article key={item.id} className="card-panel p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-800 text-slate-900">{item.title}</h3>
                <span className="text-xs font-700 uppercase text-blue-700">
                  {item.severity} · {item.status}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Detected {new Date(item.detected_at).toLocaleString()}
              </p>
              {item.status === "OPEN" && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() =>
                      void act(item.id, () => apiAcknowledgeAlert(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Acknowledge
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiResolveAlert(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiDismissAlert(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {item.status === "ACKNOWLEDGED" && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() =>
                      void act(item.id, () => apiResolveAlert(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiDismissAlert(item.id))
                    }
                    className="rounded border px-3 py-2 text-xs font-700"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      ) : (
        <EmptyState
          title="No alerts"
          description="Persisted monitoring alerts will appear here when configured rules match a detected change."
        />
      )}
      {hasMore && (
        <button
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="mt-4 rounded border px-4 py-2 text-sm font-700 disabled:opacity-60"
        >
          Load more
        </button>
      )}
    </div>
  )
}
