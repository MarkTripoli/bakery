import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";

registerPageHealth(test);

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = uuid(12);
const runId = uuid(20);
const doneStepId = uuid(21);
const waitingStepId = uuid(22);
const approvalId = uuid(50);
const BASE = "a7254e7".padEnd(40, "c");
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const run = {
  id: runId,
  taskId: id,
  workflowVersionId: uuid(23),
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
  environment: "live",
  status: "running",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  version: 4,
  waitingOnModel: false,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd: "10",
      reservedUsd: "2",
      settledUsd: "1",
      availableUsd: "7",
      unknownCount: 0,
    },
  },
};
const stepRow = (stepId: string, stepKey: string, status: string) => ({
  id: stepId,
  runId,
  stepKey,
  iteration: 1,
  status,
  input: {},
  output: null,
  error: null,
  startedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: null,
  createdAt: stepKey === "design"
    ? "2026-01-01T00:00:02.000Z"
    : "2026-01-01T00:00:03.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  version: 1,
  handoffManifest: null,
});
const task = {
  id,
  applicationId: uuid(4),
  repositoryId: uuid(5),
  conversationId: uuid(6),
  parentTaskId: null,
  title: "Add invoice export",
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
const approval = (over: Record<string, unknown> = {}) => ({
  id: approvalId,
  kind: "approval",
  taskId: id,
  conversationId: uuid(6),
  turnId: null,
  runId: null,
  prompt: "Approve the design before Bakery builds.",
  status: "open",
  subjectType: "run_step",
  subjectId: runId,
  subjectDigest: "d".repeat(64),
  scope: null,
  policyDigest: "e".repeat(64),
  decision: null,
  decisionComment: null,
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  consumedByRunId: null,
  revokedAt: null,
  revokedBy: null,
  expiresAt: iso(7 * 86_400_000 + 60_000),
  createdAt: iso(-60_000),
  updatedAt: iso(-60_000),
  version: 1,
  ...over,
});
const problem = (status: number, code: string, reason?: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
  requestId: uuid(110),
  traceId: uuid(111),
  retryable: false,
  ...(reason === undefined ? {} : { reason }),
});
const list = <T>(items: T[]) => ({ items, nextCursor: null });

type State = {
  approvals: ReturnType<typeof approval>[];
  decisions: { key: string | undefined; body: Record<string, unknown> }[];
  reply?: (route: Route) => Promise<void>;
};

async function open(page: Page): Promise<State> {
  const state: State = { approvals: [approval()], decisions: [] };
  await mockAuthenticatedSession(page);
  await page.route(`**/v1/tasks/${id}`, (r) => r.fulfill({ json: task }));
  await page.route(`**/v1/runs/${runId}`, (r) => r.fulfill({ json: run }));
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (r) =>
      r.fulfill({
        json: list([
          stepRow(doneStepId, "design", "completed"),
          stepRow(waitingStepId, "signoff", "waiting"),
        ]),
      }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (r) =>
    r.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: true,
          reason: "allowed",
        })),
      },
    }));
  const empty = (r: Route) => r.fulfill({ json: list([]) });
  for (
    const pattern of [
      "**/v1/artifacts?*",
      "**/v1/conversations/*/messages*",
      "**/v1/conversations/*/turns*",
      "**/v1/conversations/*/participants*",
      "**/v1/plan-revisions*",
      "**/v1/questions*",
      "**/v1/coordination-plans*",
      "**/v1/pull-requests?*",
      "**/v1/merge-attempts?*",
      `**/v1/runs/${runId}/checks*`,
      `**/v1/runs/${runId}/reviews*`,
      `**/v1/runs/${runId}/delivery-decisions*`,
      `**/v1/runs/${runId}/route-continuations`,
    ]
  ) await page.route(pattern, empty);
  await page.route(
    "**/v1/approvals?*",
    (r) => r.fulfill({ json: list(state.approvals) }),
  );
  await page.route("**/v1/approvals/*/decision", async (r) => {
    const request = r.request();
    state.decisions.push({
      key: request.headers()["idempotency-key"],
      body: request.postDataJSON() as Record<string, unknown>,
    });
    if (state.reply) return await state.reply(r);
    const body = request.postDataJSON() as { decision: string };
    state.approvals = [
      approval({
        status: "answered",
        decision: body.decision,
        version: 2,
      }),
    ];
    await r.fulfill({ json: state.approvals[0] });
  });
  await page.route("**/v1/sync*", (r) =>
    r.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: new URL(r.request().url()).searchParams.has("after")
          ? null
          : "cursor-0",
        resetRequired: false,
      },
    }));
  await page.goto(`/tasks/${id}`);
  return state;
}

const pane = (page: Page) => page.locator('[data-ui-region^="step-approval"]');

async function review(page: Page) {
  await page.getByRole("button", { name: "Review the signoff" }).click();
  await expect(pane(page).first()).toBeVisible();
}

