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
import { laneBudgetMs } from "./helpers/lane-budget.ts";

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
  policyDigest: sha("c"),
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
  policyDigest: sha("c"),
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
  policyDigest: sha("c"),
  failedChecks: [],
  blockingFingerprints: fingerprints,
  limits: { maxRepairCycles: 2, maxLoopDurationMs: 600000, maxFindings: 25 },
  createdAt: at(4 + ordinal),
  updatedAt: at(4 + ordinal),
  version: 1,
});

/** A tracked pull request as `pullRequests.list` returns it. */
const pullRequestRow = (
  providerNumber: number,
  over: Record<string, unknown> = {},
) => ({
  id: uuid(600 + providerNumber),
  taskId: id,
  repositoryId: uuid(13),
  runId,
  providerNumber,
  url: `https://github.com/o/r/pull/${providerNumber}`,
  headSha: NEW,
  baseSha: BASE,
  status: "open",
  mergedSha: null,
  createdAt: at(6),
  updatedAt: at(6),
  version: 1,
  // What the server says about merging: may this person, and with what method.
  mayMerge: true,
  mergeMethod: "squash",
  // The branch it merges into: named in the cards and sent when a merge is queued.
  targetBranch: "main",
  ...over,
});

/** A queued merge as `mergeEntries.list` returns it, newest first. */
const mergeEntryRow = (
  status:
    | "queued"
    | "validating"
    | "merging"
    | "merged"
    | "blocked"
    | "canceled",
  over: Record<string, unknown> = {},
) => ({
  id: uuid(900),
  pullRequestId: uuid(600 + 482),
  repositoryId: uuid(13),
  targetBranch: "main",
  expectedHeadSha: NEW,
  expectedBaseSha: BASE,
  status,
  externalEffectId: null,
  runId,
  policyDigest: sha("c"),
  reviewCycleId: reviewId,
  createdAt: at(7),
  updatedAt: at(8),
  version: 1,
  blockedReason: null,
  ...over,
});

/** An entry the queue stopped, with the reason it recorded. */
const stoppedEntry = (blockedReason: string | null) =>
  mergeEntryRow("blocked", { blockedReason });

const mergeAttemptRow = (
  state: "merged" | "refused" | "unknown",
  over: Record<string, unknown> = {},
) => ({
  id: uuid(800),
  pullRequestId: uuid(600 + 482),
  providerNumber: 482,
  repositoryId: uuid(13),
  baseBranch: "main",
  expectedHeadSha: NEW,
  state,
  providerStatus: state === "refused" ? 405 : null,
  mergedSha: state === "merged" ? sha("9") : null,
  createdAt: at(7),
  settledAt: state === "unknown" ? null : at(7),
  ...over,
});

type Scenario = {
  checks: Check[];
  review?: Parameters<typeof reviewRow>[0];
  findings?: ReturnType<typeof findingRow>[];
  decisions?: ReturnType<typeof decisionRow>[];
  /** The task's pull requests, as `pullRequests.list` returns them (oldest first). */
  pullRequests?: ReturnType<typeof pullRequestRow>[];
  /** The chosen pull request's merge attempts, newest first. */
  mergeAttempts?: ReturnType<typeof mergeAttemptRow>[];
  /** The chosen pull request's queued merges, newest first. */
  mergeEntries?: ReturnType<typeof mergeEntryRow>[];
};
const page_ = <T>(items: T[]) => ({ items, nextCursor: null });

const problemBody = (status: number, code: string, reason?: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
  requestId: uuid(110),
  traceId: uuid(111),
  retryable: false,
  // The rule a refused merge names: a conflict or failed precondition only.
  ...(reason === undefined ? {} : { reason }),
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
  /** While true the list read fails with a 500. */
  listFails: boolean;
};

/** Serves the task's approvals and records every decision sent. */
async function mockApprovals(
  page: Page,
  approvals: ApprovalRow[],
  reply?: ApprovalsMock["reply"],
): Promise<ApprovalsMock> {
  const mock: ApprovalsMock = {
    approvals,
    posted: [],
    reply,
    listFails: false,
  };
  await page.route(
    "**/v1/approvals?*",
    (route) =>
      mock.listFails
        ? route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          json: problemBody(500, "INTERNAL_ERROR"),
        })
        : route.fulfill({ json: page_(mock.approvals) }),
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
  // The "After approval" group's read: no pull request unless the scenario
  // serves one, which is the "nothing known" state.
  await page.route(
    "**/v1/pull-requests?*",
    (route) => route.fulfill({ json: page_(scenario.pullRequests ?? []) }),
  );
  // The attempts read: none unless the scenario serves some. Read per request,
  // so a test that settles an attempt changes what the next read returns.
  await page.route(
    "**/v1/merge-attempts?*",
    (route) => route.fulfill({ json: page_(scenario.mergeAttempts ?? []) }),
  );
  // The queued merges: none unless the scenario serves some. Read per request,
  // like the attempts, so a test that queues one changes the next read.
  await page.route(
    "**/v1/merge-entries?*",
    (route) => route.fulfill({ json: page_(scenario.mergeEntries ?? []) }),
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
const approvalStep = (page: Page) => page.getByTestId("delivery-approval-step");

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
  // Beside the text the primary is first; on a phone they are stacked with it last.
  const phone = (page.viewportSize()?.width ?? 1280) <= 743;
  await expect(now.getByRole("button")).toHaveText(
    phone
      ? ["Reject", "Request changes", "Approve"]
      : ["Approve", "Request changes", "Reject"],
  );
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
  // Typing goes into the note, and closing gives focus back to the button.
  await expect(dialog.getByLabel("What should change?")).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(button(now, "Request changes")).toBeFocused();
  await button(now, "Request changes").click();
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
  // The form is not lost: it stays, says why, and cannot be sent again.
  const dialog = page.getByRole("alertdialog", {
    name: "Approve these changes?",
  });
  await expect(dialog.getByTestId("delivery-approval-dialog-notice"))
    .toContainText("You cannot decide this approval.");
  await expect(button(dialog, "Approve")).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
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
  const dialog = page.getByRole("alertdialog", {
    name: "Approve these changes?",
  });
  await button(now, "Approve").click();
  await button(dialog, "Approve").click();
  // The dialog stays open and says so, so asking again is its own button.
  await expect(dialog.getByTestId("delivery-approval-dialog-notice"))
    .toContainText(
      "Bakery could not confirm that this was saved. Send it again; Bakery will not record it twice.",
    );
  await button(dialog, "Approve").click();
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

const FAILURES = [
  {
    status: 500,
    code: "INTERNAL_ERROR",
    says:
      "Bakery could not confirm that this was saved. Send it again; Bakery will not record it twice.",
    sameKey: true,
  },
  {
    status: 422,
    code: "VALIDATION_FAILED",
    says: "The decision could not be sent. Try again.",
    sameKey: false,
  },
] as const;
for (const failure of FAILURES) {
  test(`a failed Request changes send (${failure.status}) keeps the form and its note`, async ({ page }) => {
    await mockRun(page);
    await mockDelivery(page, CLEAN);
    let fail = true;
    const mock = await mockApprovals(
      page,
      [approvalRow()],
      async (route, m) => {
        if (fail) {
          return await route.fulfill({
            status: failure.status,
            contentType: "application/problem+json",
            json: problemBody(failure.status, failure.code),
          });
        }
        const body = route.request().postDataJSON() as Record<string, unknown>;
        m.approvals = m.approvals.map((entry) => ({
          ...entry,
          status: "answered",
          decision: body.decision as string,
          decisionComment: (body.comment as string | undefined) ?? null,
          version: entry.version + 1,
        }));
        return await route.fulfill({ json: m.approvals[0] });
      },
    );
    await page.goto(`/tasks/${id}`);
    const now = nowCard(page);
    await button(now, "Request changes").click();
    const dialog = page.getByRole("dialog", { name: "Request changes" });
    const noteText = "Validate the refund amount against the original charge.";
    await dialog.getByLabel("What should change?").fill(noteText);
    await button(dialog, "Send").click();
    // The form stays, with the note, and says why where the person is looking.
    await expect(dialog.getByTestId("delivery-approval-dialog-notice"))
      .toContainText(failure.says);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("What should change?")).toHaveValue(
      noteText,
    );
    expect(mock.posted).toHaveLength(1);
    fail = false;
    await button(dialog, "Send").click();
    await expect(now).toContainText("Changes were requested");
    expect(mock.posted).toHaveLength(2);
    expect(mock.posted[1]?.body).toEqual(mock.posted[0]?.body);
    // A lost answer is the same decision again; a refusal is a new one.
    if (failure.sameKey) expect(mock.posted[1]?.key).toBe(mock.posted[0]?.key);
    else expect(mock.posted[1]?.key).not.toBe(mock.posted[0]?.key);
  });
}

