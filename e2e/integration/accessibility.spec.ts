import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixture, openSignedIn, type Fixture } from "./helpers";

// Scan settled pages: mid-animation opacity would be misread as low contrast (the app honours reduced motion).
test.use({ reducedMotion: "reduce" });

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

// Automated WCAG 2.x A/AA checks (axe-core). Automated scanning finds only part
// of the issues; manual keyboard and screen-reader review is still required.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Serious or critical violations on the current page, as readable lines. */
async function violations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.length} node(s) — ${v.nodes.slice(0, 2).map((n) => `${n.target.join(" ")} ${n.html.slice(0, 120)} [${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 200)}]`).join(" | ")}`);
}
async function scan(page: Page, label: string) {
  expect(await violations(page, label)).toEqual([]);
}

test("login page has no serious or critical WCAG violations", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.getByRole("heading", { name: "ZigmaNeural" })).toBeVisible();
  await scan(page, "login");
});

const PAGES: Array<[string, string]> = [
  ["/", "dashboard"],
  ["/intelligence/workspace", "SEO workspace"],
  ["/intelligence/technical-health", "technical health"],
  ["/search/backlinks", "backlinks"],
  ["/monitoring/alerts", "alerts"],
  ["/monitoring", "monitoring"],
  ["/reports", "reports"],
  ["/settings/integrations", "settings"],
];

test("main signed-in pages have no serious or critical WCAG violations", async ({ page }) => {
  test.setTimeout(120_000);
  await openSignedIn(page, f.admin, f.password);
  const found: string[] = [];
  for (const [route, label] of PAGES) {
    await page.goto(`/#${route}`);
    await expect(page.locator("#zn-main h1")).toHaveCount(1, { timeout: 15_000 });
    found.push(...(await violations(page, label)));
  }
  expect(found).toEqual([]);
});
