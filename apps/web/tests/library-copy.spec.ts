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
 * Built-in workflows and "Make a copy" (design-ux, #66, slice 3a): a built-in
 * workflow opens read-only, and an administrator copies it, or a version of
 * the organization's own, into a new draft workflow.
 */
const OWN = definition(10, "Release train", { activeVersionId: uuid(1002) });
const own = (
  n: number,
  revision: number,
  status: VersionRow["status"],
  steps: VersionRow["steps"],
): VersionRow => ({
  id: uuid(1000 + n),
  workflowId: OWN.id,
  revision,
  status,
  steps,
});
const WORLD: Options = {
  workflows: [OWN],
  versions: [
    own(1, 1, "retired", [{ id: "brief", uses: "task.brief" }]),
    own(2, 2, "published", [
      { id: "brief", uses: "task.brief" },
      { id: "review", uses: "agent.review" },
    ]),
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: built-in workflows and copies`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (page: Page, options: Options, path: string) => {
      const seen = await libraryFixture(page, options);
      await page.goto(path);
      return seen;
    };
    const builtIn = (page: Page) => page.getByTestId("library-built-in");
    const dialog = (page: Page) =>
      page.getByRole("dialog", { name: "Make a copy" });

    test("a built-in row's name opens its page and an administrator can make a copy of it; a member cannot", async ({ page }) => {
      await open(page, WORLD, "/library");
      const row = builtIn(page).locator("[data-library-id=fixed-coding]");
      await expect(row.getByRole("link", { name: "Fixed coding" }))
        .toHaveAttribute("href", "/library/built-in/fixed-coding");
      await expect(
        row.getByRole("button", { name: "Make a copy of Fixed coding" }),
      ).toBeVisible();
      // Organization rows keep their one Open button and gain nothing.
      await expect(
        page.getByTestId("library-organization").getByRole("button", {
          name: /Make a copy/,
        }),
      ).toHaveCount(0);
      // The button sits at the end of the name's line at its label's width on
      // a wide screen, and spans the row under the text on a phone.
      for (
        const target of [
          row.getByRole("button", { name: "Make a copy of Fixed coding" }),
          page.getByTestId("library-organization").getByRole("button", {
            name: "Open Release train",
          }),
        ]
      ) {
        const button = (await target.boundingBox())!;
        const item =
          (await target.locator("xpath=ancestor::*[@role='listitem']")
            .boundingBox())!;
        if (viewport.name === "desktop") {
          expect(button.width).toBeLessThan(260);
          expect(button.y).toBeLessThan(item.y + 60);
          expect(button.x + button.width).toBeGreaterThan(
            item.x + item.width - 8,
          );
        } else {
          expect(button.width).toBeGreaterThan(item.width - 8);
        }
      }
      await page.mouse.move(700, 700);
      await shot(page, "library-built-in-rows");
    });

    test("a member sees the built-in rows without Make a copy", async ({ page }) => {
      await open(page, { ...WORLD, role: "developer" }, "/library");
      await expect(builtIn(page).getByRole("link", { name: "Fixed coding" }))
        .toBeVisible();
      await expect(builtIn(page).getByRole("button", { name: /Make a copy/ }))
        .toHaveCount(0);
    });

    test("the built-in page is read-only: numbered steps, its version, and one action", async ({ page }) => {
      await open(page, WORLD, "/library/built-in/fixed-coding-reviewed");
      const root = page.getByTestId("builtin-workflow-page");
      await expect(
        page.getByRole("heading", {
          name: "Coding with independent review",
          level: 1,
        }),
      )
        .toBeVisible();
      await expect(root).toContainText("Built in");
      await expect(root).toContainText("Version 3");
      await expect(root).toContainText(
        "Built-in workflows cannot be changed. Make a copy to edit it.",
      );
      await expect(root).toContainText("Steps in version 3");
      // The diagram draws "How it starts" first, then one card per step.
      const steps = root.locator("[data-card]:not([data-card=start])");
      await expect(steps).toHaveCount(3);
      await expect(steps.nth(0)).toContainText("Write the task brief");
      await expect(steps.nth(1)).toContainText("Implement");
      await expect(steps.nth(2)).toContainText("Review");
      await expect(root).not.toContainText("harness.implement");
      await expect(page.getByRole("button", { name: "Make a copy" }))
        .toHaveCount(1);
      await page.mouse.move(700, 700);
      await shot(page, "builtin-page");
    });

    test("a member sees the built-in page with no Make a copy and why", async ({ page }) => {
      await open(
        page,
        { ...WORLD, role: "developer" },
        "/library/built-in/fixed-coding",
      );
      await expect(page.getByTestId("builtin-workflow-page")).toContainText(
        "Built-in workflows cannot be changed. An organization administrator can make a copy to edit.",
      );
      await expect(page.getByRole("button", { name: "Make a copy" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "builtin-page-member");
    });

    test("a built-in workflow that is not there says so and leads back to the library", async ({ page }) => {
      await open(page, WORLD, "/library/built-in/nope");
      await expect(page.getByTestId("builtin-workflow-page")).toContainText(
        "This built-in workflow was not found",
      );
      await page.getByRole("button", { name: "Back to the library" }).click();
      await expect(page).toHaveURL("/library");
    });

    test("Make a copy from the page asks for a name, says it starts as a draft, creates the workflow and its steps, and opens it", async ({ page }) => {
      const seen = await open(
        page,
        WORLD,
        "/library/built-in/fixed-coding-reviewed",
      );
      await page.getByRole("button", { name: "Make a copy" }).click();
      const form = dialog(page);
      await expect(form.getByLabel("Name")).toHaveValue(
        "Coding with independent review (copy)",
      );
      await expect(form).toContainText(
        "The copy starts as a draft from version 3. It is not used until you publish it.",
      );
      await page.mouse.move(700, 700);
      await shot(page, "copy-dialog", [], { windowOnly: true });
      await form.getByLabel("Name").fill("Our release flow");
      await form.getByRole("button", { name: "Make a copy" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created).toEqual([{
        slug: "our-release-flow",
        name: "Our release flow",
        description:
          "Write the task brief and run the coding agent, then check and independently review the result, fixing it a limited number of times.",
      }]);
      expect(seen.versionsCreated).toHaveLength(1);
      expect(seen.versionsCreated[0]?.definition).toEqual({
        steps: [
          { id: "brief", uses: "task.brief" },
          { id: "implement", uses: "harness.implement" },
          { id: "review", uses: "agent.review" },
        ],
      });
      // The new workflow is a draft that nothing uses yet.
      await expect(page.getByTestId("workflow-page")).toContainText(
        "Our release flow",
      );
      await expect(page.getByTestId("workflow-page")).toContainText(
        "To use this workflow, publish a version in the editor.",
      );
    });

    test("Make a copy from the list does the same from a built-in row", async ({ page }) => {
      const seen = await open(page, WORLD, "/library");
      await builtIn(page).locator("[data-library-id=fixed-coding]").getByRole(
        "button",
        { name: "Make a copy of Fixed coding" },
      ).click();
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created.map((row) => row.slug)).toEqual([
        "fixed-coding-copy",
      ]);
    });

    test("a copy's address is the next free one when another workflow has it", async ({ page }) => {
      const seen = await open(page, {
        ...WORLD,
        workflows: [OWN, definition(11, "Taken", { slug: "taken" })],
      }, "/library/built-in/fixed-coding");
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByLabel("Name").fill("Taken");
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\//);
      expect(seen.created[0]?.slug).toBe("taken-2");
    });

    test("an empty name is refused where it is typed and nothing is sent", async ({ page }) => {
      const seen = await open(page, WORLD, "/library/built-in/fixed-coding");
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByLabel("Name").fill("  ");
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(dialog(page)).toContainText("Enter a name for the copy.");
      expect(seen.created).toHaveLength(0);
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Make a copy" }))
        .toBeFocused();
    });

    test("when the workflow cannot be made the dialog says so, stays, and nothing opens", async ({ page }) => {
      const seen = await open(
        page,
        { ...WORLD, copy: "workflow-fails" },
        "/library/built-in/fixed-coding",
      );
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(dialog(page)).toContainText("The copy could not be made.");
      await expect(page).toHaveURL("/library/built-in/fixed-coding");
      expect(seen.versionsCreated).toHaveLength(0);
    });

    test("when the steps cannot be added the workflow exists, so a retry only adds the steps", async ({ page }) => {
      const seen = await open(
        page,
        { ...WORLD, copy: "steps-fail-once" },
        "/library/built-in/fixed-coding",
      );
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(dialog(page)).toContainText(
        "The copy Fixed coding (copy) was made, but its steps could not be added. It is in Library with no steps yet.",
      );
      expect(seen.created).toHaveLength(1);
      // The name is locked and says why; the button says what it will do.
      await expect(dialog(page).getByLabel("Name")).toBeDisabled();
      await expect(dialog(page)).toContainText(
        "The copy already has this name.",
      );
      await expect(dialog(page).getByRole("button", { name: "Make a copy" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "copy-steps-failed", [], { windowOnly: true });
      await dialog(page).getByRole("button", { name: "Try again" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      // One workflow, two attempts at its steps.
      expect(seen.created).toHaveLength(1);
      expect(seen.stepWrites).toBe(2);
      expect(seen.versionsCreated).toHaveLength(1);
    });

    const startCopy = async (page: Page, options: Options) => {
      const seen = await open(page, options, "/library/built-in/fixed-coding");
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      return seen;
    };

    test("a refused first write says why, in words that fit: not allowed", async ({ page }) => {
      await startCopy(page, { ...WORLD, copy: "workflow-403" });
      await expect(dialog(page)).toContainText(
        "Only organization administrators can make a copy.",
      );
      await expect(dialog(page)).not.toContainText("Check your connection");
    });

    test("a refused first write says why: too many requests or a server fault is not the person's network", async ({ page }) => {
      await startCopy(page, { ...WORLD, copy: "workflow-429" });
      await expect(dialog(page)).toContainText(
        "The copy could not be made. Try again in a moment.",
      );
      await expect(dialog(page)).not.toContainText("Check your connection");
    });

    test("a taken name is the Name field's problem, the field stays editable, and a new name goes through", async ({ page }) => {
      const seen = await startCopy(page, {
        ...WORLD,
        copy: "workflow-409-once",
      });
      const name = dialog(page).getByLabel("Name");
      await expect(dialog(page)).toContainText(
        "A workflow with this name already exists. Choose another name.",
      );
      await expect(name).toBeEnabled();
      // The refused name is marked invalid, not only explained.
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await name.fill("Another name");
      await expect(dialog(page)).not.toContainText("already exists");
      await expect(name).not.toHaveAttribute("aria-invalid", "true");
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created.map((row) => row.name)).toEqual(["Another name"]);
      // A refused write did not happen, so the new attempt is a new write.
      expect(new Set(seen.workflowKeys).size).toBe(2);
    });

    test("a name the server does not accept is the Name field's problem", async ({ page }) => {
      await startCopy(page, { ...WORLD, copy: "workflow-422-once" });
      await expect(dialog(page)).toContainText(
        "This name cannot be used. Change it and try again.",
      );
      await expect(dialog(page).getByLabel("Name")).toBeEnabled();
      await expect(dialog(page).getByLabel("Name")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    test("a write whose answer was lost is retried with the same key, so the server can tell it is the same write", async ({ page }) => {
      const seen = await startCopy(page, {
        ...WORLD,
        copy: "workflow-drop-once",
      });
      // No answer at all is the offline wording (design-ux's ruling).
      await expect(dialog(page)).toContainText("You are offline.");
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.workflowKeys).toHaveLength(2);
      expect(seen.workflowKeys[0]).toBeTruthy();
      expect(seen.workflowKeys[1]).toBe(seen.workflowKeys[0]);
      expect(seen.created).toHaveLength(1);
    });

    test("the steps write keeps its key across a retry", async ({ page }) => {
      const seen = await startCopy(page, { ...WORLD, copy: "steps-fail-once" });
      await expect(dialog(page)).toContainText("its steps could not be added");
      await dialog(page).getByRole("button", { name: "Try again" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.versionKeys).toHaveLength(2);
      expect(seen.versionKeys[0]).toBeTruthy();
      expect(seen.versionKeys[1]).toBe(seen.versionKeys[0]);
      // The workflow was written once.
      expect(seen.workflowKeys).toHaveLength(1);
    });

    test("a copy whose steps never saved is in the Library with no versions, as the message says", async ({ page }) => {
      const seen = await open(
        page,
        { ...WORLD, copy: "steps-fail" },
        "/library/built-in/fixed-coding",
      );
      await page.getByRole("button", { name: "Make a copy" }).click();
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      await expect(dialog(page)).toContainText(
        "It is in Library with no steps yet.",
      );
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      expect(seen.created).toHaveLength(1);
      // The Library lists it among the organization's workflows, in use by nothing.
      await page.goto("/library");
      const row = page.getByTestId("library-organization").locator(
        "[data-library-id]",
      ).filter({ hasText: "Fixed coding (copy)" });
      await expect(row).toContainText("No version in use");
      await page.mouse.move(700, 700);
      await shot(page, "copy-half-made-row");
      // Its page says it has no versions yet.
      await row.getByRole("button", { name: /Open Fixed coding \(copy\)/ })
        .click();
      await expect(page.getByTestId("workflow-page")).toContainText(
        "This workflow has no versions yet.",
      );
    });

    test("More on a workflow has Make a copy, which starts from the version being viewed", async ({ page }) => {
      const seen = await open(page, WORLD, `/library/workflows/${OWN.id}`);
      await page.getByRole("button", { name: "More actions for Release train" })
        .click();
      await page.mouse.move(700, 700);
      await shot(page, "workflow-menu-with-copy", [], { windowOnly: true });
      await page.locator(".ui-popover__content").getByRole("button", {
        name: "Make a copy",
      }).click();
      await expect(dialog(page)).toContainText(
        "The copy starts as a draft from version 2.",
      );
      await expect(dialog(page).getByLabel("Name")).toHaveValue(
        "Release train (copy)",
      );
      await dialog(page).getByRole("button", { name: "Make a copy" }).click();
      // The page starts on a workflow's own address, so wait for the copy's.
      await expect.poll(() => seen.versionsCreated.length).toBe(1);
      await expect(page).not.toHaveURL(new RegExp(`${OWN.id}$`));
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.versionsCreated[0]?.definition.steps).toEqual([
        { id: "brief", uses: "task.brief" },
        { id: "review", uses: "agent.review" },
      ]);
      expect(seen.versionsCreated[0]?.sourceYaml).toContain("version 2");
    });

    test("a member's More menu has no Make a copy", async ({ page }) => {
      await open(
        page,
        { ...WORLD, role: "developer" },
        `/library/workflows/${OWN.id}`,
      );
      await page.getByRole("button", { name: "More actions for Release train" })
        .click();
      const menu = page.locator(".ui-popover__content");
      await expect(menu.getByRole("button", { name: "Export" })).toBeVisible();
      await expect(menu.getByRole("button", { name: "Make a copy" }))
        .toHaveCount(0);
    });
  });
}
