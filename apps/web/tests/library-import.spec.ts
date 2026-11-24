import { expect, type Page, test } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
  uuid,
} from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

// The text is checked after it rests and the answer comes from the server:
// give the result longer than the default under load.
const checked = expect.configure({ timeout: 15_000 });

/**
 * Import a workflow definition (design-ux, #66, slice 3b): the text is read
 * and checked, only a definition the checker accepts can be imported, and
 * importing makes a draft and runs nothing.
 */
const OWN = definition(10, "Release train", { activeVersionId: uuid(1002) });
const WORLD: Options = { workflows: [OWN] };
const GOOD = `name: Nightly build
steps:
  - id: brief
    uses: task.brief
  - id: implement
    uses: harness.implement
`;

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: import a workflow`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (page: Page, options: Options = WORLD) => {
      const seen = await libraryFixture(page, options);
      await page.goto("/library");
      return seen;
    };
    const importButton = (page: Page) =>
      page.getByRole("button", { name: "Import", exact: true });
    const dialog = (page: Page) =>
      page.getByRole("dialog", { name: "Import a workflow" });
    const paste = async (page: Page, text: string) => {
      await importButton(page).click();
      await dialog(page).getByLabel("Or paste the definition").fill(text);
    };
    const state = (page: Page) => dialog(page).locator("[data-import-state]");

    test("an administrator sees Import on the Workflows tab, a member does not, and Agents has none", async ({ page }) => {
      await open(page);
      await expect(importButton(page)).toBeVisible();
      await page.getByRole("tab", { name: "Agents" }).click();
      await expect(importButton(page)).toHaveCount(0);
      await open(page, { ...WORLD, role: "developer" });
      await expect(page.getByTestId("library-page")).toBeVisible();
      await expect(importButton(page)).toHaveCount(0);
    });

    test("the dialog says what it takes and that importing runs nothing, and imports nothing until the text is valid", async ({ page }) => {
      await open(page);
      await importButton(page).click();
      const form = dialog(page);
      // Disabled with its reason beside it, until something is given.
      await expect(form.getByTestId("import-reason")).toHaveText(
        "Choose a file or paste a definition first.",
      );
      await expect(form).toContainText(
        "A workflow definition file exported from Bakery (.yaml).",
      );
      await expect(form).toContainText(
        "Importing creates a draft. Nothing runs.",
      );
      await expect(form.getByRole("button", { name: "Import as draft" }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await shot(page, "import-dialog", [], { windowOnly: true });
    });

    test("valid text is checked, says what it found, and imports as a draft that nothing runs", async ({ page }) => {
      const seen = await open(page);
      await paste(page, GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
      // The name starts from what the definition calls itself.
      await expect(dialog(page).getByLabel("Name")).toHaveValue(
        "Nightly build",
      );
      expect(seen.validations).toHaveLength(1);
      await page.mouse.move(700, 700);
      await shot(page, "import-valid", [], { windowOnly: true });
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      await expect(page).not.toHaveURL(new RegExp(`${OWN.id}$`));
      expect(seen.created).toEqual([{
        slug: "nightly-build",
        name: "Nightly build",
        description: "",
      }]);
      expect(seen.versionsCreated).toHaveLength(1);
      expect(seen.versionsCreated[0]?.definition).toEqual({
        name: "Nightly build",
        steps: [
          { id: "brief", uses: "task.brief" },
          { id: "implement", uses: "harness.implement" },
        ],
      });
      // The stored file is the text that was imported.
      expect(seen.versionsCreated[0]?.sourceYaml).toBe(GOOD);
      // A draft: nothing is in use, nothing ran.
      await expect(page.getByTestId("workflow-page")).toContainText(
        "Nightly build",
      );
    });

    test("a file is read into the dialog and names the workflow after itself", async ({ page }) => {
      const seen = await open(page);
      await importButton(page).click();
      const chooser = page.waitForEvent("filechooser");
      await dialog(page).getByRole("button", { name: "Choose a file" }).click();
      await (await chooser).setFiles({
        name: "our-release-flow-v2.yaml",
        mimeType: "application/yaml",
        buffer: Buffer.from(
          "steps:\n  - id: brief\n    uses: task.brief\n",
        ),
      });
      await expect(dialog(page)).toContainText("our-release-flow-v2.yaml");
      await checked(state(page)).toContainText("Looks good: 1 step.");
      await expect(dialog(page).getByLabel("Name")).toHaveValue(
        "Our release flow",
      );
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created[0]?.slug).toBe("our-release-flow");
    });

    test("problems the checker finds say where and why, and block the import", async ({ page }) => {
      const seen = await open(page, { ...WORLD, validation: "errors" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText(
        "This definition has 2 problems.",
      );
      // Each problem names what to fix (the action is read from the definition).
      await checked(state(page)).toContainText(
        "Step 2 uses an action Bakery does not have: harness.implement.",
      );
      await checked(state(page)).toContainText(
        "The definition is missing a required field.",
      );
      await expect(
        dialog(page).getByRole("button", { name: "Import as draft" }),
      )
        .toBeDisabled();
      expect(seen.created).toHaveLength(0);
      await page.mouse.move(700, 700);
      await shot(page, "import-invalid", [], { windowOnly: true });
    });

    test("a missing field is named, in a step and at the top of the definition", async ({ page }) => {
      await open(page, { ...WORLD, validation: "named" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText(
        "Step 1 is missing a required field: id.",
      );
      await checked(state(page)).toContainText(
        "The definition is missing a required field: steps.",
      );
      // Inside a branch it says where: the names as written, the nth branch.
      await checked(state(page)).toContainText(
        "Step 1, in parallel, branch 2, is missing a required field: steps.",
      );
      // A present field of a kind the checker cannot use is not "missing".
      await checked(state(page)).toContainText(
        "Step 2 has a field with a value Bakery cannot use: with.",
      );
      // A finding with a path and no better sentence says where and that the
      // value cannot be used; the checker's own words are not shown. One located
      // in a step has the step's shape, never the path's.
      await checked(state(page)).toContainText(
        "inputs.target.type: Bakery cannot use this value.",
      );
      await checked(state(page)).toContainText(
        "Step 3 has a field with a value Bakery cannot use: id.",
      );
      await expect(state(page)).not.toContainText("Step 3, id:");
      await expect(state(page)).not.toContainText("invalid shape");
      await expect(
        dialog(page).getByRole("button", { name: "Import as draft" }),
      )
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await shot(page, "import-invalid-named", [], { windowOnly: true });
    });

    test("text that is not a definition is refused here, with where and why, without asking the server", async ({ page }) => {
      const seen = await open(page);
      await paste(page, "steps: [");
      await checked(state(page)).toContainText(
        "The definition is not valid YAML 1.2.",
      );
      await expect(
        dialog(page).getByRole("button", { name: "Import as draft" }),
      )
        .toBeDisabled();
      expect(seen.validations).toHaveLength(0);
      // Fixing the text checks it again.
      await dialog(page).getByLabel("Or paste the definition").fill(GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
    });

    test("a warning is shown and does not block the import", async ({ page }) => {
      await open(page, { ...WORLD, validation: "warnings" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
      await checked(state(page)).toContainText(
        "Step 1, uses: The step's action cannot run yet.",
      );
      await expect(
        dialog(page).getByRole("button", { name: "Import as draft" }),
      )
        .toBeEnabled();
    });

    test("when the checker cannot answer, the dialog says so and imports nothing", async ({ page }) => {
      const seen = await open(page, { ...WORLD, validation: "fail" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText(
        "The definition could not be checked.",
      );
      await expect(
        dialog(page).getByRole("button", { name: "Import as draft" }),
      )
        .toBeDisabled();
      expect(seen.created).toHaveLength(0);
    });

    test("when the steps cannot be added the workflow exists and a retry only adds the steps", async ({ page }) => {
      const seen = await open(page, { ...WORLD, copy: "steps-fail-once" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(dialog(page)).toContainText(
        "The workflow Nightly build was made, but its steps could not be added. It is in Library with no steps yet.",
      );
      await expect(dialog(page).getByLabel("Name")).toBeDisabled();
      await dialog(page).getByRole("button", { name: "Try again" }).click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created).toHaveLength(1);
      expect(seen.stepWrites).toBe(2);
    });

    test("a taken name is the Name field's problem, marked invalid and editable, and a new name imports", async ({ page }) => {
      const seen = await open(page, { ...WORLD, copy: "workflow-409-once" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      const name = dialog(page).getByLabel("Name");
      await expect(dialog(page)).toContainText(
        "A workflow with this name already exists. Choose another name.",
      );
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toBeEnabled();
      await name.fill("Nightly build 2");
      await expect(name).not.toHaveAttribute("aria-invalid", "true");
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(page).toHaveURL(/\/library\/workflows\/[0-9a-f-]{36}$/);
      expect(seen.created.map((row) => row.name)).toEqual(["Nightly build 2"]);
    });

    test("a refused import says why when it is not allowed", async ({ page }) => {
      await open(page, { ...WORLD, copy: "workflow-403" });
      await paste(page, GOOD);
      await checked(state(page)).toContainText("Looks good: 2 steps.");
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(dialog(page)).toContainText(
        "Only organization administrators can import a workflow.",
      );
      await expect(dialog(page)).not.toContainText("Check your connection");
    });

    test("an empty name is refused where it is typed and nothing is created", async ({ page }) => {
      const seen = await open(page);
      await paste(page, "steps:\n  - id: brief\n    uses: task.brief\n");
      await checked(state(page)).toContainText("Looks good: 1 step.");
      await dialog(page).getByLabel("Name").fill("");
      await dialog(page).getByRole("button", { name: "Import as draft" })
        .click();
      await expect(dialog(page)).toContainText(
        "Enter a name for the workflow.",
      );
      expect(seen.created).toHaveLength(0);
    });
  });
}
