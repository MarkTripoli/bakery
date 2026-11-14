import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";

registerPageHealth(test);

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = uuid(12);
const runId = uuid(20);
const reviewId = uuid(300);
const OLD = "4be19c2".padEnd(40, "a");
const NEW = "91d0aa3".padEnd(40, "b");
const BASE = "a7254e7".padEnd(40, "c");
const sha = (digit: string) => digit.repeat(64);

const run = {
  id: runId,
  taskId: id,
  workflowVersionId: uuid(22),
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
  status: "running",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
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
const step = {
  id: uuid(21),
  runId,
  stepKey: "implement",
  iteration: 1,
  status: "completed",
  input: {},
  output: null,
  error: null,
  startedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: "2026-01-01T00:00:03.000Z",
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  version: 1,
};
const task = {
  id,
  applicationId: uuid(4),
  repositoryId: uuid(5),
  conversationId: uuid(6),
  parentTaskId: null,
  title: "Add partial refunds",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: uuid(1),
  currentRunId: runId,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
};

const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
type Check = {
  name: string;
  head: string;
  result: string;
  minute: number;
  exitCode?: number | null;
};
const checkRow = (
  { name, head, result, minute, exitCode = 0 }: Check,
  n: number,
) => ({
  id: uuid(100 + n),
  runId,
  runStepId: null,
  pullRequestId: null,
  checkId: name,
  checkName: name,
  kind: "command",
  ruleKey: null,
  headSha: head,
  baseSha: BASE,
  profileDigest: null,
  policyDigest: "policy-1",
  subjectDigest: sha("a"),
  checkerDigest: null,
  titleDigest: null,
  bodyDigest: null,
  mergeMessageDigest: null,
  commitSelectionDigest: null,
  result,
  reason: result === "passed" ? "verified" : "exit_nonzero",
  exitCode: result === "pending" ? null : exitCode,
  durationMs: result === "pending" ? null : 1000,
  outputDigest: null,
  evidenceVersionId: null,
  providerRunId: null,
  createdAt: at(minute),
  updatedAt: at(minute),
  version: 1,
});
const reviewRow = (
  over: {
    head: string;
    status: string;
    findings: number;
    blocking: number;
    minute: number;
  },
) => ({
  id: reviewId,
  runId,
  runStepId: uuid(21),
  ordinal: 0,
  pullRequestId: null,
  reviewerSessionId: uuid(31),
  reviewerPrincipalId: uuid(32),
  implementerSessionId: uuid(33),
  implementerPrincipalId: uuid(34),
  headSha: over.head,
  baseSha: BASE,
  policyDigest: "policy-1",
  status: over.status,
  findingCount: over.findings,
  blockingCount: over.blocking,
  artifactVersionId: null,
  createdAt: at(over.minute),
  updatedAt: at(over.minute),
  version: 1,
});
const findingRow = (
  n: number,
  severity: string,
  body: string,
  path = "src/payments/refund.ts",
) => ({
  id: uuid(400 + n),
  reviewCycleId: reviewId,
  fingerprint: sha(String(n)),
  severity,
  path,
  line: 88,
  body,
  status: "open",
  resolutionArtifactId: null,
  remoteCommentId: null,
  createdAt: at(3),
  updatedAt: at(3),
  version: 1,
});
const decisionRow = (
  ordinal: number,
  decision: string,
  reason: string,
  head: string,
  fingerprints: string[] = [],
) => ({
  id: uuid(500 + ordinal),
  runId,
  ordinal,
  reviewCycleId: null,
  decision,
  reason,
  headSha: head,
  baseSha: BASE,
  policyDigest: "policy-1",
  failedChecks: [],
  blockingFingerprints: fingerprints,
  limits: { maxRepairCycles: 2, maxLoopDurationMs: 600000, maxFindings: 25 },
  createdAt: at(4 + ordinal),
  updatedAt: at(4 + ordinal),
  version: 1,
});

type Scenario = {
  checks: Check[];
  review?: Parameters<typeof reviewRow>[0];
  findings?: ReturnType<typeof findingRow>[];
  decisions?: ReturnType<typeof decisionRow>[];
};
const page_ = <T>(items: T[]) => ({ items, nextCursor: null });

const problemBody = (status: number, code: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
  requestId: uuid(110),
  traceId: uuid(111),
  retryable: false,
});

