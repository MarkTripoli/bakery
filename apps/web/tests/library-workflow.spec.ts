import { expect, type Page, test } from "@playwright/test";
import {
  type AgentVersionRow,
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
 * One workflow of the library (design-ux, #66, slice 2): the steps of the
 * version being viewed, the versions with the one in use, and an
 * administrator's changes to which version is used and whether it is on.
 */
const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1003),
});
const AGENT = definition(20, "Code writer");
const AGENT_VERSIONS: AgentVersionRow[] = [
  { id: uuid(2000), agentId: AGENT.id, revision: 1 },
  { id: uuid(2001), agentId: AGENT.id, revision: 2 },
];
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
const VERSIONS: VersionRow[] = [
  version(1, 1, "retired", [{ id: "brief", uses: "task.brief" }]),
  version(2, 2, "published", [
    { id: "brief", uses: "task.brief" },
    { id: "implement", uses: "harness.implement", agentVersionId: uuid(2000) },
  ]),
  version(3, 3, "published", [
    { id: "brief", uses: "task.brief" },
    { id: "implement", uses: "harness.implement", agentVersionId: uuid(2001) },
    { id: "review", uses: "agent.review" },
  ]),
  version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
];
const WORLD: Options = {
  workflows: [WORKFLOW],
  agents: [AGENT],
  agentVersions: AGENT_VERSIONS,
  versions: VERSIONS,
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: workflow page`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (page: Page, options: Options = WORLD) => {
      const seen = await libraryFixture(page, options);
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.getByTestId("workflow-page")).toBeVisible();
      return seen;
    };
    const versionRow = (page: Page, revision: number) =>
      page.getByTestId("workflow-versions").locator("[data-version-id]")
        .filter({ hasText: `Version ${revision}` });
    const more = (page: Page) =>
      page.getByRole("button", { name: "More actions for Release train" });

    test("opens from the list and shows the version in use: its steps, agents, and every version with its state", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto("/library");
      await page.getByRole("button", { name: "Open Release train" }).click();
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.getByRole("heading", {
        name: "Release train",
        level: 1,
      })).toBeVisible();
      await expect(page.getByText("In use").first()).toBeVisible();
      const steps = page.getByTestId("workflow-steps");
      await expect(steps).toContainText("Steps in version 3");
      // Steps are named by what they do, never by their id or action key.
      await expect(steps.locator("[data-step-id=brief]")).toContainText(
        "Write the task brief",
      );
      await expect(steps.locator("[data-step-id=implement]")).toContainText(
        "Implement",
      );
      await expect(steps.locator("[data-step-id=implement]")).not
        .toContainText("Run the coding agent");
      await expect(steps.locator("[data-step-id=implement]")).toContainText(
        "Agent: Code writer, version 2",
      );
      await expect(steps.locator("[data-step-id=review]")).toContainText(
        "Review",
      );
      await expect(steps).not.toContainText("harness.implement");
      // Each step's mark holds its number; the title is in the normal colour.
      const marks = await steps.locator(
        '.ui-step-item__mark [aria-hidden="true"]',
      )
        .allInnerTexts();
      expect(marks.map((text) => text.trim())).toEqual(["1", "2", "3"]);
      // Screen readers get "Step n" for the same mark.
      await expect(steps.locator(".ui-step-item__mark").first()).toContainText(
        "Step 1",
      );
      const titleColor = await steps.locator(".ui-step-item__title").first()
        .evaluate((element) => getComputedStyle(element).color);
      const bodyColor = await page.locator("body").evaluate((element) =>
        getComputedStyle(element).color
      );
      expect(titleColor).toBe(bodyColor);
      await expect(steps).not.toContainText("task.brief");
      await expect(page.getByRole("list", { name: "Steps" }))
        .toBeVisible();
      const versions = page.getByTestId("workflow-versions");
      // The sentence about versions never changing belongs to Versions.
      await expect(versions).toContainText(
        "A version never changes after it is published. Tasks keep the version they started with.",
      );
      await expect(steps).not.toContainText("never changes");
      // Every version has its badge; dates say what happened.
      await expect(versionRow(page, 2)).toContainText("Published");
      await expect(versionRow(page, 1)).toContainText("Retired");
      await expect(versionRow(page, 4)).toContainText("Changed");
      await expect(versionRow(page, 3)).toContainText("Created");
      // The state badge sits directly under the description.
      const description = (await page.getByText("Release train does its work.")
        .first().boundingBox())!;
      const badge = (await page.getByTestId("workflow-page")
        .getByText("In use", { exact: true }).first().boundingBox())!;
      expect(badge.y).toBeGreaterThanOrEqual(
        description.y + description.height - 1,
      );
      expect(badge.y - (description.y + description.height)).toBeLessThan(24);
      // Newest first: 4 (draft), 3 (in use), 2, 1 (retired).
      await expect(versions.locator("[data-version-id]")).toHaveCount(4);
      await expect(versionRow(page, 4)).toHaveAttribute(
        "data-version-state",
        "draft",
      );
      await expect(versionRow(page, 3)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
      await expect(versionRow(page, 2)).toHaveAttribute(
        "data-version-state",
        "published",
      );
      await expect(versionRow(page, 1)).toHaveAttribute(
        "data-version-state",
        "retired",
      );
      // Only a published version that is not in use can be made the one in use.
      await expect(versions.getByRole("button", { name: "Use this version" }))
        .toHaveCount(1);
      // In a row that has both, View sits on the buttons' line (centred).
      const use = (await versions.getByRole("button", {
        name: "Use this version",
      }).boundingBox())!;
      const row = versions.locator("[data-version-state=published]").filter({
        has: page.getByRole("button", { name: "Use this version" }),
      });
      const view = (await row.getByRole("link", { name: /^View version/ })
        .boundingBox())!;
      expect(
        Math.abs((view.y + view.height / 2) - (use.y + use.height / 2)),
      ).toBeLessThanOrEqual(1);
      await page.mouse.move(700, 700);
      await shot(page, "workflow-page");
    });

    test("an address with a version the workflow does not have shows the version in use, and says so", async ({ page }) => {
      await open(page, WORLD);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(9999)}`,
      );
      await expect(page.getByTestId("workflow-page")).toContainText(
        "That version does not exist. This is the version in use.",
      );
      await expect(page.getByTestId("workflow-steps")).toContainText(
        "Steps in version 3",
      );
    });

    test("View shows another version's steps and agents", async ({ page }) => {
      await open(page);
      await page.getByRole("link", { name: "View version 2" }).click();
      const steps = page.getByTestId("workflow-steps");
      await expect(steps).toContainText("Steps in version 2");
      await expect(steps.locator("[data-step-id=implement]")).toContainText(
        "Agent: Code writer, version 1",
      );
      await expect(steps.locator("[data-step-id=review]")).toHaveCount(0);
      // The version being shown is the address, and says so instead of View.
      await expect(page).toHaveURL(new RegExp(`\\?version=${uuid(1002)}$`));
      await expect(versionRow(page, 2)).toContainText("Shown above");
      await expect(page.getByRole("link", { name: "View version 2" }))
        .toHaveCount(0);
      await expect(page.getByRole("link", { name: "View version 3" }))
        .toBeVisible();
    });

    test("an address with ?version= opens that version", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(1002)}`,
      );
      await expect(page.getByTestId("workflow-steps")).toContainText(
        "Steps in version 2",
      );
    });

    test("Use this version asks first, says what happens to running tasks, then sends the version with the one it saw", async ({ page }) => {
      const seen = await open(page);
      await versionRow(page, 2).getByRole("button", {
        name: "Use this version",
      }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Use version 2?");
      await expect(dialog).toContainText(
        "New tasks will use version 2. Tasks already running keep the version they started with.",
      );
      expect(seen.activations).toEqual([]);
      await page.mouse.move(700, 700);
      await shot(page, "workflow-use-version", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Use version 2" }).click();
      await expect.poll(() => seen.activations.length).toBe(1);
      expect(seen.activations[0]).toMatchObject({
        id: WORKFLOW.id,
        ifMatch: '"v1"',
        body: { versionId: uuid(1002) },
      });
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(versionRow(page, 2)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
      await expect(versionRow(page, 3)).toHaveAttribute(
        "data-version-state",
        "published",
      );
    });

    test("a change someone else got to first is a warning in the dialog, and nothing is applied", async ({ page }) => {
      const seen = await open(page, { ...WORLD, conflict: "activate" });
      await versionRow(page, 2).getByRole("button", {
        name: "Use this version",
      }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Use version 2" }).click();
      await expect(dialog.getByText(
        "Someone else changed this just now. The latest version is shown.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "workflow-conflict", [], { windowOnly: true });
      expect(seen.activations).toHaveLength(1);
      await expect(versionRow(page, 3)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
    });

    test("Turn off asks first and says what it does; Turn on is direct; both send the version they saw", async ({ page }) => {
      const seen = await open(page);
      await more(page).click();
      await expect(page.getByRole("button", { name: "Turn off", exact: true }))
        .toBeVisible();
      // The menu opens inside the window at every width: every item sits
      // within the viewport (on a phone the trigger starts its row).
      const viewport = page.viewportSize()!;
      // (The entries are plain buttons in the popover, not role=menuitem: a
      // locator by that role matches nothing and checks nothing.)
      const items = await page.locator(".ui-popover__content button").all();
      expect(items.length).toBeGreaterThanOrEqual(4);
      for (const item of items) {
        const box = (await item.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      await page.mouse.move(700, 700);
      await shot(page, "workflow-menu", [], { windowOnly: true });
      await page.getByRole("button", { name: "Turn off", exact: true })
        .click();
      // The menu closed behind the dialog.
      await expect(page.getByRole("button", { name: "Rename", exact: true }))
        .toHaveCount(0);
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Turn off Release train?");
      await page.mouse.move(700, 700);
      await shot(page, "workflow-turn-off", [], { windowOnly: true });
      await expect(dialog).toContainText(
        "It can no longer be chosen for new tasks. Tasks already running finish. You can turn it on again.",
      );
      await dialog.getByRole("button", { name: "Turn off", exact: true })
        .click();
      await expect.poll(() => seen.updates.length).toBe(1);
      expect(seen.updates[0]).toMatchObject({
        id: WORKFLOW.id,
        ifMatch: '"v1"',
        body: { enabled: false },
      });
      await expect(page.getByText("Turned off").first()).toBeVisible();
      await more(page).click();
      await page.getByRole("button", { name: "Turn on", exact: true }).click();
      await expect.poll(() => seen.updates.length).toBe(2);
      expect(seen.updates[1]).toMatchObject({
        ifMatch: '"v2"',
        body: { enabled: true },
      });
      await expect(page.getByText("Turned off")).toHaveCount(0);
    });

    test("Cancel on a menu's dialog returns focus to More", async ({ page }) => {
      await open(page);
      await more(page).click();
      await page.getByRole("button", { name: "Turn off", exact: true })
        .click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Cancel",
      }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(more(page)).toBeFocused();
    });

    test("Rename sends the new name with the version it saw and shows it", async ({ page }) => {
      const seen = await open(page);
      await more(page).click();
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Rename workflow" });
      await dialog.getByLabel(/^Name\b/).fill("Release pipeline");
      await page.mouse.move(700, 700);
      await shot(page, "workflow-rename", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Rename" }).click();
      await expect.poll(() => seen.updates.length).toBe(1);
      expect(seen.updates[0]).toMatchObject({
        ifMatch: '"v1"',
        body: { name: "Release pipeline" },
      });
      await expect(page.getByRole("heading", {
        name: "Release pipeline",
        level: 1,
      })).toBeVisible();
    });

    test("Export downloads the viewed version's definition file", async ({ page }) => {
      await open(page);
      await more(page).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("release-train-v3.yaml");
      // The file holds the viewed version's definition.
      const stream = await file.createReadStream();
      let text = "";
      for await (const chunk of stream) text += chunk.toString();
      expect(text).toContain("version 3");
      expect(text).toContain("id: review");
    });

    test("with no version in use, the page says so and offers the newest published one", async ({ page }) => {
      const seen = await open(page, {
        ...WORLD,
        workflows: [{ ...WORKFLOW, activeVersionId: null }],
      });
      await expect(page.getByText(
        "No version is in use, so this workflow cannot be chosen for new tasks.",
      )).toBeVisible();
      // The banner's normal layout: the message at the start, the action at
      // the end of the banner, as on the machine page.
      const banner = page.locator('[data-ui-component="alertBanner"]').filter({
        hasText: "No version is in use",
      });
      const bannerBox = (await banner.boundingBox())!;
      const action = (await banner.getByRole("button", {
        name: "Use version 3",
      }).boundingBox())!;
      if (viewport.name === "desktop") {
        expect(action.x + action.width).toBeGreaterThan(
          bannerBox.x + bannerBox.width - 40,
        );
      }
      await page.mouse.move(700, 700);
      await shot(page, "workflow-none-in-use");
      await page.getByRole("button", { name: "Use version 3" }).first()
        .click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Use version 3",
      }).click();
      await expect.poll(() => seen.activations.length).toBe(1);
      expect(seen.activations[0]?.body).toEqual({ versionId: uuid(1003) });
    });

    test("a member reads the page and cannot change anything", async ({ page }) => {
      await open(page, { ...WORLD, role: "developer" });
      await expect(page.getByText(
        "Only organization administrators can change workflows and agents.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "workflow-member");
      await expect(page.getByRole("button", { name: "Use this version" }))
        .toHaveCount(0);
      await more(page).click();
      await expect(page.getByRole("button", { name: "Export", exact: true }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Rename", exact: true }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Turn off", exact: true }))
        .toHaveCount(0);
    });

    test("more than five versions list the newest five and Show all opens the rest with Export", async ({ page }) => {
      const many = Array.from(
        { length: 7 },
        (_, index) =>
          version(10 + index, 10 + index, "published", [
            { id: "brief", uses: "task.brief" },
          ]),
      );
      await open(page, {
        ...WORLD,
        versions: [...VERSIONS, ...many],
      });
      await expect(
        page.getByTestId("workflow-versions").locator("[data-version-id]"),
      ).toHaveCount(5);
      await page.getByRole("button", { name: /^Show all 11/ }).click();
      const sheet = page.getByRole("dialog", {
        name: "All versions of Release train",
      });
      await expect(sheet.locator("[data-version-id]")).toHaveCount(11);
      await page.mouse.move(700, 700);
      await shot(page, "workflow-show-all", [], { windowOnly: true });
      await expect(sheet.getByRole("button", { name: "Export" }).first())
        .toBeVisible();
    });

    test("while the agents are read the step shows no agent line, then the agent; when the read fails it says it could not be read", async ({ page }) => {
      const seen = await libraryFixture(page, { ...WORLD, agentReads: "hold" });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      const implement = page.locator("[data-step-id=implement]");
      await expect(implement).toContainText("Implement");
      // Nothing is said about the agent until the reads have answered.
      await expect(implement).not.toContainText("Agent:");
      await expect(page.getByText("version not found")).toHaveCount(0);
      seen.releaseAgents();
      await expect(implement).toContainText("Agent: Code writer, version 2");
    });

    test("a failed agents read says the agent could not be read, not that its version is missing", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, agentReads: "fail" });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.locator("[data-step-id=implement]")).toContainText(
        "Agent: could not be read",
      );
      await expect(page.getByText("version not found")).toHaveCount(0);
      // The rest of the page works.
      await expect(page.getByTestId("workflow-versions")).toContainText(
        "Version 3",
      );
    });

    test("an agent version that is truly missing says so once the reads have answered", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, agentVersions: [] });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.locator("[data-step-id=implement]")).toContainText(
        "Agent: version not found",
      );
    });

    test("a version list cut short says so on the card and in Show all", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, endlessVersions: true });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      const versions = page.getByTestId("workflow-versions");
      await expect(
        versions.getByText("Only the newest 500 versions are shown."),
      )
        .toBeVisible();
      // Five pages of two versions are read; Show all counts what was read.
      await page.getByRole("button", { name: /^Show all 10/ }).click();
      const sheet = page.getByRole("dialog", {
        name: "All versions of Release train",
      });
      await expect(sheet.getByText("Only the newest 500 versions are shown."))
        .toBeVisible();
      await expect(sheet.locator("[data-version-id]")).toHaveCount(10);
    });

    test("a version list that ends early has no cut-short warning", async ({ page }) => {
      await open(page);
      await expect(page.getByText("Only the newest 500 versions are shown."))
        .toHaveCount(0);
    });

    test("a workflow that is not there says so and leads back to the library", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto(`/library/workflows/${uuid(999)}`);
      await expect(page.getByText("This workflow was not found"))
        .toBeVisible();
      await page.getByRole("button", { name: "Back to the library" }).click();
      await expect(page).toHaveURL(/\/library$/);
    });
  });
}
