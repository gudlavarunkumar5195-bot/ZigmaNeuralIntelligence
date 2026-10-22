export { btn, btnPrimary, input } from "../../../components/ui/styles";
import type { RankProject } from "../../../services/api";


export const configLabel = (p: RankProject) =>
  [p.search_engine === "google" ? "Google" : "Bing", p.country?.toUpperCase() ?? "any country", p.language ?? "any language", p.device ?? "any device", p.location].filter(Boolean).join(" · ");
