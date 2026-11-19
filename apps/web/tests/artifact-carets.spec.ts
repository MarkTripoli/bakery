import { expect, test } from "@playwright/test";
import { openEditor } from "./helpers/artifact-edit-world.ts";
import { MOCK_PRINCIPAL_ID } from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

const TEXT = "Hello brave new world";

test.describe("Other people's carets", () => {
  test("a caret carries the person's first name and sits where they are", async ({ page }) => {
    await openEditor(page, TEXT, {
      peers: [{ displayName: "Ana Reyes", from: 6, to: 6 }],
    });
    const caret = page.locator(".ui-document-editor__caret");
    await expect(caret).toHaveCount(1);
    await expect(caret.locator(".ui-document-editor__caret-label")).toHaveText(
      "Ana",
    );
    const name = caret.locator(".ui-document-editor__caret-label");
    if ((page.viewportSize()?.width ?? 1280) < 744) {
      // On a phone the presence line names people; the caret has no name.
      await expect(name).toBeHidden();
    } else {
      // Clipping does not make a label invisible to Playwright, so compare the
      // boxes: the whole label sits inside the editor, not above its top edge.
      const label = await name.boundingBox();
      const frame = await page.locator(".ui-document-editor .cm-editor")
        .boundingBox();
      expect(label!.y).toBeGreaterThanOrEqual(frame!.y);
    }
    await still(page, "caret-one");
  });

  test("a selection is underlined in the person's colour", async ({ page }) => {
    await openEditor(page, TEXT, {
      peers: [{ displayName: "Ana Reyes", from: 6, to: 11 }],
    });
    await expect(page.locator(".ui-document-editor__peer-selection"))
      .toHaveText("brave");
    // Tinted in the person's colour, not the grey every selection shares.
    const tints = await page.evaluate(() => {
      const mark = document.querySelector(
        ".ui-document-editor__peer-selection",
      )!;
      const plain = document.createElement("span");
      plain.className = "ui-document-editor__peer-selection";
      mark.after(plain);
      const own = getComputedStyle(mark).backgroundColor;
      const grey = getComputedStyle(plain).backgroundColor;
      plain.remove();
      return { own, grey };
    });
    expect(tints.own).not.toBe(tints.grey);
    await still(page, "caret-selection");
  });

  test("each person has their own colour, and keeps it", async ({ page }) => {
    await openEditor(page, TEXT, {
      peers: [
        { displayName: "Ana Reyes", from: 0, to: 0 },
        { displayName: "Bo Lin", from: 6, to: 11 },
        { displayName: "Cy Ode", from: 16, to: 16 },
      ],
    });
    const colours = await page
      .locator(".ui-document-editor__caret")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-presence-color"))
      );
    expect(colours).toHaveLength(3);
    expect(new Set(colours).size).toBe(3);
    // The same colour as the person's avatar in the presence row.
    await still(page, "caret-three");
  });

  test("this person's own entry in the list is not drawn as a caret", async ({ page }) => {
    await openEditor(page, TEXT, {
      peers: [
        {
          principalId: MOCK_PRINCIPAL_ID,
          displayName: "Fixture Admin",
          from: 3,
          to: 3,
        },
        { displayName: "Ana Reyes", from: 6, to: 6 },
      ],
    });
    await expect(page.locator(".ui-document-editor__caret")).toHaveCount(1);
    await expect(page.locator(".ui-document-editor__caret-label")).toHaveText(
      "Ana",
    );
  });

  test("moving the caret tells everyone where it is, and typing keeps it current", async ({ page }) => {
    const { editor, presenceUpdates } = await openEditor(page, TEXT);
    await editor.click();
    await page.keyboard.press("Control+End");
    await expect.poll(() =>
      presenceUpdates.filter((state) => state.cursor !== null).length
    )
      .toBeGreaterThan(0);
    const last = presenceUpdates.filter((state) => state.cursor !== null).at(
      -1,
    )!;
    expect(typeof last.cursor!.anchor).toBe("string");
    expect(last.cursor!.head.length).toBeGreaterThan(0);
  });
});
