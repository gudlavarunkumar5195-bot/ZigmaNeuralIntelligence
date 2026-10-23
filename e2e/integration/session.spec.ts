import { expect, test } from "@playwright/test";
import { fixture, openSignedIn, signIn, type Fixture } from "./helpers";

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

test.describe("session", () => {
  test("sign in, see real data, survive a browser refresh, sign out", async ({ page }) => {
    await openSignedIn(page, f.owner, f.password);
    await expect(page.getByRole("heading", { level: 1, name: f.siteA.domain })).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveText(f.owner);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: f.siteA.domain })).toBeVisible();

    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page).toHaveURL(/#\/login$/);
    // Protected pages are closed again, and nothing from the session is left in the tab.
    await page.goto("/#/websites");
    await expect(page).toHaveURL(/#\/login$/);
    expect(await page.evaluate(() => [sessionStorage.getItem("zn_token"), sessionStorage.getItem("zn_selected_website")])).toEqual([null, null]);
  });

  test("a signed-out deep link returns to that page after signing in", async ({ page }) => {
    await page.goto("/#/monitoring/alerts");
    await expect(page).toHaveURL(/#\/login$/);
    await signIn(page, f.owner, f.password);
    await expect(page).toHaveURL(/#\/monitoring\/alerts$/);
    await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
  });

  test("an expired access token is renewed with the refresh cookie, without signing out", async ({ page }) => {
    await openSignedIn(page, f.owner, f.password);
    await page.evaluate(() => sessionStorage.setItem("zn_token", "expired.invalid.token"));
    // Reload so the app starts from the stored (expired) token rather than the one in memory.
    await page.goto("/#/websites");
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: f.siteA.domain })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("zn_token"))).not.toBe("expired.invalid.token");
  });

  test("when the session cannot be renewed, the user is sent to sign in and back", async ({ page, context }) => {
    await openSignedIn(page, f.owner, f.password, "/websites");
    await expect(page.getByRole("heading", { level: 2, name: f.siteA.domain })).toBeVisible();
    await context.clearCookies(); // refresh cookie gone
    await page.evaluate(() => sessionStorage.setItem("zn_token", "expired.invalid.token"));
    await page.goto("/#/search/backlinks");
    await page.reload();
    await expect(page).toHaveURL(/#\/login$/);
    await signIn(page, f.owner, f.password);
    await expect(page).toHaveURL(/#\/search\/backlinks$/);
  });

  test("wrong password is refused with a visible error", async ({ page }) => {
    await page.goto("/#/login");
    await signIn(page, f.viewer, `${f.password}-wrong`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
  });
});
