import { useParams } from "react-router";
import { PageHeader } from "../../../components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/DataState";
import { RouteTabs } from "../../../components/ui/Primitives";
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
    <div>
      <PageHeader eyebrow="Website Intelligence" title="Content" subtitle="Crawled inventory, rule-based content audit, topic coverage, evidence-backed opportunities and editable briefs."
        action={<label className="text-xs font-600 text-slate-700">Website
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} className={input}>{websites.map((w) => <option key={w.id} value={w.id}>{w.domain}</option>)}</select>
        </label>} />
      <RouteTabs label="Content sections" current={tab} tabs={CONTENT_TABS.map((t) => ({ id: t.id, label: t.label, to: t.id === "overview" ? "/intelligence/content" : `/intelligence/content/${t.id}` }))} />
      <div className="mt-5" key={websiteId}>
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