test("a note over 4000 characters is refused in the form, counted as the server counts, and kept", async ({ page }) => {
  const mock = await openApproval(page);
  const now = nowCard(page);
  await button(now, "Request changes").click();
  const dialog = page.getByRole("dialog", { name: "Request changes" });
  const field = dialog.getByLabel("What should change?");
  const send = button(dialog, "Send");
  await field.fill("a".repeat(4001));
  await expect(dialog).toContainText(
    "The note can be at most 4000 characters; it is 4001 now.",
  );
  await expect(send).toBeDisabled();
  // 2001 emoji are 4002 UTF-16 units, which is what the server counts.
  await field.fill("😀".repeat(2001));
  await expect(dialog).toContainText("it is 4002 now.");
  await expect(send).toBeDisabled();
  expect(mock.posted).toHaveLength(0);
  await field.fill("a".repeat(4000));
  await expect(dialog).not.toContainText("The note can be at most");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(now).toContainText("Changes were requested");
  expect((mock.posted[0]?.body.comment as string).length).toBe(4000);
});

test("a failed approvals read says it could not check, not that nothing is waiting", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  const mock = await mockApprovals(page, [approvalRow()]);
  mock.listFails = true;
  await page.goto(`/tasks/${id}`);
  const now = nowCard(page);
  await expect(now).toContainText(
    "Bakery could not check whether approval is needed",
  );
  await expect(now).not.toContainText("Nothing is waiting for you");
  await expect(now).toHaveAttribute("data-variant", "warning");
  mock.listFails = false;
  await button(now, "Try again").click();
  await expect(now).toContainText("Waiting for approval");
  await expect(now.getByRole("button")).toHaveCount(3);
});

test("an Approve dialog closes when someone else decides, and the card shows what they decided", async ({ page }) => {
  const mock = await openApproval(page);
  const now = nowCard(page);
  await button(now, "Approve").click();
  const dialog = page.getByRole("alertdialog", {
    name: "Approve these changes?",
  });
  await expect(dialog).toBeVisible();
  mock.approvals = mock.approvals.map((entry) => ({
    ...entry,
    status: "answered",
    decision: "reject",
    version: entry.version + 1,
  }));
  // The next read (every five seconds) finds the approval is no longer waiting.
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(now).toContainText("These changes were rejected");
  expect(mock.posted).toHaveLength(0);
});

