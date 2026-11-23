import { expect, type Locator, type Page, test } from "@playwright/test";
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
import { still } from "./helpers/stills.ts";

/**
 * The editor's save state, in the page's own status line. The shell adds an
 * empty live region for notification arrivals, which is also a status, so the
 * one with words is the one to read.
 */
const saveStatus = (page: Page) =>
  page.getByRole("status").filter({ hasText: /\S/ });

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
/**
 * A version whose steps Bakery cannot fully read (design-ux's ruling on #67,
 * comment 6917906748): one step it can read, one with no id and no type, and
 * one that is not a step at all. None may be dropped from the page.
 */
const BROKEN: Options = {
  workflows: [WORKFLOW],
  agents: [AGENT],
  agentVersions: AGENT_VERSIONS,
  versions: [
    ...VERSIONS,
    {
      ...version(5, 5, "published", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { id: "brief", uses: "task.brief" },
        { kind: "action" },
        "not a step",
      ],
    },
  ],
};
/**
 * A workflow whose steps hold groups (#67 UX ruling 6932934119 fix 15): a
 * condition with one empty arm, and a repeat. The read-only page must draw the
 * groups as containers, not as loose labels.
 */
const GROUPED: Options = {
  workflows: [WORKFLOW],
  agents: [AGENT],
  agentVersions: AGENT_VERSIONS,
  versions: [
    ...VERSIONS,
    {
      ...version(6, 6, "published", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { kind: "action", id: "brief", uses: "task.brief" },
        {
          kind: "branch",
          then: [{
            kind: "action",
            id: "implement",
            uses: "harness.implement",
          }],
          else: [],
        },
        {
          kind: "repeat",
          steps: [{ kind: "action", id: "review", uses: "agent.review" }],
        },
      ],
    },
  ],
};
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

    test("a built-in workflow draws its steps as cards too, read-only, and ends the path", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto("/library/built-in/fixed-coding-reviewed");
      const steps = page.getByTestId("workflow-steps");
      // The same tree the editor draws: the start card, then one per step.
      await expect(steps.locator("[data-card]")).toHaveCount(4);
      expect(
        await steps.locator("[data-card]").evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-card"))
        ),
      ).toEqual(["start", "brief", "implement", "review"]);
      await expect(steps.locator(".ui-step-card").first()).toBeVisible();
      await expect(steps.locator(".ui-step-item")).toHaveCount(0);
      // Nothing to press: a built-in is maintained by Bakery.
      await expect(steps.getByRole("button", { name: "Add a step" }))
        .toHaveCount(0);
      await expect(steps).not.toContainText("Remove");
      // The line runs to the end and stops there.
      await expect(steps.locator(".ui-step-connector")).not.toHaveCount(0);
      await expect(steps.locator(".ui-step-connector__end")).toHaveText("End");
      await shot(page, "workflow-built-in", [], { windowOnly: true });
    });

    test("a workflow with groups draws them as containers, read-only", async ({ page }) => {
      await libraryFixture(page, GROUPED);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(1006)}`,
      );
      const steps = page.getByTestId("workflow-steps");
      // The If container holds both arms, one of them empty.
      await expect(steps.locator("[data-group=if]")).toHaveCount(1);
      await expect(steps.locator("[data-group=if]")).toContainText("If");
      await expect(steps.locator("[data-group-arm=yes]")).toContainText(
        "Implement",
      );
      await expect(steps.locator("[data-group-arm=otherwise]")).toContainText(
        "No steps",
      );
      // The repeat is its own container.
      await expect(steps.locator("[data-group=repeat]")).toHaveCount(1);
      // A read-only page never says "Edited in code" (fix 14).
      await expect(steps).not.toContainText("Edited in code");
      await page.mouse.move(700, 700);
      await shot(page, "workflow-groups", [], { windowOnly: true });
    });

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
      await expect(steps.locator("[data-card=brief]")).toContainText(
        "Write the task brief",
      );
      await expect(steps.locator("[data-card=implement]")).toContainText(
        "Implement",
      );
      await expect(steps.locator("[data-card=implement]")).not
        .toContainText("Run the coding agent");
      await expect(steps.locator("[data-card=implement]")).toContainText(
        "Agent: Code writer, version 2",
      );
      await expect(steps.locator("[data-card=review]")).toContainText(
        "Review",
      );
      await expect(steps).not.toContainText("harness.implement");
      // The ruling (design-ux, comment 6917906748): a step is a card, not a
      // numbered row. Every step keeps one, in order, and none of them carries
      // the editor's controls (no "+", no Move, no Remove).
      await expect(steps.locator("[data-card]")).toHaveCount(4);
      expect(
        await steps.locator("[data-card]").evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-card"))
        ),
      ).toEqual(["start", "brief", "implement", "review"]);
      await expect(steps.locator(".ui-step-card").first()).toBeVisible();
      await expect(steps.locator(".ui-step-item")).toHaveCount(0);
      await expect(steps.getByRole("button", { name: "Add a step" }))
        .toHaveCount(0);
      await expect(steps).not.toContainText("Move");
      await expect(steps).not.toContainText("Remove");
      // The path still runs from the first card to the last and stops.
      await expect(steps.locator(".ui-step-connector")).not.toHaveCount(0);
      await expect(steps.locator(".ui-step-connector__end")).toHaveText("End");
      await expect(steps).not.toContainText("task.brief");
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
      await expect(steps.locator("[data-card=implement]")).toContainText(
        "Agent: Code writer, version 1",
      );
      await expect(steps.locator("[data-card=review]")).toHaveCount(0);
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

    test("Export says how many private skills the file leaves out and for which step", async ({ page }) => {
      await open(page, {
        ...WORLD,
        skills: {
          items: [
            {
              stepPath: "/steps/1",
              skillVersionId: uuid(7001),
              skillName: "Brand voice",
              revision: 1,
              scope: "personal",
              ownerDisplayName: null,
              mine: true,
              status: "available",
              publishedVersionUsesIt: false,
            },
            {
              stepPath: "/steps/1",
              skillVersionId: uuid(7002),
              skillName: "Code style",
              revision: 2,
              scope: "global",
              ownerDisplayName: null,
              mine: false,
              status: "available",
              publishedVersionUsesIt: false,
            },
          ],
        },
      });
      await more(page).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await download;
      await expect(page.getByText(
        "Exported without 1 private skill. Whoever imports it is asked to choose a skill for Implement.",
      )).toBeVisible();
    });

    test("Export counts the steps when private skills sit on more than one", async ({ page }) => {
      await open(page, {
        ...WORLD,
        skills: {
          items: [
            {
              stepPath: "/steps/1",
              skillVersionId: uuid(7001),
              skillName: "Brand voice",
              revision: 1,
              scope: "personal",
              ownerDisplayName: null,
              mine: true,
              status: "available",
              publishedVersionUsesIt: false,
            },
            {
              stepPath: "/steps/2",
              skillVersionId: uuid(7003),
              skillName: "Brand voice",
              revision: 1,
              scope: "personal",
              ownerDisplayName: null,
              mine: true,
              status: "available",
              publishedVersionUsesIt: false,
            },
          ],
        },
      });
      await more(page).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await download;
      await expect(page.getByText(
        "Exported without 2 private skills. Whoever imports it is asked to choose a skill for 2 steps.",
      )).toBeVisible();
    });

    test("Export of a version with no private skill says nothing more", async ({ page }) => {
      const seen = await open(page);
      await more(page).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await download;
      await expect.poll(() => seen.skillReads).toBeGreaterThan(0);
      await expect(page.getByText(/Exported without/)).toHaveCount(0);
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
      const implement = page.locator("[data-card=implement]");
      await expect(implement).toContainText("Implement");
      // Nothing is said about the agent until the reads have answered.
      await expect(implement).not.toContainText("Agent:");
      await expect(page.getByText("version not found")).toHaveCount(0);
      seen.releaseAgents();
      await expect(implement).toContainText("Agent: Code writer, version 2");
    });

    test("a version with steps it cannot read keeps every step, and never says it has none", async ({ page }) => {
      await libraryFixture(page, BROKEN);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(1005)}`,
      );
      const steps = page.getByTestId("workflow-steps");
      await expect(steps).not.toContainText("This version has no steps.");
      // The readable step, and two cards for the two it cannot read.
      await expect(steps).toContainText("Write the task brief");
      await expect(steps.getByText("Unreadable step")).toHaveCount(2);
      // Each of them is a card that says it needs setup (design-ux's ruling:
      // the cards, not a numbered row, and the state is never colour alone).
      await expect(steps.locator('.ui-step-card[data-needs-setup="true"]'))
        .toHaveCount(2);
      await expect(steps.getByText("Needs setup")).toHaveCount(2);
      await shot(page, "workflow-unreadable-steps", [], { windowOnly: true });
    });

    test("a failed agents read says the agent could not be read, not that its version is missing", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, agentReads: "fail" });
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.locator("[data-card=implement]")).toContainText(
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
      await expect(page.locator("[data-card=implement]")).toContainText(
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

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: the workflow editor`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const openEditor = async (page: Page, options: Options = WORLD) => {
      const seen = await libraryFixture(page, options);
      await page.goto(`/library/workflows/${WORKFLOW.id}`);
      await expect(page.getByTestId("workflow-page")).toBeVisible();
      if (viewport.width < 744) {
        await page
          .getByRole("button", { name: "More actions for Release train" })
          .click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
      } else {
        await page.getByRole("link", { name: "Edit" }).click();
      }
      await expect(page).toHaveURL(`/library/workflows/${WORKFLOW.id}/edit`);
      return seen;
    };

    test("Edit draws the workflow: how it starts, then a card per step", async ({ page }) => {
      await openEditor(page);
      // The ruled wording, and it is a card like any other so its sentence is reachable.
      await expect(page.locator("[data-card='start']")).toContainText(
        "Started by hand",
      );
      await expect(page.locator("[data-card='start']")).toContainText(
        "From a task",
      );
      // The editor edits the workflow's DRAFT when there is one (revision 4 of
      // this fixture holds a single step), so the drawing is the start plus one
      // card — and the header still says which version new tasks get.
      await expect(page.locator("[data-card]")).toHaveCount(2);
      await expect(page.locator("[data-card]").nth(1)).toContainText(
        "Write the task brief",
      );
      await expect(page.getByText("Version 3 is in use")).toBeVisible();
      // There is no list editor and no tab strip: the design's own shape.
      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Check the steps" }))
        .toHaveCount(0);
      // The header says the draft is saved, not that it is unsaved.
      await expect(saveStatus(page)).toContainText("Saved");
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-diagram");
    });

    test("the + on a connector opens the picker and adds the step picked", async ({ page }) => {
      await openEditor(page);
      const connectors = page.locator("[data-connector]");
      await expect(connectors.first()).toBeVisible();
      await page
        .getByRole("button", { name: /Add a step after/ })
        .first()
        .click();
      const picker = page.getByTestId("step-picker");
      await expect(picker).toBeVisible();
      // The picker says what each step does, and its search narrows the list:
      // a bare list of names told a person nothing (#67 UX ruling 6934081003).
      await expect(picker.locator("[data-pick-step]")).toHaveCount(8);
      await expect(
        picker.locator("[data-pick-step='review.independent']"),
      ).toContainText(
        "A separate agent reviews the changes and lists what it found.",
      );
      await picker
        .getByRole("searchbox", { name: "Search step types" })
        .fill("merge");
      await expect(picker.locator("[data-pick-step]")).toHaveCount(1);
      await expect(picker.locator("[data-pick-step='delivery.merge']"))
        .toBeVisible();
      await picker
        .getByRole("searchbox", { name: "Search step types" })
        .fill("");
      // The still is the open picker itself, not the page after a pick: a
      // capture taken after the picker closes is a byte copy of the selected
      // card (#67 UX ruling 6932934119 fix 12).
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-picker", [], { windowOnly: true });
      // The fade rule (#67 UX ruling 6942486257) is about overflow, not a
      // breakpoint, so both branches are asserted: the desktop list is longer
      // than its box and fades, the phone sheet's list fits and must not fade at
      // either edge. A fade that always showed would fail this on a phone.
      const list = page.locator(
        '[data-testid="step-picker"] > [data-picker-list="true"]',
      );
      if (viewport.width < 744) {
        // Just opened, and nothing can be hidden above or below because the
        // list fits: no fade at either edge.
        await expect(list).not.toHaveAttribute("data-picker-fade-top", "true");
        await expect(list).not.toHaveAttribute(
          "data-picker-fade-bottom",
          "true",
        );
      } else {
        // Just opened: rows are hidden below, so only the bottom edge fades.
        await expect(list).toHaveAttribute("data-picker-fade-bottom", "true");
        await expect(list).not.toHaveAttribute("data-picker-fade-top", "true");
        // Scroll the way a person does, so the real listener runs.
        await list.hover();
        await page.mouse.wheel(0, 4000);
        // React re-renders the fade attributes on the next frame after a
        // programmatic scroll; wait for that before reading them, and again
        // before the capture, so the still shows the end state.
        await page.waitForTimeout(200);
        // At the end: nothing is hidden below, so only the top edge fades.
        const after = await list.evaluate((n) => ({
          top: n.getAttribute("data-picker-fade-top"),
          bottom: n.getAttribute("data-picker-fade-bottom"),
        }));
        expect(after.top).toBe("true");
        expect(after.bottom).toBeNull();
        // `shot` resets the viewport per viewport, which resets the scroll, so
        // capture the end state directly at the evidence viewport instead.
        if (process.env.BAKERY_EVIDENCE_DIR) {
          // Capture at the same 1440x900 the other desktop stills use, so the
          // two picker states are directly comparable.
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.evaluate(() =>
            new Promise((resolve) => requestAnimationFrame(resolve))
          );
          await list.evaluate((n) => {
            n.scrollTop = n.scrollHeight;
            n.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
          // Let the fade attributes settle on the end state, so the still and
          // the assertions above cannot disagree.
          await page.waitForFunction(
            () => {
              const n = document.querySelector(
                '[data-testid="step-picker"] > [data-picker-list="true"]',
              );
              return n !== null &&
                n.getAttribute("data-picker-fade-bottom") !== "true";
            },
            undefined,
            { timeout: 5000 },
          );
          await page.screenshot({
            path:
              `${process.env.BAKERY_EVIDENCE_DIR}/workflow-editor-picker-end--desktop.png`,
            fullPage: false,
          });
        }
      }
      await picker.locator("[data-pick-step='review.independent']").click();
      // The picked step type is what got added — never a fixed one.
      await expect(page.locator("[data-card]")).toHaveCount(3);
      await expect(page.locator("[data-card]").nth(2)).toContainText("Review");
    });

    test("the panel moves and removes the selected step, and the draft saves itself", async ({ page }) => {
      const seen = await openEditor(page);
      // The draft holds one step; add a second through the picker so there is
      // somewhere to move it to.
      await page.getByRole("button", { name: /Add a step after/ }).first()
        .click();
      await page
        .getByTestId("step-picker")
        .locator("[data-pick-step='review.independent']")
        .click();
      // The step the picker added is the one slice 1 can move: a step type the
      // picker does not offer (task.brief) is drawn "Edited in code" and its
      // panel offers no Move or Remove (design-ux's ruling, comment 6917906748).
      await page
        .locator("[data-card]")
        .filter({ hasText: "Review" })
        .getByRole("button")
        .first()
        .click();
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("button", { name: "Move up" }))
        .toBeEnabled();
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-card-selected");
      await panel.getByRole("button", { name: "Move up" }).click();
      await expect(page.locator("[data-card]").nth(1)).toContainText(
        "Review",
      );
      // The draft saves after the person stops; the header says so.
      // The draft save is a PATCH on the draft version, with its own If-Match.
      await expect.poll(() => seen.draftSaves.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      expect(seen.draftSaves[0].ifMatch).not.toBeNull();
      await expect(saveStatus(page)).toContainText("Saved");
    });

    test("publish offers both forms when the draft differs from the version in use", async ({ page }) => {
      await openEditor(page);
      await page.getByRole("button", { name: "Publish" }).click();
      const dialog = page.getByRole("alertdialog", {
        name: /Publish version/,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Publish only" }))
        .toBeVisible();
      await expect(dialog.getByRole("button", { name: "Publish and use" }))
        .toBeVisible();
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-publish");
    });

    test("a member who may not change workflows sees no plus, no panel footer and no Publish", async ({ page }) => {
      await libraryFixture(page, { ...WORLD, role: "member" });
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(page.locator("[data-card='start']")).toBeVisible();
      await expect(page.getByRole("button", { name: /Add a step after/ }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(
        0,
      );
      await shot(page, "workflow-editor-read-only");
    });
  });
}

test("a draft that matches the version in use has nothing to publish", async ({ page }) => {
  // The workflow's one version is the one it names as in use (uuid(1003)) and
  // there is no separate draft, so the editor's steps and the steps in use are
  // the same and publishing would change nothing.
  const same = [{
    id: uuid(1003),
    workflowId: WORKFLOW.id,
    revision: 3,
    status: "published" as const,
    steps: [{ id: "brief", uses: "task.brief" }],
    normalizedSpec: {
      kind: "fixed",
      steps: [{ id: "brief", uses: "task.brief" }],
    },
  }];
  await libraryFixture(page, { ...WORLD, versions: same });
  await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  const nothing = page.getByRole("alertdialog", { name: "Nothing to publish" });
  await expect(nothing).toBeVisible();
  await nothing.getByRole("button", { name: "Close" }).click();
});

test("the state selector shows the save states a spec cannot force", async ({ page }) => {
  // The saved state is the real one; the two forced states exist so a failed or
  // in-flight save can be seen without breaking the network on purpose (design's
  // State menu, #67). Development builds only.
  await libraryFixture(page, WORLD);
  await page.goto(`/library/workflows/${WORKFLOW.id}/edit?state=save-failed`);
  await expect(saveStatus(page)).toContainText("Not saved");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await shot(page, "workflow-editor-save-failed");

  await page.goto(`/library/workflows/${WORKFLOW.id}/edit?state=saving`);
  await expect(saveStatus(page)).toContainText("Saving…");
  await shot(page, "workflow-editor-saving");
});

test("the leave warning is armed only while a change is unsaved", async ({ page }) => {
  // D8, tier 2: Chromium does not surface the beforeunload dialog to Playwright,
  // and React double-invokes effects in development builds, so raw add counts
  // cannot tell a correct page from a broken one. Net registrations can.
  await page.addInitScript(() => {
    const held = { adds: 0, removes: 0 };
    (globalThis as unknown as { __leave: typeof held }).__leave = held;
    const add = globalThis.addEventListener.bind(globalThis);
    const remove = globalThis.removeEventListener.bind(globalThis);
    globalThis.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "beforeunload") held.adds += 1;
      return (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof globalThis.addEventListener;
    globalThis.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "beforeunload") held.removes += 1;
      return (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof globalThis.removeEventListener;
  });
  const net = async () => {
    const held = await page.evaluate(() =>
      (globalThis as unknown as { __leave: { adds: number; removes: number } })
        .__leave
    );
    const value = held.adds - held.removes;
    console.log(
      `beforeunload net registrations: ${value} (adds ${held.adds}, removes ${held.removes})`,
    );
    return value;
  };
  await libraryFixture(page, WORLD);
  // Straight to the address: on a phone the Edit action lives in the More menu,
  // and this spec is about the leave warning, not about how a person got here.
  await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
  await expect(saveStatus(page)).toContainText("Saved");
  // Saved and untouched: this page contributes nothing — other parts of the app
  // may register their own listener, so the baseline is what it is and the
  // editor's contribution is the delta from here.
  const baseline = await net();
  // A change that is not saved yet arms one more.
  await page.getByRole("button", { name: /Add a step after/ }).first().click();
  await page
    .getByTestId("step-picker")
    .locator("[data-pick-step='review.independent']")
    .click();
  await expect.poll(net).toBe(baseline + 1);
  // Once the draft is saved again, nothing is armed.
  await expect(saveStatus(page)).toContainText("Saved", {
    timeout: 10_000,
  });
  await expect.poll(net).toBe(baseline);
});

test("a step with a problem keeps its card and shows the sentence", async ({ page }) => {
  // (4) the problem card: the report's pointer lands on its step, and the card
  // stays a card with the sentence under it. The warning points at the drawn
  // step, so the chip counts it and its row can select that card.
  await libraryFixture(page, { ...WORLD, validation: "warnings" });
  await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  // The card wears the red outline and says "Needs setup" in place of its usual
  // line; the sentence itself is the ruled one, never the server's message
  // (#67 UX ruling 6932934119 fixes 1 and 2).
  const problemCard = page.locator("[data-card]").nth(1);
  await expect(problemCard).toContainText("Needs setup");
  await expect(problemCard).not.toContainText(
    "The step runs a model but no agent is bound.",
  );
  const sentence =
    "This step has no agent to run it, and agents cannot be chosen on this page yet. Delete the step, or ask an administrator to set the workflow's agents.";
  const chip = page.getByTestId("editor-problems");
  await expect(chip).toHaveText("1 problem");
  await chip.click();
  const list = page.getByTestId("editor-problem-list");
  await expect(list).toContainText(sentence);
  await list.getByRole("button", { name: "Show me" }).click();
  const panel = page.getByRole("complementary", {
    name: "The selected step",
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(sentence);
  await page.mouse.move(600, 700);
  await shot(page, "workflow-editor-card-problem");
});

test("a problem that points at no drawn step is counted and answered in code", async ({ page }) => {
  // design-ux's ruling: a checker problem with no place in the drawing is in
  // the chip and has no card, so its row offers "View as code" — never a
  // "Show me" that selects nothing.
  await libraryFixture(page, { ...WORLD, validation: "errors" });
  await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  const chip = page.getByTestId("editor-problems");
  await expect(chip).toHaveText("2 problems");
  await chip.click();
  const list = page.getByTestId("editor-problem-list");
  // The ruled sentences, not the server's messages (fix 1). The step's code the
  // table knows; the workflow's `field_missing` code falls back to one sentence.
  await expect(list).toContainText(
    "Bakery does not know this kind of step. Delete it and add a step from the list.",
  );
  await expect(list).toContainText(
    "This step has a problem. Open View as code to see the detail.",
  );
  await expect(list.getByRole("button", { name: "Show me" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "View as code" }))
    .toHaveCount(2);
  await page.mouse.move(600, 700);
  await shot(page, "workflow-editor-problems-list");
});

/**
 * design-ux's ruling on the three cases a definition can be in (issue 67
 * comment 6917906748): a part only changeable in code is marked, an unreadable
 * step keeps a card, and a definition whose steps cannot be read says so in
 * place of the drawing. Nothing is ever dropped.
 */
const RULED: Options = {
  ...WORLD,
  versions: [
    ...VERSIONS.filter((row) => row.status !== "draft"),
    {
      ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { kind: "action", id: "brief", uses: "task.brief" },
        { kind: "action", id: "add", uses: "harness.implement" },
        {
          kind: "branch",
          then: [],
          else: [{ kind: "action", id: "rev", uses: "agent.review" }],
        },
        { kind: "wait" },
        { kind: "repeat", steps: [] },
      ],
    },
  ],
};

const UNREADABLE: Options = {
  ...WORLD,
  versions: [
    ...VERSIONS.filter((row) => row.status !== "draft"),
    {
      ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
      spec: "written in code",
    },
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: the ruled three cases`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a part only changeable in code is marked and is not a problem", async ({ page }) => {
      await libraryFixture(page, RULED);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      const brief = page.locator("[data-card='brief']");
      await expect(brief).toContainText("Write the task brief");
      await expect(brief).toContainText("Edited in code");
      // A known type the picker does not offer is not a problem.
      await expect(brief).not.toContainText("Needs setup");
      // Both arms of a branch sit inside one If container, and an empty arm
      // keeps its place with "No steps" (fix 10).
      await expect(page.locator("[data-group='if']")).toContainText("If");
      await expect(page.locator("[data-group='if']")).toContainText(
        "Edited in code",
      );
      await expect(page.locator("[data-group-arm='yes']")).toContainText(
        "No steps",
      );
      // Labels are the ruling's words, not the old ones.
      await expect(page.locator("[data-group='wait']")).toContainText("Wait");
      await expect(page.locator("[data-group='repeat']")).toContainText(
        "Repeat",
      );
      // Nothing above is a problem: the chip says the workflow is ready.
      await expect(page.getByTestId("editor-problems")).toHaveText(
        "Ready to publish",
      );
      // Selecting a code-only step offers the code, never Move or Remove.
      await brief.getByRole("button").first().click();
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toContainText(
        "This part of the workflow is written in code.",
      );
      await expect(panel.getByRole("button", { name: "View as code" }))
        .toBeVisible();
      await expect(panel.getByRole("button", { name: "Delete" })).toHaveCount(
        0,
      );
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-code-only");
    });

    test("a step with no id and no type keeps a card and one problem", async ({ page }) => {
      // Case 2 of the ruling: an unreadable step is a card marked "Needs setup",
      // one chip problem, and "Show me" selects it.
      await libraryFixture(page, {
        ...WORLD,
        versions: [
          ...VERSIONS.filter((row) => row.status !== "draft"),
          {
            ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
            spec: [{ kind: "action" }],
          },
        ],
      });
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      const card = page.locator("[data-card^='unreadable']");
      await expect(card).toContainText("Unreadable step");
      await expect(card).toContainText("Needs setup");
      const chip = page.getByTestId("editor-problems");
      await expect(chip).toHaveText("1 problem");
      await chip.click();
      const list = page.getByTestId("editor-problem-list");
      await expect(list).toContainText("Bakery cannot read this step.");
      await list.getByRole("button", { name: "Show me" }).click();
      await expect(
        page.getByRole("complementary", { name: "The selected step" }),
      ).toContainText("Bakery cannot read this step.");
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-unreadable-step");
    });

    test("steps that cannot be read are said in place of the drawing", async ({ page }) => {
      await libraryFixture(page, UNREADABLE);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(page.locator("[data-card='start']")).toBeVisible();
      const notice = page.locator('[data-ui-region="workflow-diagram"]');
      await expect(notice).toContainText(
        "Bakery cannot draw this workflow's steps",
      );
      await expect(notice).toContainText(
        "The steps are written in a way Bakery cannot read. Open the code to see them.",
      );
      await expect(notice.getByRole("button", { name: "View as code" }))
        .toBeVisible();
      // No "+" under the start card: there is nothing to add to.
      await expect(page.getByRole("button", { name: /Add a step after/ }))
        .toHaveCount(0);
      // One problem, and its row can only be answered in the code.
      const chip = page.getByTestId("editor-problems");
      await expect(chip).toHaveText("1 problem");
      await chip.click();
      const list = page.getByTestId("editor-problem-list");
      await expect(list).toContainText("The steps cannot be read.");
      await expect(list.getByRole("button", { name: "View as code" }))
        .toBeVisible();
      await expect(list.getByRole("button", { name: "Show me" })).toHaveCount(
        0,
      );
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-steps-unreadable");
    });

    const openEditor = async (page: Page, options: Options) => {
      const seen = await libraryFixture(page, options);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(page.locator("[data-card='start']")).toBeVisible();
      return seen;
    };

    // The skills a step names (#431, design-ux): the draft's agent step lists
    // them, a private skill wears one word, and someone else's is a placeholder.
    // The draft's agent step names the skills the read answers for it, as real data does.
    const skillsWorld = (read: unknown): Options => {
      const items = (read as { items?: unknown } | null | undefined)?.items;
      // A read that cannot be answered still leaves the draft naming its skill.
      const held = read === "fail"
        ? [uuid(7000)]
        : (Array.isArray(items) ? items : [])
          .filter((item: { stepPath?: string; skillVersionId?: unknown }) =>
            item.stepPath === "/steps/1" &&
            typeof item.skillVersionId === "string"
          )
          .map((item: { skillVersionId: string }) => item.skillVersionId);
      return {
        ...WORLD,
        versions: [
          ...VERSIONS.slice(0, 3),
          version(4, 4, "draft", [
            { id: "brief", uses: "task.brief" },
            {
              id: "implement",
              uses: "harness.implement",
              agentVersionId: uuid(2000),
              ...(held.length === 0 ? {} : { skills: held }),
            },
          ]),
        ],
      };
    };
    const skill = (over: Record<string, unknown>) => ({
      stepPath: "/steps/1",
      skillVersionId: uuid(7000),
      skillName: "Code style",
      revision: 2,
      scope: "global",
      ownerDisplayName: null,
      mine: false,
      status: "available",
      publishedVersionUsesIt: false,
      ...over,
    });
    const openSkills = async (page: Page, options: Options) => {
      const seen = await openEditor(page, {
        ...skillsWorld(options.skills),
        ...options,
      });
      await page.locator("[data-card]").filter({ hasText: "Implement" })
        .getByRole("button").first().click();
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toBeVisible();
      return { seen, skills: panel.getByTestId("step-skills") };
    };

    test("a step lists its skills: private ones wear a word, someone else's is a placeholder, a lost one is a slot", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: {
          items: [
            skill({}),
            skill({
              skillVersionId: uuid(7001),
              skillName: "Release notes",
              revision: 3,
              scope: "personal",
              ownerDisplayName: "Ana Ruiz",
              mine: true,
            }),
            skill({
              skillVersionId: uuid(7002),
              skillName: "Security review",
              revision: 1,
              scope: "personal",
              ownerDisplayName: "Dana Lee",
            }),
            skill({
              skillVersionId: null,
              skillName: "Brand voice",
              revision: null,
              scope: null,
              status: "missing",
            }),
            // A skill on another step is not this step's.
            skill({ stepPath: "/steps/0", skillName: "Not here" }),
          ],
        },
      });
      await expect(skills.getByText("Skills", { exact: true })).toBeVisible();
      await expect(skills).toContainText("Code style");
      await expect(skills).toContainText("Version 2 · comes with Bakery");
      await expect(skills).toContainText("Release notes");
      await expect(skills).toContainText(
        "Version 3 · yours",
      );
      await expect(skills).toContainText("Security review");
      await expect(skills).toContainText(
        "Version 1 · Dana Lee's. You can run this workflow with it but cannot open its files.",
      );
      // Two private skills wear the word; the global one does not.
      await expect(skills.getByText("Private", { exact: true })).toHaveCount(2);
      await expect(
        skills.getByRole("button", {
          name: "About the private skill Security review",
        }),
      ).toBeVisible();
      // The lost skill is a slot that says what to do, never a link to its files.
      await expect(skills).toContainText("A skill is missing");
      await expect(skills).toContainText(
        'This workflow was made with a private skill called "Brand voice", which did not come with it.',
      );
      // While the list is read only, no slot tells the person to use a control that is not there.
      await expect(skills).not.toContainText("Choose");
      await expect(skills).not.toContainText("remove it");
      // No separate badge: the row has its own actions.
      await expect(skills).not.toContainText("Needs attention");
      await expect(skills).not.toContainText("Not here");
      await expect(skills.getByRole("link")).toHaveCount(0);
      // A help tip does not make its row taller: the name-to-version distance is the same with and without one.
      const nameToLine = async (name: string) => {
        const row = skills.getByRole("listitem").filter({ hasText: name });
        const title = await row.getByText(name, { exact: true }).boundingBox();
        const line = await row.locator(".ui-text--muted").boundingBox();
        if (title === null || line === null) throw new Error("no boxes");
        return line.y - title.y;
      };
      const plain = await nameToLine("Code style");
      expect(Math.abs((await nameToLine("Security review")) - plain))
        .toBeLessThanOrEqual(2);
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills");
    });

    // Four slots on one step: a lost skill, one its owner stopped, a missing one and an unnamed lost one.
    const fourSlots = () => [
      skill({
        skillVersionId: uuid(7006),
        skillName: "Gone skill",
        revision: 1,
        scope: "organization",
        status: "unavailable",
      }),
      skill({
        skillVersionId: uuid(7005),
        skillName: "Paused skill",
        revision: 1,
        scope: "personal",
        ownerDisplayName: "Dana Lee",
        status: "stopped",
      }),
      skill({
        skillVersionId: null,
        skillName: null,
        revision: null,
        scope: null,
        status: "missing",
      }),
      skill({
        skillVersionId: uuid(7007),
        skillName: null,
        revision: null,
        scope: null,
        status: "unavailable",
      }),
    ];

    test("a skill that cannot be used says what happened, and names no control that is not there", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: fourSlots() },
      });
      await expect(skills).toContainText("Gone skill is no longer available");
      await expect(skills).toContainText(
        "It was removed or switched off, or its owner left.",
      );
      await expect(skills).toContainText("Paused skill cannot be used here");
      await expect(skills).toContainText(
        "Its owner does not allow this workflow to use it. Only its owner can allow it.",
      );
      await expect(skills).toContainText(
        "This workflow was made with a private skill, which did not come with it.",
      );
      await expect(skills).toContainText("A skill is no longer available");
      await expect(skills.locator("[data-skill-status]")).toHaveCount(4);
      // No badge; each row has Remove, and no Choose while nothing is on offer.
      await expect(skills.getByText("Needs attention")).toHaveCount(0);
      await expect(skills).not.toContainText("Choose a skill");
      await expect(skills.getByRole("button", { name: /^Remove/ }))
        .toHaveCount(4);
      await expect(skills.getByRole("link")).toHaveCount(0);
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-slots");
    });

    test("with skills on offer every slot row has Choose a skill… beside Remove", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: fourSlots() },
        catalog: [catalogSkill({})],
      });
      await expect(skills.locator("[data-skill-status]")).toHaveCount(4);
      await expect(skills.getByRole("button", { name: "Choose a skill…" }))
        .toHaveCount(4);
      await expect(skills.getByRole("button", { name: /^Remove/ }))
        .toHaveCount(4);
      await page.mouse.move(600, 700);
      await still(page, "workflow-editor-skills-slots-choose");
    });

    test("a missing skill is chosen in place from its own row, and the save settles the slot", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: {
          items: [
            skill({}),
            skill({
              skillVersionId: null,
              skillName: "Brand voice",
              revision: null,
              scope: null,
              status: "missing",
            }),
          ],
        },
        catalog: [
          catalogSkill({
            id: uuid(8003),
            slug: "house-style",
            name: "House style",
            activeVersionId: uuid(8103),
          }),
        ],
      });
      // The row that needs a choice comes first, then the skills that work.
      const rows = skills.getByRole("listitem");
      await expect(rows.first()).toContainText("A skill is missing");
      // The slot is the step's one problem: the count, the card and the list each say so once.
      const chip = page.getByTestId("editor-problems");
      await expect(chip).toHaveText("1 problem");
      await expect(page.locator("[data-card]").filter({ hasText: "Implement" }))
        .toContainText("Needs setup");
      await chip.click();
      await expect(page.getByTestId("editor-problem-list")).toContainText(
        "A skill on this step needs a choice.",
      );
      await page.keyboard.press("Escape");
      const slot = skills.locator("[data-skill-status='missing']");
      await expect(slot.getByRole("button", { name: "Remove" })).toBeVisible();
      await slot.getByRole("button", { name: "Choose a skill…" }).click();
      await pickerOf(slot).getByRole("button", {
        name: "House style · Version 2",
        exact: true,
      }).click();
      await expect(skills.locator("[data-skill-status='missing']"))
        .toHaveCount(0);
      await expect(skills).toContainText("House style");
      await expect(page.getByTestId("editor-problems")).toHaveText(
        "Ready to publish",
      );
      await expect(page.locator("[data-card]").filter({ hasText: "Implement" }))
        .not.toContainText("Needs setup");
      await expect.poll(() => seen.draftSaves.length).toBeGreaterThan(0);
      const sent = seen.draftSaves.at(-1)!.body as {
        resolveSkillSlots?: string[];
      };
      expect(sent.resolveSkillSlots).toEqual(["/steps/1"]);
      expect(savedSkills(seen).skills).toContain(uuid(8103));
    });

    // A step that waits for another is written in code; its skills are still the panel's to change.
    const writtenInCode = (items: unknown[]) => {
      const world = skillsWorld({ items });
      return {
        ...world,
        versions: world.versions!.map((row) =>
          row.status === "draft"
            ? {
              ...row,
              steps: row.steps.map((step) =>
                step.id === "implement" ? { ...step, needs: ["brief"] } : step
              ),
            }
            : row
        ),
      };
    };

    test("an agent step written in code shows its Skills first, and a missing skill is chosen there", async ({ page }) => {
      const items = [
        skill({}),
        skill({
          skillVersionId: null,
          skillName: "Brand voice",
          revision: null,
          scope: null,
          status: "missing",
        }),
      ];
      const { seen, skills } = await openSkills(page, {
        skills: { items },
        catalog: [
          catalogSkill({
            id: uuid(8003),
            slug: "house-style",
            name: "House style",
            activeVersionId: uuid(8103),
          }),
        ],
        versions: writtenInCode(items).versions,
      });
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      // The slot is the step's one problem, counted and on its card, and the notice above it is not drawn.
      await expect(page.getByTestId("editor-problems")).toHaveText("1 problem");
      await expect(page.locator("[data-card]").filter({ hasText: "Implement" }))
        .toContainText("Needs setup");
      await expect(panel).not.toContainText(
        "A skill on this step needs a choice.",
      );
      // Skills first, then the sentence about the rest, then View as code.
      await expect(panel).toContainText(
        "The rest of this step is written in code.",
      );
      await expect(panel).not.toContainText("You cannot change it here");
      const skillsBox = (await skills.boundingBox())!;
      const restBox = (await panel.getByText(
        "The rest of this step is written in code.",
      ).boundingBox())!;
      const codeBox = (await panel.getByRole("button", { name: "View as code" })
        .boundingBox())!;
      expect(skillsBox.y).toBeLessThan(restBox.y);
      expect(restBox.y).toBeLessThan(codeBox.y);
      const slot = skills.locator("[data-skill-status='missing']");
      await expect(slot.getByRole("button", { name: "Choose a skill…" }))
        .toBeVisible();
      await expect(slot.getByRole("button", { name: "Remove" })).toBeVisible();
      await expect(skills.getByRole("button", { name: "Attach a skill…" }))
        .toBeVisible();
      await page.mouse.move(600, 700);
      await still(page, "workflow-editor-skills-codeonly-slot");
      const readsBefore = seen.skillReads;
      await slot.getByRole("button", { name: "Choose a skill…" }).click();
      await pickerOf(slot).getByRole("button", {
        name: "House style · Version 2",
        exact: true,
      }).click();
      await expect(skills.locator("[data-skill-status='missing']"))
        .toHaveCount(0);
      await expect(page.getByTestId("editor-problems")).toHaveText(
        "Ready to publish",
      );
      await expect.poll(() => seen.draftSaves.length).toBeGreaterThan(0);
      // The skills are read again after the save, and the settled slot does not come back.
      await expect.poll(() => seen.skillReads).toBeGreaterThan(readsBefore);
      await expect(skills.locator("[data-skill-status='missing']"))
        .toHaveCount(0);
      await expect(page.getByTestId("editor-problems")).toHaveText(
        "Ready to publish",
      );
      const sent = seen.draftSaves.at(-1)!.body as {
        resolveSkillSlots?: string[];
        definition?: { steps?: { id: string; needs?: string[] }[] };
      };
      expect(sent.resolveSkillSlots).toEqual(["/steps/1"]);
      // What the panel cannot show is kept as it was.
      expect(
        sent.definition?.steps?.find((step) => step.id === "implement")?.needs,
      ).toEqual(["brief"]);
      expect(savedSkills(seen).skills).toContain(uuid(8103));
      await page.mouse.move(600, 700);
      await still(page, "workflow-editor-skills-codeonly-chosen");
    });

    test("choosing on a stopped skill leaves the step's missing skill open and asks the server to settle nothing", async ({ page }) => {
      const items = [
        skill({
          skillVersionId: null,
          skillName: "Brand voice",
          revision: null,
          scope: null,
          status: "missing",
        }),
        skill({
          skillVersionId: uuid(7005),
          skillName: "Paused skill",
          revision: 1,
          scope: "personal",
          ownerDisplayName: "Dana Lee",
          status: "stopped",
        }),
      ];
      const { seen, skills } = await openSkills(page, {
        skills: { items },
        catalog: [
          catalogSkill({
            id: uuid(8003),
            slug: "house-style",
            name: "House style",
            activeVersionId: uuid(8103),
          }),
        ],
      });
      const stopped = skills.locator("[data-skill-status='stopped']");
      await stopped.getByRole("button", { name: "Choose a skill…" }).click();
      await pickerOf(stopped).getByRole("button", {
        name: "House style · Version 2",
        exact: true,
      }).click();
      // The stopped row is replaced; the missing one is still the person's to settle.
      await expect(skills.locator("[data-skill-status='stopped']"))
        .toHaveCount(0);
      await expect(skills.locator("[data-skill-status='missing']"))
        .toHaveCount(1);
      await expect(skills).toContainText("House style");
      await expect(page.getByTestId("editor-problems")).toHaveText("1 problem");
      await expect.poll(() => seen.draftSaves.length).toBeGreaterThan(0);
      const sent = seen.draftSaves.at(-1)!.body as {
        resolveSkillSlots?: string[];
      };
      expect(sent.resolveSkillSlots).toBeUndefined();
      expect(savedSkills(seen).skills).toEqual([uuid(8103)]);
    });

    test("removing a missing skill is at once, says so, and has no Undo", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: {
          items: [
            skill({
              skillVersionId: null,
              skillName: null,
              revision: null,
              scope: null,
              status: "missing",
            }),
          ],
        },
        catalog: [catalogSkill({})],
      });
      await skills.getByRole("button", { name: "Remove the missing skill" })
        .click();
      await expect(skills.locator("[data-skill-status]")).toHaveCount(0);
      await expect(page.getByText("Removed the missing skill from Implement."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
      await expect(page.getByTestId("editor-problems")).toHaveText(
        "Ready to publish",
      );
      await expect.poll(() => seen.draftSaves.length).toBeGreaterThan(0);
      expect(
        (seen.draftSaves.at(-1)!.body as { resolveSkillSlots?: string[] })
          .resolveSkillSlots,
      ).toEqual(["/steps/1"]);
    });

    test("someone else's private skill with no owner name never reads \"'s\"", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: {
          items: [
            skill({
              skillVersionId: uuid(7006),
              skillName: "Orphan review",
              revision: 1,
              scope: "personal",
              ownerDisplayName: null,
            }),
            skill({
              skillVersionId: uuid(7008),
              skillName: "Blank owner review",
              revision: 2,
              scope: "personal",
              ownerDisplayName: "  ",
            }),
          ],
        },
      });
      await expect(skills).toContainText(
        "Version 1 · someone else's. You can run this workflow with it but cannot open its files.",
      );
      await expect(skills).toContainText(
        "Version 2 · someone else's. You can run this workflow with it but cannot open its files.",
      );
      expect(await skills.innerText()).not.toMatch(/· 's/);
      // The help tip carries the unnamed-owner words (when it is open is the tip's own business).
      await expect(
        skills.getByRole("button", {
          name: "About the private skill Orphan review",
        }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Its owner let this workflow use a private skill. Anyone who can run the workflow runs it with the skill; only its owner can read or change it.",
        ).first(),
      ).toBeAttached();
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-no-owner");
    });

    // Attaching and removing skills (#431 slice 2, design-ux).
    const catalogSkill = (over: Record<string, unknown>) => ({
      id: uuid(8000),
      sourceId: null,
      slug: "code-style",
      name: "Code style",
      activeVersionId: uuid(8100),
      activeRevision: 2,
      enabled: true,
      scope: "organization",
      ownerPrincipalId: null,
      copiedFromSkillId: null,
      copiedFromVersionId: null,
      description: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
      ...over,
    });
    // The picker is a popover with a search field: open it from its trigger, then press an option.
    const pickerOf = (skills: Locator) =>
      skills.getByRole("dialog", { name: "Attach a skill" });
    const openPicker = async (skills: Locator) => {
      await skills.getByRole("button", { name: "Attach a skill…" }).click();
      const picker = pickerOf(skills);
      await expect(picker).toBeVisible();
      return picker;
    };
    const pickSkill = async (skills: Locator, label: string) => {
      const picker = await openPicker(skills);
      await picker.getByRole("button", { name: label, exact: true }).click();
    };
    const savedSkills = (
      seen: { draftSaves: { body: Record<string, unknown> }[] },
    ) => {
      const last = seen.draftSaves.at(-1)?.body as {
        definition?: { steps?: { id: string; skills?: string[] }[] };
        confirmPersonalSkillUse?: string[];
      } | undefined;
      return {
        skills: last?.definition?.steps?.find((one) => one.id === "implement")
          ?.skills,
        confirmed: last?.confirmPersonalSkillUse,
      };
    };

    test("an organization skill attaches at once from the picker and is saved on the step", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [
          catalogSkill({}),
          catalogSkill({
            id: uuid(8001),
            slug: "release-notes",
            name: "Release notes",
            activeVersionId: uuid(8101),
            activeRevision: 3,
            scope: "personal",
          }),
        ],
      });
      const picker = await openPicker(skills);
      // Two groups: the organization's skills, then the caller's own private ones.
      await expect(picker).toContainText("Your organization");
      await expect(picker).toContainText("Private to you");
      // The picker does not repeat what the confirmation says about files.
      await expect(picker).not.toContainText("not its files");
      await shot(page, "workflow-editor-skills-picker");
      // The search field narrows the list and keeps a group's heading only while it has a match.
      const find = picker.getByLabel("Find a skill");
      await find.fill("release");
      await expect(picker.getByRole("button", { name: /Code style/ }))
        .toHaveCount(0);
      await expect(picker.getByText("Your organization")).toHaveCount(0);
      await expect(picker.getByText("Private to you")).toHaveCount(1);
      await find.fill("zzz");
      await expect(picker).toContainText('No skill matches "zzz".');
      await find.fill("");
      await picker.getByRole("button", {
        name: "Code style · Version 2",
        exact: true,
      }).click();
      await expect(skills).toContainText("Code style");
      await expect(skills).toContainText("Version 2 · your organization");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => savedSkills(seen).skills).toEqual([uuid(8100)]);
      expect(savedSkills(seen).confirmed).toBeUndefined();
      // It is no longer offered for this step.
      const again = await openPicker(skills);
      await expect(again.getByRole("button", { name: /Code style/ }))
        .toHaveCount(0);
    });

    test("a private skill asks the owner first, and only the owner's yes attaches it", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [
          catalogSkill({
            slug: "release-notes",
            name: "Release notes",
            activeVersionId: uuid(8101),
            activeRevision: 3,
            scope: "personal",
          }),
        ],
      });
      await pickSkill(skills, "Release notes · Version 3");
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText(
        "Let this workflow use your private skill?",
      );
      await expect(dialog).toContainText(
        "Everyone who can see or run Release train will be able to use Release notes, version 3, in this workflow.",
      );
      await expect(dialog).toContainText(
        "They cannot open, copy or download its files.",
      );
      await expect(dialog).toContainText("Only version 3 is shared.");
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-confirm");
      // Cancel attaches nothing and saves nothing.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(skills.getByRole("listitem")).toHaveCount(0);
      expect(seen.draftSaves).toHaveLength(0);
      // Choosing again and confirming attaches it, says what it now allows, and names the confirmation in the save.
      await pickSkill(skills, "Release notes · Version 3");
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Attach and allow use",
      }).click();
      await expect(skills).toContainText("Release notes");
      await expect(skills.getByText("Private", { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          "Attached Release notes. People who can see or run this workflow can now use version 3.",
        ),
      ).toBeVisible();
      await expect.poll(() => savedSkills(seen).skills).toEqual([uuid(8101)]);
      expect(savedSkills(seen).confirmed).toEqual([uuid(8101)]);
    });

    test("removing a skill says so and Undo puts it back", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: { items: [skill({ stepPath: "/steps/1" })] },
        catalog: [catalogSkill({})],
      });
      // The step already names it: the draft holds it, so the saved step carries it.
      await skills.getByRole("button", { name: "Remove Code style" }).click();
      await expect(skills).not.toContainText("Version 2 · comes with Bakery");
      await expect(page.getByText("Removed Code style from this step."))
        .toBeVisible();
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-removed");
      // The removal is saved (no skills left on the step), then Undo saves it back.
      await expect.poll(() => seen.draftSaves.length).toBe(1);
      expect(savedSkills(seen).skills).toBeUndefined();
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(skills).toContainText("Version 2 · comes with Bakery");
      await expect.poll(() => savedSkills(seen).skills).toEqual([uuid(7000)]);
    });

    test("removing someone else's private skill that a published version uses says so", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: {
          items: [
            skill({
              skillVersionId: uuid(7002),
              skillName: "Security review",
              revision: 1,
              scope: "personal",
              ownerDisplayName: "Dana Lee",
              publishedVersionUsesIt: true,
            }),
          ],
        },
      });
      await skills.getByRole("button", { name: "Remove Security review" })
        .click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Remove",
        exact: true,
      }).click();
      await expect(
        page.getByText(
          "Removed Security review from this step. A published version of this workflow still uses it.",
        ),
      ).toBeVisible();
    });

    test("removing someone else's private skill asks first", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: {
          items: [
            skill({
              skillVersionId: uuid(7002),
              skillName: "Security review",
              revision: 1,
              scope: "personal",
              ownerDisplayName: "Dana Lee",
            }),
          ],
        },
      });
      await skills.getByRole("button", { name: "Remove Security review" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Remove Dana Lee's private skill?");
      await expect(dialog).toContainText("Only Dana Lee can attach it again.");
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(skills).not.toContainText("Security review");
      await expect(page.getByText("Removed Security review from this step."))
        .toBeVisible();
    });

    test("the picker says when no skill fits, tells equal names apart, and can be tried again", async ({ page }) => {
      const first = await openSkills(page, {
        skills: { items: [] },
        catalog: [
          catalogSkill({ slug: "style-a" }),
          catalogSkill({
            id: uuid(8002),
            slug: "style-b",
            activeVersionId: uuid(8102),
          }),
        ],
      });
      // Two skills of one name carry their slug so they can be told apart.
      const picker = await openPicker(first.skills);
      await expect(
        picker.getByRole("button", {
          name: "Code style · Version 2 · style-a",
        }),
      ).toHaveCount(1);
      await expect(
        picker.getByRole("button", {
          name: "Code style · Version 2 · style-b",
        }),
      ).toHaveCount(1);
    });

    test("a picker that did not load can be tried again", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: "fail",
      });
      await expect(skills).toContainText("The skills did not load.");
      seen.catalogAnswer = [catalogSkill({})];
      const before = seen.catalogReads;
      await skills.getByRole("button", { name: "Try again" }).click();
      await expect(skills.getByRole("button", { name: "Attach a skill…" }))
        .toBeVisible();
      expect(seen.catalogReads).toBeGreaterThan(before);
    });

    test("when every skill on offer is attached the picker gives way to a line, and returns on remove", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [catalogSkill({})],
      });
      const trigger = skills.getByRole("button", { name: "Attach a skill…" });
      await pickSkill(skills, "Code style · Version 2");
      await expect(skills).toContainText(
        "No more skills to attach.",
      );
      await expect(trigger).toHaveCount(0);
      // Not the "nothing fits" line: something does fit, and it is on the step.
      await expect(skills).not.toContainText(
        "No skills fit this kind of step.",
      );
      await skills.getByRole("button", { name: "Remove Code style" }).click();
      await expect(trigger).toBeVisible();
      const back = await openPicker(skills);
      await expect(back.getByRole("button", { name: /Code style/ }))
        .toHaveCount(1);
      await expect(skills).not.toContainText("No more skills to attach.");
    });

    test("an edit made while a save is still answering waits, then saves on the version that save returned", async ({ page }) => {
      const { seen, skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [catalogSkill({})],
        saveDelayMs: 1500,
      });
      await pickSkill(skills, "Code style · Version 2");
      // The attach is still being saved when the person takes it off again.
      await expect.poll(() => seen.draftSaves.length).toBe(1);
      await skills.getByRole("button", { name: "Remove Code style" }).click();
      await expect.poll(() => seen.draftSaves.length, { timeout: 10_000 })
        .toBe(2);
      await expect(page.getByText("Not saved")).toHaveCount(0);
      // The second save carries what the first returned (version 2), not what was read before it.
      expect(seen.draftSaves[1].ifMatch).toBe('"v2"');
      expect(savedSkills(seen).skills ?? []).toEqual([]);
    });

    test("with no skill to offer the picker says so", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [],
      });
      await expect(skills).toContainText(
        "No skills fit this kind of step. Skills are made in the Library.",
      );
      // One empty line, not two.
      await expect(skills).not.toContainText("No skills attached.");
    });

    test("a step that shows skills and has none left to offer says nothing more can be attached", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: [skill({})] },
        catalog: [],
      });
      await expect(skills).toContainText("Code style");
      await expect(skills).toContainText("No more skills to attach.");
      await expect(skills).not.toContainText(
        "No skills fit this kind of step.",
      );
    });

    test("a step with no skills says the agent uses only its own", async ({ page }) => {
      const { skills } = await openSkills(page, {
        skills: { items: [] },
        catalog: [catalogSkill({})],
      });
      await expect(skills).toContainText(
        "No skills attached. The agent uses only its own.",
      );
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-empty");
    });

    test("skills that did not load say so and can be read again", async ({ page }) => {
      const { seen, skills } = await openSkills(page, { skills: "fail" });
      await expect(skills).toContainText("The skills did not load.");
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-failed");
      const before = seen.skillReads;
      seen.skillsAnswer = { items: [skill({})] };
      await skills.getByRole("button", { name: "Try again" }).click();
      await expect(skills).toContainText("Code style");
      await expect(skills).not.toContainText("The skills did not load.");
      expect(seen.skillReads).toBeGreaterThan(before);
    });

    test("a step without an agent has no Skills list", async ({ page }) => {
      await openEditor(page, {
        ...skillsWorld(undefined),
        skills: {
          items: [
            skill({ stepPath: "/steps/0", skillName: "Not for this step" }),
            skill({}),
          ],
        },
      });
      await page.locator("[data-card]").filter({
        hasText: "Write the task brief",
      })
        .getByRole("button").first().click();
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("step-skills")).toHaveCount(0);
      await expect(page.getByText("Not for this step")).toHaveCount(0);
    });

    test("while the skills load the list is busy, not empty", async ({ page }) => {
      await libraryFixture(page, {
        ...skillsWorld({ items: [skill({})] }),
        skills: { items: [skill({})] },
      });
      await page.route(
        (url) =>
          /^\/v1\/workflows\/[^/]+\/versions\/[^/]+\/skills$/.test(
            url.pathname,
          ),
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await route.fallback();
        },
      );
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      await expect(page.locator("[data-card='start']")).toBeVisible();
      await page.locator("[data-card]").filter({ hasText: "Implement" })
        .getByRole("button").first().click();
      const skills = page
        .getByRole("complementary", { name: "The selected step" })
        .getByTestId("step-skills");
      await expect(skills.locator("[aria-busy='true']")).toBeVisible();
      await expect(skills).not.toContainText("No skills attached");
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-loading");
      await expect(skills).toContainText("Code style", { timeout: 10000 });
    });

    test("a very long skill name wraps inside the panel", async ({ page }) => {
      const long =
        "Security-review-of-the-whole-release-pipeline-including-every-vendored-dependency-and-build-script-"
          .repeat(2);
      const { skills } = await openSkills(page, {
        skills: {
          items: [
            skill({
              skillName: long,
              scope: "personal",
              ownerDisplayName: "Dana Lee",
              skillVersionId: uuid(7007),
            }),
          ],
        },
      });
      await expect(skills).toContainText("Security-review");
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.mouse.move(600, 700);
      await shot(page, "workflow-editor-skills-long");
    });
  });
}

