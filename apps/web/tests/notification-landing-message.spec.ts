import {
  expect as baseExpect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { inboxFixture, inboxRowId } from "./helpers/inbox-fixture.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import {
  NOTIFICATION_ID,
  NOTIFICATION_REVISION,
} from "./helpers/notification-world.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const expect = baseExpect.configure({ timeout: 15_000 });

const taskId = "00000000-0000-4000-8000-000000000012";
const conversationId = "00000000-0000-4000-8000-000000000006";
const principalId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000003";
const SECOND_NOTIFICATION_ID = "00000000-0000-4000-8000-0000000000a2";
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
const message = (sequence: number) => ({
  id: messageId(sequence),
  conversationId,
  authorId: principalId,
  agentSessionId: null,
  messageType: "user",
  body: `Message number ${sequence}`,
  clientMessageId: `client-${sequence}`,
  replyToId: null,
  createdAt: stamp(sequence),
  updatedAt: stamp(sequence),
  version: 1,
  sequence: String(sequence),
  intent: "discussion",
  commentContext: null,
});

const PAGES: Record<string, { items: number[]; next: string | null }> = {
  first: { items: [60, 61, 62], next: "page-2" },
  "page-2": { items: [30, 31, 32], next: "page-3" },
  "page-3": { items: [3, 4, 5], next: "page-4" },
  "page-4": { items: [1, 2], next: null },
};

const problem = {
  type: "https://bakery.example/problems/test",
  title: "Failed",
  detail: "Failed.",
  status: 500,
  code: "INTERNAL_ERROR",
  retryable: false,
  requestId: "00000000-0000-4000-8000-0000000000f1",
  traceId: "00000000-0000-4000-8000-0000000000f2",
};

type Read = { messagesOnPage: number; body: unknown };