for (const width of [320, 390, 820, 1280]) {
  test(`the card's answers fit at ${width}px and stack on a phone with Approve last`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApproval(page);
    const section = page.getByTestId("delivery-section");
    const now = nowCard(page);
    expect(
      await section.evaluate((element) =>
        element.scrollWidth <= element.clientWidth
      ),
    ).toBe(true);
    const card = (await now.boundingBox())!;
    const names = ["Approve", "Request changes", "Reject"];
    const boxes = new Map<
      string,
      { x: number; y: number; width: number; height: number }
    >();
    for (const name of names) {
      boxes.set(name, (await button(now, name).boundingBox())!);
    }
    for (const [name, box] of boxes) {
      // Nothing is cut: every button sits inside the card.
      expect(box.x, name).toBeGreaterThanOrEqual(card.x - 1);
      expect(box.x + box.width, name).toBeLessThanOrEqual(
        card.x + card.width + 1,
      );
      expect(box.height, name).toBeGreaterThanOrEqual(44 - 1);
    }
    const approve = boxes.get("Approve")!;
    const changes = boxes.get("Request changes")!;
    const reject = boxes.get("Reject")!;
    if (width <= 743) {
      // Stacked, one under the other, equally wide, the primary last.
      expect(reject.y).toBeLessThan(changes.y);
      expect(changes.y).toBeLessThan(approve.y);
      expect(Math.abs(reject.width - approve.width)).toBeLessThan(2);
      expect(Math.abs(changes.width - approve.width)).toBeLessThan(2);
      expect(approve.width).toBeGreaterThan(width * 0.6);
      // The first answer starts one gap below the text, the gap between answers.
      const text = (await now.getByText(
        "Approving lets Bakery merge these changes.",
      ).boundingBox())!;
      const between = changes.y - (reject.y + reject.height);
      const above = reject.y - (text.y + text.height);
      expect(Math.abs(above - between), "gap above equals the gap between")
        .toBeLessThan(2);
      // Grouping the answers must not move the heading or the text: the
      // heading-to-text gap is the one the Approved card (no answers) has.
      const headingToText = async (body: string) => {
        const heading = (await page.locator("#delivery-now-title")
          .boundingBox())!;
        const line = (await now.getByText(body).boundingBox())!;
        return line.y - (heading.y + heading.height);
      };
      const waitingGap = await headingToText(
        "Approving lets Bakery merge these changes.",
      );
      await button(now, "Approve").click();
      await button(page.getByRole("alertdialog"), "Approve").click();
      await expect(now).toContainText("Approved");
      const approvedGap = await headingToText(
        "Bakery may now merge these changes. Nothing is waiting for you.",
      );
      expect(
        Math.abs(waitingGap - approvedGap),
        "heading-to-text gap is the same with and without answers",
      ).toBeLessThan(1.5);
    } else {
      expect(approve.x).toBeLessThan(changes.x);
      expect(changes.x).toBeLessThan(reject.x);
    }
  });
}

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
const STILLS = process.env.BAKERY_EVIDENCE_DIR ??
  process.env.BAKERY_STILLS_DIR;
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
  "approval-retry",
  "approval-unavailable",
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
        const mock = await mockApprovals(
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
            : name === "approval-retry"
            ? (route) =>
              route.fulfill({
                status: 500,
                contentType: "application/problem+json",
                json: problemBody(500, "INTERNAL_ERROR"),
              })
            : undefined,
        );
        const unavailable = name === "approval-unavailable";
        if (unavailable) mock.listFails = true;
        await page.goto(`/tasks/${id}`);
        const section = page.getByTestId("delivery-section");
        const now = section.getByTestId("delivery-now");
        await expect(now).toContainText(
          unavailable
            ? "Bakery could not check whether approval is needed"
            : "Waiting for approval",
        );
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
        if (name === "approval-retry") {
          // A send that failed keeps the form, the note and says why in it.
          await button(now, "Request changes").click();
          await page.getByLabel("What should change?").fill(
            "Validate the refund amount against the original charge.",
          );
          await button(page.locator("dialog[open]"), "Send").click();
          await expect(page.getByTestId("delivery-approval-dialog-notice"))
            .toBeVisible();
          return await dialogPicture();
        }
        if (
          name === "approval-approved" || conflict ||
          name === "approval-refused"
        ) {
          await button(now, "Approve").click();
          await button(page.getByRole("alertdialog"), "Approve").click();
          if (name === "approval-refused") {
            // The dialog explains first; closing it leaves the card without answers.
            await expect(page.getByTestId("delivery-approval-dialog-notice"))
              .toBeVisible();
            await page.getByRole("alertdialog")
              .getByRole("button", { name: "Cancel" }).click();
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

// ---- the "After approval" group: pull request, merge, and the badge that ends
// the trace (design-ux's #57 "after approval" design, accepted 2026-11-16).

const approvedRow = () =>
  approvalRow({
    status: "answered",
    decision: "approve",
    decidedBy: uuid(1),
    decidedAt: at(6),
  });

const afterApprovalHeading = (page: Page) =>
  page.getByTestId("delivery-section").getByRole("heading", {
    name: "After approval",
  });

const pullRequestStep = (page: Page) =>
  page.getByTestId("delivery-pull-request-step");

const mergeStep = (page: Page) => page.getByTestId("delivery-merge-step");

async function openApproved(page: Page, scenario: Scenario) {
  await mockRun(page);
  await mockDelivery(page, { ...CLEAN, ...scenario });
  await mockApprovals(page, [approvedRow()]);
  await page.goto(`/tasks/${id}`);
  await expect(afterApprovalHeading(page)).toBeVisible();
}

test("before approval the after-approval group and its badge are not drawn", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
  });
  await page.goto(`/tasks/${id}`);
  // A clean candidate with no approval asked: the trace ends at review, so the
  // group that ends it has nothing to stand on yet.
  await expect(
    page.getByTestId("delivery-section").getByRole("list", {
      name: "Delivery steps",
    }),
  ).toBeVisible();
  await expect(afterApprovalHeading(page)).toHaveCount(0);
  await expect(pullRequestStep(page)).toHaveCount(0);
  await expect(mergeStep(page)).toHaveCount(0);
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveCount(0);
});

test("an approved run with a pull request open says so, badges Ready to merge and links to GitHub", async ({ page }) => {
  await openApproved(page, { pullRequests: [pullRequestRow(482)] });
  const section = page.getByTestId("delivery-section");
  await expect(pullRequestStep(page)).toContainText(
    "Pull request #482 is open.",
  );
  await expect(mergeStep(page)).toContainText("Not merged yet.");
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Ready to merge",
  );
  await expect(section).toContainText(
    "Releases are not tracked in Bakery yet.",
  );
  const link = pullRequestStep(page).getByRole("link", {
    name: /Open on GitHub/,
  });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/o/r/pull/482",
  );
  await expect(link).toHaveAttribute("target", "_blank");
});

test("a recorded merge commit is said as Merged as <sha>, confirmed by GitHub, and Copy copies all of it", async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (globalThis as unknown as { copied: string[] }).copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  await openApproved(page, {
    pullRequests: [
      pullRequestRow(482, { status: "merged", mergedSha: sha("9") }),
    ],
  });
  await expect(mergeStep(page)).toContainText(
    `Merged as ${sha("9").slice(0, 7)}, confirmed by GitHub.`,
  );
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText("Merged");
  await button(mergeStep(page), "Copy").click();
  await expect(button(mergeStep(page), "Copied")).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => (globalThis as unknown as { copied: string[] }).copied)
  ).toEqual([sha("9")]);
});

test("a pull request closed without merging is failed, badged Not merged and never called merged", async ({ page }) => {
  await openApproved(page, {
    pullRequests: [pullRequestRow(482, { status: "closed" })],
  });
  await expect(pullRequestStep(page)).toContainText(
    "Pull request #482 was closed without merging.",
  );
  await expect(mergeStep(page)).toContainText("Not merged.");
  await expect(pullRequestStep(page)).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Not merged",
  );
});

test("with no pull request the group says Bakery has seen none and cannot tell whether the work merged", async ({ page }) => {
  await openApproved(page, {});
  await expect(pullRequestStep(page)).toContainText(
    "Bakery has not seen a pull request for this task. If one was opened, check GitHub.",
  );
  await expect(mergeStep(page)).toContainText(
    "Bakery cannot tell whether these changes were merged.",
  );
  await expect(pullRequestStep(page)).toHaveAttribute("data-state", "unknown");
  await expect(mergeStep(page)).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Approved",
  );
  await expect(pullRequestStep(page).getByRole("link")).toHaveCount(0);
});

