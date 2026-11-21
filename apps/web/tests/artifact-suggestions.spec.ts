import { expect, type Page, test } from "@playwright/test";
import { openEditor } from "./helpers/artifact-edit-world.ts";
import { still } from "./helpers/stills.ts";

const TEXT = "Hello brave new world";
const card = (page: Page, summary: RegExp | string) =>
  page.getByRole("article", { name: summary });
/** The visible result line; it is the live region for the result sentence. */
const noticeText = (scope: Page | ReturnType<Page["locator"]>, text: string) =>
  scope.locator(".ui-inline-notice__content", { hasText: text });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 744;

/** The list: in the side column from 744px, behind the Suggestions button below it. */
async function showList(page: Page) {
  if (isPhone(page)) {
    await page.getByTestId("suggestions-open").click();
    return page.getByRole("dialog").getByTestId("draft-suggestions");
  }
  return page.getByTestId("draft-suggestions");
}
const three = [
  { from: 0, to: 5, replacement: "Hi" },
  { from: 6, to: 11, replacement: "bold" },
  { from: 16, to: 21, replacement: "planet" },
];

test.describe("Agent suggestions on a draft", () => {
  test("each kind of change reads as itself, in the order of the text", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [
        {
          from: 16,
          to: 21,
          replacement: "planet",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        { from: 12, to: 16, replacement: "" },
        { from: 5, to: 5, replacement: "," },
        {
          from: 6,
          to: 11,
          replacement: "bold",
          agentName: null,
          requestedByName: "",
        },
      ],
    });
    const section = await showList(page);
    await expect(page.getByRole("heading", { name: "Suggestions (4)" }))
      .toBeVisible();
    const names = await section.getByRole("article").evaluateAll((els) =>
      els.map((el) =>
        el.querySelector("h3")?.textContent + " | " +
        el.querySelector("p")?.textContent
      )
    );
    expect(names).toEqual([
      "Suggested by review-agent | Add “,”",
      "Suggested by an agent | Replace “brave” with “bold”",
      "Suggested by review-agent | Remove “new ”",
      "Suggested by review-agent | Replace “world” with “planet”",
    ]);
    await expect(section.getByText(/^Asked by Review agent · /).first())
      .toBeVisible();
    await still(page, "suggestions-list", section);
  });

  test("from 744px the cards sit beside the text, above Comments", async ({ page }) => {
    test.skip(isPhone(page), "a phone opens them in a sheet");
    await openEditor(page, TEXT, { suggestionList: three });
    const host = page.getByTestId("artifact-suggestions-host");
    await expect(host.getByRole("heading", { name: "Suggestions (3)" }))
      .toBeVisible();
    const editor = await page.getByRole("textbox", { name: "Document text" })
      .boundingBox();
    const cards = await host.boundingBox();
    expect(cards!.x).toBeGreaterThan(editor!.x + editor!.width - 1);
    // Comments come after the suggestions in the same column.
    const comments = await page.getByRole("heading", { name: "Comments" })
      .first().boundingBox();
    expect(comments!.y).toBeGreaterThan(cards!.y);
    await still(page, "suggestions-beside-text");
  });

  test("on a phone a Suggestions button opens a sheet and choosing a card closes it", async ({ page }) => {
    test.skip(!isPhone(page), "wider screens show them beside the text");
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
    await expect(page.getByTestId("draft-suggestions")).toHaveCount(0);
    await page.getByTestId("suggestions-open").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "Suggestions (1)" }))
      .toBeVisible();
    await still(page, "suggestions-sheet");
    await card(page, /Replace “brave”/).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".ui-document-editor__suggested")).toHaveText(
      "brave",
    );
  });

  test("choosing a card tints and brings into view the text it points at", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
    await showList(page);
    await expect(page.locator(".ui-document-editor__suggested")).toHaveCount(0);
    await card(page, /Replace “brave”/).click();
    await expect(page.locator(".ui-document-editor__suggested")).toHaveText(
      "brave",
    );
    await still(page, "suggestions-selected");
    if (!isPhone(page)) {
      // Choosing it again lets go.
      await card(page, /Replace “brave”/).click();
      await expect(page.locator(".ui-document-editor__suggested")).toHaveCount(
        0,
      );
    }
  });

  test("a long suggestion is clamped and can be shown whole", async ({ page }) => {
    const long = "very ".repeat(60).trim();
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: long }],
    });
    await showList(page);
    const clamped = card(page, /Replace “brave”/);
    await still(page, "suggestions-long-clamped", clamped);
    await clamped.getByRole("button", { name: "Show all" }).click();
    await expect(clamped.getByRole("button", { name: "Show less" }))
      .toBeVisible();
    await still(page, "suggestions-long-whole", clamped);
  });

  test("Accept applies it as a decision and the card leaves", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
    await showList(page);
    await card(page, /Replace “brave”/).getByRole("button", { name: "Accept" })
      .click();
    await expect(page.getByTestId("draft-suggestions")).toHaveCount(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("accept");
  });

  test("Reject leaves at once, without asking", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
    await showList(page);
    await card(page, /Replace “brave”/).getByRole("button", { name: "Reject" })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByTestId("draft-suggestions")).toHaveCount(0);
    expect(decisions[0].action).toBe("reject");
  });

  test("a suggestion that no longer fits can only be rejected, and says why", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [
        {
          from: 6,
          to: 11,
          replacement: "bold",
          state: "no_longer_fits",
          refusalReason: "text_changed",
        },
        {
          from: 16,
          to: 21,
          replacement: "planet",
          state: "no_longer_fits",
          refusalReason: "draft_moved_on",
        },
      ],
    });
    const section = await showList(page);
    const first = card(page, /Replace “brave”/);
    await expect(
      first.getByText("This no longer fits the text. Ask the agent again."),
    ).toBeVisible();
    await expect(first.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Reject" })).toBeVisible();
    await expect(
      card(page, /Replace “world”/).getByText(
        "A new version was published since this was suggested. Ask the agent again.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-no-longer-fits", section);
  });

  test("an unknown outcome stays, is never shown as applied, and can be checked again", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{
        from: 6,
        to: 11,
        replacement: "bold",
        state: "unknown",
      }],
    });
    const section = await showList(page);
    const unknown = card(page, /Replace “brave”/);
    await expect(unknown.getByText("Could not tell whether this was applied."))
      .toBeVisible();
    await expect(unknown.getByRole("button", { name: "Accept" })).toHaveCount(
      0,
    );
    await expect(unknown.getByRole("button", { name: "Check again" }))
      .toBeVisible();
    await expect(unknown.getByRole("button", { name: "Reject" })).toBeVisible();
    await still(page, "suggestions-unknown", section);
  });

  test("a failed accept keeps the card and says so inside it", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      decide: "fail",
    });
    const section = await showList(page);
    const one = card(page, /Replace “brave”/);
    await one.getByRole("button", { name: "Accept" }).click();
    await expect(
      one.getByText("This suggestion could not be accepted. Try again."),
    ).toBeVisible();
    expect(decisions).toHaveLength(0);
    await still(page, "suggestions-failed", section);
  });

  test("three or more can be accepted together, after asking, and the result is said", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: three,
    });
    const section = await showList(page);
    await section.getByRole("button", { name: "Accept all" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Accept 3 suggestions?")).toBeVisible();
    await expect(
      dialog.getByText(
        "Each one is applied to the document as your edit. Any that no longer fit are skipped.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-accept-all", dialog);
    await dialog.getByRole("button", { name: "Accept 3" }).click();
    await expect(noticeText(page, "Accepted 3 suggestions."))
      .toBeVisible();
    expect(decisions.map((entry) => entry.action)).toEqual([
      "accept",
      "accept",
      "accept",
    ]);
  });

  test("a run that stops at a failure says how far it got and leaves the rest", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: three,
      decideFailAfter: 1,
    });
    const section = await showList(page);
    await section.getByRole("button", { name: "Accept all" }).click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Accept 3",
    }).click();
    await expect(
      noticeText(
        section,
        "Accepted 1 of 3 suggestions. The rest were not changed.",
      ),
    ).toBeVisible();
    expect(decisions).toHaveLength(1);
    await expect(
      section.getByText("This suggestion could not be accepted. Try again."),
    ).toBeVisible();
    await still(page, "suggestions-stopped", section);
  });

  test("suggestions that no longer fit are skipped, not failed, and stay listed", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: three,
      acceptStates: ["accepted", "no_longer_fits", "accepted"],
    });
    const section = await showList(page);
    await section.getByRole("button", { name: "Accept all" }).click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Accept 3",
    }).click();
    await expect(
      noticeText(
        section,
        "Accepted 2 of 3 suggestions. 1 no longer fits the text and is still listed.",
      ),
    ).toBeVisible();
    expect(decisions).toHaveLength(3);
    await expect(
      card(page, /Replace “brave”/).getByText(
        "This no longer fits the text. Ask the agent again.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-skipped", section);
  });

  test("what arrives later is announced once, politely", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      arrivals: [{ from: 16, to: 21, replacement: "planet" }],
    });
    const section = await showList(page);
    await expect(card(page, /Replace “brave”/)).toBeVisible();
    // Coming back to the tab reads the list again, and one more suggestion is there.
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await expect(card(page, /Replace “world”/)).toBeVisible();
    const announcer = section.locator(".bakery-visually-hidden[role=status]");
    await expect(announcer).toHaveText("1 new suggestion");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
  });

  test("the result of Accept all is announced by one live region", async ({ page }) => {
    await openEditor(page, TEXT, { suggestionList: three });
    const section = await showList(page);
    await section.getByRole("button", { name: "Accept all" }).click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Accept 3",
    }).click();
    await expect(noticeText(page, "Accepted 3 suggestions.")).toBeVisible();
    // The visible line is the live region; the hidden one stays silent about it.
    await expect(
      page.getByRole("status").filter({ hasText: "Accepted 3 suggestions." }),
    ).toHaveCount(1);
  });

  test("Reject all asks with its own words", async ({ page }) => {
    await openEditor(page, TEXT, { suggestionList: three });
    const section = await showList(page);
    await section.getByRole("button", { name: "Reject all" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Reject 3 suggestions?")).toBeVisible();
    await expect(
      dialog.getByText(
        "They are removed from the list. The document does not change.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-reject-all", dialog);
  });

  test("without the right to decide, no card offers Accept or Reject, and it is not an error", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      decide: "forbidden",
    });
    const section = await showList(page);
    await card(page, /Replace “brave”/).getByRole("button", { name: "Accept" })
      .click();
    await expect(
      section.getByText(
        "You cannot accept or reject suggestions in this document.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
    await still(page, "suggestions-no-right", section);
  });

  test("a list that cannot be read says so, with Try again, and never shows a count", async ({ page }) => {
    await openEditor(page, TEXT, { suggestionsRead: "fail" });
    const section = await showList(page);
    await expect(
      page.getByRole("heading", { name: "Suggestions", exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Suggestions could not be loaded."))
      .toBeVisible();
    await expect(section.getByRole("button", { name: "Try again" }))
      .toBeVisible();
    await expect(page.getByText("Suggestions (0)")).toHaveCount(0);
    await still(page, "suggestions-load-failed", section);
  });

  test("a refresh that fails keeps the cards and warns the list may be out of date", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      suggestionsRead: "fail-later",
    });
    const section = await showList(page);
    await expect(card(page, /Replace “brave”/)).toBeVisible();
    // Coming back to the tab reads the list again, and that read fails.
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await expect(section.getByText("This list may be out of date."))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Suggestions (1)" }))
      .toBeVisible();
    await expect(card(page, /Replace “brave”/)).toBeVisible();
    await expect(section.getByRole("button", { name: "Try again" }))
      .toBeVisible();
    await still(page, "suggestions-stale", section);
  });

  test("a list refused to this person shows nothing", async ({ page }) => {
    await openEditor(page, TEXT, { suggestionsRead: "forbidden" });
    await expect(page.getByTestId("draft-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("suggestions-open")).toHaveCount(0);
  });

  test("Publish still opens ready when the list cannot be read, and says nothing about suggestions", async ({ page }) => {
    await openEditor(page, TEXT, { suggestionsRead: "fail" });
    await page.getByTestId("artifact-publish").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Publish version 3" }))
      .toBeEnabled();
    await expect(dialog.getByText(/suggestion/i)).toHaveCount(0);
  });
});
