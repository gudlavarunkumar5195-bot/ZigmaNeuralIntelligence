import { NavLink, useParams } from "react-router";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/DataState";
import { useWebsites } from "../../search/research/shared";
import { AuditTab, BriefsTab, InventoryTab, OpportunitiesTab, OverviewTab, TopicsTab } from "./tabs";
import { input } from "./ui";

export const CONTENT_TABS = [
  { id: "overview", label: "Overview" },
  { id: "inventory", label: "Inventory" },
  { id: "audit", label: "Audit" },
  { id: "topics", label: "Topics" },
  { id: "opportunities", label: "Opportunities" },
  { id: "briefs", label: "Briefs" },
] as const;
export type ContentTab = (typeof CONTENT_TABS)[number]["id"];

/** Content intelligence: crawled inventory, content audit, topics, opportunities and briefs. */
export function ContentPage() {
  const { tab: rawTab } = useParams();
  const tab: ContentTab = (CONTENT_TABS.find((t) => t.id === rawTab)?.id ?? "overview") as ContentTab;
  const { websites, websiteId, setWebsiteId, error } = useWebsites();
  if (error) return <ErrorState title="Unable to load websites" message={error} />;
  if (!websites) return <LoadingState label="Loading websites…" />;
  if (!websites.length) return <EmptyState title="No websites yet" description="Add and verify a website, then run a scan with the crawl module." />;
  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">Intelligence</p>
          <h2 className="mt-2 text-2xl font-800 text-slate-950">Content</h2>
        </div>
        <label className="text-xs text-slate-700">Website
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className={input}>{websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}</select>
        </label>
      </div>
      <nav aria-label="Content sections" className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {CONTENT_TABS.map((t) => (
          <NavLink key={t.id} to={t.id === "overview" ? "/intelligence/content" : `/intelligence/content/${t.id}`} end aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-xs font-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${tab === t.id ? "border-blue-600 text-blue-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-4" key={websiteId}>
        {tab === "overview" && <OverviewTab websiteId={websiteId} />}
        {tab === "inventory" && <InventoryTab websiteId={websiteId} />}
        {tab === "audit" && <AuditTab websiteId={websiteId} />}
        {tab === "topics" && <TopicsTab websiteId={websiteId} />}
        {tab === "opportunities" && <OpportunitiesTab websiteId={websiteId} />}
        {tab === "briefs" && <BriefsTab websiteId={websiteId} />}
      </div>
    </div>
  );
}
