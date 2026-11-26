import { expect, type Page, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { EDIT, skillEditorFixture } from "./helpers/skill-editor-fixture.ts";

registerPageHealth(test);

const EDITOR = `/library/skills/${EDIT.skill}/edit`;
const SKILL = `/library/skills/${EDIT.skill}`;

const decode = (value: unknown) =>
  Buffer.from(String(value), "base64").toString("utf8");

const rowMenu = async (page: Page, name: string, action: string) => {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("button", { name: action, exact: true }).click();
};

const openFile = async (page: Page, name: string) => {
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await expect(
    page.getByRole("textbox", { name: `Text of ${name}` }),
  ).toBeVisible();
};

const typeInto = async (page: Page, name: string, text: string) => {
  const box = page.getByRole("textbox", { name: `Text of ${name}` });
  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
};

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900, phone: false },
    { name: "phone", width: 390, height: 844, phone: true },
  ]
) {
  test.describe(`${viewport.name}: editing a skill`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the editor says what the draft is based on, groups its files and counts its size", async ({ page }) => {
      await skillEditorFixture(page);
      await page.goto(EDITOR);
      await expect(page.getByText("Draft · based on version 2")).toBeVisible();
      await expect(
        page.getByText(
          "Nothing changes for agents or workflows until you publish.",
        ),
      ).toBeVisible();
      const files = page.getByTestId("skill-editor-files");
      await expect(files.getByText("Instructions", { exact: true }))
        .toBeVisible();
      await expect(files.getByText("Other files", { exact: true }))
        .toBeVisible();
      await expect(files.getByRole("button", { name: "Open SKILL.md" }))
        .toBeVisible();
      await expect(files.getByRole("button", { name: "Open assets/logo.bin" }))
        .toBeVisible();
      await expect(page.getByTestId("skill-editor-size")).toHaveText(
        "0.0 of 10 MB · 3 of 256 files",
      );
      await expect(page.getByLabel("Instructions file")).toHaveValue(
        "SKILL.md",
      );
      await page.mouse.move(700, 700);
      await still(page, "skill-editor");
    });

    test("typing saves the file by itself, each save carrying the latest draft version", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await openFile(page, "SKILL.md");
      await typeInto(page, "SKILL.md", "First text");
      await expect(page.getByTestId("skill-editor-save")).toContainText(
        "Saved",
      );
      await typeInto(page, "SKILL.md", "Second text");
      await expect.poll(() =>
        calls.filter((call) => call.path.endsWith("/draft/files")).length
      ).toBe(2);
      const saves = calls.filter((call) => call.path.endsWith("/draft/files"));
      expect(saves.map((call) => call.ifMatch)).toEqual(['"v1"', '"v2"']);
      expect(decode(saves[0]!.body!.contentBase64)).toBe("First text");
      expect(decode(saves[1]!.body!.contentBase64)).toBe("Second text");
      expect(saves[0]!.body!.path).toBe("SKILL.md");
      expect(saves[0]!.body!.mediaType).toBe("text/markdown");
    });

    test("Add file refuses a name that differs only in capitals, then adds a runnable script", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Add file" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("File name").fill("skill.MD");
      await dialog.getByRole("button", { name: "Add file" }).click();
      await expect(dialog).toContainText(
        "A file with this name already exists.",
      );
      await dialog.getByLabel("File name").fill("scripts/check.sh");
      await dialog.getByRole("checkbox", { name: "This file can be run" })
        .check();
      await dialog.getByRole("button", { name: "Add file" }).click();
      await expect(dialog).toHaveCount(0);
      const save = calls.find((call) => call.path.endsWith("/draft/files"));
      expect(save!.body).toMatchObject({
        path: "scripts/check.sh",
        mediaType: "text/x-shellscript",
        isExecutable: true,
      });
      if (viewport.phone) {
        await expect(
          page.getByRole("textbox", { name: "Text of scripts/check.sh" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Back to files" }).click();
      }
      await expect(
        page.getByTestId("skill-editor-files").getByRole("button", {
          name: "Open scripts/check.sh",
        }),
      ).toBeVisible();
    });

    test("Remove is undone from the toast, and the instructions file is not removed", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await rowMenu(page, "SKILL.md", "Remove");
      await expect(page.getByText("Choose another instructions file first."))
        .toBeVisible();
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
      await rowMenu(page, "examples/good-answer.md", "Remove");
      await expect(page.getByTestId("skill-editor-removed")).toContainText(
        "Removed examples/good-answer.md.",
      );
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() =>
        calls.filter((call) => call.path.endsWith("/draft/files")).length
      ).toBe(1);
      const back = calls.find((call) => call.path.endsWith("/draft/files"));
      expect(back!.body!.path).toBe("examples/good-answer.md");
      expect(decode(back!.body!.contentBase64)).toBe(
        "A short, clear answer.\n",
      );
    });

    test("Rename moves the file in one step", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await openFile(page, "examples/good-answer.md");
      if (viewport.phone) {
        await page.getByRole("button", { name: "Back to files" }).click();
      }
      await rowMenu(page, "examples/good-answer.md", "Rename");
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("File name").fill("examples/best-answer.md");
      await dialog.getByRole("button", { name: "Rename" }).click();
      await expect(dialog).toHaveCount(0);
      const rename = calls.find((call) => call.path.endsWith("/files/rename"));
      expect(rename!.body).toMatchObject({
        path: "examples/good-answer.md",
        newPath: "examples/best-answer.md",
      });
      await expect(
        page.getByRole("textbox", { name: "Text of examples/best-answer.md" }),
      ).toBeFocused();
    });

    test("leaving with a file not saved yet asks, and Stay keeps the text", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(SKILL);
      await page.getByRole("button", { name: "Continue editing" }).click();
      await openFile(page, "SKILL.md");
      await typeInto(page, "SKILL.md", "Typed and left");
      await page.evaluate(() => history.back());
      const ask = page.getByRole("alertdialog");
      await expect(ask).toContainText("Leave the editor?");
      await expect(ask).toContainText(
        "What you just typed may not be saved yet.",
      );
      await ask.getByRole("button", { name: "Stay" }).click();
      await expect(page).toHaveURL(new RegExp(`${EDITOR}$`));
      await expect(page.getByTestId("skill-editor-save")).toContainText(
        "Saved",
      );
      expect(
        calls.some((call) =>
          decode(call.body?.contentBase64) ===
            "Typed and left"
        ),
      ).toBe(true);
    });

    test("after Publish the skill page shows the new version and no draft", async ({ page }) => {
      await skillEditorFixture(page);
      await page.goto(SKILL);
      await expect(page.getByText("Version 2").first()).toBeVisible();
      await page.getByRole("button", { name: "Continue editing" }).click();
      await page.getByRole("button", { name: "Publish" }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Publish",
      }).click();
      await expect(page).toHaveURL(new RegExp(`${SKILL}$`));
      await expect(page.getByRole("button", { name: "Edit", exact: true }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Continue editing" }))
        .toHaveCount(0);
      await expect(page.getByText("Version 3").first()).toBeVisible();
    });

    test("choosing a problem puts the caret on its line", async ({ page }) => {
      await skillEditorFixture(page, {
        files: [{ path: "SKILL.md", text: "one\ntwo\nthree\nfour\n" }],
        problems: [{
          file: "SKILL.md",
          line: 3,
          code: "missing_file",
          message: "Something on line three.",
        }],
      });
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await page.getByRole("button", {
        name: "SKILL.md · line 3: Something on line three.",
      }).click();
      const box = page.getByRole("textbox", { name: "Text of SKILL.md" });
      await expect(box).toBeFocused();
      await page.keyboard.type("HERE ");
      await expect(box).toContainText("HERE three");
    });

    test("changing the licence after a check keeps the result and says it is old", async ({ page }) => {
      await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByText("No problems found.")).toBeVisible();
      await page.getByRole("textbox", { name: "Licence" }).fill("MIT");
      await page.getByRole("textbox", { name: "Licence" }).blur();
      await expect(page.getByText("Checked before your last change."))
        .toBeVisible();
      await expect(page.getByText("No problems found.")).toBeVisible();
    });

    test("a file that is not text is replaced with a chosen one", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Open assets/logo.bin" }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Replace" }).click();
      await (await chooser).setFiles({
        name: "new.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([1, 2, 3]),
      });
      await expect.poll(() =>
        calls.find((call) => call.path.endsWith("/draft/files"))?.body
      ).toMatchObject({ path: "assets/logo.bin", contentBase64: "AQID" });
    });

    test("a skill published here says it was written here, with its licence", async ({ page }) => {
      const source = "00000000-0000-4000-8000-000000000799";
      await skillEditorFixture(page, { sourceId: source });
      await page.route(
        `**/v1/skill-sources/${source}`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: source,
              name: "Quarterly release notes",
              sourceType: "local_bundle",
              locator: `bakery://organizations/x/skills/${EDIT.skill}`,
              publisher: null,
              license: "MIT",
              lastCheckedAt: null,
              enabled: true,
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
              version: 1,
            }),
          }),
      );
      await page.goto(SKILL);
      await expect(page.getByText("Written here")).toBeVisible();
      await expect(page.getByText(/bakery:\/\//)).toHaveCount(0);
      await expect(page.getByText("MIT")).toBeVisible();
    });

    test("Publish checks first and, with problems, publishes nothing and moves focus to the list", async ({ page }) => {
      const { calls } = await skillEditorFixture(page, {
        problems: [
          {
            file: "SKILL.md",
            line: 3,
            code: "missing_file",
            message:
              'The instructions mention "examples/long.md", which is not in this skill.',
          },
          {
            file: null,
            line: null,
            code: "too_large",
            message: "This skill is larger than the limit of 10 MB.",
          },
        ],
      });
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Publish" }).click();
      const heading = page.getByText("Fix 2 problems to publish");
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      const list = page.getByTestId("skill-editor-problems");
      await expect(list).toContainText(
        'SKILL.md · line 3: The instructions mention "examples/long.md", which is not in this skill.',
      );
      await expect(list).toContainText(
        "The whole skill: This skill is larger than the limit of 10 MB.",
      );
      expect(calls.some((call) => call.path.endsWith("/publish"))).toBe(false);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await openFile(page, "SKILL.md");
      await typeInto(page, "SKILL.md", "Changed");
      await expect(page.getByTestId("skill-editor-save")).toContainText(
        "Saved",
      );
      if (viewport.phone) {
        await page.getByRole("button", { name: "Back to files" }).click();
      }
      await expect(page.getByText("Checked before your last change."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Check again" }))
        .toBeVisible();
      await still(page, "skill-editor-problems");
    });

    test("Publish with no problems asks first, then opens the skill with the new version in use", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Publish" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Publish version 3?");
      await expect(dialog).toContainText(
        "Agents that use this skill keep the version they have. To give them version 3, update each agent.",
      );
      await still(page, "skill-editor-publish");
      await dialog.getByRole("button", { name: "Publish" }).click();
      await expect(page).toHaveURL(new RegExp(`${SKILL}$`));
      await expect(page.getByTestId("skill-toast")).toContainText(
        "Published version 3. It is now the one in use.",
      );
      const publish = calls.find((call) => call.path.endsWith("/publish"));
      expect(publish!.ifMatch).toBe('"v1"');
    });

    test("a draft changed somewhere else keeps the typed text until the latest is loaded", async ({ page }) => {
      const fixture = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await openFile(page, "SKILL.md");
      fixture.failNextSaveWithConflict();
      await typeInto(page, "SKILL.md", "My unsaved text");
      const notice = page.getByTestId("skill-editor-conflict");
      await expect(notice).toContainText(
        "This draft was changed somewhere else, so your last change to SKILL.md was not saved.",
      );
      await expect(
        page.getByRole("textbox", { name: "Text of SKILL.md" }),
      ).toContainText("My unsaved text");
      await still(page, "skill-editor-conflict");
      await notice.getByRole("button", { name: "Load the latest" }).click();
      await expect(notice).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Text of SKILL.md" }),
      ).toContainText("Write in plain words.");
    });

    test("Discard changes asks, says what is lost, and removes the draft", async ({ page }) => {
      const { calls } = await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Discard changes" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Discard this draft?");
      await expect(dialog).toContainText(
        "Everything changed since version 2 is lost. Version 2 stays in use.",
      );
      await dialog.getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(new RegExp(`${SKILL}$`));
      const gone = calls.find((call) => call.method === "DELETE");
      expect(gone!.ifMatch).toBe('"v1"');
    });

    test("a draft never published says the skill stays with no version", async ({ page }) => {
      await skillEditorFixture(page, { baseRevision: null });
      await page.goto(EDITOR);
      await expect(page.getByText("Draft · not published yet")).toBeVisible();
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(page.getByRole("alertdialog")).toContainText(
        "The skill stays, with no version.",
      );
    });

    test("a skill with no draft offers to start one, and Edit says Continue editing once there is one", async ({ page }) => {
      const { calls } = await skillEditorFixture(page, { hasDraft: false });
      await page.goto(SKILL);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${EDITOR}$`));
      expect(calls.some((call) => call.path.endsWith("/draft"))).toBe(true);
      await page.goto(SKILL);
      await expect(
        page.getByRole("button", { name: "Continue editing" }),
      ).toBeVisible();
    });

    test("opening the editor with no draft says so and starts one on request", async ({ page }) => {
      await skillEditorFixture(page, { hasDraft: false });
      await page.goto(EDITOR);
      await expect(page.getByText("No draft is open")).toBeVisible();
      await page.getByRole("button", { name: "Start a draft" }).click();
      await expect(page.getByText("Draft · based on version 2")).toBeVisible();
    });

    test("someone who may not edit it is told so", async ({ page }) => {
      await skillEditorFixture(page, { draftStatus: 403 });
      await page.goto(EDITOR);
      await expect(page.getByText("You cannot edit this skill")).toBeVisible();
    });

    test("a skill shared by Bakery cannot be edited", async ({ page }) => {
      await skillEditorFixture(page, { scope: "global" });
      await page.goto(EDITOR);
      await expect(
        page.getByText("Skills shared by Bakery cannot be changed"),
      ).toBeVisible();
    });

    test("a draft with no files asks for the instructions first", async ({ page }) => {
      const { calls } = await skillEditorFixture(page, { files: [] });
      await page.goto(EDITOR);
      await expect(page.getByText("Start with the instructions")).toBeVisible();
      await expect(page.getByLabel("Instructions file")).toHaveCount(0);
      await still(page, "skill-editor-empty");
      await page.getByRole("button", { name: "Add SKILL.md" }).click();
      await expect.poll(() =>
        calls.some((call) => call.path.endsWith("/draft/files"))
      ).toBe(true);
      expect(calls.find((call) => call.path.endsWith("/draft/files"))!.body)
        .toMatchObject({ path: "SKILL.md", mediaType: "text/markdown" });
    });

    test("a file that is not text offers no editor", async ({ page }) => {
      await skillEditorFixture(page);
      await page.goto(EDITOR);
      await page.getByRole("button", { name: "Open assets/logo.bin" }).click();
      await expect(page.getByText("This file cannot be edited here."))
        .toBeVisible();
      await expect(page.getByTestId("skill-editor-text")).toHaveCount(0);
    });
  });
}

test.describe("New skill", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("asks who it is for and its name, makes the slug from the name, and opens an empty draft", async ({ page }) => {
    const { calls } = await skillEditorFixture(page);
    await page.goto("/library?tab=skills");
    await page.getByRole("button", { name: "New skill" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Organization" }))
      .toBeDisabled();
    await expect(dialog.getByRole("radio", { name: "Private" }))
      .toBeChecked();
    await expect(dialog).toContainText(
      "Only people who manage the Library can add organization skills.",
    );
    await dialog.getByRole("button", { name: "Create skill" }).click();
    await expect(dialog).toContainText("Give it a name.");
    await still(page, "skill-new");
    await dialog.getByLabel("Name").fill("Release checklist, v2!");
    await dialog.getByRole("button", { name: "Create skill" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/library/skills/${EDIT.created}/edit$`),
    );
    const created = calls.find((call) => call.path === "/v1/skills");
    expect(created!.body).toEqual({
      slug: "release-checklist-v2",
      name: "Release checklist, v2!",
      scope: "personal",
    });
    await expect(page.getByText("Start with the instructions")).toBeVisible();
  });

  test("an administrator may choose Organization, which is the default", async ({ page }) => {
    const { calls } = await skillEditorFixture(page, { role: "admin" });
    await page.goto("/library?tab=skills");
    await page.getByRole("button", { name: "New skill" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Organization" }))
      .toBeChecked();
    await dialog.getByLabel("Name").fill("Support macros");
    await dialog.getByRole("button", { name: "Create skill" }).click();
    await expect(page).toHaveURL(/\/edit$/);
    expect(calls.find((call) => call.path === "/v1/skills")!.body)
      .toMatchObject({
        scope: "organization",
      });
  });

  test("a name that is taken is said under the field and nothing opens", async ({ page }) => {
    await skillEditorFixture(page, { createStatus: 409 });
    await page.goto("/library?tab=skills");
    await page.getByRole("button", { name: "New skill" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("House style");
    await dialog.getByRole("button", { name: "Create skill" }).click();
    await expect(dialog).toContainText(
      "You already have a skill with this name here. Choose another.",
    );
    await expect(page).toHaveURL(/\/library\?tab=skills/);
  });
});
