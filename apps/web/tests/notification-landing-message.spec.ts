import { expect as baseExpect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import {
  openNotification as open,
  stubNotification,
} from "./helpers/notification-world.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const expect = baseExpect.configure({ timeout: 15_000 });

const taskId = "00000000-0000-4000-8000-000000000012";
const conversationId = "00000000-0000-4000-8000-000000000006";
const principalId = "00000000-0000-4000-8000-000000000001";
const stamp = (sequence: number) =>
  `2026-01-01T00:${String(sequence % 60).padStart(2, "0")}:00.000Z`;

const task = {
  id: taskId,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId,
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: principalId,
  currentRunId: null,
  archivedAt: null,
  createdAt: stamp(0),
  updatedAt: stamp(0),
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
};

const messageId = (sequence: number) =>
  `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, "0")}`;
const message = (sequence: number, body: string) => ({
  id: messageId(sequence),
  conversationId,
  authorId: principalId,
  agentSessionId: null,
  messageType: "user",
  body,
  clientMessageId: `client-${sequence}`,
  replyToId: null,
  createdAt: stamp(sequence),
  updatedAt: stamp(sequence),
  version: 1,
  sequence: String(sequence),
  intent: "discussion",
  commentContext: null,
});

const OLDER_CURSOR = "older-page";
const newest = [30, 31, 32].map((n) => message(n, `Recent message ${n}`));
const older = [3, 4, 5].map((n) => message(n, `Earlier message ${n}`));

async function world(page: Page, anchor: string) {
  await mockAuthenticatedSession(page);
  const cursors: (string | null)[] = [];
  await page.route(
    `**/v1/tasks/${taskId}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/conversations/${conversationId}/messages*`,
    (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      cursors.push(cursor);
      return route.fulfill({
        json: cursor === OLDER_CURSOR
          ? { items: older, nextCursor: null }
          : { items: newest, nextCursor: OLDER_CURSOR },
      });
    },
  );
  for (
    const empty of [
      "**/v1/artifacts?*",
      "**/v1/questions?*",
      "**/v1/plan-revisions*",
      "**/v1/approvals*",
      `**/v1/conversations/${conversationId}/participants*`,
      `**/v1/conversations/${conversationId}/turns*`,
      "**/v1/coordination-plans*",
    ]
  ) {
    await page.route(
      empty,
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
  }
  await page.route("**/v1/sync*", (route) =>
    route.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: new URL(route.request().url()).searchParams.has("after")
          ? null
          : "cursor-0",
        resetRequired: false,
      },
    }));
  await stubNotification(page, {
    status: "available",
    targetKind: "conversation_message",
    path: `/tasks/${taskId}`,
    anchor,
  }, { taskId, targetId: anchor.slice("message:".length), title: task.title });
  return { cursors };
}

test("a mention of an earlier message loads the earlier messages and lands on it", async ({ page }) => {
  const { cursors } = await world(page, `message:${messageId(4)}`);
  await open(page);
  const landed = page.locator(`[data-message-id="${messageId(4)}"]`);
  await expect(landed).toHaveAttribute("data-landed", "true");
  await expect(landed).toContainText("Earlier message 4");
  expect(cursors).toContain(OLDER_CURSOR);
  await expect(page.locator("[data-landed]")).toHaveCount(1);
  await still(page, "notification-landing-message", undefined, {
    scrollTo: landed,
  });
});

test("a mention of a message already on the page lands without loading more", async ({ page }) => {
  const { cursors } = await world(page, `message:${messageId(31)}`);
  await open(page);
  const landed = page.locator(`[data-message-id="${messageId(31)}"]`);
  await expect(landed).toHaveAttribute("data-landed", "true");
  expect(cursors).not.toContain(OLDER_CURSOR);
});

test("a mention of a message that is on no page says the part is gone", async ({ page }) => {
  const { cursors } = await world(page, `message:${messageId(77)}`);
  await open(page);
  await expect(
    page.getByText("The part this notification was about is no longer here."),
  ).toBeVisible();
  expect(cursors).toContain(OLDER_CURSOR);
  await expect(page.locator("[data-landed]")).toHaveCount(0);
});
