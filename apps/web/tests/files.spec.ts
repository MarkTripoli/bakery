import { expect, test } from "@playwright/test";
import { filesFixture } from "./helpers/files-fixture.ts";
import { uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/** The files browser (#445): folders, a file's details, its versions and uses. */
for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: files`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the top of the tree lists the folders with what each holds", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files");
      await expect(page.getByRole("heading", { name: "Files", level: 1 }))
        .toBeVisible();
      const files = page.getByTestId("files-page");
      await expect(files.getByRole("link", { name: "projects" })).toBeVisible();
      await expect(files.getByRole("link", { name: "Your files" }))
        .toBeVisible();
      await expect(page.getByText(
        "Each project's documents, run outputs, workspaces and reference files.",
      )).toBeVisible();
      await expect(page.getByText(
        "Your own uploads and scratch files. Only you can see them.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-top");
    });

    test("a folder lists its folders first, then its files, with kind, size and date", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await expect(page.getByRole("link", { name: "docs" })).toBeVisible();
      const plan = page.locator(`[data-entry-id="${uuid(40)}"]`);
      await expect(plan).toContainText("Plan");
      await expect(plan).toContainText("4.1 KB");
      await expect(page.locator(`[data-entry-id="${uuid(41)}"]`))
        .toContainText("3.2 MB");
      await expect(
        page.getByRole("navigation", { name: "Folder path" }),
      ).toContainText("web-app");
      await page.mouse.move(700, 700);
      await still(page, "files-folder");
    });

    test("opening a folder from the top goes down the breadcrumb", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files");
      const files = page.getByTestId("files-page");
      await files.getByRole("link", { name: "projects" }).click();
      await expect(page).toHaveURL(/\/files\/projects$/);
      await files.getByRole("link", { name: "web-app" }).last().click();
      await expect(page).toHaveURL(/\/files\/projects\/web-app$/);
      await expect(page.getByRole("link", { name: "plan.md" })).toBeVisible();
    });

    test("a path that is not a folder says it was not found, and Go to Files goes back", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/nowhere");
      await expect(page.getByText("This folder was not found")).toBeVisible();
      await page.getByRole("button", { name: "Go to Files" }).click();
      await expect(page).toHaveURL(/\/files$/);
    });

    test("an empty folder says so", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app/docs");
      await expect(page.getByText("This folder is empty")).toBeVisible();
    });

    test("a folder that fails to load offers Try again", async ({ page }) => {
      await filesFixture(page, { entriesFail: true });
      await page.goto("/files/projects/web-app");
      await expect(page.getByText("This folder did not load.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
    });

    test("Load more adds the next page of a long folder", async ({ page }) => {
      await filesFixture(page, { pageSize: 2 });
      await page.goto("/files/projects/web-app");
      await expect(page.getByRole("link", { name: "demo.mp4" })).toHaveCount(0);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.getByRole("link", { name: "demo.mp4" })).toBeVisible();
    });

    test("selecting a file opens its details, then Versions and Used by", async ({ page }) => {
      const { seen } = await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await page.getByRole("link", { name: "plan.md" }).click();
      await expect(page).toHaveURL(new RegExp(`file=${uuid(40)}`));
      const panel = page.getByTestId("file-details");
      await expect(panel).toContainText("/projects/web-app/plan.md");
      await expect(panel).toContainText("text/markdown");
      await expect(panel).toContainText(
        "plan, a step of Fix the login redirect",
      );
      await page.mouse.move(700, 700);
      await still(page, "files-details");
      await page.getByRole("tab", { name: "Versions" }).click();
      await expect(page).toHaveURL(/tab=versions/);
      await expect(panel).toContainText("Version 2");
      await expect(panel).toContainText("Current");
      await expect(panel).toContainText("Ana Reyes");
      await expect(panel).toContainText(
        "Every version of a record is kept until its retention ends.",
      );
      await page.getByRole("tab", { name: "Used by" }).click();
      await expect(panel).toContainText("Fix the login redirect");
      await expect(panel).toContainText("used version 2");
      expect(seen.uses).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page).not.toHaveURL(/file=/);
      await expect(page.getByTestId("file-details")).toHaveCount(0);
    });

    test("a file nothing has used says so", async ({ page }) => {
      await filesFixture(page, { uses: [] });
      await page.goto(`/files/projects/web-app?file=${uuid(40)}&tab=uses`);
      await expect(page.getByText("Nothing has used this file yet"))
        .toBeVisible();
    });
  });
}
