import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ExternalLink, Globe2, Plus, ScanLine, ShieldCheck } from "lucide-react";
import {
  apiCreateScan,
  apiGetDashboard,
  apiListWebsites,
  apiVerifyOwnership,
  ApiCallError,
  DashboardData,
  IntegrationRequired,
  isAuthenticated,
  WebsiteRecord,
} from "../../services/api";
import { useSelectedWebsiteId } from "../../lib/selectedWebsite";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { ScoreRing } from "../../components/ui/ScoreRing";
import { StatusBadge } from "../../components/ui/StatusBadge";

function verificationInstructions(site: WebsiteRecord): string {
  const token = site.verification_token ?? "<token>";
  if (site.verification_method === "dns") return `Create a DNS TXT record at _zignaneural-verify.${site.domain} with the value ${token}`;
  if (site.verification_method === "file") return `Serve a text file at ${new URL(site.url).origin}/zignaneural-verify.txt containing exactly ${token}`;
  return `Add <meta name="zignaneural-site-verification" content="${token}"> to the <head> of ${site.url}`;
}

export function MyWebsites() {
  const navigate = useNavigate();
  const selectedId = useSelectedWebsiteId();
  const [data, setData] = useState<DashboardData | null>(null);
  const [records, setRecords] = useState<Record<string, WebsiteRecord>>({});
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      if (!isAuthenticated()) {
        navigate("/login", { replace: true });
        return;
      }
      const result = await apiGetDashboard(selectedId);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setData(result.data);
      // Verification method/token only come from the websites list; failure is non-fatal.
      try {
        const list = await apiListWebsites({ pageSize: 100 });
        if (list.data) setRecords(Object.fromEntries(list.data.map((row) => [row.id, row])));
      } catch {
        setRecords({});
      }
    } catch (cause) {
      setError(cause as Error);
    }
  };

  useEffect(() => {
    void load();
  }, [navigate, selectedId]);

  const startScan = async (siteId: string) => {
    setActionError(null);
    setBusyId(siteId);
    try {
      const result = await apiCreateScan(siteId, ["seo", "security", "performance", "ssl"]);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      if (result.data?.id) {
        navigate(`/websites/scan/${result.data.id}`);
        return;
      }
      setActionError("The scan was accepted but no scan id was returned.");
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const verify = async (siteId: string) => {
    setActionError(null);
    setBusyId(siteId);
    try {
      const result = await apiVerifyOwnership(siteId);
      if (result.error) throw new ApiCallError(0, result.error.code, result.error.message);
      setVerifyingId(null);
      await load();
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (!data && !error) return <LoadingState label="Loading your websites…" />;
  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Websites" />;
  if (error) return <ErrorState title="Unable to load websites" message={error.message} onRetry={load} />;

  return (
    <div className="mx-auto max-w-6xl p-5 md:p-8 animate-slide-in">
      <header className="mb-8 flex items-end justify-between border-b border-slate-200 pb-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Tenant inventory</p>
          <h2 className="mt-2 text-2xl font-800 text-slate-950">Websites</h2>
        </div>
        <button onClick={() => navigate("/websites/add")} className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-700 text-white">
          <Plus size={15} />
          Add website
        </button>
      </header>

      {actionError && (
        <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      )}

      {!data?.websites.length ? (
        <EmptyState
          title="No websites connected"
          description="Add a verified website to begin collecting intelligence."
          action={
            <button onClick={() => navigate("/websites/add")} className="rounded bg-primary px-3 py-2 text-sm font-700 text-white">
              Add Website
            </button>
          }
        />
      ) : (
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          {data.websites.map((site) => (
            <article key={site.id} aria-current={site.id === data.selectedWebsite?.id ? "true" : undefined} className={`flex flex-col flex-wrap gap-4 py-5 sm:flex-row sm:items-center ${site.id === data.selectedWebsite?.id ? "bg-blue-50/40" : ""}`}>
              <div className="flex items-center gap-4">
                <div>
                  {site.overall_score === null ? (
                    <div className="grid h-14 w-14 place-items-center rounded-full border-4 border-slate-100 text-xl text-slate-400">—</div>
                  ) : (
                    <ScoreRing score={site.overall_score} size={56} strokeWidth={4} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Globe2 size={15} className="text-blue-600" />
                    <h3 className="font-800 text-slate-900">{site.domain}</h3>
                    <a href={site.url} target="_blank" rel="noreferrer" aria-label={`Open ${site.domain}`}>
                      <ExternalLink size={13} className="text-slate-400" />
                    </a>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {site.latest_scan_status
                      ? `${site.latest_scan_status} · ${site.finding_count} findings · ${site.critical_count} critical`
                      : "No scan results yet"}
                  </p>
                </div>
              </div>

              <div className="sm:ml-auto">
                <StatusBadge status={site.latest_scan_status ?? (site.verified ? "verified" : "unverified")} />
              </div>

              <div className="flex flex-wrap gap-2">
                {site.latest_scan_id && (
                  <button
                    onClick={() => navigate(`/websites/scan/${site.latest_scan_id}`)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-700 text-slate-700 shadow-sm hover:bg-slate-50"
                  >
                    Open latest scan
                  </button>
                )}
                <button
                  disabled={!site.verified || busyId === site.id}
                  onClick={() => void startScan(site.id)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-700 text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ScanLine size={14} />
                  {site.latest_scan_id ? "New scan" : "Start scan"}
                </button>
                {!site.verified && (
                  <button
                    onClick={() => setVerifyingId(verifyingId === site.id ? null : site.id)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-700 text-amber-800 shadow-sm hover:bg-amber-100"
                  >
                    <ShieldCheck size={14} />
                    Verify ownership
                  </button>
                )}
              </div>
              {!site.verified && (
                <p className="basis-full text-xs text-amber-800">Scans are disabled until ownership of this website is verified.</p>
              )}
              {!site.verified && verifyingId === site.id && (
                <div className="basis-full rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
                  {records[site.id]?.verification_token ? (
                    <>
                      <p className="text-xs font-700 uppercase tracking-[.12em] text-slate-500">Verification token ({records[site.id].verification_method ?? "html"})</p>
                      <code className="mt-2 block break-all text-slate-900">{records[site.id].verification_token}</code>
                      <p className="mt-2 text-xs leading-5 text-slate-600">{verificationInstructions(records[site.id])}</p>
                    </>
                  ) : (
                    <p className="text-xs leading-5 text-slate-600">The verification token could not be retrieved from the server. You can still run the check if you already placed it.</p>
                  )}
                  <button
                    disabled={busyId === site.id}
                    onClick={() => void verify(site.id)}
                    className="mt-3 rounded-md bg-slate-950 px-3 py-2 text-xs font-700 text-white disabled:opacity-60"
                  >
                    {busyId === site.id ? "Checking…" : "Check ownership"}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