test("this run's pull request wins, and the task's others open in place, newest first", async ({ page }) => {
  await openApproved(page, {
    pullRequests: [
      pullRequestRow(480, {
        createdAt: "2026-01-01T00:00:01.000Z",
        status: "closed",
      }),
      pullRequestRow(481, {
        createdAt: "2026-01-01T00:00:02.000Z",
        status: "merged",
        mergedSha: sha("9"),
      }),
      pullRequestRow(482),
    ],
  });
  await expect(pullRequestStep(page)).toContainText(
    "Pull request #482 is open.",
  );
  const earlier = page.getByTestId("delivery-earlier-pull-requests");
  // A count the person can open, and nothing listed until they do.
  const control = earlier.getByText("and 2 earlier", { exact: true });
  await expect(control).toBeVisible();
  // A native disclosure: closed, so the rows are neither read nor reached.
  await expect(earlier).not.toHaveAttribute("open");
  const rows = earlier.getByRole("listitem");
  await expect(rows).toHaveCount(0);
  // On a phone the step's own button must not read as the button for the last
  // row: it comes before the list (design-ux, 2026-11-16).
  if ((page.viewportSize()?.width ?? 1280) <= 743) {
    const ownButton = pullRequestStep(page).getByRole("link", {
      name: /Open on GitHub/,
    });
    await expect(ownButton).toHaveCount(1);
    const buttonTop = (await ownButton.boundingBox())?.y ?? 0;
    const controlTop = (await earlier.locator("summary").boundingBox())?.y ?? 0;
    expect(buttonTop).toBeLessThan(controlTop);
  }
  await earlier.locator("summary").click();
  await expect(earlier).toHaveAttribute("open", "");
  await expect(rows).toHaveCount(2);
  // Newest first: #481 before #480, each with its status and its own link.
  await expect(rows.nth(0)).toContainText("#481");
  await expect(rows.nth(0)).toContainText("Merged");
  await expect(rows.nth(1)).toContainText("#480");
  await expect(rows.nth(1)).toContainText("Closed");
  await expect(rows.nth(1).getByRole("link", { name: /Open on GitHub/ }))
    .toHaveAttribute("href", "https://github.com/o/r/pull/480");
  // Pressing it again closes the list.
  await earlier.locator("summary").click();
  await expect(earlier).not.toHaveAttribute("open");
  await expect(rows).toHaveCount(0);
});

test("the after-approval group has no accessibility violations and fits a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApproved(page, {
    pullRequests: [
      pullRequestRow(482, { status: "merged", mergedSha: sha("9") }),
    ],
  });
  const section = page.getByTestId("delivery-section");
  const overflow = await section.evaluate((node) =>
    node.scrollWidth - node.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).include(
    '[data-testid="delivery-section"]',
  ).analyze();
  expect(results.violations).toEqual([]);
});

// ---- stills for design-ux's and QA's review of the after-approval group
// (BAKERY_STILLS_DIR; nothing is written otherwise)

const AFTER_APPROVAL_STILLS = [
  ["pull-request-open", { pullRequests: [pullRequestRow(482)] }],
  [
    "merged",
    {
      pullRequests: [
        pullRequestRow(482, { status: "merged", mergedSha: sha("9") }),
      ],
    },
  ],
  ["closed", { pullRequests: [pullRequestRow(482, { status: "closed" })] }],
  ["nothing-known", {}],
] as const;

for (const [name, scenario] of AFTER_APPROVAL_STILLS) {
  test(`still: after approval, ${name}`, async ({ page }) => {
    test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
    test.setTimeout(laneBudgetMs(120_000));
    for (const scheme of ["light", "dark"] as const) {
      for (
        const [size, width, height] of [["1440", 1440, 900], [
          "390",
          390,
          844,
        ]] as const
      ) {
        const fresh = await page.context().newPage();
        await fresh.emulateMedia({ colorScheme: scheme });
        await fresh.setViewportSize({ width, height });
        await mockRun(fresh);
        await mockDelivery(fresh, { ...CLEAN, ...scenario });
        await mockApprovals(fresh, [approvedRow()]);
        await fresh.goto(`/tasks/${id}`);
        await expect(fresh.getByTestId("delivery-merge-step")).toBeVisible();
        // Framed on the group, so the whole group is in the shot: the step
        // list is taller than the window and clips at its pane otherwise.
        await fresh.getByTestId("delivery-merge-step").scrollIntoViewIfNeeded();
        await fresh.screenshot({
          path: `${STILLS}/after-approval-${name}-${size}-${scheme}.png`,
          animations: "disabled",
        });
        if (size === "1440" && scheme === "light") {
          // The badge sits beside the section's heading, so it is captured with
          // it rather than cropped alone.
          await fresh.getByTestId("delivery-outcome-badge")
            .scrollIntoViewIfNeeded();
          await fresh.screenshot({
            path: `${STILLS}/after-approval-header-${name}.png`,
            animations: "disabled",
          });
        }
        await fresh.close();
      }
    }
  });
}

test("still: the task's other pull requests, closed and opened", async ({ page }) => {
  test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
  test.setTimeout(laneBudgetMs(120_000));
  const earlier = [
    pullRequestRow(480, {
      createdAt: "2026-01-01T00:00:01.000Z",
      status: "closed",
    }),
    pullRequestRow(481, {
      createdAt: "2026-01-01T00:00:02.000Z",
      status: "merged",
      mergedSha: sha("9"),
    }),
    pullRequestRow(482),
  ];
  for (
    const [size, width, height] of [["1440", 1440, 900], [
      "390",
      390,
      844,
    ]] as const
  ) {
    const fresh = await page.context().newPage();
    await fresh.setViewportSize({ width, height });
    await mockRun(fresh);
    await mockDelivery(fresh, { ...CLEAN, pullRequests: earlier });
    await mockApprovals(fresh, [approvedRow()]);
    await fresh.goto(`/tasks/${id}`);
    const disclosure = fresh.getByTestId("delivery-earlier-pull-requests");
    await expect(disclosure).toBeVisible();
    // Closed first, then opened, both framed on the step that carries them.
    for (const scheme of ["light", "dark"] as const) {
      await fresh.emulateMedia({ colorScheme: scheme });
      await disclosure.scrollIntoViewIfNeeded();
      await fresh.screenshot({
        path: `${STILLS}/after-approval-earlier-closed-${size}-${scheme}.png`,
        animations: "disabled",
      });
      await disclosure.locator("summary").click();
      await expect(disclosure.getByRole("listitem").first()).toBeVisible();
      await fresh.screenshot({
        path: `${STILLS}/after-approval-earlier-open-${size}-${scheme}.png`,
        animations: "disabled",
      });
      await disclosure.locator("summary").click();
    }
    await fresh.close();
  }
});

// ---- merging from Bakery (#57).

type Merged = { merges: Array<Record<string, unknown>>; reconciles: number };

