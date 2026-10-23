import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiAiQuotaSync, apiAiStatus, type AiPricingClass, type AiQuotaPool } from "../../../services/api";
import { useApiQuery } from "../../../lib/useApiQuery";
import { useBusy } from "../../../lib/useBusy";
import { Card, SectionHeader } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, Freshness, Notice } from "../../../components/ui/Primitives";
import { InlineError, LoadingState } from "../../../components/ui/DataState";
import { useToast } from "../../../components/ui/Toast";
import { errorText, fmtDateTime, Meter, Stat, type Access } from "./shared";

const CLASSES: AiPricingClass[] = ["FREE", "TRIAL", "PAID", "UNKNOWN"];
const SYNC_MESSAGES: Record<string, string> = {
  synced: "Quota synced from OpenRouter.",
  not_configured: "OpenRouter is not configured, so there was nothing to sync.",
  unavailable: "OpenRouter could not be reached. The configured limits stay in force.",
  unexpected: "OpenRouter returned an unexpected response. The configured limits stay in force.",
};

function QuotaCard({ q }: { q: AiQuotaPool }) {
  const title = q.pool === "FREE" ? "Free models — daily requests" : "Trial models — daily requests";
  return (
    <Card>
      <h3 className="text-card-title">{title}</h3>
      <p className="mt-1 text-2xl font-700 tabular-nums text-slate-900">
        {q.used.toLocaleString()} <span className="text-sm font-500 text-slate-500">/ {q.limit.toLocaleString()} used</span>
      </p>
      <div className="mt-2">
        <Meter label={`${title}: used`} value={q.used} max={q.limit} text={`${q.remaining.toLocaleString()} remaining today (UTC day ${q.day})`} />
      </div>
      {q.exhaustedUntil ? (
        <p className="mt-2"><Badge tone="danger" icon>Exhausted until {fmtDateTime(q.exhaustedUntil)}</Badge></p>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <Stat label="Provider-reported limit">{q.providerLimit === null ? <span className="text-slate-600">Not reported</span> : q.providerLimit.toLocaleString()}</Stat>
        <Stat label="Provider sync">{q.providerSyncedAt ? fmtDateTime(q.providerSyncedAt) : <span className="text-slate-600">Never synced</span>}</Stat>
      </dl>
    </Card>
  );
}

export function OverviewTab({ access }: { access: Access }) {
  const status = useApiQuery(() => apiAiStatus(), []);
  const { busy, guard } = useBusy();
  const { notify } = useToast();
  const [syncError, setSyncError] = useState<string | null>(null);

  const sync = guard(async () => {
    setSyncError(null);
    const r = await apiAiQuotaSync();
    if (r.error) {
      setSyncError(r.error.status === 403 ? "Only platform administrators can sync the quota from OpenRouter. Your organization role does not include this." : r.error.message);
      return;
    }
    notify(SYNC_MESSAGES[r.data?.status ?? ""] ?? "Quota sync finished.", r.data?.status === "synced" ? "success" : "info");
    status.reload();
  });

  if (status.loading && !status.data) return <LoadingState label="Loading router status…" />;
  if (status.error) return <InlineError what="the router status" error={{ ...status.error, message: errorText(status.error) }} onRetry={status.reload} />;
  const s = status.data;
  if (!s) return null;

  return (
    <div className="space-y-5">
      <section>
        <SectionHeader as="h2" title="Router health" subtitle="Live state of the model router for this deployment." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <h3 className="text-card-title">AI provider</h3>
            <p className="mt-2">{s.providerConfigured ? <Badge tone="success" icon>OpenRouter configured</Badge> : <Badge tone="warning" icon>Not configured</Badge>}</p>
          </Card>
          <Card>
            <h3 className="text-card-title">Paid models</h3>
            <p className="mt-2">{s.paidModelsAllowed ? <Badge tone="warning" icon>Allowed by deployment switch</Badge> : <Badge tone="success" icon>Disabled — free models only</Badge>}</p>
          </Card>
          <Card>
            <h3 className="text-card-title">Model catalog</h3>
            <p className="mt-2"><Freshness at={s.catalog.lastRefreshAt} stale={s.catalog.stale} never="Never refreshed" /></p>
            <p className="mt-1 text-[11px] text-slate-600">Last refresh: {s.catalog.lastRefreshStatus ?? "none recorded"}{s.catalog.stale ? " · stale" : ""}</p>
          </Card>
          <Card>
            <h3 className="text-card-title">Settings</h3>
            <p className="mt-2 text-[13px] text-slate-900">Version {s.settings.version}{s.settings.version === 0 ? " (defaults)" : ""}</p>
            <p className="mt-1 text-[11px] text-slate-600">{s.settings.updatedAt ? `Updated ${fmtDateTime(s.settings.updatedAt)}` : "Never changed"} · trials {s.settings.trialsEnabled ? "enabled" : "disabled"}</p>
          </Card>
        </div>
      </section>

      <section>
        <SectionHeader as="h2" title="Enabled models by pricing class" subtitle="Only FREE models (and TRIAL models while trials are enabled) are routed to." />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CLASSES.map((c) => (
            <Card key={c} padding="sm">
              <dl><Stat label={c}>{(s.catalog.modelsByPricingClass[c] ?? 0).toLocaleString()} models</Stat></dl>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader
          as="h2"
          title="Daily request quotas"
          subtitle="Counted by this platform and lowered by any limit OpenRouter reports."
          action={access.isPlatformAdmin ? (
            <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={busy} onClick={() => void sync()}>
              Sync quota from OpenRouter
            </Button>
          ) : undefined}
        />
        {syncError ? <div className="mb-3"><Notice tone="danger">{syncError}</Notice></div> : null}
        {s.quotas.length === 0 ? (
          <p className="text-xs text-slate-600">No quota pools reported.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {s.quotas.map((q) => <QuotaCard key={q.pool} q={q} />)}
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-600">Token estimates use {s.tokenEstimate}.</p>
      </section>
    </div>
  );
}
