import { expect, test } from "@playwright/test";
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
    await expect(page.locator(`#comment-${COMMENT_ID}`)).toHaveAttribute(
      "data-landed",
      "true",
    );
    await still(page, "landing-comment");
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
    await expect(
      page.getByText("The part this notification was about is no longer here."),
    ).toBeVisible();
    await expect.poll(() => reads.length).toBe(1);
    await still(page, "landing-document-part-gone");
  });
});