/** The run-stage approval the server asks when a clean candidate needs a person. */
const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(700),
  kind: "approval",
  taskId: id,
  conversationId: uuid(30),
  turnId: null,
  runId: null,
  prompt: "Approve the reviewed change 91d0aa3bbbbb before it may merge",
  status: "open",
  subjectType: "run_stage",
  // The delivery decision the approval was asked about: ordinal 0.
  subjectId: uuid(500),
  subjectDigest: sha("d"),
  scope: { stage: "review", runId, headSha: NEW, repositoryId: uuid(40) },
  policyDigest: sha("c"),
  decision: null,
  decisionComment: null,
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  consumedByRunId: null,
  revokedAt: null,
  revokedBy: null,
  expiresAt: null,
  createdAt: at(6),
  updatedAt: at(6),
  version: 4,
  ...over,
});
type ApprovalRow = ReturnType<typeof approvalRow>;

type Posted = {
  id: string;
  key: string | undefined;
  body: Record<string, unknown>;
};
type ApprovalsMock = {
  approvals: ApprovalRow[];
  posted: Posted[];
  /** Answers a decision instead of the default (accepting it). */
  reply?: (route: Route, mock: ApprovalsMock) => Promise<void>;
};

/** Serves the task's approvals and records every decision sent. */
async function mockApprovals(
  page: Page,
  approvals: ApprovalRow[],
  reply?: ApprovalsMock["reply"],
): Promise<ApprovalsMock> {
  const mock: ApprovalsMock = { approvals, posted: [], reply };
  await page.route(
    "**/v1/approvals?*",
    (route) => route.fulfill({ json: page_(mock.approvals) }),
  );
  await page.route("**/v1/approvals/*/decision", async (route) => {
    const request = route.request();
    const approvalId = request.url().split("/approvals/")[1].split("/")[0];
    const body = request.postDataJSON() as Record<string, unknown>;
    mock.posted.push({
      id: approvalId,
      key: request.headers()["idempotency-key"],
      body,
    });
    if (mock.reply) return await mock.reply(route, mock);
    const found = mock.approvals.find((entry) => entry.id === approvalId)!;
    const decided = {
      ...found,
      status: "answered",
      decision: body.decision as string,
      decisionComment: (body.comment as string | undefined) ?? null,
      decidedBy: uuid(1),
      decidedAt: at(8),
      version: found.version + 1,
    };
    mock.approvals = mock.approvals.map((entry) =>
      entry.id === approvalId ? decided : entry
    );
    return route.fulfill({ json: decided });
  });
  return mock;
}

async function mockRun(page: Page) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: page_([step]) }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (route) =>
    route.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: true,
          reason: "allowed",
        })),
      },
    }));
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: page_([]) }),
  );
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
}

async function mockDelivery(page: Page, scenario: Scenario) {
  await page.route(
    `**/v1/runs/${runId}/checks*`,
    (route) => route.fulfill({ json: page_(scenario.checks.map(checkRow)) }),
  );
  await page.route(`**/v1/runs/${runId}/reviews*`, (route) =>
    route.fulfill({
      json: page_(scenario.review ? [reviewRow(scenario.review)] : []),
    }));
  await page.route(
    `**/v1/reviews/${reviewId}/findings*`,
    (route) => route.fulfill({ json: page_(scenario.findings ?? []) }),
  );
  await page.route(
    `**/v1/runs/${runId}/delivery-decisions*`,
    (route) => route.fulfill({ json: page_(scenario.decisions ?? []) }),
  );
  // No approval unless a test serves one with `mockApprovals` (registered
  // later, so it wins).
  await page.route(
    "**/v1/approvals?*",
    (route) => route.fulfill({ json: page_([]) }),
  );
}

