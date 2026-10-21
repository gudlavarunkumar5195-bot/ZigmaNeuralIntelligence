import { DatabaseZap } from "lucide-react";
import { EmptyState } from "../../components/ui/DataState";

/**
 * Search-data features (keywords, rankings, backlinks, competitors) need an
 * authorized external data source. Until one is connected these views say so
 * plainly and show no numbers: nothing here is estimated or simulated.
 */
function SearchDataUnavailable({ title, needs, why }: { title: string; needs: string; why: string }) {
  return (
    <div className="mx-auto max-w-4xl p-6 md:p-10">
      <p className="font-mono text-[11px] uppercase tracking-[.18em] text-blue-700">{title}</p>
      <EmptyState
        icon={<DatabaseZap size={19} className="text-blue-600" />}
        title="Unavailable: no data source connected"
        description={`${needs} ${why} No figures are shown until a real, authorized source is connected.`}
      />
    </div>
  );
}

const OWN_CRAWL = "The ZigmaNeural crawler only measures your own verified site, so it cannot produce this data.";

export function KeywordsPage() {
  return <SearchDataUnavailable title="Keywords" needs="Keyword volumes and difficulty require a licensed keyword data provider or your Google Search Console data." why={OWN_CRAWL} />;
}
export function RankingsPage() {
  return <SearchDataUnavailable title="Rankings" needs="Ranking positions require a connected Google Search Console property or a licensed SERP data provider." why={OWN_CRAWL} />;
}
export function BacklinksPage() {
  return <SearchDataUnavailable title="Backlinks" needs="Backlinks and referring domains require a licensed backlink index provider." why={OWN_CRAWL} />;
}
export function CompetitorsPage() {
  return <SearchDataUnavailable title="Competitors" needs="Competitor keyword and traffic comparisons require a licensed search data provider." why={OWN_CRAWL} />;
}
