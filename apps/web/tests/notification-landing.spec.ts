import {
  expect as baseExpect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import {
  NOTIFICATION_ID as N,
  NOTIFICATION_REVISION as REVISION,
  openNotification as open,
  stubNotification,
  type Target,
} from "./helpers/notification-world.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

// These wait on a cold dev server and a redirect, which a loaded host slows.
const expect = baseExpect.configure({ timeout: 15_000 });

/**
 * Where a notification opens on the task page. A row links to
 * /notifications?open={id}&r={rev}; that resolves the target now and replaces
 * itself with the place, which the page then brings into view (the part
 * outlined once, a polite announcement, the notification read) or, for a gone
 * part, says so.
 */
const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const stepA = "00000000-0000-4000-8000-000000000021";
const stepB = "00000000-0000-4000-8000-000000000031";
const questionId = "00000000-0000-4000-8000-000000000601";
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

const approvalId = "00000000-0000-4000-8000-000000000501";
const revision = {
  id: "00000000-0000-4000-8000-000000000401",
  taskId,
  conversationId: task.conversationId,
  revision: 1,
  body: {
    title: "Repository onboarding",
    steps: [{ id: "s1", title: "Import the repository", detail: "Read it." }],
    repositoryId: task.repositoryId,
  },
  digest: "1".repeat(64),
  status: "proposed",
  proposedByTurnId: null,
  supersedesRevision: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
};
const approval = {
  id: approvalId,
  kind: "approval",
  taskId,
  conversationId: task.conversationId,
  turnId: null,
  runId: null,
  prompt: "Approve plan revision 1",
  status: "open",
  subjectType: "plan_revision",
  subjectId: revision.id,
  subjectDigest: revision.digest,
  scope: { stage: "plan" },
  policyDigest: "c".repeat(64),
  decision: null,
  decisionComment: null,
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  consumedByRunId: null,
  revokedAt: null,
  revokedBy: null,
  expiresAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 7,
};

/** The task page's reads and one notification whose target is `target`. */
async function world(
  page: Page,
  target: Target,
  options: { questions?: boolean; plan?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
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
  // The rest of the task page reads empty, so a still shows the landing and
  // not a "could not be loaded" banner.
  for (
    const empty of [
      `**/v1/runs/${runId}/checks*`,
      `**/v1/runs/${runId}/reviews*`,
      `**/v1/runs/${runId}/delivery-decisions*`,
      "**/v1/pull-requests?*",
      `**/v1/conversations/${task.conversationId}/messages*`,
      `**/v1/conversations/${task.conversationId}/participants*`,
      `**/v1/conversations/${task.conversationId}/turns*`,
      "**/v1/coordination-plans*",
    ]
  ) {
    await page.route(
      empty,
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
  }
  await page.route("**/v1/plan-revisions*", (route) =>
    route.fulfill({
      json: { items: options.plan ? [revision] : [], nextCursor: null },
    }));
  await page.route("**/v1/approvals*", (route) =>
    route.fulfill({
      json: { items: options.plan ? [approval] : [], nextCursor: null },
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
  return stubNotification(page, target, {
    taskId,
    targetId: stepB,
    title: task.title,
  });
}

const announcer = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Opened from a notification." });

/**
 * Holds a landing's outline (it fades after 2.5s) and frames the still on the
 * part. The still widens a desktop window to 1500px, which re-clamps the
 * scroll the landing made, so the part is centred again at that height the
 * way the landing centres it, instead of keeping the old offset.
 */
async function landedStill(page: Page, name: string, part: Locator) {
  await part.evaluate((element) => element.setAttribute("data-landed", "true"));
  const size = page.viewportSize();
  if (size && size.width > 743) {
    await page.setViewportSize({ width: size.width, height: 1500 });
  }
  await part.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await still(page, name, undefined, { scrollTo: part });
}

/**
 * The outline stands clear of the part's text, and is the only box: no focus
 * ring inside it. A part that fills a panel (the plan in the inspector) draws
 * the line just inside, because the panel would clip it outside.
 */
async function oneBoxWithRoom(page: Page, part: Locator) {
  const fillsPanel = await part.evaluate((element) =>
    element.classList.contains("ui-pane-section")
  );
  expect(
    await part.evaluate((element) => getComputedStyle(element).outlineOffset),
  )
    .toBe(fillsPanel ? "-2px" : "8px");
  const ring = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const landed = document.querySelector("[data-landed]");
    return active && landed && active !== landed && landed.contains(active)
      ? getComputedStyle(active).outlineWidth
      : "0px";
  });
  expect(ring).toBe("0px");
}

/**
 * The shell moves focus to a new page title after a route change; it must not
 * take focus back from what a landing focused. A fresh title is planted inside
 * the shell's watch window (a page title that renders late does the same),
 * and focus must still be on the landing's target once the shell has had its
 * frame. Without the guard in AppLayout the planted title wins.
 */
async function shellLeavesLandingFocus(page: Page) {
  const state = () =>
    page.evaluate(() => ({
      landing: document.activeElement?.hasAttribute("data-landing-focus") ??
        false,
      probe: document.activeElement?.id === "landing-probe-title",
    }));
  expect(await state()).toEqual({ landing: true, probe: false });
  await page.evaluate(async () => {
    const title = document.createElement("h1");
    title.id = "landing-probe-title";
    title.textContent = "A page title that rendered late";
    document.querySelector("main")?.prepend(title);
    // Two frames for the shell's requestAnimationFrame, then a margin.
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done))
    );
    await new Promise((done) => setTimeout(done, 200));
  });
  expect(await state()).toEqual({ landing: true, probe: false });
  await page.evaluate(() =>
    document.getElementById("landing-probe-title")?.remove()
  );
}

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
    const thread = page.locator(`[data-landing-step="${stepB}"]`);
    await expect(thread).toHaveAttribute("data-landed", "true");
    await oneBoxWithRoom(page, thread);
    // Room above the thread: its Step label is on screen, not under the header.
    const selector = await page.getByRole("combobox", { name: "Step" })
      .boundingBox();
    const scroller = await page.locator(".ui-task-detail__transcript")
      .boundingBox();
    expect(selector!.y - scroller!.y).toBeGreaterThanOrEqual(32);
    await shellLeavesLandingFocus(page);
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
    await landedStill(page, "landing-step", thread);
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
    const card = page.locator(`[data-question-id="${questionId}"]:visible`);
    await expect(card).toHaveAttribute("data-landed", "true");
    await oneBoxWithRoom(page, card);
    await shellLeavesLandingFocus(page);
    await landedStill(page, "landing-question", card);
  });

  test("an approval: the plan card is outlined", async ({ page }) => {
    await world(
      page,
      {
        status: "available",
        targetKind: "approval",
        path: `/tasks/${taskId}`,
        anchor: `approval:${approvalId}`,
      },
      { plan: true },
    );
    await open(page);
    const card = page.locator(`[data-approval-id="${approvalId}"]:visible`);
    await expect(card).toHaveAttribute("data-landed", "true");
    await oneBoxWithRoom(page, card);
    await landedStill(page, "landing-approval", card);
  });

  test("a chat message has no address yet: the page opens, is read, and claims nothing is gone", async ({ page }) => {
    const { reads } = await world(page, {
      status: "available",
      targetKind: "conversation_message",
      path: `/tasks/${taskId}`,
      anchor: "message:00000000-0000-4000-8000-000000000701",
    });
    await open(page);
    await expect.poll(() => reads.length).toBe(1);
    await expect(announcer(page)).toHaveCount(1);
    await expect(
      page.getByText("The part this notification was about is no longer here."),
    ).toHaveCount(0);
  });

  test("a part that is gone: the page opens, says so, outlines nothing, and is read", async ({ page }) => {
    const { reads } = await world(page, {
      status: "part_unavailable",
      targetKind: "run_step",
      path: `/tasks/${taskId}`,
      anchor: null,
    });
    await open(page);
    const notice = page.locator(".ui-inline-notice", {
      hasText: "The part this notification was about is no longer here.",
    });
    await expect(notice).toBeVisible();
    await expect(page.locator("[data-landed]")).toHaveCount(0);
    await expect.poll(() => reads.length).toBe(1);
    // At the top, right under the stages, above everything else on the page.
    const stages = await page.getByRole("list", { name: "Workflow stages" })
      .boundingBox();
    const at = await notice.boundingBox();
    const run = await page.getByRole("heading", { name: "Current run" })
      .boundingBox();
    expect(at!.y).toBeGreaterThanOrEqual(stages!.y + stages!.height - 1);
    expect(at!.y).toBeLessThan(run!.y);
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
