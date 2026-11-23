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
import { expectReferenceCardUsable } from "./helpers/reference-card.ts";

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
  // Required since #921: the run's pinned environment.
  environment: "live",
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
  handoffManifest: null,
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
  /** The server's reason; passed → verified, anything else → exit_nonzero by default. */
  reason?: string;
  /** `command` unless the check is a repository rule (title, description, commits). */
  kind?: string;
  durationMs?: number | null;
  /** The file version that holds the check's output. */
  evidence?: string | null;
};
const checkRow = (
  {
    name,
    head,
    result,
    minute,
    exitCode = 0,
    reason,
    kind = "command",
    durationMs,
    evidence = null,
  }: Check,
  n: number,
) => ({
  id: uuid(100 + n),
  runId,
  runStepId: null,
  pullRequestId: null,
  checkId: name,
  checkName: name,
  kind,
  ruleKey: kind === "title" ? "changeRequest.semanticTitle" : null,
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
  reason: reason ??
    (result === "passed"
      ? "verified"
      : result === "pending"
      ? "awaiting_result"
      : "exit_nonzero"),
  exitCode: result === "pending" ? null : exitCode,
  durationMs: durationMs !== undefined
    ? durationMs
    : result === "pending"
    ? null
    : 1000,
  outputDigest: null,
  evidenceVersionId: evidence,
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
    /** A person accepted the review anyway. */
    accepted?: { at: string; reason: string; by?: string };
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
  acceptedBy: over.accepted ? uuid(77) : null,
  acceptedByName: over.accepted?.by ?? null,
  acceptedAt: over.accepted?.at ?? null,
  acceptReason: over.accepted?.reason ?? null,
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
  /** The checks a repair was asked to fix, by id. */
  failed: string[] = [],
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
  failedChecks: failed.map((checkId, index) => ({
    checkRunId: uuid(900 + index),
    checkId,
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 1,
  })),
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

/** Opens a disclosure's summary once; a closed one holds its content in the page already. */
const openLink = async (section: Locator, testId: string) => {
  const link = section.getByTestId(testId);
  if ((await link.getAttribute("open")) === null) {
    await link.locator("summary").first().click();
  }
  return link;
};

test("a clean run says nothing is waiting, offers no buttons and lists nothing that needs attention", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  // The side panel loads (nothing to show) rather than reporting an error, so
  // the stills show no banner that has nothing to do with the card.
  await stubSidePanel(page);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section.getByRole("heading", { name: "Delivery", level: 2 }))
    .toBeVisible();
  const now = section.getByTestId("delivery-now");
  await expect(now).toContainText("Nothing is waiting for you");
  await expect(now.getByRole("button")).toHaveCount(0);
  await expect(now).toHaveAttribute("data-variant", "success");
  // The old purpose line is gone: the headline already says where it stands.
  await expect(section).not.toContainText("Whether this change is ready");
  await expect(section).not.toContainText("release");
  // Nothing needs attention, so no list is drawn; what is settled is one short line each.
  await expect(section.getByTestId("delivery-attention")).toHaveCount(0);
  await expect(section.getByTestId("delivery-settled-checks")).toHaveText(
    "2 checks passed",
  );
  await expect(section.getByTestId("delivery-settled-review")).toHaveText(
    "Review found nothing blocking",
  );
  // The step list, its marks and its chips are gone. Two links hold the rest,
  // and "What Bakery tried" is not drawn when nothing was tried.
  await expect(section.getByRole("list", { name: "Delivery steps" }))
    .toHaveCount(0);
  await expect(section.getByTestId("delivery-tried")).toHaveCount(0);
  const details = section.getByTestId("delivery-details");
  await expect(details).not.toHaveAttribute("open");
  await openLink(section, "delivery-details");
  await expect(details).toContainText("Commit 91d0aa3 on top of a7254e7");
  // The commit in the sentence is a reference: keyboard focus opens its card
  // with the whole id.
  const head = details.locator(
    '[data-ui-component="reference"][data-kind="commit"]',
    { hasText: "91d0aa3" },
  ).first();
  await page.keyboard.press("Shift");
  await head.locator(".ui-reference__plain").focus();
  await expect(head.getByRole("group", { name: "Commit" })).toContainText(NEW);
  const refCard = head.getByRole("group", { name: "Commit" });
  await expectReferenceCardUsable(refCard);
  const onPhone = (page.viewportSize()?.width ?? 1440) <= 743;
  // Close is drawn only where the card is the phone sheet.
  await expect(refCard.getByRole("button", { name: "Close" })).toHaveCount(
    onPhone ? 1 : 0,
  );
  if (onPhone) {
    // On a phone the card is the sheet: it rests on the bottom of the window.
    const box = await refCard.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(height - ((box?.y ?? 0) + (box?.height ?? 0))).toBeLessThanOrEqual(
      24,
    );
  }
  if (STILLS !== undefined) {
    const phone = (page.viewportSize()?.width ?? 1440) <= 743;
    // The whole window, not a crop: on a phone the card is a sheet fixed to the
    // window's bottom, which a crop of the Details block would not contain.
    await page.screenshot({
      path: `${STILLS}/delivery-reference-card-${
        phone ? "phone" : "desktop"
      }-light.png`,
    });
  }
  if (onPhone) {
    // Close puts the sheet away, and the message box takes a tap again.
    await refCard.getByRole("button", { name: "Close" }).click();
    await expect(refCard).toHaveCount(0);
    const composer = page.getByPlaceholder("Message this task…");
    await composer.click();
    await expect(composer).toBeFocused();
    // A tap outside the reference also closes the sheet. Focus stays on the id
    // (on iOS a tap on plain text does not blur it), so only the outside-tap
    // handler can close the sheet here.
    await head.locator(".ui-reference__plain").click();
    await expect(refCard).toBeVisible();
    await expect(head.locator(".ui-reference__plain")).toBeFocused();
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      )
    );
    await expect(refCard).toHaveCount(0);
  }
  await expect(details.getByTestId("delivery-checks-rows")).toContainText(
    "tests",
  );
  await expect(details.getByTestId("delivery-checks-rows")).toContainText(
    "lint",
  );
  await expect(details).toContainText(
    "Approved by the reviewing agent · 2 notes, nothing blocking",
  );
  for (
    const absent of ["Fixing", "Pull request", "Release", "Needs attention"]
  ) {
    await expect(section).not.toContainText(absent);
  }
  await expect(
    section.getByRole("button", { name: /approve|reject|request changes/i }),
  ).toHaveCount(0);
});