async function world(
  page: Page,
  anchors: Record<string, number>,
  options: { failingPage?: string; inbox?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
  const cursors: string[] = [];
  const reads: Read[] = [];
  const control = { failingPage: options.failingPage };
  await page.route(
    `**/v1/tasks/${taskId}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/conversations/${conversationId}/messages*`,
    (route: Route) => {
      const cursor =
        new URL(route.request().url()).searchParams.get("cursor") ??
          "first";
      cursors.push(cursor);
      if (cursor === control.failingPage) {
        return route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify(problem),
        });
      }
      const found = PAGES[cursor]!;
      return route.fulfill({
        json: { items: found.items.map(message), nextCursor: found.next },
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
  await page.route(/\/v1\/notifications\/[0-9a-f-]{36}\/target$/, (route) => {
    const id = route.request().url().split("/").at(-2)!;
    const sequence = anchors[id] ?? Object.values(anchors)[0]!;
    return route.fulfill({
      json: {
        status: "available",
        targetKind: "conversation_message",
        path: `/tasks/${taskId}`,
        anchor: `message:${messageId(sequence)}`,
      },
    });
  });
  await page.route(/\/v1\/notifications\/[0-9a-f-]{36}$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    const id = request.url().split("/").at(-1)!;
    const sequence = anchors[id] ?? Object.values(anchors)[0]!;
    reads.push({
      messagesOnPage: await page
        .locator(`[data-message-id="${messageId(sequence)}"]`)
        .count(),
      body: request.postDataJSON(),
    });
    return route.fulfill({
      json: {
        id,
        organizationId,
        recipientId: principalId,
        kind: "mention",
        targetKind: "conversation_message",
        targetId: messageId(sequence),
        targetAnchor: `message:${messageId(sequence)}`,
        conversationId,
        runId: null,
        taskId,
        actor: null,
        destination: { available: true, title: task.title },
        approvalOutcome: null,
        read: true,
        revision: NOTIFICATION_REVISION + 1,
        createdAt: stamp(0),
      },
    });
  });
  if (options.inbox !== true) {
    await page.route(
      "**/v1/notifications?*",
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(
      "**/v1/notifications/count*",
      (route) => route.fulfill({ json: { unread: 0 } }),
    );
  }
  return { cursors, reads, control };
}

const open = (page: Page, id = NOTIFICATION_ID) =>
  page.goto(`/notifications?open=${id}&r=${NOTIFICATION_REVISION}`);

const messageOf = (page: Page, sequence: number) =>
  page.locator(`[data-message-id="${messageId(sequence)}"]`);

const partGone = (page: Page) =>
  page.getByText("The part this notification was about is no longer here.");

test("a mention of a message on the newest page lands on it without loading more", async ({ page }) => {
  const { cursors, reads } = await world(page, { [NOTIFICATION_ID]: 61 });
  await open(page);
  const landed = messageOf(page, 61);
  await expect(landed).toHaveAttribute("data-landed", "true");
  await expect(page.locator("[data-landed]")).toHaveCount(1);
  await expect(landed).toBeInViewport();
  await expect.poll(() => reads.length).toBe(1);
  expect(cursors).toEqual(["first"]);
  expect(reads[0]!.messagesOnPage).toBe(1);
});

test("a mention of an older message reads past each cursor, lands once, and is read only after it is on the page", async ({ page }) => {
  const { cursors, reads } = await world(page, { [NOTIFICATION_ID]: 4 });
  await open(page);
  const landed = messageOf(page, 4);
  await expect(landed).toHaveAttribute("data-landed", "true");
  await expect(landed).toContainText("Message number 4");
  await expect(page.locator("[data-landed]")).toHaveCount(1);
  await expect(landed).toBeInViewport();
  expect(
    await page.evaluate(() =>
      document.activeElement?.closest("[data-message-id]")?.getAttribute(
        "data-message-id",
      )
    ),
  ).toBe(messageId(4));
  await expect.poll(() => reads.length).toBe(1);
  expect([...new Set(cursors)]).toEqual(["first", "page-2", "page-3"]);
  expect(reads[0]!.messagesOnPage).toBe(1);
  await still(page, "notification-landing-message", undefined, {
    scrollTo: landed,
  });
});

test("a message that is on no page says the part is gone only after the last page, then is read", async ({ page }) => {
  const { cursors, reads } = await world(page, { [NOTIFICATION_ID]: 77 });
  await open(page);
  await expect(partGone(page)).toBeVisible();
  await expect(page.locator("[data-landed]")).toHaveCount(0);
  await expect.poll(() => reads.length).toBe(1);
  expect([...new Set(cursors)]).toEqual([
    "first",
    "page-2",
    "page-3",
    "page-4",
  ]);
  await still(page, "notification-landing-message-gone");
});

test("a page that fails to load is not a gone message: nothing is read until a retry finds it", async ({ page }) => {
  const { cursors, reads, control } = await world(page, {
    [NOTIFICATION_ID]: 4,
  }, { failingPage: "page-3" });
  await open(page);
  await expect.poll(() => cursors.filter((c) => c === "page-3").length)
    .toBeGreaterThan(0);
  await page.waitForTimeout(5_000);
  await expect(partGone(page)).toHaveCount(0);
  expect(reads).toHaveLength(0);
  control.failingPage = undefined;
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  const landed = messageOf(page, 4);
  await expect(landed).toHaveAttribute("data-landed", "true");
  await expect.poll(() => reads.length).toBe(1);
  expect(reads[0]!.messagesOnPage).toBe(1);
  await expect(partGone(page)).toHaveCount(0);
});

test("a draft typed after landing survives, and Load earlier still adds the next page", async ({ page }) => {
  const { cursors } = await world(page, { [NOTIFICATION_ID]: 4 });
  await open(page);
  await expect(messageOf(page, 4)).toHaveAttribute("data-landed", "true");
  const draft = page.getByPlaceholder("Message this task…");
  await draft.fill("My half-written reply");
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(messageOf(page, 1)).toBeVisible();
  expect([...new Set(cursors)]).toEqual([
    "first",
    "page-2",
    "page-3",
    "page-4",
  ]);
  await expect(draft).toHaveValue("My half-written reply");
  await expect(messageOf(page, 4)).toBeAttached();
});

test("a second notification for the same task lands on its own message", async ({ page }) => {
  const { reads } = await world(page, {
    [NOTIFICATION_ID]: 61,
    [SECOND_NOTIFICATION_ID]: 4,
  });
  await open(page);
  await expect(messageOf(page, 61)).toHaveAttribute("data-landed", "true");
  await expect.poll(() => reads.length).toBe(1);
  await page.evaluate(
    ([id, revision]) => {
      globalThis.history.pushState(
        null,
        "",
        `/notifications?open=${id}&r=${revision}`,
      );
      globalThis.dispatchEvent(new PopStateEvent("popstate"));
    },
    [SECOND_NOTIFICATION_ID, NOTIFICATION_REVISION],
  );
  await expect(messageOf(page, 4)).toHaveAttribute("data-landed", "true");
  await expect.poll(() => reads.length).toBe(2);
  expect(reads[1]!.messagesOnPage).toBe(1);
});

test("Back from a landed message returns to the filtered inbox", async ({ page }) => {
  await inboxFixture(page);
  const { reads } = await world(page, { [inboxRowId(0)]: 4 }, { inbox: true });
  await page.goto("/notifications");
  await page.getByRole("tab", { name: /^Mentions/ }).click();
  const rows = page.locator("[data-ui-component=notificationRow]");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await rows.first().getByRole("link").first().click();
  await expect(messageOf(page, 4)).toHaveAttribute("data-landed", "true");
  await expect.poll(() => reads.length).toBe(1);
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^Mentions/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rows).toHaveCount(before);
});
