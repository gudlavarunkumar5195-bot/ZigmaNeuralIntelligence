import { useEffect, useState } from "react";
import { apiListWebsites, WebsiteRecord } from "../services/api";

/** Loads the org's websites (up to one max-size page) so UIs can show domains instead of ids. */
export function useWebsites(): {
  websites: WebsiteRecord[];
  loaded: boolean;
  domainOf: (websiteId: string) => string;
} {
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void apiListWebsites({ pageSize: 100 })
      .then((result) => { if (active && result.data) setWebsites(result.data); })
      .catch(() => {})
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);
  const domainOf = (websiteId: string) =>
    websites.find((site) => site.id === websiteId)?.domain ?? `Unknown website (${websiteId.slice(0, 8)})`;
  return { websites, loaded, domainOf };
}
