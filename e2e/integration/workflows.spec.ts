import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { fixture, openSignedIn, type Fixture } from "./helpers";

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

test.describe("permissions and tenant isolation", () => {
  test("a viewer is told up front, and a refused change leaves the record unchanged", async ({ page }) => {
    await openSignedIn(page, f.viewer, f.password, "/monitoring/alerts");
    await expect(page.getByRole("note").filter({ hasText: "view-only access" })).toBeVisible();
    const alert = page.locator("article", { hasText: f.alertTitles[1] });
    await alert.getByRole("button", { name: "Resolve" }).click();
    // The server names the roles that may do this.
    await expect(page.getByRole("alert")).toContainText(/requires one of: owner, admin, member/);
    await page.reload();
    await expect(page.locator("article", { hasText: f.alertTitles[1] })).toContainText("OPEN");
  });

  test("another organization's scan and website stay invisible", async ({ page }) => {
    await openSignedIn(page, f.owner, f.password, `/websites/scan/${f.siteB.scanId}`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(f.siteB.domain)).toHaveCount(0);
    // The API refuses it directly too, whatever the UI does.
    const status = await page.evaluate(async (id) => {
      const res = await fetch(`/api/v1/websites/${id}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem("zn_token")}`, "x-org-id": sessionStorage.getItem("zn_active_org_id") ?? "" } });
      return res.status;
    }, f.siteB.websiteId);
    expect([403, 404]).toContain(status);
    await page.goto("/#/websites");
    await expect(page.getByRole("heading", { level: 2, name: f.siteA.domain })).toBeVisible();
    await expect(page.getByText(f.siteB.domain)).toHaveCount(0);
  });
});

test.describe("mutations", () => {
  test("a member resolves an alert: one request, and the change survives a refresh", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/monitoring/alerts");
    const alert = page.locator("article", { hasText: f.alertTitles[0] });
    await expect(alert).toContainText("OPEN");
    let resolveCalls = 0;
    page.on("request", (r) => { if (r.method() === "POST" && /\/monitoring\/alerts\/[^/]+\/resolve$/.test(r.url())) resolveCalls++; });
    await alert.getByRole("button", { name: "Resolve" }).dblclick();
    await expect(page.locator("article", { hasText: f.alertTitles[0] })).toContainText("RESOLVED");
    expect(resolveCalls).toBe(1);
    await page.reload();
    await expect(page.locator("article", { hasText: f.alertTitles[0] })).toContainText("RESOLVED");
  });

  test("an unsafe website URL is rejected before anything is saved", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/websites/add");
    let posted = false;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/v1/websites")) posted = true; });
    await page.getByLabel("Public website URL").fill("http://127.0.0.1/admin");
    await page.getByRole("button", { name: "Connect website" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(posted).toBe(false);
  });
});

test.describe("modules", () => {
  test("technical health shows the issues found by the stored crawl", async ({ page }) => {
    await openSignedIn(page, f.admin, f.password, "/intelligence/technical-health");
    await expect(page.getByRole("heading", { level: 1, name: "Technical health" })).toBeVisible();
    await expect(page.locator("#issues-heading")).toBeVisible();
    await expect(page.getByText(/\/gone/).first()).toBeVisible();
  });

  test("backlink export downloads a CSV with spreadsheet formulas neutralized", async ({ page }) => {
    await openSignedIn(page, f.admin, f.password, "/search/backlinks/links");
    await expect(page.getByRole("heading", { level: 1, name: "Backlink intelligence" })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const text = fs.readFileSync((await download.path())!, "utf8");
    expect(text).toContain(`blog-`);
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });
});
