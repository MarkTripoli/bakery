import { expect as baseExpect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  CONVERSATION_ID,
  ROOT,
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
const ANA_ID = "00000000-0000-4000-8000-0000000000b2";

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
            authorId: ANA_ID,
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
    (route) =>
      route.fulfill({
        json: {
          items: [{
            principalId: ANA_ID,
            principalType: "human",
            displayName: GRANTER,
          }],
          nextCursor: null,
        },
      }),
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
      const { reads } = await stubNotification(
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
      await expect(body).not.toContainText("00000000-0000-4000");
      await expect(body).not.toContainText("2026-01-01T");
      await expect(body.getByText("Outdated")).toHaveCount(1);
      await expect(body.getByRole("button", { name: "Resolve" })).toHaveCount(
        0,
      );
      await expect(body.getByRole("link", { name: "Open original version" }))
        .toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open task" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("link", { name: "View details" }))
        .toHaveCount(0);
      await openSharedComments(page);
      const thread = page.locator(`#comment-${COMMENT_ID}`);
      await expect(thread).toHaveAttribute("data-landed", "true");
      await expect.poll(() => reads.length).toBe(1);
      await still(page, "shared-document", undefined, { scrollTo: thread });
    });

    test("a comment far down the rail is still in view once the landing is stripped from the address", async ({ page }) => {
      const fillers = Array.from({ length: 12 }, (_, index) => ({
        ...ROOT,
        id: `00000000-0000-4000-8000-0000000002${
          String(index).padStart(2, "0")
        }`,
        body: `Earlier comment ${index + 1}`,
      }));
      await stubArtifactPage(page, {
        roots: [...fillers, {
          ...ROOT,
          body: "The comment you were mentioned in",
        }],
      });
      const { reads } = await stubNotification(
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
      await openSharedComments(page);
      const thread = page.locator(`#comment-${COMMENT_ID}`);
      await expect(thread).toHaveAttribute("data-landed", "true");
      await expect.poll(() => reads.length).toBe(1);
      await expect(page).not.toHaveURL(/[?&]n=/);
      await expect(thread).toBeInViewport();
    });

    test("a part that is gone is said once, folded into the page's own notice, on both shared pages", async ({ page }) => {
      await stubArtifactPage(page);
      await stubNotification(
        page,
        {
          status: "part_unavailable",
          targetKind: "comment",
          path: `${DOCUMENT_PATH}?version=${VERSION_ID}&comment=${COMMENT_ID}`,
          anchor: null,
          sharedByName: GRANTER,
          sharedAt: SHARED_AT,
        },
        { taskId: TASK_ID, targetId: COMMENT_ID },
      );
      await open(page);
      const document = page.getByTestId("shared-document-page");
      await expect(document).toContainText(
        "The part this notification was about is no longer here. You can read this document and comment on it.",
      );
      await expect(document.getByText("The part this notification was about"))
        .toHaveCount(1);
      await expect(
        page.getByText("This comment was not found in this artifact."),
      ).toHaveCount(0);
    });

    test("a conversation whose message is gone says so once", async ({ page }) => {
      await conversationWorld(page);
      await stubNotification(
        page,
        {
          status: "part_unavailable",
          targetKind: "conversation_message",
          path: `${CONVERSATION_PATH}?message=${MESSAGE_ID}`,
          anchor: null,
        },
        { taskId: TASK_ID, targetId: MESSAGE_ID, title: MENTIONED },
      );
      await open(page);
      const body = page.getByTestId("shared-conversation-page");
      await expect(body).toContainText(
        "The part this notification was about is no longer here. You can read and reply in this conversation.",
      );
      await expect(body.getByText("The part this notification was about"))
        .toHaveCount(1);
    });

    test("Send stays on with nothing typed: pressing it says what is missing and focuses the box", async ({ page }) => {
      await conversationWorld(page);
      const sent: unknown[] = [];
      await page.route(
        `**/v1/conversations/${CONVERSATION_ID}/messages`,
        (route) => {
          if (route.request().method() === "POST") {
            sent.push(route.request().postDataJSON());
            return route.fulfill({ status: 500, json: {} });
          }
          return route.fallback();
        },
      );
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
      const send = page.getByRole("button", { name: "Send" });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(page.getByText("Write a message first.")).toBeVisible();
      await expect(page.getByRole("textbox", { name: /Reply/ })).toBeFocused();
      expect(sent).toHaveLength(0);
      await page.keyboard.type("Thanks");
      await expect(page.getByText("Write a message first.")).toHaveCount(0);
    });

    test("Mark read that could not be saved says so", async ({ page }) => {
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
      await page.route(
        (url) => url.pathname === `/v1/notifications/${NOTIFICATION_ID}`,
        (route) =>
          route.request().method() === "PATCH"
            ? route.fulfill({
              status: 500,
              json: { type: "about:blank", title: "Failed", status: 500 },
            })
            : route.fallback(),
      );
      await page.goto(opened(DOCUMENT_PATH));
      await page.getByRole("button", { name: "Mark read" }).click();
      await expect(page.getByRole("alert")).toContainText(
        "That could not be saved. Try again.",
      );
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toBeVisible();
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
      await expect(body.locator("[data-message-id]")).toContainText(GRANTER);
      await expect(body.locator("[data-message-id]")).not.toContainText("You");
      await expect(page.getByRole("link", { name: "Open task" })).toHaveCount(
        0,
      );
      await still(page, "shared-conversation");
    });

    test("a document that was deleted names who shared it and offers the way back and a read mark", async ({ page }) => {
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
      await expect(page.getByRole("button", { name: "Back to notifications" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toBeVisible();
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
      await expect(page.getByRole("button", { name: "Back to notifications" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toBeVisible();
      await still(page, "shared-no-longer-shared");
    });

    for (
      const [reason, title, description] of [
        [
          "gone",
          "This document was deleted",
          "Ana Duarte or someone on the task removed it. Nothing here can be opened.",
        ],
        [
          "no_longer_shared",
          "This document is no longer shared with you",
          "Ask Ana Duarte if you still need it.",
        ],
        [
          "unknown",
          "This is no longer available",
          "It was deleted, or it is no longer shared with you.",
        ],
      ] as const
    ) {
      test(`opening a row whose document is ${reason} says so and reads nothing until asked`, async ({ page }) => {
        await mockAuthenticatedSession(page);
        const { reads } = await stubNotification(
          page,
          {
            status: "unavailable",
            targetKind: "comment",
            path: null,
            anchor: null,
            reason,
            ...(reason === "unknown" ? {} : { sharedByName: GRANTER }),
          },
          { taskId: TASK_ID, targetId: COMMENT_ID },
        );
        await open(page);
        const body = page.getByTestId(`shared-unavailable-${reason}`);
        await expect(body).toContainText(title);
        await expect(body).toContainText(
          reason === "unknown"
            ? description
            : description.replace("Ana Duarte", GRANTER),
        );
        await expect(page).toHaveURL(/\/notifications\?open=/);
        expect(reads).toHaveLength(0);
        await page.getByRole("button", { name: "Mark read" }).click();
        await expect.poll(() => reads.length).toBe(1);
        await still(page, `opening-${reason}`);
        await page.getByRole("button", { name: "Back to notifications" })
          .click();
        await expect(page).toHaveURL(/\/notifications$/);
      });
    }

    test("a shared document opened without its row is safely unavailable and reads nothing", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await page.route("**/v1/artifacts/**", (route) =>
        route.fulfill({
          status: 403,
          json: { type: "about:blank", title: "Forbidden", status: 403 },
        }));
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(DOCUMENT_PATH);
      const body = page.getByTestId("shared-unavailable-unknown");
      await expect(body).toContainText("This is no longer available");
      await expect(body).not.toContainText("Ana Duarte");
      await expect(page.getByRole("button", { name: "Mark read" }))
        .toHaveCount(0);
      expect(
        requests.filter((url) => /\/notifications\/[0-9a-f-]{36}/.test(url)),
      ).toHaveLength(0);
    });

    test("a comment that is not there says the part is gone and marks the row read once the search ends", async ({ page }) => {
      await stubArtifactPage(page);
      const { reads } = await stubNotification(
        page,
        {
          status: "available",
          targetKind: "comment",
          path:
            `${DOCUMENT_PATH}?version=${VERSION_ID}&comment=00000000-0000-4000-8000-0000000009ff`,
          anchor: null,
          sharedByName: GRANTER,
          sharedAt: SHARED_AT,
        },
        { taskId: TASK_ID, targetId: COMMENT_ID },
      );
      await open(page);
      await openSharedComments(page);
      await expect(
        page.getByText("This comment was not found in this artifact."),
      ).toBeVisible();
      await expect.poll(() => reads.length).toBe(1);
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
