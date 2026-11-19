import { expect, test } from "@playwright/test";
import { baseURL } from "./storybook-harness.ts";

// The editor and the patched loro-codemirror binding, in a real browser. The two
// binding tests fail on the unpatched library (patches/loro-codemirror@0.3.3.patch):
// an edit made right after mount was never written to the shared document, and
// undo / redo threw from inside the editor's own update and left the editor
// showing text the document had already undone.
const story =
  `${baseURL}/iframe.html?id=bakery-molecules-documenteditor--contract&viewMode=story`;

test.describe("DocumentEditor", () => {
  test("is one named multi-line text field; empty shows its placeholder; read-only refuses typing", async ({ page }) => {
    await page.goto(story);
    const empty = page.getByRole("textbox", { name: "Empty document" });
    await expect(empty).toHaveAttribute("aria-multiline", "true");
    await expect(page.getByTestId("editor-empty")).toContainText(
      "Start writing. Everyone here sees it as you type.",
    );
    const text = page.getByRole("textbox", { name: "Document with text" });
    await text.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" More.");
    await expect(text).toContainText("flour every Monday. More.");

    const readOnly = page.getByRole("textbox", { name: "Read-only document" });
    await expect(readOnly).toHaveAttribute("aria-readonly", "true");
    await readOnly.click();
    await page.keyboard.type("nope");
    await expect(readOnly).toHaveText("Nobody can type here.");
  });

  test("an edit made right after mount reaches the shared document", async ({ page }) => {
    await page.goto(story);
    const restored = page.getByTestId("editor-restored");
    await expect(restored.getByRole("textbox")).toContainText("hello restored");
    // Unpatched, the editor shows it and the shared document keeps "hello".
    await expect(restored.getByTestId("shared-text")).toHaveText(
      "hello restored",
    );
  });

  test("a pasted or typed change is shared; undo and redo move the editor and the document together without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(story);
    const shared = page.getByTestId("editor-shared");
    const editor = shared.getByRole("textbox", {
      name: "Shared document text",
    });
    const sharedText = shared.getByTestId("shared-text");
    await editor.click();
    await page.keyboard.press("Control+End");
    // One input event inserting several characters, as a paste does: one undo step.
    await page.keyboard.insertText("abc");
    await expect(sharedText).toHaveText("helloabc");

    await page.keyboard.press("Control+z");
    await expect(sharedText).toHaveText("hello");
    // Unpatched, the document undoes it and the editor keeps showing "helloabc".
    await expect(editor).toHaveText("hello");

    await page.keyboard.press("Control+y");
    await expect(sharedText).toHaveText("helloabc");
    await expect(editor).toHaveText("helloabc");
    expect(errors).toEqual([]);
  });
});