/** Opens an approved candidate whose pull request and attempts the test owns. */
async function openMerge(
  page: Page,
  scenario: Scenario,
  answers: {
    merge?: (route: Route) => Promise<void> | void;
    reconcile?: (route: Route) => Promise<void> | void;
    /** Registered after the run mocks, so these answers win. */
    stub?: (page: Page) => Promise<void>;
  } = {},
): Promise<Merged> {
  const seen: Merged = { merges: [], reconciles: 0 };
  await mockRun(page);
  await mockDelivery(page, scenario);
  await answers.stub?.(page);
  await mockApprovals(page, [approvedRow()]);
  // Queuing a merge is a POST to the queue; the list above is a GET.
  await page.route("**/v1/merge-entries", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    seen.merges.push(route.request().postDataJSON() as Record<string, unknown>);
    if (answers.merge) return await answers.merge(route);
    await route.fulfill({ json: mergeEntryRow("queued") });
  });
  await page.route("**/v1/merge-attempts/reconcile", async (route) => {
    seen.reconciles += 1;
    if (answers.reconcile) return await answers.reconcile(route);
    await route.fulfill({ json: { reconciled: 0, merged: 0, refused: 0 } });
  });
  await page.goto(`/tasks/${id}`);
  await expect(afterApprovalHeading(page)).toBeVisible();
  return seen;
}

test("an approved candidate at the reviewed head offers Merge, asks first, and queues the candidate it saw once", async ({ page }) => {
  const scenario: Scenario = { ...CLEAN, pullRequests: [pullRequestRow(482)] };
  const seen = await openMerge(page, scenario, {
    merge: async (route) => {
      // The server queues the merge; the next reads say so.
      scenario.mergeEntries = [mergeEntryRow("queued")];
      await route.fulfill({ json: mergeEntryRow("queued") });
    },
  });
  const now = nowCard(page);
  await expect(now).toContainText("Ready to merge");
  await expect(now).toContainText(
    "Checks and the review passed for commit 91d0aa3, and it was approved.",
  );
  await button(now, "Merge").click();
  const dialog = page.getByRole("alertdialog", {
    name: "Merge pull request #482?",
  });
  await expect(dialog).toContainText(
    "Bakery merges commit 91d0aa3 exactly, as a squash merge.",
  );
  await expect(dialog).toContainText("A merge cannot be undone from Bakery.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(seen.merges).toHaveLength(0);
  await button(now, "Merge").click();
  await button(dialog, "Merge").click();
  // The card becomes the queue's: Bakery checks, then merges, and the person
  // has nothing to do. Focus goes to its title so the change is announced.
  await expect(now).toContainText("Checking before the merge");
  await expect(now.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Merging",
  );
  await expect(mergeStep(page)).toContainText(
    "About to check that nothing changed since the review.",
  );
  expect(seen.merges).toHaveLength(1);
  // The page names the exact head and base it read, the branch, and the run,
  // rules, review and checks behind them. It never chooses any of them.
  expect(seen.merges[0]).toEqual({
    pullRequestId: uuid(600 + 482),
    repositoryId: uuid(13),
    targetBranch: "main",
    expectedHeadSha: NEW,
    expectedBaseSha: BASE,
    runId,
    policyDigest: sha("c"),
    reviewCycleId: reviewId,
    checkRunIds: [uuid(100), uuid(101)],
  });
  await expect(page.locator("#delivery-now-title")).toBeFocused();
});

for (
  const [status, sentence] of [
    ["queued", "About to check that nothing changed since the review."],
    ["validating", "Checking that nothing changed since the review."],
    ["merging", "Merging into main."],
  ] as const
) {
  test(`a ${status} merge is one card with nothing to press, and only the Merge step's sentence says where it is`, async ({ page }) => {
    const seen = await openMerge(page, {
      ...CLEAN,
      pullRequests: [pullRequestRow(482)],
      mergeEntries: [mergeEntryRow(status)],
    });
    const now = nowCard(page);
    await expect(now).toContainText("Checking before the merge");
    await expect(now).toContainText(
      "Bakery is checking that nothing changed since the review, then it merges. Nothing for you to do.",
    );
    await expect(now.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
      "Merging",
    );
    await expect(mergeStep(page)).toContainText(sentence);
    await expect(mergeStep(page)).toHaveAttribute("data-state", "running");
    // The mark says In progress; "Running" is for the run's own steps.
    await expect(mergeStep(page)).toContainText("In progress");
    await expect(mergeStep(page)).not.toContainText("Running");
    // A reload, or another person looking, sees the same.
    await page.reload();
    await expect(nowCard(page)).toContainText("Checking before the merge");
    expect(seen.merges).toHaveLength(0);
  });
}

test("a merging entry whose newest attempt is unknown is the unknown card with Check again", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeEntries: [mergeEntryRow("merging")],
    mergeAttempts: [mergeAttemptRow("unknown")],
  });
  const now = nowCard(page);
  await expect(now).toContainText("Bakery does not know whether this merged");
  await expect(button(now, "Check again")).toBeVisible();
  await expect(now.getByRole("button")).toHaveCount(1);
});

for (
  const [reason, title, text, action, mayMerge] of [
    [
      "head_moved",
      "Not merged: the pull request changed",
      "Bakery merges only what was checked.",
      null,
      true,
    ],
    [
      "base_moved",
      "Not merged: main changed",
      "main got new commits after the checks ran, and Bakery merges only what was checked. Checks and the review need to pass again on top of main.",
      null,
      true,
    ],
    [
      "evidence_changed",
      "Not merged: the review or the rules changed",
      "What was checked no longer matches. The repository's rules or the review changed after the merge was asked for. Checks and the review need to pass again.",
      null,
      true,
    ],
    [
      "checks_not_passed",
      "Not merged: a check no longer passes",
      "GitHub reports a required check that has not passed for commit 91d0aa3. Open the pull request to see which one.",
      "Open on GitHub",
      true,
    ],
    [
      "not_open",
      "Not merged: the pull request is closed",
      "It was closed on GitHub before Bakery could merge it. Nothing was merged.",
      "Open on GitHub",
      true,
    ],
    [
      "not_permitted",
      "Not merged: permission was removed",
      "The person who asked for this merge can no longer merge in this repository. Someone who can merge can start it again.",
      "Merge again",
      true,
    ],
    [
      "not_permitted",
      "Not merged: permission was removed",
      "Someone who can merge can start it again.",
      null,
      false,
    ],
    [
      "unavailable",
      "Not merged: Bakery could not finish",
      "Bakery could not reach GitHub after several tries, so it stopped. Nothing was merged.",
      "Merge again",
      true,
    ],
    [
      null,
      "Bakery did not merge this",
      "The merge was stopped and Bakery was not told why. Open the pull request to check it.",
      "Open on GitHub",
      true,
    ],
  ] as const
) {
  test(`a merge stopped for ${reason}${mayMerge ? "" : " by a reader who may not merge"} says so, with ${action ?? "no button"}`, async ({ page }) => {
    await openMerge(page, {
      ...CLEAN,
      pullRequests: [pullRequestRow(482, { mayMerge })],
      mergeEntries: [stoppedEntry(reason)],
    });
    const now = nowCard(page);
    await expect(now).toContainText(title);
    await expect(now).toContainText(text);
    await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
      "Not merged",
    );
    await expect(mergeStep(page)).toContainText("Bakery did not merge.");
    await expect(mergeStep(page)).toHaveAttribute("data-state", "failed");
    // One primary action, or none: pressing it must be able to help.
    const buttons = now.getByRole("button");
    const links = now.getByRole("link", { name: /Open on GitHub/ });
    await expect(buttons).toHaveCount(action === "Merge again" ? 1 : 0);
    await expect(links).toHaveCount(action === "Open on GitHub" ? 1 : 0);
    if (action === "Merge again") {
      await expect(button(now, "Merge again")).toBeVisible();
    }
    if (action === "Open on GitHub") {
      await expect(links).toHaveAttribute(
        "href",
        "https://github.com/o/r/pull/482",
      );
    }
  });
}

