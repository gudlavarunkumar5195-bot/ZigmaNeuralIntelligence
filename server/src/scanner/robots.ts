/**
 * robots.txt parsing and matching per RFC 9309 (Robots Exclusion Protocol).
 *
 * - Groups start with one or more `user-agent` lines; the group whose product
 *   token matches our token (case-insensitive) wins, otherwise the `*` group.
 * - Rules are `allow` / `disallow` path patterns; `*` matches any sequence and
 *   a trailing `$` anchors the end. The most specific (longest) matching rule
 *   wins; on a tie, `allow` wins. An empty `disallow` allows everything.
 * - `sitemap` lines are global (not group-scoped).
 * - `/robots.txt` itself is always allowed.
 */

export const CRAWLER_TOKEN = "zigmaneural-scanner";

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** Rules that apply to our crawler. */
  rules: RobotsRule[];
  sitemaps: string[];
  /** Seconds, if the matched group declares one (non-standard; capped by the crawler). */
  crawlDelay: number | null;
}

/** How the crawler should treat the site given the robots.txt fetch outcome. */
export type RobotsFetchOutcome =
  | { kind: "parsed"; policy: RobotsPolicy }
  | { kind: "missing" } // 4xx: crawl everything (RFC 9309 2.3.1.3)
  | { kind: "unreachable" }; // 5xx / network error: assume complete disallow (RFC 9309 2.3.1.4)

const MAX_ROBOTS_BYTES = 500 * 1024; // RFC 9309 requires parsing at least 500 KiB

export function parseRobotsTxt(text: string, token = CRAWLER_TOKEN): RobotsPolicy {
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any user-agent are ignored
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // empty disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const ours = groups.filter((g) => g.agents.some((a) => a === token.toLowerCase()));
  const chosen = ours.length > 0 ? ours : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    sitemaps,
    crawlDelay: chosen.map((g) => g.crawlDelay).find((d) => d !== null) ?? null,
  };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** Path + query of a URL, percent-encoding normalized for comparison. */
function matchTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

export function isAllowedByRobots(policy: RobotsPolicy, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname === "/robots.txt") return true;
  const target = matchTarget(parsed);
  let best: RobotsRule | null = null;
  for (const rule of policy.rules) {
    if (!rule.pattern) continue;
    if (!patternToRegExp(rule.pattern).test(target)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

export function robotsAllows(outcome: RobotsFetchOutcome, url: string): boolean {
  if (outcome.kind === "missing") return true;
  if (outcome.kind === "unreachable") return false;
  return isAllowedByRobots(outcome.policy, url);
}
