import { expect as baseExpect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  CONVERSATION_ID,
  stubArtifactPage,
  VERSION_ID,
} from "./helpers/artifact-page-fixture.ts";
import {
  NOTIFICATION_ID,
  NOTIFICATION_REVISION,
  openNotification as open,
  stubNotification,
} from "./helpers/notification-world.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const expect = baseExpect.configure({ timeout: 15_000 });

const TASK_ID = "00000000-0000-4000-8000-000000000101";
const GRANTER = "Ana Duarte";
const SHARED_AT = "2026-02-03T09:15:00.000Z";
const DOCUMENT_PATH = `/shared/documents/${ARTIFACT_ID}`;
const CONVERSATION_PATH = `/shared/conversations/${CONVERSATION_ID}`;
const MENTIONED = "Ana Duarte mentioned you";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000001a1";

const opened = (path: string) =>
  `${path}?n=${NOTIFICATION_ID}&r=${NOTIFICATION_REVISION}`;

async function conversationWorld(page: Page) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/conversations/${CONVERSATION_ID}/messages*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{
            id: MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            authorId: "00000000-0000-4000-8000-000000000001",
            agentSessionId: null,
            messageType: "user",
            body: "Refund policy: the draft is in the task.",
            clientMessageId: "client-1",
            replyToId: null,
            createdAt: SHARED_AT,
            updatedAt: SHARED_AT,
            version: 1,
            sequence: "1",
            intent: "discussion",
            commentContext: null,
          }],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/conversations/${CONVERSATION_ID}/participants*`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/v1/sync*", (route) =>
    route.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: null,
        resetRequired: false,
      },
    }));
}

async function openSharedComments(page: Page) {
  const panel = page.getByRole("button", { name: /^Show comments/ });
  if (await panel.isVisible()) await panel.click();
  await expect(page.getByLabel("Comment", { exact: true })).toBeVisible();
}

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: a landing for someone with only a grant`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a document grant opens the document, says who shared it, and outlines the comment", async ({ page }) => {
      await stubArtifactPage(page);
      await stubNotification(
        page,
        {
          status: "available",
          targetKind: "comment",
          path: `${DOCUMENT_PATH}?version=${VERSION_ID}&comment=${COMMENT_ID}`,
          anchor: `comment:${COMMENT_ID}`,
          sharedByName: GRANTER,
          sharedAt: SHARED_AT,
        },
        { taskId: TASK_ID, targetId: COMMENT_ID },
      );
      await open(page);
      await expect(page).toHaveURL(
        new RegExp(DOCUMENT_PATH.replaceAll("/", "\\/")),
      );
      const body = page.getByTestId("shared-document-page");
      await expect(body).toContainText("Reviewable artifact");
      await expect(body).toContainText(
        "Ana Duarte shared this document with you on Feb 3, 2026.",
      );
      await expect(body).toContainText(
        "You can read this document and comment on it. The rest of the task is not shared with you.",
      );
      await expect(page.getByRole("link", { name: "Open task" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("link", { name: "View details" }))
        .toHaveCount(0);
      await openSharedComments(page);
      const thread = page.locator(`#comment-${COMMENT_ID}`);
      await expect(thread).toHaveAttribute("data-landed", "true");
      await thread.evaluate((el) => el.setAttribute("data-landed", "true"));
      await still(page, "shared-document", undefined, { scrollTo: thread });
    });

    test("a conversation grant takes the notification's own title and replies in it", async ({ page }) => {
      await conversationWorld(page);
      await stubNotification(
        page,
        {
          status: "available",
          targetKind: "conversation_message",
          path: `${CONVERSATION_PATH}?message=${MESSAGE_ID}`,
          anchor: `message:${MESSAGE_ID}`,
        },
        { taskId: TASK_ID, targetId: MESSAGE_ID, title: MENTIONED },
      );
      await open(page);
      await expect(page).toHaveURL(
        new RegExp(CONVERSATION_PATH.replaceAll("/", "\\/")),
      );
      const body = page.getByTestId("shared-conversation-page");
      await expect(body).toContainText(MENTIONED);
      await expect(body).toContainText(
        "You can read and reply in this conversation. The rest of this task is not shared with you.",
      );
      await expect(body).toContainText(
        "Refund policy: the draft is in the task.",
      );
      await expect(body).not.toContainText("A conversation");
      await expect(page.getByRole("link", { name: "Open task" })).toHaveCount(
        0,
      );
      await still(page, "shared-conversation");
    });

    test("a document that was deleted names who shared it and offers the way back", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await page.route("**/v1/artifacts/**", (route) =>
        route.fulfill({
          status: 404,
          json: { type: "about:blank", title: "Not found", status: 404 },
        }));
      await stubNotification(
        page,
        {
          status: "unavailable",
          targetKind: "comment",
          path: null,
          anchor: null,
          reason: "gone",
          sharedByName: GRANTER,
        },
        { taskId: TASK_ID, targetId: COMMENT_ID },
      );
      await page.goto(opened(DOCUMENT_PATH));
      const body = page.getByTestId("shared-unavailable-gone");
      await expect(body).toContainText("This document was deleted");
      await expect(body).toContainText(
        "Ana Duarte or someone on the task removed it. Nothing here can be opened.",
      );
      await expect(page.getByRole("button", { name: "Back to inbox" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toHaveCount(0);
      await still(page, "shared-gone");
    });

    test("a grant that ended names the person to ask and still marks the row read", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await page.route("**/v1/artifacts/**", (route) =>
        route.fulfill({
          status: 403,
          json: { type: "about:blank", title: "Forbidden", status: 403 },
        }));
      await stubNotification(
        page,
        {
          status: "unavailable",
          targetKind: "comment",
          path: null,
          anchor: null,
          reason: "no_longer_shared",
          sharedByName: GRANTER,
        },
        { taskId: TASK_ID, targetId: COMMENT_ID },
      );
      await page.goto(opened(DOCUMENT_PATH));
      const body = page.getByTestId("shared-unavailable-no_longer_shared");
      await expect(body).toContainText(
        "This document is no longer shared with you",
      );
      await expect(body).toContainText("Ask Ana Duarte if you still need it.");
      await expect(page.getByRole("button", { name: "Back to inbox" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toBeVisible();
      await still(page, "shared-no-longer-shared");
    });
  });
}

test("an old row with no reason says only what the resolver could say", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route("**/v1/artifacts/**", (route) =>
    route.fulfill({
      status: 404,
      json: { type: "about:blank", title: "Not found", status: 404 },
    }));
  await stubNotification(
    page,
    {
      status: "unavailable",
      targetKind: "comment",
      path: null,
      anchor: null,
    },
    { taskId: TASK_ID, targetId: COMMENT_ID },
  );
  await page.goto(opened(DOCUMENT_PATH));
  const body = page.getByTestId("shared-unavailable-unknown");
  await expect(body).toContainText("This is no longer available");
  await expect(body).toContainText(
    "It was deleted, or it is no longer shared with you.",
  );
  await still(page, "shared-unknown");
});

test("a shared conversation opened without its row carries no invented header", async ({ page }) => {
  await conversationWorld(page);
  await page.goto(CONVERSATION_PATH);
  const body = page.getByTestId("shared-conversation-page");
  await expect(body).toContainText(
    "You can read and reply in this conversation. The rest of this task is not shared with you.",
  );
  await expect(body).not.toContainText("A conversation");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
});
