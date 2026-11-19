import { expect, test } from "@playwright/test";
import { BinaryFrameKind } from "../src/collaboration/binary-frame.ts";
import { DRAFT, openEditor } from "./helpers/artifact-edit-world.ts";

test.describe("Editing a document in place", () => {
  test("Edit opens the draft with the server's text; what is typed is sent and saved", async ({ page }) => {
    const { editor, updates } = await openEditor(page, "Hello world");
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
  });
});
