import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { PageHeader } from "../../../components/ui/Card";
import { EmptyState, ErrorState, IntegrationRequiredState, LoadingState } from "../../../components/ui/DataState";
import { RouteTabs } from "../../../components/ui/Primitives";
import { apiRankCreateProject, apiRankProjects, apiRankSources, apiRankUpdateProject, IntegrationRequired, type RankProject, type RankSources } from "../../../services/api";
import { ConfirmDialog } from "../../../components/ui/Dialog";
import { useBusy } from "../../../lib/useBusy";
import { useWebsites } from "../research/shared";
import { AlertsTab, CompetitorsTab, FeaturesTab, HistoryTab, ImportTab, KeywordsTab, OverviewTab, SourcesTab } from "./tabs";
import { btn, btnPrimary, configLabel, input } from "./ui";

export const RANK_TABS = [
  { id: "overview", label: "Overview" },
  { id: "keywords", label: "Keywords" },
  { id: "history", label: "History" },
  { id: "competitors", label: "Competitors" },
  { id: "features", label: "SERP features" },
  { id: "alerts", label: "Alerts" },
  { id: "import", label: "Import" },
  { id: "sources", label: "Data sources" },
] as const;
export type RankTab = (typeof RANK_TABS)[number]["id"];


/**
 * Rank tracking: projects per website and search configuration; rankings
 * only from imported reports or a configured SERP provider.
 */
export function RankTrackingPage() {
  const { tab: rawTab } = useParams();
  const tab: RankTab = (RANK_TABS.find((t) => t.id === rawTab)?.id ?? "overview") as RankTab;
  const [projects, setProjects] = useState<RankProject[] | null>(null);
  const [sources, setSources] = useState<RankSources | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const { busy, guard } = useBusy();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, s] = await Promise.all([apiRankProjects(), apiRankSources()]);
      if (p.error) throw new Error(p.error.message);
      if (s.error) throw new Error(s.error.message);
      setProjects(p.data ?? []);
      setSources(s.data);
      setProjectId((cur) => cur || p.data?.[0]?.id || "");
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const setStatus = guard(async (status: "active" | "paused" | "archived") => {
    if (!projectId) return;
    setProjectMessage(null);
    const r = await apiRankUpdateProject(projectId, { status });
    setConfirmArchive(false);
    if (r.error) return setProjectMessage(r.error.message);
    if (status === "archived") setProjectId("");
    await load();
  });

  if (error instanceof IntegrationRequired) return <IntegrationRequiredState feature="Rank tracking" />;
  if (error) return <ErrorState title="Unable to load rank tracking" message={error.message} onRetry={load} />;
  if (!projects || !sources) return <LoadingState label="Loading rank tracking…" />;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const providerAvailable = sources.sources.some((s) => s.id !== "csv_import" && s.id !== "google_search_console" && s.status === "available");

  return (
    <div>
      <PageHeader eyebrow="SEO Research" title="Rank tracking" subtitle="Observed keyword positions, SERP features and competitors per project. Rankings come only from imported reports or a configured SERP provider."
        action={<>
          {projects.length ? (
            <label className="text-xs font-600 text-slate-700">Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.website_domain}{p.status === "paused" ? " (paused)" : ""}</option>)}
              </select>
            </label>
          ) : null}
          <button type="button" className={btn} onClick={() => setCreating((c) => !c)} aria-expanded={creating}>New project</button>
        </>} />
      {!providerAvailable ? (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-950">
          No SERP data provider is configured, so rankings are not collected automatically. Import ranking reports from a tool you are authorized to use (Import tab); scheduled tracking needs an approved provider (Data sources tab).
        </p>
      ) : null}
      {creating || projects.length === 0 ? (
        <NewProject providerAvailable={providerAvailable} onCreated={async (p) => { setCreating(false); await load(); setProjectId(p.id); }} onCancel={projects.length ? () => setCreating(false) : undefined} />
      ) : null}
      {projects.length === 0 ? null : !project ? <EmptyState title="Choose a project" /> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>{configLabel(project)} · {project.frequency === "manual" ? "updated by imports" : `${project.frequency} tracking`} · time zone {project.timezone}{project.status === "paused" ? " · paused" : ""}</span>
            <button type="button" className={btn} disabled={busy} onClick={() => void setStatus(project.status === "paused" ? "active" : "paused")}>{project.status === "paused" ? "Resume project" : "Pause project"}</button>
            <button type="button" className={btn} disabled={busy} onClick={() => setConfirmArchive(true)}>Archive…</button>
            {projectMessage ? <span role="alert" className="text-red-700">{projectMessage}</span> : null}
          </div>
          <ConfirmDialog open={confirmArchive} title={`Archive “${project.name}”?`} confirmLabel="Archive project" busy={busy}
            description="The project leaves this list and any running collection stops. Its keywords and ranking history stay stored, but the app cannot reopen an archived project."
            onCancel={() => setConfirmArchive(false)} onConfirm={() => void setStatus("archived")} />
          <RouteTabs label="Rank tracking sections" current={tab} tabs={RANK_TABS.map((t) => ({ id: t.id, label: t.label, to: t.id === "overview" ? "/search/rankings" : `/search/rankings/${t.id}` }))} />
          <div className="mt-5" key={project.id}>
            {tab === "overview" && <OverviewTab project={project} providerAvailable={providerAvailable} onChanged={load} />}
            {tab === "keywords" && <KeywordsTab project={project} sources={sources} />}
            {tab === "history" && <HistoryTab project={project} />}
            {tab === "competitors" && <CompetitorsTab project={project} sources={sources} />}
            {tab === "features" && <FeaturesTab project={project} />}
            {tab === "alerts" && <AlertsTab project={project} />}
            {tab === "import" && <ImportTab project={project} sources={sources} onImported={load} />}
            {tab === "sources" && <SourcesTab sources={sources} />}
          </div>
        </>
      )}
    </div>
  );
}

