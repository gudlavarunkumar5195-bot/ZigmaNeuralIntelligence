import { expect, test } from "@playwright/test";
import { fixture, openSignedIn, type Fixture } from "./helpers";

let f: Fixture;
test.beforeAll(() => { f = fixture(); });

test.describe("module workflows (real API, persisted)", () => {
  test("rank tracking: create a project, add keywords, pause it; all survives a reload", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/search/rankings");
    const form = page.getByRole("form", { name: "New rank-tracking project" });
    await form.getByLabel("Name").fill("E2E project");
    await form.getByRole("button", { name: "Create project" }).click();
    await page.goto("/#/search/rankings/keywords");
    await page.getByLabel("Keywords (one per line)").fill("trail running shoes\nwaterproof hiking boots");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added" })).toContainText("Added 2");
    await page.getByRole("button", { name: "Pause project" }).click();
    await expect(page.getByRole("button", { name: "Resume project" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Resume project" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "waterproof hiking boots" })).toBeVisible();
  });

  test("technical health: ignore an issue with a reason, then reopen it", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/intelligence/technical-health");
    const first = page.locator("#issues-heading ~ * li").first();
    const title = (await first.locator("p").first().innerText()).trim();
    await first.getByRole("button", { name: /^Ignore…/ }).click();
    await first.getByLabel("Reason").fill("Known; handled by the redirect project");
    await first.getByRole("button", { name: /Ignore/ }).last().click();
    await page.reload();
    await page.getByRole("button", { name: /^Ignored \(1\)/ }).click();
    const ignored = page.locator("#issues-heading ~ * li").first();
    await expect(ignored).toContainText("Known; handled by the redirect project");
    await ignored.getByRole("button", { name: /^Reopen/ }).click();
    await ignored.getByRole("button", { name: "Confirm reopen" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /^Ignored \(0\)/ })).toBeVisible();
    expect(title.length).toBeGreaterThan(0);
  });

  test("content: create a topic; it persists", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/intelligence/content/topics");
    await page.getByRole("form", { name: "New topic" }).getByLabel("New topic").fill("Trail running");
    await page.getByRole("button", { name: "Add topic" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Trail running" })).toBeVisible();
  });

  test("keywords: remove a keyword from a saved list, then delete the list (confirmed)", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/search/keywords");
    const row = page.locator("li", { hasText: f.listName });
    await row.getByRole("button", { name: "Open" }).click();
    await row.getByRole("button", { name: "Remove waterproof hiking boots from the list" }).click();
    await expect(row.getByRole("button", { name: "Remove waterproof hiking boots from the list" })).toHaveCount(0);
    await expect(row).toContainText("1 keyword(s)");
    await row.getByRole("button", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete list" }).click();
    await page.reload();
    await expect(page.locator("#lists-heading")).toBeVisible();
    await expect(page.getByText(f.listName)).toHaveCount(0);
  });

  test("AI visibility: create a brand, then re-run matching over stored answers", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/intelligence/ai-visibility");
    const form = page.getByRole("form", { name: "Brand" });
    await form.getByLabel("Name", { exact: true }).fill("Shoeco");
    // Brand domains must be public domains (the reserved .test TLD is refused); nothing is fetched.
    await form.getByLabel("Official domains (comma-separated)").fill("shoeco-e2e.com");
    await form.getByRole("button", { name: "Create brand" }).click();
    await page.goto("/#/intelligence/ai-visibility/brand");
    await page.getByRole("button", { name: "Re-run matching" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Re-matched" })).toContainText("All stored observations are up to date");
  });
});

test.describe("administration of monitoring and integrations", () => {
  test("an org admin adds an alert rule; it is stored", async ({ page }) => {
    await openSignedIn(page, f.admin, f.password, "/monitoring");
    await page.getByRole("button", { name: "Alert rules" }).first().click();
    const rules = page.getByRole("region", { name: /Alert rules for/ });
    await rules.getByLabel("Add rule").selectOption("score_drop");
    await rules.getByLabel("Points").fill("15");
    await rules.getByRole("button", { name: "Save rule" }).click();
    await expect(rules.getByRole("status")).toContainText("15 points");
    await page.reload();
    await page.getByRole("button", { name: "Alert rules" }).first().click();
    await expect(page.getByRole("region", { name: /Alert rules for/ })).toContainText("A score drop of at least… 15 points");
  });

  test("a member cannot read alert rules: the refusal is shown, not an empty list", async ({ page }) => {
    await openSignedIn(page, f.member, f.password, "/monitoring");
    await page.getByRole("button", { name: "Alert rules" }).first().click();
    await expect(page.getByRole("region", { name: /Alert rules for/ }).getByRole("alert")).toContainText("Could not load the alert rules");
  });

  test("an org admin unlinks a Search Console property after confirming", async ({ page }) => {
    await openSignedIn(page, f.admin, f.password, "/settings/integrations");
    await expect(page.getByText(`sc-domain:${f.siteA.domain}`)).toBeVisible();
    await page.getByRole("button", { name: "Unlink", exact: true }).click();
    await page.getByRole("button", { name: "Unlink and delete" }).click();
    await page.reload();
    await expect(page.getByText(`sc-domain:${f.siteA.domain}`)).toHaveCount(0);
  });

  test("a platform admin disables a model with a reason and enables it again", async ({ page }) => {
    await openSignedIn(page, f.owner, f.password, "/agents/model-registry");
    await page.getByText(f.modelName).click();
    await page.getByLabel("Reason (recorded in the audit log)").fill("E2E: temporarily excluded from routing");
    await page.getByRole("button", { name: "Disable model" }).click();
    await expect(page.getByText("Disabled for routing (all organizations).")).toBeVisible();
    await page.reload();
    await page.getByText(f.modelName).click();
    await expect(page.getByText("Disabled for routing (all organizations).")).toBeVisible();
    await page.getByRole("button", { name: "Enable model" }).click();
    await expect(page.getByText("Enabled for routing (all organizations).")).toBeVisible();
  });

  test("a platform admin sees the full audit log", async ({ page }) => {
    await openSignedIn(page, f.owner, f.password, "/admin/control-center");
    await page.getByText("Full audit log").click();
    await expect(page.getByRole("table", { name: "Administrative audit log" }).or(page.getByText("No administrative actions recorded."))).toBeVisible();
  });
});
