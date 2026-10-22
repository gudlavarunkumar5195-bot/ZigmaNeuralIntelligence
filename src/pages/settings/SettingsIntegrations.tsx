import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  apiDisconnectIntegration,
  apiLinkSearchConsole,
  apiListGscProperties,
  apiListIntegrations,
  apiListWebsites,
  apiStartGoogleConnect,
  IntegrationRequired,
  type GoogleConfigStatus,
  type GscPropertyOption,
  type IntegrationRecord,
  type WebsiteRecord,
} from "../../services/api";
import { ErrorState, IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { SettingsLayout } from "./SettingsLayout";

/** Messages for the ?gsc=&reason= the OAuth callback redirects with (fixed vocabulary from the server). */
const OAUTH_MESSAGES: Record<string, string> = {
  connected: "Google Search Console connected. Choose a property for each website below.",
  access_denied: "You cancelled the Google sign-in. Nothing was connected.",
  scope_denied: "Search Console access was not granted, so nothing was stored. Connect again and allow \"View Search Console data\".",
  invalid_state: "That sign-in link expired or was already used. Start the connection again.",
  browser_mismatch: "The sign-in finished in a different browser session. Start the connection again from this browser.",
  forbidden: "Only organization owners and admins can connect Google accounts.",
  invalid_grant: "Google did not accept the sign-in. Start the connection again.",
  no_refresh_token: "Google did not grant offline access. Start the connection again.",
  redirect_uri_mismatch: "The server's Google OAuth redirect URI does not match the OAuth client. An administrator must fix the configuration.",
  admin_policy_enforced: "Your Google Workspace administrator blocks this app.",
};
const ROLE_CODES = new Set(["FORBIDDEN", "INSUFFICIENT_ROLE"]);
const PERMISSION_LABEL: Record<string, string> = {
  siteOwner: "Owner",
  siteFullUser: "Full user",
  siteRestrictedUser: "Restricted user",
  siteUnverifiedUser: "Unverified (no data access)",
};
const LINK_ERRORS: Record<string, string> = {
  PROPERTY_MISMATCH: "That property does not cover this website's URL. Pick a Domain property for the site's domain or a URL-prefix property matching its address exactly.",
  PROPERTY_ACCESS_DENIED: "This Google account cannot read that property's data. Ask the property owner for access in Search Console.",
  WEBSITE_NOT_VERIFIED: "Verify ownership of the website in ZigmaNeural first. Google's permissions do not replace ZigmaNeural verification.",
  INTEGRATION_REAUTH_REQUIRED: "Reconnect this Google account first.",
};

export function SettingsIntegrations() {
  const [params, setParams] = useSearchParams();
  const [integrations, setIntegrations] = useState<IntegrationRecord[] | null>(null);
  const [config, setConfig] = useState<GoogleConfigStatus | null>(null);
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setError(null);
    try {
      const [list, sites] = await Promise.all([apiListIntegrations(), apiListWebsites({ pageSize: 100 }).catch(() => null)]);
      if (list.error) throw new Error(list.error.message);
      setIntegrations(list.data ?? []);
      setConfig(list.meta?.googleSearchConsole ?? null);
      setWebsites(sites?.data ?? []);
    } catch (cause) {
      setError(cause as Error);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // OAuth result from the callback redirect: announce it once, then clean the URL.
  useEffect(() => {
    const result = params.get("gsc");
    if (!result) return;
    const reason = params.get("reason") ?? "";
    setNotice(
      result === "connected"
        ? { kind: "ok", text: OAUTH_MESSAGES.connected }
        : { kind: "error", text: OAUTH_MESSAGES[reason] ?? `Google sign-in did not complete (${reason || "unknown error"}). Try again.` },
    );
    setParams({}, { replace: true });
    window.setTimeout(() => noticeRef.current?.focus(), 0);
  }, [params]);

  const connect = async () => {
    setConnecting(true);
    setNotice(null);
    try {
      const r = await apiStartGoogleConnect("/settings/integrations");
      if (r.error || !r.data) {
        setNotice({ kind: "error", text: ROLE_CODES.has(r.error?.code ?? "") ? "Only organization owners and admins can connect Google accounts." : r.error?.message ?? "Could not start the Google sign-in." });
        return;
      }
      window.location.assign(r.data.authorizationUrl);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (integration: IntegrationRecord) => {
    const r = await apiDisconnectIntegration(integration.id);
    setConfirmDisconnect(null);
    if (r.error) {
      setNotice({ kind: "error", text: ROLE_CODES.has(r.error.code) ? "Only owners and admins can disconnect." : r.error.message });
      return;
    }
    setNotice({
      kind: "ok",
      text: `Disconnected ${integration.account_email ?? "the Google account"}. Stored Search Console data for its properties was deleted${r.data?.revokedAtGoogle ? " and access was revoked at Google" : "; revoking at Google failed, so also remove access at myaccount.google.com"}.`,
    });
    await load();
  };

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Integrations" />;

  return (
    <SettingsLayout eyebrow="Integrations" title="Integrations">
      <div ref={noticeRef} tabIndex={-1} role={notice?.kind === "error" ? "alert" : "status"} aria-live="polite" className="focus:outline-none">
        {notice ? (
          <p className={`mb-4 rounded-lg border px-3 py-2 text-sm ${notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800"}`}>{notice.text}</p>
        ) : null}
      </div>
      {error ? (
        <ErrorState title="Unable to load integrations" message={error.message} onRetry={load} />
      ) : !integrations || !config ? (
        <LoadingState label="Loading integrations…" />
      ) : (
        <section aria-labelledby="gsc-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="gsc-heading" className="text-base font-800 text-slate-900">Google Search Console</h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Read-only access to clicks, impressions, CTR and average position for properties your Google account can see. Tokens stay on the server, encrypted.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={!config.configured || connecting}
              className="rounded-md bg-slate-950 px-3 py-2 text-sm font-700 text-white disabled:opacity-50"
            >
              {connecting ? "Opening Google…" : integrations.length ? "Connect another Google account" : "Connect Google Search Console"}
            </button>
          </div>

          {!config.configured ? (
            <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="font-700">Not configured on this server.</p>
              <p className="mt-1">An administrator must set these server environment variables (values are never shown here):</p>
              <ul className="mt-1 list-disc pl-5 font-mono text-xs">{config.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          ) : null}

          {integrations.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">No Google account is connected.</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {integrations.map((integration) => (
                <li key={integration.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-700 text-slate-900">{integration.account_email ?? "Google account"}</p>
                      <p className="text-xs text-slate-600">
                        Connected {new Date(integration.connected_at).toLocaleString()}
                        {integration.connected_by_name ? ` by ${integration.connected_by_name}` : ""}
                      </p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-[11px] font-700 ${integration.status === "active" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
                      {integration.status === "active" ? "Active" : "Reauthorization required"}
                    </span>
                  </div>
                  {integration.status !== "active" ? (
                    <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-800">
                      {integration.status_reason ?? "Google access was revoked or expired."} Syncing is paused.{" "}
                      <button type="button" onClick={() => void connect()} className="font-700 underline">Reconnect {integration.account_email ?? "this account"}</button>
                    </p>
                  ) : null}
                  {integration.properties.length ? (
                    <ul className="mt-3 space-y-1 text-xs text-slate-700">
                      {integration.properties.map((p) => (
                        <li key={p.websiteId}>
                          <span className="font-600">{p.domain}</span> → <span className="font-mono">{p.siteUrl}</span>
                          {p.status !== "active" ? <span className="ml-1 text-red-700">(access lost)</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {integration.status === "active" ? <LinkWebsiteForm integration={integration} websites={websites} onLinked={(text) => { setNotice({ kind: "ok", text }); void load(); }} /> : null}
                  <div className="mt-3">
                    {confirmDisconnect === integration.id ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm disconnect">
                        <span>Disconnect and delete this account's stored Search Console data?</span>
                        <button type="button" onClick={() => void disconnect(integration)} className="rounded bg-red-700 px-2 py-1 font-700 text-white">Disconnect and delete</button>
                        <button type="button" onClick={() => setConfirmDisconnect(null)} className="text-slate-600">Cancel</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setConfirmDisconnect(integration.id)} className="text-xs font-600 text-red-700 underline">
                        Disconnect <span className="sr-only">{integration.account_email}</span>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </SettingsLayout>
  );
}

/** Choose a website, load the account's properties from Google, pick one, link it. */
function LinkWebsiteForm({ integration, websites, onLinked }: { integration: IntegrationRecord; websites: WebsiteRecord[]; onLinked: (message: string) => void }) {
  const [websiteId, setWebsiteId] = useState("");
  const [properties, setProperties] = useState<GscPropertyOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProperties = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiListGscProperties(integration.id);
      if (r.error) {
        setError(ROLE_CODES.has(r.error.code) ? "Only owners and admins can link properties." : r.error.message);
        return;
      }
      setProperties(r.data ?? []);
    } finally {
      setLoading(false);
    }
  };

  const link = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!websiteId || !siteUrl) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiLinkSearchConsole(websiteId, integration.id, siteUrl);
      if (r.error) {
        setError(LINK_ERRORS[r.error.code] ?? (ROLE_CODES.has(r.error.code) ? "Only owners and admins can link properties." : r.error.message));
        return;
      }
      const site = websites.find((w) => w.id === websiteId);
      onLinked(`Linked ${site?.domain ?? "the website"} to ${siteUrl}. The first historical sync has been queued.`);
      setSiteUrl("");
      setWebsiteId("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={link} className="mt-4 rounded-lg bg-slate-50 p-3" aria-label={`Link a website to a property of ${integration.account_email ?? "this account"}`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">
          Website
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="">Choose a website</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id} disabled={!w.verified}>
                {w.domain}{w.verified ? "" : " (not verified in ZigmaNeural)"}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void loadProperties()} disabled={loading} className="rounded border border-slate-300 px-2 py-1 text-xs font-600 text-slate-700">
          {loading ? "Loading properties…" : properties ? "Refresh properties" : "Load Search Console properties"}
        </button>
      </div>
      {properties ? (
        properties.length === 0 ? (
          <p className="mt-3 text-xs text-slate-600">This Google account has no Search Console properties.</p>
        ) : (
          <fieldset className="mt-3">
            <legend className="text-xs font-700 text-slate-700">Search Console property</legend>
            <div className="mt-1 space-y-1">
              {properties.map((p) => (
                <label key={p.siteUrl} className={`flex flex-wrap items-center gap-2 text-xs ${p.canReadData ? "text-slate-800" : "text-slate-400"}`}>
                  <input type="radio" name={`property-${integration.id}`} value={p.siteUrl} checked={siteUrl === p.siteUrl} disabled={!p.canReadData} onChange={() => setSiteUrl(p.siteUrl)} />
                  <span className="font-mono">{p.siteUrl}</span>
                  <span>· {p.propertyType === "domain" ? "Domain property" : "URL-prefix property"}</span>
                  <span>· {PERMISSION_LABEL[p.permissionLevel] ?? p.permissionLevel}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )
      ) : null}
      {error ? <p role="alert" className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!websiteId || !siteUrl || busy} className="rounded bg-slate-900 px-3 py-1.5 text-xs font-700 text-white disabled:opacity-50">
          {busy ? "Linking…" : "Link property"}
        </button>
        <Link to="/search/performance" className="text-xs font-600 text-blue-700 underline">Open Search performance</Link>
      </div>
    </form>
  );
}
