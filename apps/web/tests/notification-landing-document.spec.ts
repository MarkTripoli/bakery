import { expect as baseExpect, test } from "@playwright/test";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  openComments,
  stubArtifactPage,
  TASK_ID,
} from "./helpers/artifact-page-fixture.ts";
import {
  NOTIFICATION_ID as N,
  NOTIFICATION_REVISION as REVISION,
  openNotification as open,
  stubNotification,
} from "./helpers/notification-world.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

// These wait on a cold dev server and a redirect, which a loaded host slows.
const expect = baseExpect.configure({ timeout: 15_000 });

const path = `/tasks/${TASK_ID}/artifacts/${ARTIFACT_ID}`;

test.describe("Opening a notification about a document", () => {
  test("a version: that version opens, and the notification is read", async ({ page }) => {
    await stubArtifactPage(page);
    const { reads } = await stubNotification(
      page,
      {
        status: "available",
        targetKind: "document_version",
        path,
        anchor: "version:1",
      },
      { taskId: TASK_ID },
    );
    await open(page);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    // The current version is 2; the notification was about version 1.
    await expect(page.getByTestId("artifact-retrieval-page")).toContainText(
      "Version 1",
    );
    await expect.poll(() => reads).toEqual([{
      id: N,
      read: true,
      expectedCasVersion: REVISION,
    }]);
    await expect(
      page.getByRole("status").filter({
        hasText: "Opened from a notification.",
      }),
    ).toHaveCount(1);
    await still(page, "landing-version");
  });

  test("a comment: its thread is in view and outlined", async ({ page }) => {
    await stubArtifactPage(page);
    await stubNotification(
      page,
      {
        status: "available",
        targetKind: "comment",
        path,
        anchor: `comment:${COMMENT_ID}`,
      },
      { taskId: TASK_ID, targetId: COMMENT_ID },
    );
    await open(page);
    await openComments(page);
    const thread = page.locator(`#comment-${COMMENT_ID}`);
    await expect(thread).toHaveAttribute("data-landed", "true");
    expect(await thread.evaluate((el) => getComputedStyle(el).outlineOffset))
      .toBe("8px");
    // Hold the outline (it fades) and frame the still on the thread.
    await thread.evaluate((el) => el.setAttribute("data-landed", "true"));
    await still(page, "landing-comment", undefined, { scrollTo: thread });
  });

  test("a document part that is gone: the page says so", async ({ page }) => {
    await stubArtifactPage(page);
    const { reads } = await stubNotification(
      page,
      {
        status: "part_unavailable",
        targetKind: "comment",
        path,
        anchor: null,
      },
      { taskId: TASK_ID },
    );
    await open(page);
    // The same information notice the task page uses, not a card with a title.
    await expect(
      page.locator(".ui-inline-notice", {
        hasText: "The part this notification was about is no longer here.",
      }),
    ).toBeVisible();
    await expect.poll(() => reads.length).toBe(1);
    await still(page, "landing-document-part-gone");
  });
});
