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

// Bounds on hostile robots.txt files: longer patterns or more wildcards are
// ignored (they cannot be matched in bounded time and no real site needs them).
const MAX_PATTERN_LENGTH = 512;
const MAX_WILDCARDS = 16;

/**
 * Linear-time `*` / `$` glob match (no regular expressions, so no
 * catastrophic backtracking). Greedy-leftmost matching of the literal
 * segments is exact for patterns whose only metacharacter is `*`.
 */
export function robotsPatternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  if (!target.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return anchored ? target.length === pos : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = target.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  const last = parts[parts.length - 1];
  if (anchored) return target.length - last.length >= pos && target.endsWith(last);
  return target.indexOf(last, pos) >= 0;
}

function usablePattern(pattern: string): boolean {
  return pattern.length <= MAX_PATTERN_LENGTH && pattern.split("*").length - 1 <= MAX_WILDCARDS;
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
    if (!rule.pattern || !usablePattern(rule.pattern)) continue;
    if (!robotsPatternMatches(rule.pattern, target)) continue;
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