test("results for an older commit are said once, in the headline, and the card says a fix is running", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, FIXING);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  const now = section.getByTestId("delivery-now");
  await expect(now).toContainText("Bakery is fixing this");
  // No count in the headline: "What Bakery tried" says how many checks each try was asked to fix.
  await expect(now).toContainText(
    "It is working on the problems it found. Nothing for you to do yet.",
  );
  await expect(now).not.toContainText(/\d+ checks?\. Nothing/);
  await expect(now).toHaveAttribute("data-variant", "information");
  // The count never breaks across lines ("try 1 of" / "2" on a phone).
  expect(await now.getByRole("heading").textContent()).toContain(
    "try\u00a01\u00a0of\u00a02",
  );
  // One state, one place: no second notice and no "Older commit" chip repeat it.
  await expect(section.getByTestId("delivery-out-of-date")).toHaveCount(0);
  await expect(section.getByText(/^Older commit [0-9a-f]{7}$/)).toHaveCount(0);
  // Results that no longer count are never drawn as passed, and the old
  // commit's findings are not a thing to attend to now.
  await expect(section.getByTestId("delivery-attention")).toHaveCount(0);
  // One check so far: "check", not "checks".
  await expect(section.getByTestId("delivery-settled-checks")).toHaveText(
    "0 of 1 check finished",
  );
  const details = await openLink(section, "delivery-details");
  await expect(details).toContainText("Earlier results, for commit 4be19c2");
  // A check still running has no time yet; it is not a repository rule.
  await expect(details.getByTestId("delivery-checks-rows").first()).not
    .toContainText("Repository rule");
  const tried = await openLink(section, "delivery-tried");
  await expect(tried).toContainText("Try 1");
});

