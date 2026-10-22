import { useEffect, useState } from "react"
import { PageHeader } from "../../components/ui/Card";
import { btn, buttonClass } from "../../components/ui/styles";
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
    <div className="animate-slide-in">
      <PageHeader eyebrow="Monitoring" title="Alerts" subtitle="Alerts raised by monitoring runs. Acknowledge or resolve them as you act." />
      {actionError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </p>
      )}
      {items?.length ? (
        <section className="space-y-3">
          {items.map((item) => (
            <article key={item.id} className="rounded-xl border border-slate-200 bg-white shadow-sm p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-card-title text-slate-900">{item.title}</h3>
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
                    className={btn}
                  >
                    Acknowledge
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiResolveAlert(item.id))
                    }
                    className={btn}
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiDismissAlert(item.id))
                    }
                    className={btn}
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
                    className={btn}
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() =>
                      void act(item.id, () => apiDismissAlert(item.id))
                    }
                    className={btn}
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
          className={`${buttonClass("secondary", "md")} mt-4`}
        >
          Load more
        </button>
      )}
    </div>
  )
}