const CLEAN: Scenario = {
  checks: [
    { name: "tests", head: NEW, result: "passed", minute: 1 },
    { name: "lint", head: NEW, result: "passed", minute: 1 },
  ],
  review: {
    head: NEW,
    status: "approved",
    findings: 2,
    blocking: 0,
    minute: 2,
  },
  decisions: [decisionRow(0, "proceed", "clean", NEW)],
};
const FIXING: Scenario = {
  checks: [
    { name: "tests", head: OLD, result: "failed", minute: 1, exitCode: 1 },
    { name: "lint", head: OLD, result: "passed", minute: 1 },
    { name: "tests", head: NEW, result: "pending", minute: 5 },
  ],
  review: {
    head: OLD,
    status: "changes_requested",
    findings: 3,
    blocking: 2,
    minute: 2,
  },
  findings: [
    findingRow(
      1,
      "note",
      "Consider naming the constant for the retry limit.",
      "src/retry.ts",
    ),
    findingRow(
      2,
      "blocker",
      "Refund amount is not validated against the original charge.",
    ),
    findingRow(
      3,
      "major",
      "No test covers the partial refund path.",
      "tests/refund_test.ts",
    ),
  ],
  decisions: [decisionRow(0, "repair", "repair_selected", OLD)],
};
const STOPPED: Scenario = {
  checks: [{ name: "tests", head: NEW, result: "passed", minute: 1 }],
  review: {
    head: NEW,
    status: "changes_requested",
    findings: 1,
    blocking: 1,
    minute: 2,
  },
  findings: [
    findingRow(
      2,
      "blocker",
      "Refund amount is not validated against the original charge.",
    ),
  ],
  decisions: [
    decisionRow(0, "repair", "repair_selected", OLD),
    decisionRow(1, "repair", "repair_selected", NEW),
    decisionRow(2, "stop", "repair_cycles_exhausted", NEW, [sha("2")]),
  ],
};

test("a clean run says nothing is waiting, offers no buttons and draws no step the server did not report", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section.getByRole("heading", { name: "Delivery", level: 2 }))
    .toBeVisible();
  const now = section.getByTestId("delivery-now");
  await expect(now).toContainText(
    "Checks passed and the review found nothing blocking",
  );
  await expect(now).toContainText("Nothing is waiting for you.");
  await expect(now.getByRole("button")).toHaveCount(0);
  await expect(now).toHaveAttribute("data-variant", "success");
  await expect(section).toContainText(
    "Whether this change is ready, and what it is waiting for.",
  );
  await expect(section).not.toContainText("release");
  const steps = section.getByRole("list", { name: "Delivery steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps).toContainText("Commit 91d0aa3 on top of a7254e7");
  await expect(steps).toContainText("2 of 2 passed");
  await expect(steps).toContainText(
    "Approved by the reviewing agent · 2 notes, nothing blocking",
  );
  for (
    const absent of ["Approval", "Fixing", "Pull request", "Release"]
  ) {
    await expect(section).not.toContainText(absent);
  }
  await expect(
    section.getByRole("button", { name: /approve|reject|request changes/i }),
  ).toHaveCount(0);
});

test("results for an older commit are marked and the card says a fix is running", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, FIXING);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  const now = section.getByTestId("delivery-now");
  const notice = section.getByTestId("delivery-out-of-date");
  await expect(notice).toContainText(
    "The changes were updated after these results",
  );
  // Nothing is wrong and nothing is asked of the person: a neutral notice,
  // under the card that says whose turn it is.
  await expect(notice).toHaveAttribute("data-variant", "neutral");
  await expect(now).toContainText("Fixing review findings · try 1 of 2");
  await expect(now).toHaveAttribute("data-variant", "information");
  // The count never breaks across lines ("try 1 of" / "2" on a phone).
  expect(await now.getByRole("heading").textContent()).toContain(
    "try\u00a01\u00a0of\u00a02",
  );
  const nowBox = await now.boundingBox();
  const noticeBox = await notice.boundingBox();
  expect(nowBox).not.toBeNull();
  expect(noticeBox).not.toBeNull();
  expect(nowBox!.y).toBeLessThan(noticeBox!.y);
  await expect(section.getByText("Older commit 4be19c2").first()).toBeVisible();
  const steps = section.getByRole("list", { name: "Delivery steps" });
  await expect(steps).toContainText("Try 1 of 2 is running.");
  // A result that no longer counts is never drawn as passed.
  const checks = steps.getByRole("listitem").filter({ hasText: "Checks" });
  await expect(checks).toContainText("Running again for commit 91d0aa3.");
  await expect(checks.getByText("Passed on older commit 4be19c2"))
    .toBeVisible();
  await expect(checks.getByText("Passed", { exact: true })).toHaveCount(0);
  // Every step lines up, whether or not it has a help button: the mark is level
  // with the title, the title sits the same distance from its summary, and
  // every mark is drawn at the tick's size.
  const metrics = await steps.evaluate((list) =>
    [...list.querySelectorAll(":scope > li")].map((item) => {
      const rect = (selector: string) => {
        const element = item.querySelector(selector);
        if (element === null) throw new Error(`missing ${selector}`);
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          width: box.width,
        };
      };
      const mark = rect(".ui-step-item__mark");
      const title = rect(".ui-step-item__title");
      const summary = rect(".ui-step-item__summary");
      const icon = rect(".ui-step-item__mark svg");
      return {
        markMiddle: mark.top + mark.height / 2,
        titleMiddle: title.top + title.height / 2,
        gap: summary.top - title.bottom,
        icon: [icon.width, icon.height],
      };
    })
  );
  expect(metrics).toHaveLength(4);
  for (const row of metrics) {
    expect(Math.abs(row.markMiddle - row.titleMiddle)).toBeLessThanOrEqual(3);
    expect(Math.abs(row.gap - metrics[0].gap)).toBeLessThanOrEqual(1);
    expect(row.icon).toEqual([16, 16]);
  }
  const findings = steps.getByRole("listitem").filter({ hasText: "Review" });
  await expect(findings.getByText("Blocker", { exact: true })).toBeVisible();
  await expect(findings.getByText("Major", { exact: true })).toBeVisible();
  await expect(findings.getByText("Note", { exact: true })).toBeVisible();
});

