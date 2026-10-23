import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NAV_GROUPS, routeTitle } from "../../src/components/layout/navigation";
import { fixture, openSignedIn, type Fixture } from "./helpers";

// Scan settled pages: mid-animation opacity would be misread as low contrast (the app honours reduced motion).
test.use({ reducedMotion: "reduce" });

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

// Every page in the navigation model (admin pages need a platform admin and are covered by their own tests).
const ROUTES = NAV_GROUPS.filter((g) => !g.adminOnly).flatMap((g) => g.items.map((i) => i.path));

test("every navigable page renders against the real API (no crash, one heading, no page overflow, no serious WCAG violations)", async ({ page }) => {
  test.setTimeout(420_000);
  const a11y: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // The API allows 200 requests a minute per client (a production control we
  // keep), and the earlier tests share that budget. Pace on the server's own
  // rate-limit headers: when fewer than 40 requests remain, wait for the reset.
  let remaining = Infinity;
  let resetAt = 0;
  page.on("response", (r) => {
    const left = r.headers()["x-ratelimit-remaining"];
    const reset = r.headers()["x-ratelimit-reset"];
    if (r.url().includes("/api/v1/") && left !== undefined) {
      remaining = Number(left);
      resetAt = Date.now() + Number(reset ?? 60) * 1000;
    }
  });
  /** Waits for the window to reset when the budget is low; true when it waited. */
  const withinBudget = async () => {
    if (remaining >= 40) return false;
    await page.waitForTimeout(Math.max(0, resetAt - Date.now()) + 250);
    remaining = Infinity;
    return true;
  };
  await openSignedIn(page, f.admin, f.password);
  for (const route of ROUTES) {
    const waited = await withinBudget();
    await page.goto(`/#${route}`);
    if (waited) await page.reload(); // re-request anything refused before the reset
    // A hash change keeps the document: wait until this route is the one on screen.
    await expect(page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]'), route).toHaveText(routeTitle(route).title);
    await expect(page.locator("#zn-main h1"), route).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByText("Something went wrong"), route).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} overflows horizontally`).toBeLessThanOrEqual(1);
    // Scan the settled page, not its loading skeleton (which is intentionally faint).
    await expect(page.locator("#zn-main")).not.toContainText(/Loading/, { timeout: 15_000 });
    // Automated WCAG 2.2 A/AA check (axe-core); manual review is still needed for full conformance.
    // A slow runner can scan a frame that is still being painted or animated, which reads as
    // low contrast; such a result is rescanned once and only a violation present twice counts.
    let serious: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await settle(page, attempt === 0 ? 0 : 1_000);
      const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      serious = scan.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
      if (serious.length === 0) break;
      if (attempt === 0) console.log(`[a11y] ${route}: rescanning after ${serious.map((v) => v.id).join(", ")}`);
    }
    for (const v of serious) {
      const nodes = v.nodes.slice(0, 2).map((n) => `${n.html.slice(0, 140)} [${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}]`);
      a11y.push(`${route}: ${v.id} (${v.impact}) — ${nodes.join(" | ")}`);
    }
  }
  expect(a11y).toEqual([]);
  expect(pageErrors).toEqual([]);
});

/** Waits for in-flight requests and running animations, then for two painted frames. */
async function settle(page: Page, extraMs: number) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  if (extraMs) await page.waitForTimeout(extraMs);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
