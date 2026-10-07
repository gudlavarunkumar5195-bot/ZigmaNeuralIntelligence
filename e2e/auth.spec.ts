import { expect, test } from "@playwright/test";

test.describe("authentication surface", () => {
  test("renders the sign-in experience", async ({ page }) => {
    await page.goto("/#/login");

    await expect(page.getByRole("heading", { name: "ZigmaNeural" })).toBeVisible();
    await expect(page.locator("form").getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveAttribute("type", "email");
    await expect(page.locator("#password")).toHaveAttribute("type", "password");
  });

  test("switches to registration without leaving the route", async ({ page }) => {
    await page.goto("/#/login");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Organization name")).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
  });
});

test.describe("routing without a backend", () => {
  test("unauthenticated visitors are redirected from / to the login route", async ({ page }) => {
    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.locator("form").getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("unauthenticated visitors cannot reach a protected deep link", async ({ page }) => {
    await page.goto("/#/monitoring/alerts");
    await expect(page).toHaveURL(/#\/login$/);
  });

  test("unknown routes do not render protected content when signed out", async ({ page }) => {
    await page.goto("/#/definitely-not-a-page");
    await expect(page).toHaveURL(/#\/login$/);
  });
});