test("a stopped run names the reason and its one button moves focus to the message box", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, STOPPED);
  await page.goto(`/tasks/${id}`);
  const now = page.getByTestId("delivery-section").getByTestId("delivery-now");
  await expect(now).toContainText("Bakery could not fix this");
  await expect(now).toContainText(
    "It tried 2 times and 1 blocking finding remains.",
  );
  await expect(now).toContainText("Send a message to say what to do next.");
  await expect(now).toHaveAttribute("data-variant", "warning");
  const fixing = page.getByRole("list", { name: "Delivery steps" })
    .getByRole("listitem").last();
  await expect(fixing).toContainText(
    "Stopped after 2 tries. 1 blocking finding remains.",
  );
  await expect(fixing).toContainText("Failed");
  await expect(fixing).not.toContainText("finished");
  await expect(now.getByRole("button")).toHaveCount(1);
  await now.getByRole("button", { name: "Tell Bakery what to change" }).click();
  await expect(page.locator("#task-message-field")).toBeFocused();
});

test("a denied read says there is no access and draws no steps", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  await page.route(`**/v1/runs/${runId}/checks*`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      json: {
        type: "about:blank",
        title: "Not found",
        status: 404,
        code: "NOT_FOUND",
        detail: "Not found.",
        requestId: uuid(110),
        traceId: uuid(111),
        retryable: false,
      },
    }));
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section).toContainText(
    "You do not have access to this run's delivery status.",
  );
  await expect(section.getByRole("list", { name: "Delivery steps" }))
    .toHaveCount(0);
});

test("a failed load offers Try again, and the retry shows the steps", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  let failing = true;
  await page.route(`**/v1/runs/${runId}/checks*`, (route) => {
    if (failing) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Server error",
          status: 500,
          code: "INTERNAL",
          detail: "Failed.",
          requestId: uuid(112),
          traceId: uuid(113),
          retryable: false,
        },
      });
    }
    return route.fulfill({ json: page_(CLEAN.checks.map(checkRow)) });
  });
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section).toContainText("Delivery status could not be loaded.");
  failing = false;
  await section.getByRole("button", { name: "Try again" }).click();
  await expect(section.getByRole("list", { name: "Delivery steps" }))
    .toBeVisible();
});

test("a run with no changes yet draws no delivery section", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, { checks: [] });
  await page.goto(`/tasks/${id}`);
  await expect(page.getByRole("button", { name: "Pause" }).first())
    .toBeVisible();
  await expect(page.getByTestId("delivery-section")).toHaveCount(0);
});

test("the section has no accessibility violations and fits a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRun(page);
  await mockDelivery(page, FIXING);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section.getByRole("list", { name: "Delivery steps" }))
    .toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[data-testid="delivery-section"]')
    .analyze();
  expect(results.violations).toEqual([]);
  expect(
    await section.evaluate((element) =>
      element.scrollWidth <= element.clientWidth
    ),
  ).toBe(true);
});