function NewProject({ providerAvailable, onCreated, onCancel }: { providerAvailable: boolean; onCreated: (p: RankProject) => void; onCancel?: () => void }) {
  const { websites, websiteId, setWebsiteId } = useWebsites();
  const [form, setForm] = useState({ name: "", searchEngine: "google" as "google" | "bing", country: "", language: "", device: "" as "" | "desktop" | "mobile", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", frequency: "manual" as "manual" | "daily" | "weekly" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiRankCreateProject({ websiteId, name: form.name.trim(), searchEngine: form.searchEngine, country: form.country.trim() || null, language: form.language.trim() || null, device: form.device || null, timezone: form.timezone, frequency: form.frequency });
      if (r.error || !r.data) return setMessage(r.error?.message ?? "Could not create the project.");
      onCreated(r.data);
    } finally {
      setBusy(false);
    }
  };
  if (!websites) return <LoadingState label="Loading websites…" />;
  if (!websites.length) return <EmptyState title="No websites yet" description="Add and verify a website before tracking its rankings." />;
  return (
    <form onSubmit={submit} aria-label="New rank-tracking project" className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-700 text-slate-900">New project</h3>
      <p className="mt-1 text-xs text-slate-600">One project per website and search configuration. Rankings for another country, language or device belong in another project.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-slate-700">Website<select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className={input}>{websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}</select></label>
        <label className="text-xs text-slate-700">Name<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} /></label>
        <label className="text-xs text-slate-700">Search engine<select value={form.searchEngine} onChange={(e) => setForm({ ...form, searchEngine: e.target.value as "google" | "bing" })} className={input}><option value="google">Google</option><option value="bing">Bing</option></select></label>
        <label className="text-xs text-slate-700">Country (ISO code)<input maxLength={2} placeholder="e.g. us" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className={input} /></label>
        <label className="text-xs text-slate-700">Language<input maxLength={12} placeholder="e.g. en" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className={input} /></label>
        <label className="text-xs text-slate-700">Device<select value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value as typeof form.device })} className={input}><option value="">Any</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label>
        <label className="text-xs text-slate-700">Time zone<input maxLength={64} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className={input} /></label>
        <label className="text-xs text-slate-700">Tracking
          <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as typeof form.frequency })} className={input}>
            <option value="manual">Manual (imports)</option>
            <option value="daily" disabled={!providerAvailable}>Daily{providerAvailable ? "" : " — needs a provider"}</option>
            <option value="weekly" disabled={!providerAvailable}>Weekly{providerAvailable ? "" : " — needs a provider"}</option>
          </select>
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="submit" className={btnPrimary} disabled={busy || !form.name.trim()}>{busy ? "Creating…" : "Create project"}</button>
        {onCancel ? <button type="button" className={btn} onClick={onCancel}>Cancel</button> : null}
      </div>
      {message ? <p role="alert" className="mt-2 text-xs text-red-800">{message}</p> : null}
    </form>
  );
}