test("Merge again opens the same confirmation as Merge and queues the same candidate", async ({ page }) => {
  const seen = await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeEntries: [stoppedEntry("unavailable")],
  });
  await button(nowCard(page), "Merge again").click();
  const dialog = page.getByRole("alertdialog", {
    name: "Merge pull request #482?",
  });
  await expect(dialog).toContainText(
    "Bakery merges commit 91d0aa3 exactly, as a squash merge.",
  );
  await button(dialog, "Merge").click();
  await expect.poll(() => seen.merges.length).toBe(1);
  expect(seen.merges[0]?.expectedHeadSha).toBe(NEW);
});

test("a merge GitHub did not make brings the Ready card back with the notice and Merge", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeEntries: [stoppedEntry("not_merged")],
  });
  const now = nowCard(page);
  await expect(now).toContainText("Ready to merge");
  await expect(page.getByTestId("delivery-merge-notice")).toContainText(
    "GitHub did not merge it. You can merge again.",
  );
  await expect(button(now, "Merge")).toBeVisible();
});

test("a stopped merge stops showing when the pull request's head changes", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482, { headSha: OLD })],
    mergeEntries: [stoppedEntry("checks_not_passed")],
  });
  const now = nowCard(page);
  await expect(now).toContainText("Not merged: the pull request changed");
  await expect(now).toContainText("now ends at 4be19c2");
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("someone who may not merge is told so and is offered no button", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482, { mayMerge: false })],
  });
  const now = nowCard(page);
  await expect(now).toContainText("Ready to merge");
  await expect(now).toContainText(
    "Someone who can merge in this repository can do it here.",
  );
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("an attempt whose outcome is unknown says so after a reload, offers only Check again, and never Merge", async ({ page }) => {
  const scenario: Scenario = {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeAttempts: [mergeAttemptRow("unknown")],
  };
  const seen = await openMerge(page, scenario);
  const now = nowCard(page);
  await expect(now).toContainText("Bakery does not know whether this merged");
  await expect(now).toContainText(
    "Checking again never sends a second merge.",
  );
  await expect(button(now, "Check again")).toBeVisible();
  await expect(now.getByRole("button", { name: "Merge", exact: true }))
    .toHaveCount(0);
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Merge unknown",
  );
  await expect(mergeStep(page)).toContainText(
    "Bakery cannot tell whether these changes were merged.",
  );
  // A reload shows the same: the answer is read, not remembered by the page.
  await page.reload();
  await expect(nowCard(page)).toContainText(
    "Bakery does not know whether this merged",
  );
  expect(seen.merges).toHaveLength(0);
});

test("Check again settles an unknown merge by reading GitHub and never sends a merge", async ({ page }) => {
  const scenario: Scenario = {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeAttempts: [mergeAttemptRow("unknown")],
  };
  const seen = await openMerge(page, scenario, {
    reconcile: async (route) => {
      scenario.mergeAttempts = [mergeAttemptRow("refused")];
      await route.fulfill({ json: { reconciled: 1, merged: 0, refused: 1 } });
    },
  });
  const now = nowCard(page);
  await button(now, "Check again").click();
  await expect(now).toContainText("GitHub refused the merge");
  await expect(page.getByTestId("delivery-merge-notice")).toContainText(
    "GitHub did not merge it. You can merge again.",
  );
  expect(seen.reconciles).toBe(1);
  expect(seen.merges).toHaveLength(0);
});

test("Check again that cannot reach GitHub keeps the outcome unknown and says so", async ({ page }) => {
  await openMerge(
    page,
    {
      ...CLEAN,
      pullRequests: [pullRequestRow(482)],
      mergeAttempts: [mergeAttemptRow("unknown")],
    },
    {
      reconcile: (route) =>
        route.fulfill({
          status: 502,
          contentType: "application/problem+json",
          json: problemBody(502, "PROVIDER_UNAVAILABLE"),
        }),
    },
  );
  const now = nowCard(page);
  await button(now, "Check again").click();
  await expect(page.getByTestId("delivery-merge-notice")).toContainText(
    "GitHub could not be reached. The outcome is still unknown.",
  );
  await expect(now).toContainText("Bakery does not know whether this merged");
});

test("a refused merge says so, links to GitHub and offers Merge as a secondary action", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
    mergeAttempts: [mergeAttemptRow("refused")],
  });
  const now = nowCard(page);
  await expect(now).toContainText("GitHub refused the merge");
  await expect(mergeStep(page)).toContainText("GitHub refused the merge.");
  await expect(now.getByRole("link", { name: /Open on GitHub/ }))
    .toHaveAttribute("href", "https://github.com/o/r/pull/482");
  await expect(button(now, "Merge")).toBeVisible();
});