test("a stopped run names the reason once, lists what remains, and its one button moves focus to the message box", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, STOPPED);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  const now = section.getByTestId("delivery-now");
  await expect(now).toContainText("Bakery could not fix this");
  await expect(now).toContainText(
    "It stopped after 2 tries. Nothing was merged. Send a message to say what to do next.",
  );
  await expect(now).toHaveAttribute("data-variant", "warning");
  // What remains is in the list, not in the headline.
  const attention = section.getByTestId("delivery-attention");
  await expect(attention).toContainText("Needs attention");
  await expect(attention).toContainText("Review finding");
  await expect(attention).toContainText(
    "Refund amount is not validated against the original charge.",
  );
  // The tries are behind a closed link, and the try count is said nowhere else.
  const tried = section.getByTestId("delivery-tried");
  await expect(tried).not.toHaveAttribute("open");
  await openLink(section, "delivery-tried");
  await expect(tried).toContainText("Try 2");
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
  await expect(section.getByTestId("delivery-settled")).toHaveCount(0);
  await expect(section.getByTestId("delivery-details")).toHaveCount(0);
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
  await expect(section.getByTestId("delivery-settled")).toBeVisible();
});

test("a run with no changes yet draws no delivery section", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, { checks: [] });
  await page.goto(`/tasks/${id}`);
  // The run section is drawn (its heading), and it has no Delivery part.
  await expect(page.getByRole("heading", { name: "Current run" }))
    .toBeVisible();
  await expect(page.getByTestId("delivery-section")).toHaveCount(0);
});

test("the section has no accessibility violations and fits a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRun(page);
  await mockDelivery(page, FIXING);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section.getByTestId("delivery-settled")).toBeVisible();
  // Both links open, so the whole section is what is checked.
  await openLink(section, "delivery-details");
  await openLink(section, "delivery-tried");
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

async function openApproval(page: Page, approvals = [approvalRow()]) {
  await mockRun(page);
  await mockDelivery(page, CLEAN);
  const mock = await mockApprovals(page, approvals);
  await page.goto(`/tasks/${id}`);
  await expect(nowCard(page)).toContainText("Ready for your approval");
  return mock;
}

