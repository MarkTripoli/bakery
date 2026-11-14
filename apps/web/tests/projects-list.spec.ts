import { expect, type Page, test } from "@playwright/test";
import {
  application,
  type Options,
  projectsFixture,
  repository,
} from "./helpers/projects-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Projects list (design-ux, #65, slice 1): the applications and their
 * repositories with one badge (only where it is known) and one button per row,
 * Add repository from the GitHub connection, and application create, rename
 * and archive.
 */

const PAYMENTS = application(1, "Payments");
const WEB = application(2, "Web storefront");
const OLD = application(3, "Old app", {
  archivedAt: "2026-01-01T00:00:00.000Z",
});
const WORLD: Options = {
  applications: [PAYMENTS, WEB, OLD],
  repositories: [
    repository(1, PAYMENTS.id, "ledger"),
    repository(2, PAYMENTS.id, "billing", {
      activeProfileId: "00000000-0000-4000-8000-000000000999",
    }),
    repository(3, PAYMENTS.id, "legacy", {
      archivedAt: "2026-01-01T00:00:00.000Z",
    }),
    repository(4, WEB.id, "shop", {
      activeProfileId: "00000000-0000-4000-8000-000000000998",
    }),
  ],
  offered: [
    { id: "5001", name: "acme/ledger" },
    { id: "5009", name: "acme/payments-web" },
    { id: "5010", name: "acme/mobile app" },
    { id: "5011", name: "acme/hidden", selected: false },
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: projects list`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (page: Page, options: Options = WORLD) => {
      const seen = await projectsFixture(page, options);
      await page.goto("/projects");
      return seen;
    };
    const section = (page: Page, name: string) =>
      page.locator(`[data-application-id]`).filter({ hasText: name }).first();

    test("groups repositories under their application with a badge only where it is known and one button each", async ({ page }) => {
      await open(page);
      await expect(page.getByRole("heading", { name: "Projects", level: 1 }))
        .toBeVisible();
      await expect(page.getByText(
        "Your applications and the repositories Bakery works in.",
      )).toBeVisible();
      const payments = section(page, "Payments");
      await expect(payments.getByText("2 repositories")).toBeVisible();
      // No working settings: Not set up, with Set up.
      const ledger = payments.locator("[data-repository-id]").filter({
        hasText: "acme/ledger",
      });
      await expect(ledger).toContainText("Not set up");
      await expect(ledger).toContainText(
        "Working settings are not chosen yet.",
      );
      await expect(ledger.getByRole("button")).toHaveCount(1);
      await expect(ledger.getByRole("button", { name: /Set up/ }))
        .toBeVisible();
      // Settings in use: nothing is guessed, no badge, Open.
      const billing = payments.locator("[data-repository-id]").filter({
        hasText: "acme/billing",
      });
      await expect(billing).toContainText("Default branch main");
      await expect(billing.getByText("Not set up")).toHaveCount(0);
      await expect(billing.getByRole("button", { name: /Open/ })).toBeVisible();
      // Archived ones are hidden until asked for.
      await expect(page.getByText("acme/legacy")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /Old app/ })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Show archived" }).click();
      await expect(page.getByText("acme/legacy")).toBeVisible();
      await expect(page.getByRole("heading", { name: /Old app/ }))
        .toBeVisible();
      await page.getByRole("button", { name: "Hide archived" }).click();
      await expect(page.getByText("acme/legacy")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "projects-list");
    });

    test("a row's button opens that repository's setup", async ({ page }) => {
      await open(page);
      await section(page, "Payments").getByRole("button", {
        name: "Set up acme/ledger",
      }).click();
      await expect(page).toHaveURL(
        new RegExp(
          `/projects/onboarding\\?.*repository=${
            repository(1, PAYMENTS.id, "ledger").id
          }`,
        ),
      );
    });

    test("an empty organization is told to add a repository, or to connect GitHub first", async ({ page }) => {
      await open(page, { applications: [], repositories: [], offered: [] });
      await expect(page.getByText("No repositories yet")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add repository" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "projects-empty");
    });

    test("without a GitHub connection the empty list says to connect GitHub first", async ({ page }) => {
      await open(page, { applications: [], repositories: [], offered: null });
      await expect(page.getByText("Connect GitHub first")).toBeVisible();
      await expect(page.getByRole("button", { name: "Open Integrations" }))
        .toBeVisible();
    });

    test("a member reads the list and cannot add or change anything", async ({ page }) => {
      await open(page, { ...WORLD, role: "developer" });
      await expect(section(page, "Payments")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add repository" }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "New application" }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: /^More about/ }))
        .toHaveCount(0);
    });

    test("Add repository offers what the connection lists, shows what is already added and keeps it off the list", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: "Add repository" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add repository" });
      await expect(
        dialog.getByText("Choose a repository from your GitHub connection."),
      )
        .toBeVisible();
      // Selected and available only; one is already added and cannot be picked.
      await expect(dialog.getByText("acme/payments-web")).toBeVisible();
      await expect(dialog.getByText("acme/hidden")).toHaveCount(0);
      const added = dialog.getByText("acme/ledger");
      await expect(added).toBeVisible();
      await expect(dialog.getByText("Already added")).toBeVisible();
      await expect(dialog.getByRole("button", { name: /acme\/ledger/ }))
        .toHaveCount(0);
      // Search narrows the list.
      await dialog.getByRole("searchbox").fill("payments");
      await expect(dialog.getByText("acme/mobile app")).toHaveCount(0);
      await expect(dialog.getByText("acme/payments-web")).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "projects-add-pick", [], { windowOnly: true });
    });

    test("step two derives a short name, takes the branch and application, and sends exactly that", async ({ page }) => {
      const seen = await open(page);
      await page.getByRole("button", { name: "Add repository" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add repository" });
      await dialog.getByRole("button", { name: /acme\/payments-web/ }).click();
      await expect(dialog.getByText("Adding acme/payments-web.")).toBeVisible();
      await expect(dialog.getByLabel("Short name")).toHaveValue("payments-web");
      await expect(dialog.getByLabel("Default branch")).toHaveValue("main");
      await expect(dialog.getByText(
        "Bakery works from this branch by default. Check that it matches the repository's default branch on GitHub.",
      )).toBeVisible();
      // Nothing is sent without an application.
      await dialog.getByRole("button", { name: "Add repository" }).click();
      await expect(
        dialog.getByText("Choose an application, or make a new one."),
      )
        .toBeVisible();
      expect(seen.createdRepositories).toEqual([]);
      await dialog.getByLabel("Application").selectOption({
        label: "Payments",
      });
      await dialog.getByLabel("Short name").fill("pay-web");
      await dialog.getByLabel("Default branch").fill("develop");
      await page.mouse.move(700, 700);
      await shot(page, "projects-add-details", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Add repository" }).click();
      await expect.poll(() => seen.createdRepositories.length).toBe(1);
      expect(seen.createdRepositories[0]).toMatchObject({
        applicationId: PAYMENTS.id,
        slug: "pay-web",
        owner: "acme",
        name: "payments-web",
        providerRepoId: "5009",
        defaultBranch: "develop",
      });
      // It opens the new repository's own page.
      await expect(page).toHaveURL(/\/projects\/onboarding\?/);
    });

    test("a short name that does not fit, or an emptied branch, is named", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: "Add repository" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add repository" });
      await dialog.getByRole("button", { name: /acme\/payments-web/ }).click();
      await dialog.getByLabel("Application").selectOption({
        label: "Payments",
      });
      await dialog.getByLabel("Short name").fill("-Bad Name");
      await dialog.getByLabel("Default branch").fill("");
      await dialog.getByRole("button", { name: "Add repository" }).click();
      await expect(dialog.getByText("Use letters, numbers and dashes only"))
        .toBeVisible();
      await expect(dialog.getByText("Enter a branch name.")).toBeVisible();
    });

    test("a refusal without a reason says the short name is used or the repository was just added", async ({ page }) => {
      await open(page, { ...WORLD, create: "conflict" });
      await page.getByRole("button", { name: "Add repository" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add repository" });
      await dialog.getByRole("button", { name: /acme\/payments-web/ }).click();
      await dialog.getByLabel("Application").selectOption({
        label: "Payments",
      });
      await dialog.getByRole("button", { name: "Add repository" }).click();
      await expect(dialog.getByText(
        "That short name is already used, or someone else just added this repository. Change the short name, or reload the page.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "projects-add-refused", [], { windowOnly: true });
    });

    test("a new application can be made inside Add repository", async ({ page }) => {
      const seen = await open(page);
      await page.getByRole("button", { name: "Add repository" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add repository" });
      // A name with a space is not owner/name, so it is not offered.
      await expect(dialog.getByText("acme/mobile app")).toHaveCount(0);
      await dialog.getByRole("button", { name: /acme\/payments-web/ }).click();
      await dialog.getByLabel("Application").selectOption({
        label: "New application…",
      });
      await dialog.getByLabel(/^Name\b/).fill("Mobile apps");
      await expect(dialog.getByLabel("Short name").first()).toHaveValue(
        "mobile-apps",
      );
      await dialog.getByRole("button", { name: "Add repository" }).click();
      await expect.poll(() => seen.createdApplications.length).toBe(1);
      expect(seen.createdApplications[0]).toMatchObject({
        name: "Mobile apps",
        slug: "mobile-apps",
      });
      await expect.poll(() => seen.createdRepositories.length).toBe(1);
    });

    test("New application asks for a name and a short name that follows it", async ({ page }) => {
      const seen = await open(page);
      await page.getByRole("button", { name: "New application" }).first()
        .click();
      const dialog = page.getByRole("dialog", { name: "New application" });
      await expect(dialog.getByText(
        "A product or service. It groups the repositories that belong together.",
      )).toBeVisible();
      await dialog.getByRole("button", { name: "Create application" }).click();
      await expect(dialog.getByText("Enter a name.")).toBeVisible();
      await dialog.getByLabel(/^Name\b/).fill("Data platform");
      await expect(dialog.getByLabel("Short name")).toHaveValue(
        "data-platform",
      );
      await page.mouse.move(700, 700);
      await shot(page, "projects-new-application", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Create application" }).click();
      await expect.poll(() => seen.createdApplications.length).toBe(1);
      expect(seen.createdApplications[0]).toMatchObject({
        name: "Data platform",
        slug: "data-platform",
      });
      await expect(page.getByRole("heading", { name: "Data platform" }))
        .toBeVisible();
    });

    test("Rename sends the new name with the version it saw", async ({ page }) => {
      const seen = await open(page);
      await section(page, "Payments").getByRole("button", {
        name: "More about Payments",
      }).click();
      await page.getByRole("button", { name: "Rename" }).click();
      const dialog = page.getByRole("dialog", { name: "Rename application" });
      await dialog.getByLabel(/^Name\b/).fill(
        "Payments platform",
      );
      await page.mouse.move(700, 700);
      await shot(page, "projects-rename", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Rename" }).click();
      await expect.poll(() => seen.updates.length).toBe(1);
      expect(seen.updates[0]).toMatchObject({
        id: PAYMENTS.id,
        ifMatch: '"v1"',
        body: { name: "Payments platform" },
      });
      await expect(page.getByRole("heading", { name: "Payments platform" }))
        .toBeVisible();
    });

    test("Archive asks first, then hides the application until Show archived", async ({ page }) => {
      const seen = await open(page);
      await section(page, "Web storefront").getByRole("button", {
        name: "More about Web storefront",
      }).click();
      await page.getByRole("button", { name: "Archive", exact: true }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Archive Web storefront?");
      await dialog.getByRole("button", { name: "Archive", exact: true })
        .click();
      await expect.poll(() => seen.updates.length).toBe(1);
      expect(seen.updates[0]?.body.archivedAt).toEqual(expect.any(String));
      await expect(page.getByRole("heading", { name: /Web storefront/ }))
        .toHaveCount(0);
    });

    test("Cancel and Escape return focus to the button that opened a dialog", async ({ page }) => {
      await open(page);
      const add = page.getByRole("button", { name: "Add repository" }).first();
      await add.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Add repository" }))
        .toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(add).toBeFocused();
    });

    test("with more than a page of applications, Load more adds the next and puts focus on what it added", async ({ page }) => {
      const many = Array.from(
        { length: 30 },
        (_, index) => application(10 + index, `App number ${index + 1}`),
      );
      await open(page, {
        applications: many,
        repositories: [],
        offered: [],
        pageSize: 25,
      });
      await expect(page.getByRole("heading", { name: "App number 25" }))
        .toBeVisible();
      await expect(page.getByRole("heading", { name: "App number 26" }))
        .toHaveCount(0);
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(page.getByRole("heading", { name: "App number 30" }))
        .toBeVisible();
      await expect(more).toHaveCount(0);
    });
  });
}
