import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/**
 * Where a notification opens. A row links to /notifications?open={id}&r={rev};
 * that resolves the target now and replaces itself with the place, which the
 * page then brings into view (the part outlined once, a polite announcement,
 * the notification read) or, for a gone part, says so.
 */
const N = "00000000-0000-4000-8000-0000000000a1";
const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const stepA = "00000000-0000-4000-8000-000000000021";
const stepB = "00000000-0000-4000-8000-000000000031";
const questionId = "00000000-0000-4000-8000-000000000601";
const REVISION = 2;
const stamp = "2026-01-01T00:00:00.000Z";

const step = (id: string, stepKey: string, status: string) => ({
  id,
  runId,
  stepKey,
  iteration: 1,
  status,
  input: {},
  output: null,
  error: null,
  startedAt: stamp,
  finishedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
});
const run = {
  id: runId,
  taskId,
  workflowVersionId: "00000000-0000-4000-8000-000000000022",
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: "00000000-0000-4000-8000-000000000001",
  inngestRunId: null,
  status: "failed",
  budgetLimitUsd: "10.00",
  startedAt: stamp,
  finishedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd: "10",
      reservedUsd: "0",
      settledUsd: "1",
      availableUsd: "9",
      unknownCount: 0,
    },
  },
};
const task = {
  id: taskId,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "failed",
  priority: 50,
  createdBy: "00000000-0000-4000-8000-000000000001",
  currentRunId: runId,
  archivedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
};
const question = {
  id: questionId,
  taskId,
  runId: null,
  conversationId: task.conversationId,
  prompt: "Which repositories should we import?",
  responseSchema: null,
  status: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  kind: "question",
  turnId: null,
  generation: 1,
  options: [
    { id: "bakery", label: "Bakery only" },
    { id: "choose", label: "Choose repositories" },
  ],
  allowFreeText: false,
  audience: { type: "task_participants" },
  expiresAt: null,
};

type Target = {
  status: "available" | "part_unavailable" | "unavailable";
  targetKind: string;
  path: string | null;
  anchor: string | null;
};

/** The task page's reads and one notification whose target is `target`. */
async function world(
  page: Page,
  target: Target,
  options: { questions?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
  const reads: unknown[] = [];
  await page.route(
    `**/v1/tasks/${taskId}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(`**/v1/runs/${runId}/steps*`, (route) =>
    route.fulfill({
      json: {
        items: [
          step(stepA, "publish", "completed"),
          step(stepB, "verify", "failed"),
        ],
        nextCursor: null,
      },
    }));
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: { runId, actions: [] } }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/v1/questions?*", (route) =>
    route.fulfill({
      json: { items: options.questions ? [question] : [], nextCursor: null },
    }));
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
  await page.route(
    `**/v1/notifications/${N}/target`,
    (route) => route.fulfill({ json: target }),
  );
  await page.route(`**/v1/notifications/${N}`, (route) => {
    reads.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        id: N,
        organizationId: "00000000-0000-4000-8000-000000000003",
        recipientId: "00000000-0000-4000-8000-000000000001",
        kind: "step_failed",
        targetKind: target.targetKind,
        targetId: stepB,
        targetAnchor: target.anchor,
        conversationId: null,
        runId,
        taskId,
        actor: null,
        destination: { available: true, title: task.title },
        read: true,
        revision: REVISION + 1,
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

const open = (page: Page) =>
  page.goto(`/notifications?open=${N}&r=${REVISION}`);
const announcer = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Opened from a notification." });

test.describe("Opening a notification", () => {
  test("a failed step: the step is selected, outlined once, the notification is read", async ({ page }) => {
    const { reads } = await world(page, {
      status: "available",
      targetKind: "run_step",
      path: `/tasks/${taskId}`,
      anchor: `step:${stepB}`,
    });
    await open(page);
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}\\?`));
    await expect(page.getByRole("combobox", { name: "Step" })).toHaveValue(
      stepB,
    );
    await expect(page.locator(`[data-landing-step="${stepB}"]`))
      .toHaveAttribute(
        "data-landed",
        "true",
      );
    await expect(announcer(page)).toHaveCount(1);
    // Read once the place is on screen, and the read marker leaves the address.
    await expect.poll(() => reads).toEqual([{
      id: N,
      read: true,
      expectedCasVersion: REVISION,
    }]);
    await expect(page).toHaveURL(
      new RegExp(`at=step%3A${stepB}|at=step:${stepB}`),
    );
    expect(page.url()).not.toMatch(/[?&](n|r)=/);
    // The outline fades.
    await expect(page.locator("[data-landed]")).toHaveCount(0, {
      timeout: 6000,
    });
    await still(page, "landing-step");
  });

  test("a finished or failed task with no part: the Current run section is in view", async ({ page }) => {
    await world(page, {
      status: "available",
      targetKind: "run",
      path: `/tasks/${taskId}`,
      anchor: null,
    });
    await open(page);
    const heading = page.getByRole("heading", { name: "Current run" });
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute("data-landed", "true");
  });

  test("a question: its card is outlined", async ({ page }) => {
    await world(
      page,
      {
        status: "available",
        targetKind: "question",
        path: `/tasks/${taskId}`,
        anchor: `question:${questionId}`,
      },
      { questions: true },
    );
    await open(page);
    await expect(page.locator(`[data-question-id="${questionId}"]`))
      .toHaveAttribute(
        "data-landed",
        "true",
      );
  });

  test("a part that is gone: the page opens, says so, outlines nothing, and is read", async ({ page }) => {
    const { reads } = await world(page, {
      status: "part_unavailable",
      targetKind: "run_step",
      path: `/tasks/${taskId}`,
      anchor: null,
    });
    await open(page);
    await expect(
      page.getByText("The part this notification was about is no longer here."),
    ).toBeVisible();
    await expect(page.locator("[data-landed]")).toHaveCount(0);
    await expect.poll(() => reads.length).toBe(1);
    await still(page, "landing-part-gone");
  });

  test("a task you can no longer reach: says so, offers the way back, reads nothing", async ({ page }) => {
    const { reads } = await world(page, {
      status: "unavailable",
      targetKind: "run_step",
      path: null,
      anchor: null,
    });
    await open(page);
    await expect(page.getByRole("heading", { name: "Notifications" }))
      .toBeVisible();
    await expect(page.getByText("This item is no longer available"))
      .toBeVisible();
    expect(reads).toEqual([]);
    await page.getByRole("button", { name: "Back to notifications" }).click();
    await expect(page).toHaveURL(/\/notifications$/);
  });
});