const nowCard = (page: Page) =>
  page.getByTestId("delivery-section").getByTestId("delivery-now");
const notice = (page: Page) => page.getByTestId("delivery-approval-notice");
const button = (card: Locator, name: string) =>
  card.getByRole("button", { name, exact: true });
const approvalStep = (page: Page) =>
  page.getByRole("list", { name: "Delivery steps" })
    .getByRole("listitem").filter({ hasText: "Approval" });

async function openApproval(page: Page, approvals = [approvalRow()]) {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  const mock = await mockApprovals(page, approvals);
  await page.goto(`/tasks/${id}`);
  await expect(nowCard(page)).toContainText("Waiting for approval");
  return mock;
}

test("an open approval asks for a decision with three visible answers, Approve first", async ({ page }) => {
  await openApproval(page);
  const now = nowCard(page);
  await expect(now).toContainText(
    "Checks passed and the reviewer found nothing blocking. Approving lets Bakery merge these changes.",
  );
  // The page cannot know who may decide, so it does not call the approval theirs.
  await expect(now).not.toContainText("your approval");
  await expect(now).toHaveAttribute("data-variant", "warning");
  await expect(now.getByRole("button")).toHaveText([
    "Approve",
    "Request changes",
    "Reject",
  ]);
  await expect(now.getByRole("button", { name: "More" })).toHaveCount(0);
  const steps = page.getByRole("list", { name: "Delivery steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(4);
  const step = approvalStep(page);
  await expect(step).toContainText("Waiting for you");
  await expect(step).toContainText("Waiting for approval.");
  // Keyboard focus opens a help tip on every screen. On a phone, scrolling closes
  // it, and focusing a button that is below the fold scrolls the page, so the
  // button is brought into view first and the scroll's own event is let through.
  const help = step.getByRole("button", { name: "About approval" });
  await help.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  );
  await help.focus();
  await expect(
    page.getByRole("tooltip").filter({
      hasText: "Your workflow asks a person to approve at this point.",
    }),
  ).toBeVisible();
  await expect(help).toHaveAccessibleDescription(
    "Your workflow asks a person to approve at this point.",
  );
});

test("approving asks first, sends the version it saw once, and the card announces the result", async ({ page }) => {
  const mock = await openApproval(page);
  const now = nowCard(page);
  await button(now, "Approve").click();
  const dialog = page.getByRole("alertdialog", {
    name: "Approve these changes?",
  });
  await expect(dialog).toContainText(
    "Bakery may then merge them. This applies to commit 91d0aa3. If the changes are updated, approval is asked again.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.posted).toHaveLength(0);
  await button(now, "Approve").click();
  await button(dialog, "Approve").click();
  await expect(now).toContainText("Approved");
  await expect(now).toContainText(
    "Bakery may now merge these changes. Nothing is waiting for you.",
  );
  await expect(now).toHaveAttribute("data-variant", "success");
  expect(mock.posted).toHaveLength(1);
  expect(mock.posted[0]?.id).toBe(uuid(700));
  expect(mock.posted[0]?.body).toEqual({
    decision: "approve",
    expectedVersion: 4,
  });
  expect(mock.posted[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.locator("#delivery-now-title")).toBeFocused();
  await expect(approvalStep(page)).toContainText("Approved");
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("changes need a note, which is sent as the decision's comment", async ({ page }) => {
  const mock = await openApproval(page);
  const now = nowCard(page);
  await button(now, "Request changes").click();
  const dialog = page.getByRole("dialog", { name: "Request changes" });
  await expect(dialog).toContainText(
    "The agent gets this as its next instruction.",
  );
  await expect(dialog).toContainText(
    "Say what is wrong with these changes. The agent fixes them and Bakery checks them again.",
  );
  const send = dialog.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await dialog.getByLabel("What should change?").fill("   ");
  await expect(send).toBeDisabled();
  await dialog.getByLabel("What should change?").fill(
    "Validate the refund amount against the original charge.",
  );
  await send.click();
  await expect(now).toContainText("Changes were requested");
  await expect(now).toContainText(
    "Bakery sent the note to the agent. It will fix the changes and check again.",
  );
  expect(mock.posted).toHaveLength(1);
  expect(mock.posted[0]?.body).toEqual({
    decision: "request_changes",
    comment: "Validate the refund amount against the original charge.",
    expectedVersion: 4,
  });
  await expect(approvalStep(page)).toContainText("Changes requested");
});

test("rejecting asks first and says what it does", async ({ page }) => {
  const mock = await openApproval(page);
  const now = nowCard(page);
  await button(now, "Reject").click();
  const dialog = page.getByRole("alertdialog", {
    name: "Reject these changes?",
  });
  await expect(dialog).toContainText(
    "Bakery will not merge them. The changes are kept. This cannot be undone.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(mock.posted).toHaveLength(0);
  await button(now, "Reject").click();
  await button(dialog, "Reject").click();
  await expect(now).toContainText("These changes were rejected");
  expect(mock.posted[0]?.body).toEqual({
    decision: "reject",
    expectedVersion: 4,
  });
  await expect(approvalStep(page)).toContainText("Rejected");
});

test("a decision that lost to another says so under the card, moves focus to it and shows the latest state", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  const mock = await mockApprovals(page, [approvalRow()], async (route, m) => {
    // Someone else approved first.
    m.approvals = m.approvals.map((entry) => ({
      ...entry,
      status: "answered",
      decision: "approve",
      version: entry.version + 1,
    }));
    await route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problemBody(409, "STATE_CONFLICT"),
    });
  });
  await page.goto(`/tasks/${id}`);
  const now = nowCard(page);
  await button(now, "Approve").click();
  await button(
    page.getByRole("alertdialog", { name: "Approve these changes?" }),
    "Approve",
  ).click();
  await expect(notice(page)).toContainText(
    "This was already decided, or the changes were updated. The latest state is shown.",
  );
  await expect(notice(page)).toBeFocused();
  // Nothing failed: it is information, outside the card, not an error inside it.
  await expect(notice(page)).toHaveAttribute("data-variant", "neutral");
  await expect(now.getByTestId("delivery-approval-notice")).toHaveCount(0);
  expect(mock.posted).toHaveLength(1);
  await expect(now).toContainText("Approved");
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("a person who may not decide is told so, the answers go away and nothing changes", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  await mockApprovals(page, [approvalRow()], (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      json: problemBody(403, "AUTH_FORBIDDEN"),
    }));
  await page.goto(`/tasks/${id}`);
  const now = nowCard(page);
  await button(now, "Approve").click();
  await button(
    page.getByRole("alertdialog", { name: "Approve these changes?" }),
    "Approve",
  ).click();
  await expect(notice(page)).toContainText("You cannot decide this approval.");
  await expect(now).toContainText("Waiting for approval");
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("a lost answer keeps the key, so asking again is the same decision", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  let lost = true;
  const mock = await mockApprovals(page, [approvalRow()], async (route, m) => {
    if (lost) {
      lost = false;
      return await route.abort("failed");
    }
    m.approvals = m.approvals.map((entry) => ({
      ...entry,
      status: "answered",
      decision: "approve",
      version: entry.version + 1,
    }));
    return await route.fulfill({ json: m.approvals[0] });
  });
  await page.goto(`/tasks/${id}`);
  const now = nowCard(page);
  const approve = async () => {
    await button(now, "Approve").click();
    await button(
      page.getByRole("alertdialog", { name: "Approve these changes?" }),
      "Approve",
    ).click();
  };
  await approve();
  await expect(notice(page)).toContainText(
    "Bakery could not confirm that the decision was saved.",
  );
  await approve();
  await expect(now).toContainText("Approved");
  expect(mock.posted).toHaveLength(2);
  expect(mock.posted[1]?.key).toBe(mock.posted[0]?.key);
});

test("an approval asked about an earlier candidate is not shown", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  await mockApprovals(page, [approvalRow({ subjectId: uuid(999) })]);
  await page.goto(`/tasks/${id}`);
  const now = nowCard(page);
  await expect(now).toContainText(
    "Checks passed and the review found nothing blocking",
  );
  await expect(page.getByTestId("delivery-section")).not.toContainText(
    "Approval",
  );
});

test("the approval card and its dialogs have no accessibility violations and fit a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApproval(page);
  const section = page.getByTestId("delivery-section");
  const scan = async (selector: string) => {
    const results = await new AxeBuilder({ page }).include(selector).analyze();
    expect(results.violations).toEqual([]);
  };
  await scan('[data-testid="delivery-section"]');
  expect(
    await section.evaluate((element) =>
      element.scrollWidth <= element.clientWidth
    ),
  ).toBe(true);
  const now = nowCard(page);
  await button(now, "Approve").click();
  await scan("dialog[open]");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" })
    .click();
  await button(now, "Request changes").click();
  await scan("dialog[open]");
});

// Evidence stills for the PR description (desktop and phone, light and dark), only
// when BAKERY_STILLS_DIR is set.
const STILLS = process.env.BAKERY_STILLS_DIR;
for (
  const [name, scenario] of [["clean", CLEAN], ["fixing", FIXING], [
    "stopped",
    STOPPED,
  ]] as const
) {
  for (
    const [width, height, label] of [[1280, 1800, "desktop"], [
      390,
      2200,
      "phone",
    ]] as const
  ) {
    for (const scheme of ["light", "dark"] as const) {
      test(`still: ${name} ${label} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await mockRun(page);
        await mockDelivery(page, scenario);
        await page.goto(`/tasks/${id}`);
        const section = page.getByTestId("delivery-section");
        await expect(section.getByRole("list", { name: "Delivery steps" }))
          .toBeVisible();
        await section.scrollIntoViewIfNeeded();
        await section.screenshot({
          path: `${STILLS}/delivery-${name}-${label}-${scheme}.png`,
        });
      });
    }
  }
}

// Stills of the approval step: the card waiting, each dialog, the outcomes.
const APPROVAL_STILLS = [
  "approval",
  "approval-approve",
  "approval-changes",
  "approval-reject",
  "approval-approved",
  "approval-conflict",
  "approval-refused",
] as const;
for (const name of APPROVAL_STILLS) {
  for (
    const [width, height, label] of [[1280, 1800, "desktop"], [
      390,
      2200,
      "phone",
    ]] as const
  ) {
    for (const scheme of ["light", "dark"] as const) {
      test(`still: ${name} ${label} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await mockRun(page);
        await mockDelivery(page, CLEAN);
        const conflict = name === "approval-conflict";
        await mockApprovals(
          page,
          [approvalRow()],
          conflict
            ? async (route, m) => {
              m.approvals = m.approvals.map((entry) => ({
                ...entry,
                status: "answered",
                decision: "approve",
                version: entry.version + 1,
              }));
              await route.fulfill({
                status: 409,
                contentType: "application/problem+json",
                json: problemBody(409, "STATE_CONFLICT"),
              });
            }
            : name === "approval-refused"
            ? (route) =>
              route.fulfill({
                status: 403,
                contentType: "application/problem+json",
                json: problemBody(403, "AUTH_FORBIDDEN"),
              })
            : undefined,
        );
        await page.goto(`/tasks/${id}`);
        const section = page.getByTestId("delivery-section");
        const now = section.getByTestId("delivery-now");
        await expect(now).toContainText("Waiting for approval");
        // A dialog is pictured alone: the page behind it is not what changed.
        const dialogPicture = async () => {
          await page.locator("dialog[open]").screenshot({
            path: `${STILLS}/delivery-${name}-${label}-${scheme}.png`,
          });
        };
        if (name === "approval-approve") {
          await button(now, "Approve").click();
          await expect(page.getByRole("alertdialog")).toBeVisible();
          return await dialogPicture();
        }
        if (name === "approval-changes") {
          await button(now, "Request changes").click();
          await page.getByLabel("What should change?").fill(
            "Validate the refund amount against the original charge.",
          );
          await expect(page.locator("dialog[open]")).toBeVisible();
          return await dialogPicture();
        }
        if (name === "approval-reject") {
          await button(now, "Reject").click();
          await expect(page.getByRole("alertdialog")).toBeVisible();
          return await dialogPicture();
        }
        if (
          name === "approval-approved" || conflict ||
          name === "approval-refused"
        ) {
          await button(now, "Approve").click();
          await button(page.getByRole("alertdialog"), "Approve").click();
          if (name === "approval-refused") {
            await expect(notice(page)).toBeVisible();
          } else {
            await expect(now).toContainText("Approved");
          }
        }
        await section.scrollIntoViewIfNeeded();
        await section.screenshot({
          path: `${STILLS}/delivery-${name}-${label}-${scheme}.png`,
        });
      });
    }
  }
}
