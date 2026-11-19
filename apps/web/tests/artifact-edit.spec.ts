import { expect, test } from "@playwright/test";
import { BinaryFrameKind } from "../src/collaboration/binary-frame.ts";
import { DRAFT, openEditor } from "./helpers/artifact-edit-world.ts";
import { still } from "./helpers/stills.ts";

test.describe("Editing a document in place", () => {
  test("Edit opens the draft with the server's text; what is typed is sent and saved", async ({ page }) => {
    const { editor, updates } = await openEditor(page, "Hello world");
    // The page says this is the shared draft and what is published.
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Version 2 is published. Your team is editing the next one.",
      ),
    )
      .toBeVisible();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" there");
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    expect(updates[0].kind).toBe(BinaryFrameKind.ClientUpdate);
    expect(updates[0].draftId).toBe(DRAFT);
    await expect(editor).toContainText("Hello world there");
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.getByTestId("artifact-edit-toggle").click();
    await expect(editor).toHaveCount(0);
  });

  test("who is here and what they are doing sits above the editor", async ({ page }) => {
    await openEditor(page, "Hello", {
      participants: [{
        participantKey: "22222222-2222-4222-8222-222222222222",
        principalId: "33333333-3333-4333-8333-333333333333",
        principalType: "human",
        displayName: "Ana Reyes",
        state: { activity: "active", typing: true, cursor: null },
        receivedAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    await expect(page.getByRole("group", { name: "People in this document" }))
      .toContainText("Ana Reyes is typing");
  });

  test("a change the server refuses is kept: a notice, the text in a sheet, and a confirmed discard", async ({ page }) => {
    const { editor } = await openEditor(page, "Hello world", {
      onUpdate: "reject",
    });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    await expect(page.getByText("Some of your changes could not be saved."))
      .toBeVisible();
    await page.getByRole("button", { name: "Show what I typed" }).click();
    const sheet = page.getByRole("dialog", { name: "Text that was not saved" });
    await expect(sheet).toContainText("!");
    await sheet.getByRole("button", { name: "Discard" }).click();
    const confirm = page.getByRole("alertdialog", {
      name: "Discard this text?",
    });
    await expect(confirm).toContainText("It was never saved.");
    await confirm.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("Some of your changes could not be saved."))
      .toHaveCount(0);
  });

  test("stopping with text the server has not acknowledged keeps it: Edit again offers it back", async ({ page }) => {
    const { editor, updates } = await openEditor(page, "Hello", {
      onUpdate: "ignore",
    });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(" kept text");
    await expect.poll(() => updates.length).toBe(1);
    await page.getByTestId("artifact-edit-toggle").click();
    await expect(editor).toHaveCount(0);
    await page.getByTestId("artifact-edit-toggle").click();
    await expect(page.getByText(/You have text from .* that was not saved\./))
      .toBeVisible();
    await page.getByRole("button", { name: "Review" }).click();
    await expect(
      page.getByRole("dialog", { name: "Text that was not saved" }),
    ).toContainText("kept text");
  });

  test("losing access with unsaved text shows the banner and the text, not a second notice", async ({ page }) => {
    const { editor, updates, serverSend, room } = await openEditor(
      page,
      "Hello",
      { onUpdate: "ignore" },
    );
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(" unsaved");
    await expect.poll(() => updates.length).toBe(1);
    serverSend({
      type: "resync_required",
      room,
      mutationId: updates[0].mutationId,
      reason: "rejected",
    });
    await expect(page.getByText("Some of your changes could not be saved."))
      .toBeVisible();
    serverSend({
      type: "problem",
      requestId: null,
      problem: {
        type: "https://bakery.dev/problems/auth_forbidden",
        title: "Forbidden",
        status: 403,
        detail: "No access.",
        code: "AUTH_FORBIDDEN",
        requestId: "11111111-1111-4111-8111-111111111112",
        retryable: false,
      },
    });
    await expect(page.getByText("Text you had not saved is below."))
      .toBeVisible();
    await expect(page.getByText("Some of your changes could not be saved."))
      .toHaveCount(0);
    // The page shows the text once; the closed sheet holds a hidden copy.
    await expect(
      page.getByText("unsaved", { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
  });

  test("losing access says so and leaves the editor read-only", async ({ page }) => {
    const { editor, serverSend } = await openEditor(page, "Hello");
    serverSend({
      type: "problem",
      requestId: null,
      problem: {
        type: "https://bakery.dev/problems/auth_forbidden",
        title: "Forbidden",
        status: 403,
        detail: "No access.",
        code: "AUTH_FORBIDDEN",
        requestId: "11111111-1111-4111-8111-111111111112",
        retryable: false,
      },
    });
    await expect(
      page.getByText("You no longer have access to edit this document."),
    )
      .toBeVisible();
    await expect(editor).toHaveAttribute("aria-readonly", "true");
    // Nothing was unsaved, so the banner does not point below; nothing will
    // save any more, so the save state is gone.
    await expect(page.getByText("Text you had not saved is below."))
      .toHaveCount(0);
    await expect(page.getByText("All changes saved")).toHaveCount(0);
    await expect(page.getByText("Not saved. Reconnecting…")).toHaveCount(0);
  });
  test("Publish says what the version will hold, publishes once and offers the version", async ({ page }) => {
    let release: () => void = () => {};
    const holdRead = new Promise<void>((resolve) => (release = resolve));
    const { publishes } = await openEditor(page, "Hello world", { holdRead });
    await still(page, "publish-header");
    await page.getByTestId("artifact-publish").click();
    // While the text is read the dialog is already up and cannot publish yet.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Publish version 3?")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Publish version 3" }))
      .toBeDisabled();
    await still(page, "publish-dialog-reading", dialog);
    release();
    await expect(
      dialog.getByText(
        "Version 3 will contain the document exactly as it is now.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Version 2 and its comments are kept and cannot change.",
      ),
    ).toBeVisible();
    await still(page, "publish-dialog-ready", dialog);
    await dialog.getByRole("button", { name: "Publish version 3" }).click();
    await expect(page.getByText("Version 3 published.")).toBeVisible();
    await expect(page.getByRole("link", { name: "View version 3" }))
      .toBeVisible();
    await still(page, "publish-success");
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toMatchObject({
      checkpointId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      textDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The page stays in the draft; nobody is told twice about this version.
    await expect(page.getByRole("textbox", { name: "Document text" }))
      .toBeVisible();
    await expect(page.getByText("published version 3")).toHaveCount(0);
    // The line under the title moves on to the version just published.
    await expect(
      page.getByText(
        "Version 3 is published. Your team is editing the next one.",
      ),
    ).toBeVisible();
  });

  test("waiting agent suggestions are counted in the dialog and left out", async ({ page }) => {
    await openEditor(page, "Hello", { suggestions: 2 });
    await page.getByTestId("artifact-publish").click();
    const dialog = page.getByRole("alertdialog");
    await expect(
      dialog.getByText(
        "2 agent suggestions are not accepted. They are left out of version 3 and stay in the draft.",
      ),
    ).toBeVisible();
    await still(page, "publish-dialog-suggestions", dialog);
    // Publishing is still allowed.
    await expect(dialog.getByRole("button", { name: "Publish version 3" }))
      .toBeEnabled();
  });

  test("a checkpoint that moved under the same text is published once more, silently", async ({ page }) => {
    const { publishes } = await openEditor(page, "Hello", {
      publish: ["moved", "ok"],
    });
    await page.getByTestId("artifact-publish").click();
    await page.getByRole("button", { name: "Publish version 3" }).click();
    await expect(page.getByText("Version 3 published.")).toBeVisible();
    expect(publishes).toHaveLength(2);
  });

  test("a text that changed is not published: the dialog says so and the next press takes it", async ({ page }) => {
    const { publishes } = await openEditor(page, "Hello", {
      publish: ["moved", "ok"],
      textMoves: true,
    });
    await page.getByTestId("artifact-publish").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Publish version 3" }).click();
    await expect(
      dialog.getByText(
        "The document changed while this was open. Nothing was published. Check the text, then publish again.",
      ),
    ).toBeVisible();
    await still(page, "publish-dialog-moved", dialog);
    expect(publishes).toHaveLength(1);
    await expect(page.getByText("Version 3 published.")).toHaveCount(0);
    // Publish enabled for the text as it is now: the next press publishes it.
    await dialog.getByRole("button", { name: "Publish version 3" }).click();
    await expect(page.getByText("Version 3 published.")).toBeVisible();
    expect(publishes).toHaveLength(2);
    expect(publishes[1]).not.toEqual(publishes[0]);
  });

  test("a lost answer is checked, never published a second time", async ({ page }) => {
    const { publishes, lookups } = await openEditor(page, "Hello", {
      publish: ["lost"],
      lookup: "absent",
    });
    await page.getByTestId("artifact-publish").click();
    await page.getByRole("button", { name: "Publish version 3" }).click();
    await expect(page.getByText("Version 3 may not have been published."))
      .toBeVisible();
    await still(page, "publish-unknown");
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText(/Version 3 was not published/)).toBeVisible();
    expect(lookups).toHaveLength(1);
    expect(publishes).toHaveLength(1);
  });

  test("checking again finds the version that was published after all", async ({ page }) => {
    const { publishes, lookups } = await openEditor(page, "Hello", {
      publish: ["lost"],
      lookup: "found",
    });
    await page.getByTestId("artifact-publish").click();
    await page.getByRole("button", { name: "Publish version 3" }).click();
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText("Version 3 published.")).toBeVisible();
    expect(lookups).toHaveLength(1);
    expect(publishes).toHaveLength(1);
  });

  test("people who cannot publish see why instead of a button", async ({ page }) => {
    await openEditor(page, "Hello", { canPublish: false });
    await expect(page.getByTestId("artifact-publish")).toHaveCount(0);
    await expect(
      page.getByText(
        "You cannot publish this document. Ask an organization administrator.",
      ),
    ).toBeVisible();
    await still(page, "publish-no-right");
  });

  test("Publish waits while this person's changes are not saved", async ({ page }) => {
    const { editor } = await openEditor(page, "Hello", { onUpdate: "ignore" });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    const publish = page.getByTestId("artifact-publish");
    await expect(publish).toBeDisabled();
    // The button keeps its own width; the hint under it does not stretch it.
    expect((await publish.boundingBox())?.width ?? 0).toBeLessThan(160);
    await expect(page.getByText("Publish when your changes are saved."))
      .toBeVisible();
    await still(page, "publish-unsaved");
  });
});
