import { expect, test } from "@playwright/test";
import { NAV_GROUPS, routeTitle } from "../../src/components/layout/navigation";
import { fixture, openSignedIn, type Fixture } from "./helpers";

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

// Every page in the navigation model (admin pages need a platform admin and are covered by their own tests).
const ROUTES = NAV_GROUPS.filter((g) => !g.adminOnly).flatMap((g) => g.items.map((i) => i.path));

test("every navigable page renders against the real API (no crash, one heading, no page overflow)", async ({ page }) => {
  test.setTimeout(300_000);
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
  }
  expect(pageErrors).toEqual([]);
});