/**
 * A workflow whose repeat repairs and ends in an independent review is the
 * "Fix until it passes" block (#62); a plain repeat beside it keeps "Repeat".
 */
const FIXING: Options = {
  ...WORLD,
  versions: [
    ...VERSIONS.filter((row) => row.status !== "draft"),
    {
      ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { kind: "action", id: "brief", uses: "task.brief" },
        {
          kind: "repeat",
          max: 2,
          steps: [
            { kind: "action", id: "repair", uses: "harness.repair" },
            { kind: "action", id: "check", uses: "quality.check" },
            { kind: "action", id: "review", uses: "review.independent" },
          ],
        },
        {
          kind: "repeat",
          max: 3,
          steps: [{ kind: "action", id: "again", uses: "agent.review" }],
        },
      ],
    },
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: the Fix until it passes block`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a repeat that repairs and reviews is named with its limit; another repeat keeps its word", async ({ page }) => {
      await libraryFixture(page, FIXING);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(1004)}`,
      );
      const fix = page.locator("[data-group=fix]");
      await expect(fix).toHaveCount(1);
      await expect(fix).toContainText("Fix until it passes");
      await expect(fix).toContainText("At most 2 tries");
      await expect(fix).toContainText("Fix problems");
      // The other repeat is still just a repeat, with no limit claimed.
      const plain = page.locator("[data-group=repeat]");
      await expect(plain).toHaveCount(1);
      await expect(plain).toContainText("Repeat");
      await expect(plain).not.toContainText("tries");
      // A read-only page never says "Edited in code".
      await expect(page.getByTestId("workflow-steps")).not.toContainText(
        "Edited in code",
      );
      await page.mouse.move(700, 700);
      await shot(page, "workflow-fix-block");
    });

    test("the built-in page draws the repair loop as the same block, with its limit", async ({ page }) => {
      await libraryFixture(page, WORLD);
      // The server's real read: the repair loop's steps name their repeat.
      const inLoop = { repeatId: "repair", repeatMax: 2 };
      await page.route(
        (url) => url.pathname === "/v1/workflow-presets",
        (route) =>
          route.fulfill({
            json: {
              items: [{
                id: "fixed-coding-reviewed",
                revision: 3,
                digest: "b".repeat(64),
                nameKey: "workflowPresets.fixedCodingReviewed.name",
                steps: [
                  { id: "flow.brief", uses: "task.brief" },
                  { id: "flow.implement", uses: "harness.implement" },
                  { id: "flow.check", uses: "quality.check" },
                  { id: "flow.review", uses: "review.independent" },
                  {
                    id: "repair.repair_implement",
                    uses: "harness.repair",
                    ...inLoop,
                  },
                  {
                    id: "repair.repair_check",
                    uses: "quality.check",
                    ...inLoop,
                  },
                  {
                    id: "repair.repair_review",
                    uses: "review.independent",
                    ...inLoop,
                  },
                ],
                defaultBudgetLimitUsd: "8.00",
                availability: null,
              }],
              nextCursor: null,
            },
          }),
      );
      await page.goto("/library/built-in/fixed-coding-reviewed");
      const steps = page.getByTestId("workflow-steps");
      const fix = steps.locator("[data-group=fix]");
      await expect(fix).toHaveCount(1);
      await expect(fix).toContainText("Fix until it passes");
      await expect(fix).toContainText("At most 2 tries");
      // Every step is still drawn: four before the loop, three inside it.
      await expect(steps.locator("[data-card]:not([data-card=start])"))
        .toHaveCount(7);
      await expect(fix.locator("[data-card]")).toHaveCount(3);
      await page.mouse.move(700, 700);
      await shot(page, "workflow-built-in-fix-block");
    });

    test("in the editor the block says what it does and its limit as text, with no field", async ({ page }) => {
      await libraryFixture(page, FIXING);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      const fix = page.locator("[data-group=fix]");
      await expect(fix).toContainText("Fix until it passes");
      await expect(fix).toContainText("At most 2 tries");
      await expect(fix).toContainText("Edited in code");
      await fix.getByRole("button", { name: "Fix until it passes" }).click();
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toContainText("Fix until it passes");
      await expect(panel).toContainText(
        "Fixes what the checks and the review found, then checks and reviews again.",
      );
      await expect(panel).toContainText(
        "If the first review is already clean, this block is skipped.",
      );
      // The limit is said once, on the block, not again in the panel.
      await expect(panel).not.toContainText("At most");
      await expect(panel.getByRole("textbox")).toHaveCount(0);
      await expect(panel.getByRole("spinbutton")).toHaveCount(0);
      // The other repeat's panel claims nothing of the kind.
      await page.locator("[data-group=repeat]").getByRole("button", {
        name: "Repeat",
      }).click();
      await expect(panel).not.toContainText("At most");
      await fix.getByRole("button", { name: "Fix until it passes" }).click();
      await page.mouse.move(600, 700);
      await shot(page, "workflow-fix-block-editor");
    });
  });
}

