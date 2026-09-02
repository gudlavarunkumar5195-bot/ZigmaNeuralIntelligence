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
