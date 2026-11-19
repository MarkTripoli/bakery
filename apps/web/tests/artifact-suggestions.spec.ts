import { expect, type Page, test } from "@playwright/test";
import { openEditor } from "./helpers/artifact-edit-world.ts";
import { still } from "./helpers/stills.ts";

const TEXT = "Hello brave new world";
const card = (page: Page, summary: RegExp | string) =>
  page.getByRole("article", { name: summary });

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
          requestedByName: null,
        },
      ],
    });
    const section = page.getByTestId("draft-suggestions");
    await expect(section.getByRole("heading", { name: "Suggestions (4)" }))
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

  test("choosing a card tints and brings into view the text it points at", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
    await expect(page.locator(".ui-document-editor__suggested")).toHaveCount(0);
    await card(page, /Replace “brave”/).click();
    await expect(page.locator(".ui-document-editor__suggested")).toHaveText(
      "brave",
    );
    await still(page, "suggestions-selected");
    // Choosing it again lets go.
    await card(page, /Replace “brave”/).click();
    await expect(page.locator(".ui-document-editor__suggested")).toHaveCount(0);
  });

  test("Accept applies it as a decision and the card leaves", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
    });
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
    await still(
      page,
      "suggestions-no-longer-fits",
      page.getByTestId("draft-suggestions"),
    );
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
    const unknown = card(page, /Replace “brave”/);
    await expect(unknown.getByText("Could not tell whether this was applied."))
      .toBeVisible();
    await expect(unknown.getByRole("button", { name: "Accept" })).toHaveCount(
      0,
    );
    await expect(unknown.getByRole("button", { name: "Check again" }))
      .toBeVisible();
    await expect(unknown.getByRole("button", { name: "Reject" })).toBeVisible();
    await still(
      page,
      "suggestions-unknown",
      page.getByTestId("draft-suggestions"),
    );
  });

  test("a failed accept keeps the card and says so", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      decide: "fail",
    });
    await card(page, /Replace “brave”/).getByRole("button", { name: "Accept" })
      .click();
    await expect(
      page.getByText("This suggestion could not be accepted. Try again."),
    ).toBeVisible();
    await expect(card(page, /Replace “brave”/)).toBeVisible();
    expect(decisions).toHaveLength(0);
    await still(
      page,
      "suggestions-failed",
      page.getByTestId("draft-suggestions"),
    );
  });

  test("three or more can be accepted or rejected together, after asking", async ({ page }) => {
    const { decisions } = await openEditor(page, TEXT, {
      suggestionList: [
        { from: 0, to: 5, replacement: "Hi" },
        { from: 6, to: 11, replacement: "bold" },
        { from: 16, to: 21, replacement: "planet" },
      ],
    });
    await page.getByRole("button", { name: "Accept all" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Accept 3 suggestions?")).toBeVisible();
    await expect(
      dialog.getByText(
        "Each one is applied to the document as your edit. Any that no longer fit are skipped.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-accept-all", dialog);
    await dialog.getByRole("button", { name: "Accept 3" }).click();
    await expect(page.getByTestId("draft-suggestions")).toHaveCount(0);
    expect(decisions.map((entry) => entry.action)).toEqual([
      "accept",
      "accept",
      "accept",
    ]);
  });

  test("Reject all asks with its own words", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [
        { from: 0, to: 5, replacement: "Hi" },
        { from: 6, to: 11, replacement: "bold" },
        { from: 16, to: 21, replacement: "planet" },
      ],
    });
    await page.getByRole("button", { name: "Reject all" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Reject 3 suggestions?")).toBeVisible();
    await expect(
      dialog.getByText(
        "They are removed from the list. The document does not change.",
      ),
    ).toBeVisible();
    await still(page, "suggestions-reject-all", dialog);
  });

  test("without the right to decide, no card offers Accept or Reject", async ({ page }) => {
    await openEditor(page, TEXT, {
      suggestionList: [{ from: 6, to: 11, replacement: "bold" }],
      decide: "forbidden",
    });
    await card(page, /Replace “brave”/).getByRole("button", { name: "Accept" })
      .click();
    await expect(
      page.getByText(
        "You cannot accept or reject suggestions in this document.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
    await still(
      page,
      "suggestions-no-right",
      page.getByTestId("draft-suggestions"),
    );
  });
});