test("a pull request that moved after the approval is not offered to merge, and says which commits", async ({ page }) => {
  await openMerge(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482, { headSha: OLD })],
  });
  const now = nowCard(page);
  // Nothing was tried, so the title says what changed, not that a merge failed.
  await expect(now).toContainText(
    "The pull request changed since it was approved",
  );
  await expect(now).toContainText("Commit 91d0aa3 was approved");
  await expect(now).toContainText("now ends at 4be19c2");
  await expect(now.getByRole("button")).toHaveCount(0);
  // The results, review and approval are marked as being for the older commit,
  // not shown as green for the commit the pull request no longer ends at.
  const section = page.getByTestId("delivery-section");
  // One notice, not two: the warning card says it, the steps are marked.
  await expect(section.getByTestId("delivery-out-of-date")).toHaveCount(0);
  await expect(now).toContainText(
    "The results below are for the older commit and no longer count.",
  );
  await expect(now).toContainText(
    "Checks and the review need to pass for 4be19c2, and it needs approving again, before it can merge.",
  );
  await expect(page.getByTestId("delivery-outcome-badge")).toContainText(
    "Changed after approval",
  );
  await expect(section).toContainText("Older commit 91d0aa3");
  // The approval was for that older commit: it says so and promises nothing.
  await expect(page.getByTestId("delivery-approval-step")).toContainText(
    "Approved for older commit 91d0aa3. Commit 4be19c2 needs approving again.",
  );
  await expect(page.getByTestId("delivery-approval-step")).not.toContainText(
    "Bakery may merge these changes",
  );
  // Nothing is re-running: the page must not say the results are running again.
  await expect(section).toContainText("No results for commit 4be19c2.");
  await expect(section).not.toContainText("Running again");
});

for (
  const [name, status, code, reason, says, above] of [
    [
      "the pull request changed under it",
      412,
      "PRECONDITION_FAILED",
      "head_moved",
      "The pull request changed just now. The latest is shown.",
      false,
    ],
    [
      "the review changed under it",
      412,
      "PRECONDITION_FAILED",
      "review_evidence_stale",
      "The pull request changed just now. The latest is shown.",
      false,
    ],
    [
      "another change is merging into the branch",
      409,
      "STATE_CONFLICT",
      "target_merge_in_progress",
      "Another change is merging into main right now. Nothing was started. Try again in a moment.",
      true,
    ],
    [
      "the branch changed",
      412,
      "PRECONDITION_FAILED",
      "base_moved",
      "main changed just now. The latest is shown.",
      true,
    ],
    [
      "the pull request is no longer open",
      409,
      "STATE_CONFLICT",
      "pull_request_not_open",
      "This pull request is no longer open. Nothing was merged.",
      true,
    ],
    [
      "the review has blocking findings",
      409,
      "STATE_CONFLICT",
      "review_findings_blocking",
      "The review has findings that block the merge.",
      true,
    ],
    [
      "a required check has not passed",
      409,
      "STATE_CONFLICT",
      "checks_not_passed",
      "A required check has not passed for commit 91d0aa3.",
      true,
    ],
    [
      "a required check has no result",
      412,
      "PRECONDITION_FAILED",
      "check_runs_missing",
      "A required check has not passed for commit 91d0aa3.",
      true,
    ],
    [
      "this person may not merge",
      403,
      "AUTH_FORBIDDEN",
      undefined,
      "Someone who can merge in this repository can do it here.",
      false,
    ],
    [
      "the pull request is gone",
      404,
      "RESOURCE_NOT_FOUND",
      undefined,
      "The merge was not started. Nothing changed. Try again.",
      false,
    ],
    [
      "of a conflict the page has no words for",
      409,
      "STATE_CONFLICT",
      "something_new",
      "The merge was not started. Nothing changed. Try again.",
      false,
    ],
  ] as const
) {
  test(`a merge refused because ${name} says so once, ${above ? "above" : "in"} the card, and starts nothing`, async ({ page }) => {
    const seen = await openMerge(
      page,
      { ...CLEAN, pullRequests: [pullRequestRow(482)] },
      {
        merge: (route) =>
          route.fulfill({
            status,
            contentType: "application/problem+json",
            json: problemBody(status, code, reason),
          }),
      },
    );
    const now = nowCard(page);
    await button(now, "Merge").click();
    await button(
      page.getByRole("alertdialog", { name: "Merge pull request #482?" }),
      "Merge",
    ).click();
    const notice = page.getByTestId("delivery-merge-notice");
    await expect(notice).toContainText(says);
    await expect(notice).not.toContainText("did not get an answer");
    // The dialog closes with the answer, and nothing was started.
    await expect(page.getByRole("alertdialog")).toBeHidden();
    expect(seen.merges).toHaveLength(1);
    if (above) {
      // A refusal that started nothing is told before the card it leaves as it was.
      const before = await notice.evaluate((element, card) =>
        Boolean(
          element.compareDocumentPosition(
            document.querySelector(`[data-testid="${card}"]`)!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ), "delivery-now");
      expect(before).toBe(true);
    }
  });
}

for (
  const [name, recorded, lands, noticeStays] of [
    [
      "an unsettled attempt",
      "unknown",
      "Bakery does not know whether this merged",
      false,
    ],
    ["a refused attempt", "refused", "GitHub refused the merge", true],
    ["no attempt at all", null, "Ready to merge", true],
  ] as const
) {
  test(`a merge whose answer never arrived reads back ${name}, and never says nothing changed`, async ({ page }) => {
    const scenario: Scenario = {
      ...CLEAN,
      pullRequests: [pullRequestRow(482)],
    };
    const seen = await openMerge(page, scenario, {
      merge: async (route) => {
        // The answer was lost on the way back; the server may have recorded
        // an attempt.
        if (recorded !== null) {
          scenario.mergeAttempts = [mergeAttemptRow(recorded)];
        }
        await route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          json: problemBody(503, "UNAVAILABLE"),
        });
      },
    });
    const now = nowCard(page);
    await button(now, "Merge").click();
    await button(page.getByRole("alertdialog"), "Merge").click();
    // What it recorded is what the card says now.
    await expect(now).toContainText(lands);
    const notice = page.getByTestId("delivery-merge-notice");
    if (noticeStays) {
      await expect(notice).toContainText(
        recorded === null
          ? "Bakery did not get an answer and has no record of a merge attempt. Open the pull request on GitHub to see whether it merged before you merge again."
          : "Bakery did not get an answer, so the merge may or may not have started.",
      );
      await expect(notice).not.toContainText("Nothing changed");
      if (recorded === null) {
        // Above the card, where it is read first.
        const above = await notice.evaluate((element, card) =>
          Boolean(
            element.compareDocumentPosition(
              document.querySelector(`[data-testid="${card}"]`)!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          ), "delivery-now");
        expect(above).toBe(true);
      }
    } else {
      // The card already says exactly this, so the notice would repeat it.
      await expect(notice).toHaveCount(0);
    }
    expect(seen.merges).toHaveLength(1);
  });
}