/**
 * A forEach is the "For each item" block (#417): one bordered block with its
 * steps drawn once and its limit beside the name. A forEach with no steps and
 * one inside a repeat sit beside it.
 */
const EACHING: Options = {
  ...WORLD,
  versions: [
    ...VERSIONS.filter((row) => row.status !== "draft"),
    {
      ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { kind: "action", id: "brief", uses: "task.brief" },
        {
          kind: "forEach",
          items: "issues",
          as: "issue",
          max: 12,
          steps: [
            { kind: "action", id: "implement", uses: "harness.implement" },
            { kind: "action", id: "check", uses: "quality.check" },
          ],
        },
        { kind: "action", id: "review", uses: "review.independent" },
        { kind: "forEach", items: "files", as: "file", max: 3, steps: [] },
        {
          kind: "repeat",
          max: 2,
          steps: [{
            kind: "forEach",
            items: "notes",
            as: "note",
            max: 1,
            steps: [{ kind: "action", id: "again", uses: "agent.review" }],
          }],
        },
      ],
    },
  ],
};

/**
 * An If inside a For each item, followed by a step: the paths the block's
 * path line, selected look and one "Edited in code" also reach (#417).
 */
const EACHING_IF: Options = {
  ...WORLD,
  versions: [
    ...VERSIONS.filter((row) => row.status !== "draft"),
    {
      ...version(4, 4, "draft", [{ id: "brief", uses: "task.brief" }]),
      spec: [
        { kind: "action", id: "brief", uses: "task.brief" },
        {
          kind: "forEach",
          items: "issues",
          as: "issue",
          max: 5,
          steps: [
            {
              kind: "branch",
              then: [{
                kind: "action",
                id: "implement",
                uses: "harness.implement",
              }],
              else: [],
            },
            { kind: "action", id: "check", uses: "quality.check" },
          ],
        },
      ],
    },
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: the For each item block`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a forEach is one block with its steps once and its limit; an empty one and a nested one read the same way", async ({ page }) => {
      await libraryFixture(page, EACHING);
      await page.goto(
        `/library/workflows/${WORKFLOW.id}?version=${uuid(1004)}`,
      );
      const each = page.locator("[data-group=each]");
      await expect(each).toHaveCount(3);
      await expect(each.first()).toContainText("For each item");
      await expect(each.first()).toContainText("At most 12 items");
      // Its steps are drawn once, inside it; the list and the item name are not drawn.
      await expect(each.first().locator("[data-card]")).toHaveCount(2);
      await expect(each.first()).not.toContainText("issues");
      // One with no steps keeps the existing line.
      await expect(each.nth(1)).toContainText("At most 3 items");
      await expect(each.nth(1)).toContainText("No steps");
      // One inside a repeat is a block inside that block, and one item is singular.
      const repeat = page.locator("[data-group=repeat]");
      await expect(repeat).toHaveCount(1);
      await expect(repeat.locator("[data-group=each]")).toHaveCount(1);
      await expect(repeat.locator("[data-group=each]")).toContainText(
        "At most 1 item",
      );
      await expect(repeat.locator("[data-group=each]")).not.toContainText(
        "At most 1 items",
      );
      // A read-only page never says "Edited in code".
      await expect(page.getByTestId("workflow-steps")).not.toContainText(
        "Edited in code",
      );
      // The path line runs on from a block as from a card (#417 UX ruling
      // 7086208998 change 1): the two blocks that are not last are each followed
      // by a connector, and the one nested as the last thing in a repeat is not.
      for (const index of [0, 1]) {
        await expect(
          each.nth(index).locator("xpath=following-sibling::*[1]"),
        ).toHaveAttribute("data-connector", /.+/);
      }
      await expect(repeat.locator(":scope > [data-connector]")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "workflow-for-each");
    });

    test("an If inside a For each item has a path line after it, says nothing more about code, and shows which arm is selected", async ({ page }) => {
      await libraryFixture(page, EACHING_IF);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      const each = page.locator("[data-group=each]");
      await expect(each).toHaveCount(1);
      const inner = each.locator("[data-group=if]");
      await expect(inner).toHaveCount(1);
      // The plain path line follows the If, with no "+": a step comes after it.
      const after = inner.locator("xpath=following-sibling::*[1]");
      await expect(after).toHaveAttribute("data-connector", /.+/);
      await expect(after.getByRole("button", { name: /Add a step after/ }))
        .toHaveCount(0);
      // "Edited in code" is said once, by the outer block, and not by the If in it.
      await expect(
        page.locator("[data-group-label]").filter({
          hasText: "Edited in code",
        }),
      ).toHaveCount(1);
      await expect(each.locator("[data-group-label=if]")).not.toContainText(
        "Edited in code",
      );
      // Pressing an arm's name selects that arm and nothing else.
      const yes = inner.locator("[data-group-arm=yes]");
      const otherwise = inner.locator("[data-group-arm=otherwise]");
      const name = yes.getByRole("button", { name: "Yes" });
      await expect(yes).not.toHaveAttribute("data-selected", "true");
      await expect(name).toHaveAttribute("aria-pressed", "false");
      await name.click();
      await expect(yes).toHaveAttribute("data-selected", "true");
      await expect(name).toHaveAttribute("aria-pressed", "true");
      await expect(otherwise).not.toHaveAttribute("data-selected", "true");
      await expect(each).not.toHaveAttribute("data-selected", "true");
    });

    test("in the editor the block says what it does as text, with no field for the limit", async ({ page }) => {
      await libraryFixture(page, EACHING);
      await page.goto(`/library/workflows/${WORKFLOW.id}/edit`);
      const each = page.locator("[data-group=each]").first();
      await expect(each).toContainText("For each item");
      await expect(each).toContainText("At most 12 items");
      await expect(each).toContainText("Edited in code");
      // A block that is not last is followed by the plain path line, with no "+":
      // adding a step after a block is not part of this slice (change 1).
      const after = each.locator("xpath=following-sibling::*[1]");
      await expect(after).toHaveAttribute("data-connector", /.+/);
      await expect(after.getByRole("button", { name: /Add a step after/ }))
        .toHaveCount(0);
      // A block inside a block does not say "Edited in code" again (change 3).
      await expect(
        page.locator("[data-group=repeat] [data-group-label]").filter({
          hasText: "Edited in code",
        }),
      ).toHaveCount(1);
      // Nothing is selected until a block is pressed.
      const name = each.getByRole("button", { name: "For each item" });
      await expect(each).not.toHaveAttribute("data-selected", "true");
      await expect(name).toHaveAttribute("aria-pressed", "false");
      await name.click();
      // The pressed block, and only it, wears the selection (change 2).
      await expect(each).toHaveAttribute("data-selected", "true");
      await expect(name).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-group=each][data-selected=true]"))
        .toHaveCount(1);
      // ...and the rule paints: its border differs from an unselected block's.
      const plainBorder = await page.locator("[data-group=each]").nth(1)
        .evaluate((el) => getComputedStyle(el).borderTopColor);
      await expect(each).not.toHaveCSS("border-top-color", plainBorder);
      const panel = page.getByRole("complementary", {
        name: "The selected step",
      });
      await expect(panel).toContainText("For each item");
      await expect(panel).toContainText(
        "Runs these steps once for each item in a list, one item at a time.",
      );
      await expect(panel).toContainText(
        "A list with more items than the limit fails the run before any step starts.",
      );
      // The limit is said once, on the block, not again in the panel.
      await expect(panel).not.toContainText("At most");
      await expect(panel.getByRole("textbox")).toHaveCount(0);
      await expect(panel.getByRole("spinbutton")).toHaveCount(0);
      await page.mouse.move(600, 700);
      await shot(page, "workflow-for-each-editor");
    });
  });
}
