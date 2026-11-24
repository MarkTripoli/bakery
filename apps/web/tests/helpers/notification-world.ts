import type { Page } from "@playwright/test";

/** The notification every landing spec opens: its id and read revision. */
export const NOTIFICATION_ID = "00000000-0000-4000-8000-0000000000a1";
export const NOTIFICATION_REVISION = 2;

export type Target = {
  status: "available" | "part_unavailable" | "unavailable";
  targetKind: string;
  path: string | null;
  anchor: string | null;
};

const stamp = "2026-01-01T00:00:00.000Z";

/**
 * The notification reads a landing makes: its target, marking it read (every
 * body is kept in `reads`), and an empty inbox for the refresh after.
 */
export async function stubNotification(
  page: Page,
  target: Target,
  options: { taskId: string; targetId?: string; title?: string },
) {
  const reads: unknown[] = [];
  await page.route(
    `**/v1/notifications/${NOTIFICATION_ID}/target`,
    (route) => route.fulfill({ json: target }),
  );
  await page.route(`**/v1/notifications/${NOTIFICATION_ID}`, (route) => {
    reads.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        id: NOTIFICATION_ID,
        organizationId: "00000000-0000-4000-8000-000000000003",
        recipientId: "00000000-0000-4000-8000-000000000001",
        kind: "step_failed",
        targetKind: target.targetKind,
        targetId: options.targetId ?? options.taskId,
        targetAnchor: target.anchor,
        conversationId: null,
        runId: null,
        taskId: options.taskId,
        actor: null,
        destination: { available: true, title: options.title ?? "Task" },
        approvalOutcome: null,
        read: true,
        revision: NOTIFICATION_REVISION + 1,
        createdAt: stamp,
      },
    });
  });
  await page.route(
    "**/v1/notifications?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    "**/v1/notifications/count*",
    (route) => route.fulfill({ json: { unread: 0 } }),
  );
  return { reads };
}

export const openNotification = (page: Page) =>
  page.goto(
    `/notifications?open=${NOTIFICATION_ID}&r=${NOTIFICATION_REVISION}`,
  );
