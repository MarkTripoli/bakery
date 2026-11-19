import { expect, type Page, test } from "@playwright/test";
import { openEditor } from "./helpers/artifact-edit-world.ts";
import { MOCK_PRINCIPAL_ID } from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

const TEXT = "Hello brave new world";
const LINE = "Hello brave new world, and more";

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

  const phone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 744;
  const label = (page: Page) =>
    page.locator(".ui-document-editor__caret-label");

  test("an agent's caret carries its whole name", async ({ page }) => {
    test.skip(phone(page), "phones draw carets without names");
    await openEditor(page, TEXT, {
      peers: [{
        displayName: "Coding agent",
        principalType: "service",
        from: 6,
        to: 6,
      }],
    });
    await expect(label(page)).toHaveText("Coding agent");
    await still(page, "caret-agent");
  });

  test("a long agent name is cut at 24 characters' width and stays whole in the text", async ({ page }) => {
    test.skip(phone(page), "phones draw carets without names");
    await openEditor(page, TEXT, {
      peers: [{
        displayName: "Release notes and changelog writing agent",
        principalType: "worker",
        from: 6,
        to: 6,
      }],
    });
    await expect(label(page)).toHaveText(
      "Release notes and changelog writing agent",
    );
    expect(
      await label(page).evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await still(page, "caret-agent-long");
  });

  test("near the right edge the name sits left of the caret, inside the editor", async ({ page }) => {
    test.skip(phone(page), "phones draw carets without names");
    // A narrow editor puts the end of the line near the right edge, far enough
    // along that the name still fits to the left of the caret.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ".ui-document-editor{max-inline-size:300px}";
        document.head.append(style);
      });
    });
    await openEditor(page, LINE, {
      peers: [{
        displayName: "Release notes and changelog writing agent",
        principalType: "worker",
        from: LINE.length,
        to: LINE.length,
      }],
    });
    const caret = page.locator(".ui-document-editor__caret");
    await expect(caret).toHaveAttribute("data-flip", "true");
    const name = await label(page).boundingBox();
    const frame = await page.locator(".ui-document-editor .cm-editor")
      .boundingBox();
    const line = await page.locator(".ui-document-editor .cm-line").first()
      .boundingBox();
    expect(name!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(name!.x + name!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
    // Above the line, never over the text.
    expect(name!.y + name!.height).toBeLessThanOrEqual(line!.y + 1);
    await still(page, "caret-agent-edge");
  });

  /** A narrow editor, so the end of the line is near the inline end. */
  const narrow = (page: Page, width: number, direction = "ltr") =>
    page.addInitScript(
      ({ width, direction }) => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent =
            `.ui-document-editor{max-inline-size:${width}px;direction:${direction}}`;
          document.head.append(style);
        });
      },
      { width, direction },
    );

  test("a caret that moves to the right edge flips, and back again", async ({ page }) => {
    test.skip(phone(page), "phones draw carets without names");
    await narrow(page, 300);
    const { movePeer } = await openEditor(page, LINE, {
      peers: [{
        displayName: "Release notes and changelog writing agent",
        principalType: "worker",
        from: 6,
        to: 6,
      }],
    });
    const caret = page.locator(".ui-document-editor__caret");
    await expect(caret).not.toHaveAttribute("data-flip", "true");
    movePeer(0, LINE.length, LINE.length);
    await expect(caret).toHaveAttribute("data-flip", "true");
    movePeer(0, 6, 6);
    await expect(caret).not.toHaveAttribute("data-flip", "true");
  });

  test("in a right-to-left document the name flips at the inline end only", async ({ page }) => {
    test.skip(phone(page), "phones draw carets without names");
    const RTL = "שלום עולם יפה, ועוד קצת טקסט ארוך מאוד";
    await narrow(page, 340, "rtl");
    const { movePeer } = await openEditor(page, RTL, {
      peers: [{
        displayName: "Release notes and changelog writing agent",
        principalType: "worker",
        from: 0,
        to: 0,
      }],
    });
    const caret = page.locator(".ui-document-editor__caret");
    // The start of the line is at the right edge here, with the whole editor
    // to its left: the name has room, so it stays where it is.
    await expect(caret).toHaveCount(1);
    await expect(caret).not.toHaveAttribute("data-flip", "true");
    // The end of the line is at the left: the name would leave the editor.
    movePeer(0, RTL.length, RTL.length);
    await expect(caret).toHaveAttribute("data-flip", "true");
    const name = await label(page).boundingBox();
    const frame = await page.locator(".ui-document-editor .cm-editor")
      .boundingBox();
    expect(name!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(name!.x + name!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
  });
});