test("an approved commit with no check results says so, offers no Merge, and never says Ready to merge", async ({ page }) => {
  const seen = await openMerge(page, {
    ...CLEAN,
    checks: [],
    pullRequests: [pullRequestRow(482)],
  });
  const now = nowCard(page);
  await expect(now).toContainText("No check results for this commit");
  await expect(now).toContainText(
    "Bakery merges only what was checked, and it has no check results for commit 91d0aa3. Open the pull request to see its checks.",
  );
  await expect(now).not.toContainText("Ready to merge");
  await expect(now.getByRole("button")).toHaveCount(0);
  await expect(now.getByRole("link", { name: /Open on GitHub/ }))
    .toHaveAttribute("href", "https://github.com/o/r/pull/482");
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveText(
    "Approved",
  );
  expect(seen.merges).toHaveLength(0);
});

test("offline, merging is disabled", async ({ page, context }) => {
  await openMerge(page, { ...CLEAN, pullRequests: [pullRequestRow(482)] });
  await context.setOffline(true);
  await expect(button(nowCard(page), "Merge")).toBeDisabled();
});

test("the merge states have no accessibility violations and fit a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMerge(page, { ...CLEAN, pullRequests: [pullRequestRow(482)] });
  await expect(button(nowCard(page), "Merge")).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > globalThis.innerWidth
  );
  expect(overflow).toBe(false);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

const MERGE_STILLS = [
  ["ready", { pullRequests: [pullRequestRow(482)] }],
  [
    "no-permission",
    { pullRequests: [pullRequestRow(482, { mayMerge: false })] },
  ],
  [
    "unknown",
    {
      pullRequests: [pullRequestRow(482)],
      mergeAttempts: [mergeAttemptRow("unknown")],
    },
  ],
  [
    "refused",
    {
      pullRequests: [pullRequestRow(482)],
      mergeAttempts: [mergeAttemptRow("refused")],
    },
  ],
  ["moved", { pullRequests: [pullRequestRow(482, { headSha: OLD })] }],
  [
    "checking",
    {
      pullRequests: [pullRequestRow(482)],
      mergeEntries: [mergeEntryRow("validating")],
    },
  ],
  [
    "no-checks",
    { checks: [], pullRequests: [pullRequestRow(482)] },
  ],
  [
    "stopped-branch",
    {
      pullRequests: [pullRequestRow(482)],
      mergeEntries: [stoppedEntry("base_moved")],
    },
  ],
  [
    "stopped-check",
    {
      pullRequests: [pullRequestRow(482)],
      mergeEntries: [stoppedEntry("checks_not_passed")],
    },
  ],
  [
    "stopped-unavailable",
    {
      pullRequests: [pullRequestRow(482)],
      mergeEntries: [stoppedEntry("unavailable")],
    },
  ],
] as const;

/**
 * The stills show one consistent state: a finished run on an approved change,
 * and a side panel that loads (nothing to show) instead of reporting an error.
 */
async function stubStillsPage(page: Page) {
  const empty = (route: Route) => route.fulfill({ json: page_([]) });
  for (
    const pattern of [
      "**/v1/conversations/*/messages*",
      "**/v1/conversations/*/turns*",
      "**/v1/conversations/*/participants*",
      "**/v1/plan-revisions*",
      "**/v1/questions*",
      "**/v1/coordination-plans*",
    ]
  ) await page.route(pattern, empty);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: {
          ...run,
          status: "completed",
          finishedAt: "2026-01-01T00:09:00.000Z",
        },
      }),
  );
}

/** The whole delivery section: the steps, the Now card and After approval. */
async function stillOfSection(page: Page, file: string) {
  const section = page.getByTestId("delivery-section");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({
    path: `${STILLS}/${file}`,
    animations: "disabled",
  });
}

const STILL_SIZES = [["1440", 1440, 900], ["390", 390, 844]] as const;
/** Tall enough that the whole section, steps and After approval, is in view. */
const TALL = { "1440": 2400, "390": 3200 } as const;

// One test per still: a fresh page and its own timeout and retry, so a slow or
// crashed page costs one still and not the other seven of its state.
for (const [name, scenario] of MERGE_STILLS) {
  for (const scheme of ["light", "dark"] as const) {
    for (const [size, width, height] of STILL_SIZES) {
      test(`still: merge, ${name}, ${size} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.setTimeout(laneBudgetMs(90_000));
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await openMerge(page, { ...CLEAN, ...scenario }, {
          stub: stubStillsPage,
        });
        await page.setViewportSize({ width, height: TALL[size] });
        await stillOfSection(page, `merge-${name}-${size}-${scheme}.png`);
        await page.setViewportSize({ width, height });
        if (name === "ready") {
          // The confirmation, with the focus ring on Cancel where it lands.
          await button(nowCard(page), "Merge").click();
          const dialog = page.getByRole("alertdialog");
          await dialog.waitFor();
          await expect(button(dialog, "Cancel")).toBeFocused();
          await page.screenshot({
            path: `${STILLS}/merge-confirm-${size}-${scheme}.png`,
            animations: "disabled",
          });
        }
      });
    }
  }
}

for (const scheme of ["light", "dark"] as const) {
  for (const [size, width, height] of STILL_SIZES) {
    test(`still: merge, the branch is busy, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openMerge(
        page,
        { ...CLEAN, pullRequests: [pullRequestRow(482)] },
        {
          stub: stubStillsPage,
          merge: (route) =>
            route.fulfill({
              status: 409,
              contentType: "application/problem+json",
              json: problemBody(
                409,
                "STATE_CONFLICT",
                "target_merge_in_progress",
              ),
            }),
        },
      );
      await button(nowCard(page), "Merge").click();
      await button(page.getByRole("alertdialog"), "Merge").click();
      await expect(page.getByTestId("delivery-merge-notice")).toContainText(
        "Another change is merging into main right now.",
      );
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.setViewportSize({ width, height: TALL[size] });
      await stillOfSection(page, `merge-branch-busy-${size}-${scheme}.png`);
    });
  }
}

for (const scheme of ["light", "dark"] as const) {
  for (const [size, width, height] of STILL_SIZES) {
    test(`still: merge, the answer never arrived, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      const scenario: Scenario = {
        ...CLEAN,
        pullRequests: [pullRequestRow(482)],
      };
      await openMerge(page, scenario, {
        stub: stubStillsPage,
        merge: async (route) => {
          // The answer was lost and nothing was recorded: the read that
          // follows shows the page as it was, with the notice saying why.
          await route.fulfill({
            status: 503,
            contentType: "application/problem+json",
            json: problemBody(503, "UNAVAILABLE"),
          });
        },
      });
      await button(nowCard(page), "Merge").click();
      await button(page.getByRole("alertdialog"), "Merge").click();
      await expect(page.getByTestId("delivery-merge-notice")).toContainText(
        "has no record of a merge attempt",
      );
      await expect(nowCard(page)).toContainText("Ready to merge");
      await page.setViewportSize({ width, height: TALL[size] });
      await stillOfSection(page, `merge-no-answer-${size}-${scheme}.png`);
    });
  }
}