test("a run waiting at an approval step says so and offers the review", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Waiting for you", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText("The signoff needs your approval before Bakery builds."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review the signoff" }),
  ).toBeVisible();
});

test("a run with no open step approval shows no review", async ({ page }) => {
  const state = await open(page);
  state.approvals = [];
  await page.reload();
  await expect(page.getByRole("heading", { name: "Add invoice export" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /^Review the/ })).toHaveCount(
    0,
  );
});

test("the pane shows the request and its three decisions", async ({ page }) => {
  await open(page);
  await review(page);
  const region = page.locator('[data-ui-region="step-approval"]');
  await expect(region).toContainText(
    "Approve the design before Bakery builds.",
  );
  await expect(region).toContainText("the request expires in 7 days");
  for (const name of ["Reject", "Request changes", "Approve"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("Approve sends one decision bound to the approval and its version", async ({ page }) => {
  const state = await open(page);
  await review(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Your decision on the signoff was recorded."))
    .toBeVisible();
  expect(state.decisions).toHaveLength(1);
  expect(state.decisions[0].body).toEqual({
    decision: "approve",
    expectedVersion: 1,
  });
  expect(state.decisions[0].key).toBeTruthy();
});

test("Request changes needs a comment and sends it", async ({ page }) => {
  const state = await open(page);
  await review(page);
  await page.getByRole("button", { name: "Request changes" }).click();
  const send = page.getByRole("button", { name: "Send change request" });
  await expect(send).toBeDisabled();
  await page.getByLabel("What should change?").fill("Cover refunds too.");
  await send.click();
  await expect(page.getByText("Your decision on the signoff was recorded."))
    .toBeVisible();
  expect(state.decisions[0].body).toEqual({
    decision: "request_changes",
    comment: "Cover refunds too.",
    expectedVersion: 1,
  });
});

test("Reject asks first, and keeping the review sends nothing", async ({ page }) => {
  const state = await open(page);
  await review(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Reject the signoff?");
  await dialog.getByRole("button", { name: "Keep reviewing" }).click();
  expect(state.decisions).toHaveLength(0);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Reject",
    exact: true,
  }).click();
  await expect(page.getByText("Your decision on the signoff was recorded."))
    .toBeVisible();
  expect(state.decisions.map((entry) => entry.body.decision)).toEqual([
    "reject",
  ]);
});

const REFUSALS: [string, number, string | undefined, string][] = [
  [
    "approval_decided",
    409,
    "approval_decided",
    "Someone already decided this. The current state is shown.",
  ],
  [
    "approval_superseded",
    409,
    "approval_superseded",
    "There is a newer version. It is shown now.",
  ],
  [
    "approval_stale",
    409,
    "approval_stale",
    "There is a newer version. It is shown now.",
  ],
  [
    "approval_revoked",
    409,
    "approval_revoked",
    "This request was withdrawn. Nothing waits for a decision.",
  ],
  [
    "approval_unavailable",
    409,
    "approval_unavailable",
    "This request closed while you were deciding. The current state is shown.",
  ],
  [
    "outside the audience",
    404,
    undefined,
    "This decision is for the people on this task. Ask one of them.",
  ],
  ["forbidden", 403, undefined, "You are not allowed to decide on this."],
  [
    "another failure",
    422,
    undefined,
    "Your decision was not recorded. Try again.",
  ],
];

for (const [name, status, reason, sentence] of REFUSALS) {
  test(`a refusal says one thing: ${name}`, async ({ page }) => {
    const state = await open(page);
    state.reply = (route) =>
      route.fulfill({
        status,
        contentType: "application/problem+json",
        json: problem(
          status,
          status === 409 ? "STATE_CONFLICT" : "REFUSED",
          reason,
        ),
      });
    await review(page);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(sentence)).toBeVisible();
  });
}

test("a lost answer keeps the decision and Retry sends it with the same key", async ({ page }) => {
  const state = await open(page);
  let first = true;
  state.reply = async (route) => {
    if (first) {
      first = false;
      return await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        json: { ...problem(503, "UNAVAILABLE"), retryable: true },
      });
    }
    state.reply = undefined;
    state.approvals = [
      approval({ status: "answered", decision: "approve", version: 2 }),
    ];
    await route.fulfill({ json: state.approvals[0] });
  };
  await review(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/may not have been recorded/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Your decision on the signoff was recorded."))
    .toBeVisible();
  expect(state.decisions).toHaveLength(2);
  expect(state.decisions[1].key).toBe(state.decisions[0].key);
});

test("the pane has no accessibility violations", async ({ page }) => {
  await open(page);
  await review(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("on a phone the review opens as the sheet and decides there", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await open(page);
  await review(page);
  await expect(page.locator('[data-ui-region="step-approval-sheet"]'))
    .toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Your decision on the signoff was recorded."))
    .toBeVisible();
  expect(state.decisions).toHaveLength(1);
});