test("an open approval asks for a decision with three visible answers, Approve first", async ({ page }) => {
  await openApproval(page);
  const now = nowCard(page);
  await expect(now).toContainText("Approving lets Bakery merge these changes.");
  // The headline says it is ready for approval, once; no other line repeats it.
  await expect(now).toContainText("Ready for your approval");
  await expect(now).toHaveAttribute("data-variant", "warning");
  // Beside the text the primary is first; on a phone they are stacked with it last.
  const phone = (page.viewportSize()?.width ?? 1280) <= 743;
  await expect(now.getByRole("button")).toHaveText(
    phone
      ? ["Reject", "Request changes", "Approve"]
      : ["Approve", "Request changes", "Reject"],
  );
  await expect(now.getByRole("button", { name: "More" })).toHaveCount(0);
  // The approval is the headline and its three answers: no step repeats it.
  const section = page.getByTestId("delivery-section");
  await expect(section.getByRole("list", { name: "Delivery steps" }))
    .toHaveCount(0);
  await expect(section.getByTestId("delivery-attention")).toHaveCount(0);
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
  await expect(now).toContainText("Ready for your approval");
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
    "Nothing is waiting for you",
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
  await expect(now).toContainText("Ready for your approval");
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
      // They span the banner, under the icon as well as the text, the way
      // "Tell Bakery what to change" does in the other headlines.
      for (const [name, box] of boxes) {
        expect(box.width, name).toBeGreaterThan(card.width - 40);
        expect(box.x - card.x, name).toBeLessThan(24);
      }
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
        await expect(section.getByTestId("delivery-now")).toBeVisible();
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
            : "Ready for your approval",
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

/** The pull request, once approved, is one link on the settled line. */
const pullRequestLine = (page: Page) =>
  page.getByTestId("delivery-pull-request-line");

/** The merge sentence and commit live in Details; a closed link keeps them in the page. */
const mergeStep = (page: Page) => page.getByTestId("delivery-details");

async function openApproved(page: Page, scenario: Scenario) {
  await mockRun(page);
  await mockDelivery(page, { ...CLEAN, ...scenario });
  await mockApprovals(page, [approvedRow()]);
  await page.goto(`/tasks/${id}`);
  await expect(nowCard(page)).toBeVisible();
}

test("before approval no pull request line and no merge sentence are drawn", async ({ page }) => {
  await mockRun(page);
  await mockDelivery(page, {
    ...CLEAN,
    pullRequests: [pullRequestRow(482)],
  });
  await page.goto(`/tasks/${id}`);
  // A clean candidate with no approval asked: the trace ends at review, so
  // nothing about a pull request stands yet.
  await expect(nowCard(page)).toBeVisible();
  await expect(pullRequestLine(page)).toHaveCount(0);
  await expect(mergeStep(page)).not.toContainText("Not merged yet.");
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveCount(0);
});

test("an approved run with a pull request open links to it from the settled line", async ({ page }) => {
  await openApproved(page, { pullRequests: [pullRequestRow(482)] });
  // The line reads "Pull request #482" and the number is the reference link.
  await expect(pullRequestLine(page)).toContainText("Pull request #482");
  const link = pullRequestLine(page).getByRole("link", { name: /#482/ });
  await expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/482");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(mergeStep(page)).toContainText("Not merged yet.");
  // Said once: the "Release" note and the outcome badge are gone.
  await expect(page.getByTestId("delivery-section")).not.toContainText(
    "Releases are not tracked in Bakery yet.",
  );
  await expect(page.getByTestId("delivery-outcome-badge")).toHaveCount(0);
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
  await openLink(page.getByTestId("delivery-section"), "delivery-details");
  await button(mergeStep(page), "Copy").click();
  await expect(button(mergeStep(page), "Copied")).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => (globalThis as unknown as { copied: string[] }).copied)
  ).toEqual([sha("9")]);
});

test("a pull request closed without merging is never called merged", async ({ page }) => {
  await openApproved(page, {
    pullRequests: [pullRequestRow(482, { status: "closed" })],
  });
  await expect(mergeStep(page)).toContainText("Not merged.");
  await expect(mergeStep(page)).not.toContainText("Merged as");
  await expect(pullRequestLine(page)).toContainText("Pull request #482");
});

test("with no pull request Bakery draws none and says it cannot tell whether the work merged", async ({ page }) => {
  await openApproved(page, {});
  await expect(mergeStep(page)).toContainText(
    "Bakery cannot tell whether these changes were merged.",
  );
  await expect(pullRequestLine(page)).toHaveCount(0);
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
  await expect(pullRequestLine(page)).toContainText("Pull request #482");
  await openLink(page.getByTestId("delivery-section"), "delivery-details");
  const earlier = page.getByTestId("delivery-earlier-pull-requests");
  // A count the person can open, and nothing listed until they do.
  const control = earlier.getByText("and 2 earlier", { exact: true });
  await expect(control).toBeVisible();
  // A native disclosure: closed, so the rows are neither read nor reached.
  await expect(earlier).not.toHaveAttribute("open");
  const rows = earlier.getByRole("listitem");
  await expect(rows).toHaveCount(0);
  await earlier.locator("summary").click();
  await expect(earlier).toHaveAttribute("open", "");
  await expect(rows).toHaveCount(2);
  // Newest first: #481 before #480, each with its status and its own link.
  await expect(rows.nth(0)).toContainText("#481");
  await expect(rows.nth(0)).toContainText("Merged");
  await expect(rows.nth(1)).toContainText("#480");
  await expect(rows.nth(1)).toContainText("Closed");
  await expect(rows.nth(1).getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/o/r/pull/480",
  );
  // Pressing it again closes the list.
  await earlier.locator("summary").click();
  await expect(earlier).not.toHaveAttribute("open");
  await expect(rows).toHaveCount(0);
});

test("the settled line and Details after approval have no accessibility violations and fit a 390px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApproved(page, {
    pullRequests: [
      pullRequestRow(482, { status: "merged", mergedSha: sha("9") }),
    ],
  });
  const section = page.getByTestId("delivery-section");
  await openLink(section, "delivery-details");
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
        await expect(fresh.getByTestId("delivery-now")).toBeVisible();
        // The section is framed whole, with Details open so the merge sentence
        // and commit are in the shot.
        await openLink(
          fresh.getByTestId("delivery-section"),
          "delivery-details",
        );
        await fresh.getByTestId("delivery-section").scrollIntoViewIfNeeded();
        await fresh.screenshot({
          path: `${STILLS}/after-approval-${name}-${size}-${scheme}.png`,
          animations: "disabled",
        });
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
    await openLink(fresh.getByTestId("delivery-section"), "delivery-details");
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
  await expect(nowCard(page)).toBeVisible();
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
    await expect(mergeStep(page)).toContainText(sentence);
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
    await expect(mergeStep(page)).toContainText("Bakery did not merge.");
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
  // One notice, not two: the warning card says it, and no second banner or
  // "Older commit" chip repeats it.
  await expect(section.getByTestId("delivery-out-of-date")).toHaveCount(0);
  await expect(section.getByText(/^Older commit [0-9a-f]{7}$/)).toHaveCount(0);
  await expect(now).toContainText(
    "The results below are for the older commit and no longer count.",
  );
  await expect(now).toContainText(
    "Checks and the review need to pass for 4be19c2, and it needs approving again, before it can merge.",
  );
  // The earlier results are kept, labelled, inside Details.
  const details = await openLink(section, "delivery-details");
  await expect(details).toContainText("Earlier results, for commit 91d0aa3");
  // Nothing is re-running: the page must not say the results are running again.
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
async function stubSidePanel(page: Page) {
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
}

async function stubStillsPage(page: Page) {
  await stubSidePanel(page);
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

// ---------------------------------------------------------------- #57: checks, tries, acceptance

const OUTPUT_VERSION = uuid(950);
/** One of each: a failed command with its output, a pass, a broken rule, a check that could not run. */
const REASONS: Scenario = {
  ...CLEAN,
  checks: [
    {
      name: "tests",
      head: NEW,
      result: "failed",
      minute: 1,
      exitCode: 2,
      durationMs: 134_000,
      evidence: OUTPUT_VERSION,
    },
    { name: "lint", head: NEW, result: "passed", minute: 1 },
    {
      name: "pull request title",
      head: NEW,
      result: "failed",
      minute: 1,
      kind: "title",
      reason: "rule_violation",
      durationMs: null,
    },
    {
      name: "security scan",
      head: NEW,
      result: "unavailable",
      minute: 1,
      reason: "tool_missing",
      exitCode: null,
      durationMs: null,
    },
  ],
};
/** Two repairs, the second still running; the first was asked to fix a check and a finding. */
const TRIES: Scenario = {
  checks: [
    { name: "tests", head: OLD, result: "failed", minute: 1, exitCode: 1 },
    { name: "lint", head: OLD, result: "failed", minute: 1, exitCode: 1 },
    { name: "tests", head: NEW, result: "pending", minute: 5 },
  ],
  review: {
    head: OLD,
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
    decisionRow(0, "repair", "repair_selected", OLD, [sha("1")], ["tests"]),
    decisionRow(1, "repair", "repair_selected", NEW, [], ["tests", "lint"]),
  ],
};
const ACCEPTED: Scenario = {
  ...STOPPED,
  review: {
    head: NEW,
    status: "changes_requested",
    findings: 1,
    blocking: 1,
    minute: 2,
    accepted: {
      at: "2026-01-01T12:00:00.000Z",
      reason: "The finding is about generated code.",
      by: "Ana Ruiz",
    },
  },
};

/**
 * The rows of one of the section's tables: table rows on a desktop, and on a
 * phone the one card per row that the same table draws (`phone` renderer).
 */
const rowsOf = (page: Page, within: Locator) =>
  within.getByRole(
    (page.viewportSize()?.width ?? 1280) <= 743 ? "listitem" : "row",
  );

async function openDelivery(page: Page, scenario: Scenario) {
  await mockRun(page);
  await mockDelivery(page, scenario);
  await page.goto(`/tasks/${id}`);
  const section = page.getByTestId("delivery-section");
  await expect(section).toBeVisible();
  return section;
}

test("what needs attention lists each check that did not pass with its reason, and everything settled is counted", async ({ page }) => {
  const section = await openDelivery(page, REASONS);
  const now = section.getByTestId("delivery-now");
  // Failed, could not run: counted once, in the title, as not passed.
  await expect(now).toContainText("3 checks did not pass");
  await expect(now).toContainText(
    "The change stays blocked. Send a message to say what to do next.",
  );
  const attention = section.getByTestId("delivery-attention");
  await expect(attention).toContainText("Needs attention");
  const row = (name: string) =>
    rowsOf(page, attention).filter({ hasText: name });
  // A failed command always says it ended with an error; its exit code is in Details.
  await expect(row("tests")).toContainText("Ended with an error.");
  await expect(row("tests")).not.toContainText("exit code");
  await expect(row("tests").getByRole("link", { name: "Open the output" }))
    .toHaveAttribute("href", `/files/versions/${OUTPUT_VERSION}`);
  // A broken rule links to the rules, and says its sentence once.
  await expect(row("pull request title")).toContainText(
    "Does not follow the repository's rule.",
  );
  await expect(row("pull request title")).not.toContainText(
    "A repository rule.",
  );
  await expect(
    row("pull request title").getByRole("link", {
      name: "Open repository rules",
    }),
  ).toBeVisible();
  await expect(row("security scan")).toContainText(
    "The tool it needs is not on the machine.",
  );
  // The pass is counted on one line and is not a row.
  await expect(attention).not.toContainText("lint");
  await expect(section.getByTestId("delivery-settled-checks")).toHaveText(
    "1 check passed",
  );
  // Details lists every check with its result, time and exit code.
  const details = await openLink(section, "delivery-details");
  const all = details.getByTestId("delivery-checks-rows");
  await expect(rowsOf(page, all).filter({ hasText: "tests" })).toContainText(
    "2 min 14 s",
  );
  await expect(rowsOf(page, all).filter({ hasText: "tests" })).toContainText(
    "2",
  );
  await expect(rowsOf(page, all).filter({ hasText: "lint" })).toContainText(
    "Passed",
  );
  // The time and the exit code are bare numbers, so on a wide screen this one
  // table names its columns; a phone's cards say "Exit code" in the row.
  const wide = (page.viewportSize()?.width ?? 1280) > 743;
  for (const name of ["Check", "Result", "Took", "Exit code"]) {
    const heading = all.getByRole("columnheader", { name });
    if (wide) await expect(heading).toBeVisible();
    else await expect(heading).toHaveCount(0);
  }
  if (wide) {
    // A heading row hidden for screen readers is still "visible" to Playwright
    // but its table head is one pixel tall; a drawn one is a readable row.
    const head = (await all.locator("thead").boundingBox())!;
    expect(head.height).toBeGreaterThan(16);
  }
});

test("a check list of more than five rows folds under Show all", async ({ page }) => {
  const many: Scenario = {
    ...CLEAN,
    checks: ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({
      name,
      head: NEW,
      result: "failed" as const,
      minute: 1,
      exitCode: 1,
    })),
  };
  const section = await openDelivery(page, many);
  const attention = section.getByTestId("delivery-attention");
  const rows = rowsOf(page, attention.getByTestId("delivery-attention-rows"));
  // A table also has its heading row; a phone's cards do not.
  const heading = (page.viewportSize()?.width ?? 1280) <= 743 ? 0 : 1;
  // Five rows; Show all brings the rest.
  await expect(rows).toHaveCount(5 + heading);
  await attention.getByRole("button", { name: "Show all" }).click();
  await expect(rows).toHaveCount(7 + heading);
  await expect(attention.getByRole("button", { name: "Show all" }))
    .toHaveCount(0);
});

test("what Bakery tried lists every try, newest first, behind one closed link", async ({ page }) => {
  const section = await openDelivery(page, TRIES);
  const tried = section.getByTestId("delivery-tried");
  await expect(tried).not.toHaveAttribute("open");
  await openLink(section, "delivery-tried");
  const rows = rowsOf(page, tried.getByTestId("delivery-tried-rows"));
  await expect(rows.filter({ hasText: "Try 2" })).toContainText(
    "Asked to fix 2 checks that did not pass (tests and lint).",
  );
  await expect(rows.filter({ hasText: "Try 2" })).toContainText("91d0aa3");
  await expect(rows.filter({ hasText: "Try 1" })).toContainText(
    "Asked to fix 1 check that did not pass (tests) and 1 blocking finding.",
  );
  await expect(rows.filter({ hasText: "Try 1" })).toContainText("4be19c2");
  // No "Running" or "Finished" chip, and no "of 2" on the rows.
  await expect(tried.getByTestId("delivery-tried-rows")).not.toContainText(
    "Finished",
  );
  await expect(tried).toContainText(
    "Bakery stops after 2 tries or 10 minutes, whichever comes first.",
  );
  // The headline says the try count once.
  await expect(section.getByTestId("delivery-now")).toContainText(
    "try\u00a02\u00a0of\u00a02",
  );
});

test("a review accepted anyway is one line with who, when and why, and leaves nothing remaining", async ({ page }) => {
  const section = await openDelivery(page, ACCEPTED);
  const line = section.getByTestId("delivery-review-accepted");
  await expect(line).toContainText("Review accepted anyway");
  await expect(line).toContainText("by Ana Ruiz on Jan 1, 2026");
  await expect(line).toContainText("“The finding is about generated code.”");
  // The accepted finding is not a thing to attend to, and the run is not stopped.
  await expect(section.getByTestId("delivery-attention")).toHaveCount(0);
  await expect(section.getByTestId("delivery-now")).not.toContainText(
    "Bakery could not fix this",
  );
  await page.goto("about:blank");
  const clean = await openDelivery(page, CLEAN);
  await expect(clean.getByTestId("delivery-review-accepted")).toHaveCount(0);
});

// One still per state, size and scheme, like the merge stills above.
for (
  const [name, scenario] of [
    ["reasons", REASONS],
    ["tries", TRIES],
    ["accepted", ACCEPTED],
  ] as const
) {
  for (const scheme of ["light", "dark"] as const) {
    for (const [size, width, height] of STILL_SIZES) {
      test(`still: checks, ${name}, ${size} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.setTimeout(laneBudgetMs(90_000));
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await openDelivery(page, scenario);
        await page.setViewportSize({ width, height: TALL[size] });
        await stillOfSection(page, `checks-${name}-${size}-${scheme}.png`);
      });
    }
  }
}

// ---------------------------------------------------------------- #57: design-ux first pass

/** One repair, running: it was asked to fix one check and one blocking finding. */
const FIXING_ONE: Scenario = {
  ...TRIES,
  decisions: [
    decisionRow(0, "repair", "repair_selected", OLD, [sha("1")], ["tests"]),
  ],
};

test("the fixing headline names what the running try was asked to fix", async ({ page }) => {
  const section = await openDelivery(page, FIXING_ONE);
  const now = section.getByTestId("delivery-now");
  await expect(now).toContainText(
    "It is working on 1 failed check and 1 review finding. Nothing for you to do yet.",
  );
  // Not the last try: nothing about what happens if it fails.
  await expect(now).not.toContainText("If this try fails");
  await page.goto("about:blank");
  // The last try says what happens next, and counts its own checks.
  const last = await openDelivery(page, TRIES);
  await expect(last.getByTestId("delivery-now")).toContainText(
    "It is working on 2 failed checks. Nothing for you to do yet. If this try fails, Bakery stops and asks you.",
  );
});

test(
  "the reason takes the width the name does not, in the body colour, and the link ends the row",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "the table is a desktop layout",
    );
    const section = await openDelivery(page, STOPPED);
    const attention = section.getByTestId("delivery-attention");
    // The first row is the table's own (hidden) heading row.
    const cells = rowsOf(page, attention.getByTestId("delivery-attention-rows"))
      .nth(1).getByRole("cell");
    const [name, why] = [
      await cells.nth(0).boundingBox(),
      await cells.nth(1).boundingBox(),
    ];
    expect(name).not.toBeNull();
    expect(why).not.toBeNull();
    // The reason has clearly more room than the name (not equal thirds).
    expect(why!.width).toBeGreaterThan(name!.width * 1.2);
    // The whole finding is on screen: nothing is cut behind Show all.
    await expect(attention.getByRole("button", { name: "Show all" }))
      .toHaveCount(0);
    const finding = attention.getByText(
      "Refund amount is not validated against the original charge.",
    );
    await expect(finding).toBeVisible();
    // The body colour, not the muted grey of a caption.
    const colours = await finding.evaluate((node) => {
      const body = getComputedStyle(document.body).color;
      return [getComputedStyle(node).color, body];
    });
    expect(colours[0]).toBe(colours[1]);
  },
);

test(
  "on a phone the headline button is as wide as the headline",
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a phone layout");
    const section = await openDelivery(page, STOPPED);
    const now = (await section.getByTestId("delivery-now").boundingBox())!;
    const button = (await section.getByTestId("delivery-now")
      .getByRole("button", { name: "Tell Bakery what to change" })
      .boundingBox())!;
    // Full width inside the banner's own padding, and a 44px target.
    expect(button.width).toBeGreaterThan(now.width - 64);
    expect(button.height).toBeGreaterThanOrEqual(44);
  },
);

test(
  "the two links share one row, and the one that opens takes the whole row",
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "a wide-screen layout");
    const section = await openDelivery(page, STOPPED);
    const summary = (testId: string) =>
      section.getByTestId(testId).locator("summary").first();
    const tried = (await summary("delivery-tried").boundingBox())!;
    const details = (await summary("delivery-details").boundingBox())!;
    expect(Math.abs(tried.y - details.y)).toBeLessThan(4);
    expect(details.x).toBeGreaterThan(tried.x + tried.width);
    // Open, "What Bakery tried" has the section's width, and Details moves under it.
    await openLink(section, "delivery-tried");
    const open = (await section.getByTestId("delivery-tried").boundingBox())!;
    const attention =
      (await section.getByTestId("delivery-attention").boundingBox())!;
    expect(open.width).toBeGreaterThan(attention.width * 0.9);
    const moved = (await summary("delivery-details").boundingBox())!;
    expect(moved.y).toBeGreaterThan(open.y + open.height - 4);
  },
);

test("a long accepted-anyway line wraps beside its icon, not under it", async ({ page }) => {
  const section = await openDelivery(page, {
    ...ACCEPTED,
    review: {
      ...ACCEPTED.review!,
      accepted: {
        at: "2026-01-01T12:00:00.000Z",
        reason:
          "The finding is about generated code that nobody edits by hand, so the check is noise here and the team agreed to accept it for this change.",
        by: "Ana Ruiz",
      },
    },
  });
  const line = section.getByTestId("delivery-review-accepted");
  const icon = (await line.locator(".ui-icon").first().boundingBox())!;
  const text = (await line.locator(".ui-text").first().boundingBox())!;
  // Every line of the text starts to the right of the icon.
  expect(text.x).toBeGreaterThanOrEqual(icon.x + icon.width - 1);
  expect(text.height).toBeGreaterThan(24);
});

// The states design-ux asked to see with both links open, desktop and phone.
for (
  const [name, scenario, approve] of [
    ["tried", STOPPED, false],
    ["out-of-date", FIXING, false],
    ["approval", CLEAN, true],
    ["first-check", {
      checks: [{
        name: "tests",
        head: NEW,
        result: "pending" as const,
        minute: 1,
      }],
    }, false],
  ] as const
) {
  for (const scheme of ["light", "dark"] as const) {
    for (const [size, width, height] of STILL_SIZES) {
      test(`still: open, ${name}, ${size} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.setTimeout(laneBudgetMs(90_000));
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await mockRun(page);
        await mockDelivery(page, scenario);
        if (approve) await mockApprovals(page, [approvalRow()]);
        await page.goto(`/tasks/${id}`);
        const section = page.getByTestId("delivery-section");
        await expect(section.getByTestId("delivery-now")).toBeVisible();
        // Both links open: "What Bakery tried" exists once a repair was tried.
        const tried = (scenario.decisions ?? []).some((entry) =>
          entry.decision === "repair"
        );
        if (tried) await openLink(section, "delivery-tried");
        await openLink(section, "delivery-details");
        if (tried) {
          await expect(section.getByTestId("delivery-tried")).toHaveAttribute(
            "open",
            "",
          );
        }
        await page.setViewportSize({ width, height: TALL[size] });
        await stillOfSection(page, `open-${name}-${size}-${scheme}.png`);
      });
    }
  }
}
