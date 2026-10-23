import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export interface Fixture {
  password: string;
  owner: string;
  ownerId: string;
  modelName: string;
  listName: string;
  admin: string;
  member: string;
  viewer: string;
  other: string;
  orgA: string;
  orgB: string;
  siteA: { websiteId: string; scanId: string; domain: string };
  siteB: { websiteId: string; scanId: string; domain: string };
  alertTitles: string[];
}

/** Written by seed.mts when the API web server starts, so read it lazily (after start-up). */
export function fixture(): Fixture {
  return JSON.parse(fs.readFileSync(fileURLToPath(new URL("../.fixture.json", import.meta.url)), "utf8")) as Fixture;
}

/** Signs in through the real login form. */
export async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
}

/**
 * The API allows 200 requests a minute per client (a production control the
 * suite keeps). Before each test signs in, read the remaining budget from the
 * server's own rate-limit headers and wait for the window to reset if it is low.
 */
export async function respectRateLimit(page: Page, minimum = 60) {
  const res = await page.request.get("/api/v1/auth/me");
  const remaining = Number(res.headers()["x-ratelimit-remaining"] ?? Infinity);
  const reset = Number(res.headers()["x-ratelimit-reset"] ?? 0);
  if (remaining < minimum) await page.waitForTimeout(reset * 1000 + 250);
}

/** Opens the app signed in (through the form), then goes to `route`. */
export async function openSignedIn(page: Page, email: string, password: string, route = "/") {
  await respectRateLimit(page);
  await page.goto("/#/login");
  await signIn(page, email, password);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
  if (route !== "/") await page.goto(`/#${route}`);
}
