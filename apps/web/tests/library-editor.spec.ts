import { expect, type Page, test } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
  uuid,
  type VersionRow,
} from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The editor of one workflow's draft (design-ux, #67, slice 1): the steps in
 * order with a panel for the selected one, the definition as code, the
 * server's findings on their steps, and Save and Publish.
 */
const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1002),
});
const version = (
  n: number,
  revision: number,
  status: VersionRow["status"],
  steps: VersionRow["steps"],
): VersionRow => ({
  id: uuid(1000 + n),
  workflowId: WORKFLOW.id,
  revision,
  status,
  steps,
});
const PUBLISHED = version(2, 2, "published", [
  { id: "brief", uses: "task.brief" },
  { id: "implement", uses: "harness.implement" },
]);
const DRAFT = version(3, 3, "draft", [
  { id: "brief", uses: "task.brief" },
  { id: "implement", uses: "harness.implement" },
  { id: "review", uses: "review.independent" },
]);
const WITH_DRAFT: Options = {
  workflows: [WORKFLOW],
  versions: [PUBLISHED, DRAFT],
};
const NO_DRAFT: Options = { workflows: [WORKFLOW], versions: [PUBLISHED] };

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: workflow editor`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const editor = async (page: Page, options: Options = WITH_DRAFT) => {
      const seen = await libraryFixture(page, options);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      return seen;
    };
    const root = (page: Page) => page.getByTestId("workflow-editor");
    const rows = (page: Page) =>
      page.getByTestId("editor-steps").locator("[data-step-index]");
    const state = (page: Page) => page.getByTestId("editor-state");
    const panel = (page: Page) => page.getByTestId("step-panel");
    const select = async (page: Page, index: number) => {
      await rows(page).nth(index).getByRole("button", { name: /^Edit/ })
        .click();
      await expect(panel(page)).toBeVisible();
    };

    test("Edit on the workflow page makes a draft from the version being viewed and opens it", async ({ page }) => {
      const seen = await libraryFixture(page, NO_DRAFT);
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(root(page)).toContainText(
        "Version 3 is a draft. Changes are not live until it is published.",
      );
      expect(seen.versionsCreated).toHaveLength(1);
      expect(seen.versionsCreated[0]?.definition.steps).toEqual(
        PUBLISHED.steps,
      );
      await expect(rows(page)).toHaveCount(2);
    });

    test("with a draft the page says Continue editing and makes no new one", async ({ page }) => {
      const seen = await libraryFixture(page, WITH_DRAFT);
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await page.getByRole("button", { name: "Continue editing" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}/edit`);
      expect(seen.versionsCreated).toHaveLength(0);
      await expect(rows(page)).toHaveCount(3);
    });

    test("the steps are numbered and named by what they do, and a finished draft says Draft", async ({ page }) => {
      await editor(page);
      await expect(rows(page).nth(0)).toContainText("1. Write the task brief");
      await expect(rows(page).nth(1)).toContainText("2. Run the coding agent");
      await expect(rows(page).nth(2)).toContainText("3. Review the changes");
      await expect(state(page)).toHaveText("Draft");
      await expect(page.getByTestId("publish-reason")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
      await select(page, 1);
      await page.mouse.move(700, 700);
      await shot(page, "editor-steps");
    });

    test("changing a step marks the draft unsaved, and Save sends the definition with the version it saw", async ({ page }) => {
      const seen = await editor(page);
      await select(page, 1);
      await panel(page).getByLabel("Name").fill("build");
      await expect(root(page)).toContainText("Unsaved changes");
      await expect(page.getByRole("button", { name: "Save draft" }))
        .toBeEnabled();
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(root(page)).not.toContainText("Unsaved changes");
      expect(seen.draftSaves).toHaveLength(1);
      expect(seen.draftSaves[0]?.ifMatch).toContain("1");
      expect(seen.draftSaves[0]?.steps.map((step) => step.id)).toEqual([
        "brief",
        "build",
        "review",
      ]);
    });

    test("a step can be moved, given another action and removed, and a new one added", async ({ page }) => {
      await editor(page);
      await select(page, 2);
      await panel(page).getByRole("button", { name: "Move up" }).click();
      await expect(rows(page).nth(1)).toContainText("Review the changes");
      await panel(page).getByLabel("Action").selectOption("quality.check");
      await expect(rows(page).nth(1)).toContainText("2. Run the checks");
      await panel(page).getByRole("button", { name: "Remove" }).click();
      await expect(rows(page)).toHaveCount(2);
      await page.getByRole("button", { name: "Add step" }).click();
      await page.getByRole("dialog", { name: "Add step" }).getByLabel("Action")
        .selectOption("review.independent");
      await page.getByRole("dialog", { name: "Add step" }).getByRole("button", {
        name: "Add",
        exact: true,
      }).click();
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).nth(2)).toContainText("3. Review the changes");
    });

    test("the Code tab is the same workflow: an edit there appears in the steps, and a mistake says where", async ({ page }) => {
      await editor(page);
      await page.getByRole("tab", { name: "Code" }).click();
      const code = page.getByLabel("Definition");
      await expect(page.getByText(
        "This is the same workflow as the Steps tab. Changes here appear there.",
      )).toBeVisible();
      await expect(code).toHaveValue(/"uses": "harness.implement"/);
      await code.fill('{"steps": [');
      await expect(root(page)).toContainText("Not valid JSON:");
      await expect(page.getByRole("button", { name: "Publish" }))
        .toBeDisabled();
      await code.fill(
        JSON.stringify({ steps: [{ id: "only", uses: "quality.check" }] }),
      );
      await expect(root(page)).not.toContainText("Not valid JSON:");
      await page.getByRole("tab", { name: "Steps" }).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).nth(0)).toContainText("1. Run the checks");
    });

    test("a finding sits on its step, and Publish stays disabled with its reason until it is fixed", async ({ page }) => {
      await editor(page);
      await page.getByRole("tab", { name: "Code" }).click();
      await page.getByLabel("Definition").fill(JSON.stringify({
        steps: [{ id: "a", uses: "task.brief" }, {
          id: "b",
          uses: "nope.action",
        }],
      }));
      await expect(state(page)).toHaveText("Draft · 1 problem");
      await expect(page.getByTestId("publish-reason")).toHaveText(
        "Fix 1 problem to publish.",
      );
      await expect(page.getByRole("button", { name: "Publish" }))
        .toBeDisabled();
      await page.getByRole("tab", { name: "Steps" }).click();
      await expect(rows(page).nth(1)).toContainText("Fix");
      await expect(rows(page).nth(1)).toContainText(
        "The action is not registered.",
      );
      await expect(rows(page).nth(0)).not.toContainText("Fix");
      await page.mouse.move(700, 700);
      await shot(page, "editor-problem");
      await select(page, 1);
      await panel(page).getByLabel("Action").selectOption("quality.check");
      await expect(state(page)).toHaveText("Draft");
      await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
    });

    test("Publish asks first, saves what is unsaved, then publishes that version and says so", async ({ page }) => {
      const seen = await editor(page);
      await select(page, 0);
      await panel(page).getByLabel("Name").fill("intro");
      await page.getByRole("button", { name: "Publish" }).click();
      const confirm = page.getByRole("alertdialog", {
        name: "Publish version 3?",
      });
      await expect(confirm).toContainText(
        "New tasks use this version from now on. Tasks already running keep the version they started with.",
      );
      await page.mouse.move(700, 700);
      await shot(page, "editor-publish", [], { windowOnly: true });
      await confirm.getByRole("button", { name: "Publish" }).click();
      await expect(root(page)).toContainText("Version 3 published.");
      expect(seen.draftSaves).toHaveLength(1);
      expect(seen.publishes).toHaveLength(1);
      expect(seen.publishes[0]?.ifMatch).toContain("2");
      expect(seen.publishes[0]?.expectedDigest).toBeTruthy();
      await page.getByRole("button", { name: "Back to the workflow" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}`);
    });

    test("leaving with unsaved changes asks first; without them it just leaves", async ({ page }) => {
      await editor(page);
      await page.getByRole("button", { name: "Back to the workflow" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}`);
      await page.goBack();
      await select(page, 0);
      await panel(page).getByLabel("Name").fill("intro");
      await page.getByRole("button", { name: "Back to the workflow" }).click();
      const ask = page.getByRole("alertdialog", {
        name: "Leave without saving?",
      });
      await expect(ask).toContainText(
        "Your changes to this draft have not been saved.",
      );
      await ask.getByRole("button", { name: "Keep editing" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(root(page)).toContainText("Unsaved changes");
      await page.getByRole("button", { name: "Back to the workflow" }).click();
      await page.getByRole("alertdialog", { name: "Leave without saving?" })
        .getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}`);
    });

    test("when someone else changed the draft, saving says so and keeps the change", async ({ page }) => {
      await editor(page, { ...WITH_DRAFT, editor: "save-conflict" });
      await select(page, 0);
      await panel(page).getByLabel("Name").fill("intro");
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(root(page)).toContainText(
        "Someone else changed this draft.",
      );
      await expect(root(page)).toContainText("Unsaved changes");
    });

    test("a publish that fails says so and the draft stays", async ({ page }) => {
      await editor(page, { ...WITH_DRAFT, editor: "publish-fails" });
      await page.getByRole("button", { name: "Publish" }).click();
      const confirm = page.getByRole("alertdialog", {
        name: "Publish version 3?",
      });
      await confirm.getByRole("button", { name: "Publish" }).click();
      await expect(confirm).toContainText(
        "This did not go through. Try again.",
      );
      await expect(root(page)).not.toContainText("Version 3 published.");
    });

    test("when the checker cannot answer, Publish stays disabled and the page says it could not check", async ({ page }) => {
      await editor(page, { ...WITH_DRAFT, checker: "fail" });
      await expect(state(page)).toHaveText("Could not be checked");
      await expect(page.getByRole("button", { name: "Publish" }))
        .toBeDisabled();
    });

    test("with no draft the editor offers to start one from the newest version", async ({ page }) => {
      const seen = await editor(page, NO_DRAFT);
      await expect(root(page)).toContainText("There is no draft to edit");
      await page.getByRole("button", { name: "Start a draft from version 2" })
        .click();
      await expect(rows(page)).toHaveCount(2);
      expect(seen.versionsCreated).toHaveLength(1);
    });

    test("a member can read nothing to change: the page says so and leads back", async ({ page }) => {
      await editor(page, { ...WITH_DRAFT, role: "developer" });
      await expect(root(page)).toContainText(
        "Only organization administrators can change workflows and agents.",
      );
      await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Back to the workflow" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}`);
    });

    test("a member does not see Edit on the workflow page", async ({ page }) => {
      await libraryFixture(page, { ...WITH_DRAFT, role: "developer" });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.getByTestId("workflow-page")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Edit|Continue editing)$/ }),
      )
        .toHaveCount(0);
    });
  });
}
