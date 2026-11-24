import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

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
  mayDecide: true,
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
  runStatus: string;
};

type OpenOptions = {
  stepsBefore?: number;
};

async function open(page: Page, options: OpenOptions = {}): Promise<State> {
  const state: State = {
    approvals: [approval()],
    decisions: [],
    runStatus: "running",
  };
  await mockAuthenticatedSession(page);
  await page.route(`**/v1/tasks/${id}`, (r) => r.fulfill({ json: task }));
  await page.route(
    `**/v1/runs/${runId}`,
    (r) => r.fulfill({ json: { ...run, status: state.runStatus } }),
  );
  const before = options.stepsBefore ?? 0;
  let stepReads = 0;
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (r) => {
      stepReads += 1;
      if (before > 0 && stepReads === 1) {
        return r.fulfill({
          json: {
            items: Array.from(
              { length: before },
              (_, index) => stepRow(uuid(30 + index), "design", "completed"),
            ),
            nextCursor: "page-2",
          },
        });
      }
      return r.fulfill({
        json: list([
          stepRow(doneStepId, "design", "completed"),
          stepRow(waitingStepId, "signoff", "waiting"),
        ]),
      });
    },
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
  await page.route("**/v1/conversations/*/participants*", (r) =>
    r.fulfill({
      json: list([
        {
          principalId: uuid(1),
          principalType: "human",
          displayName: "Ana Ruiz",
        },
      ]),
    }));
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

const pane = (page: Page) =>
  page.locator(
    '[data-ui-region="step-approval"], [data-ui-region="step-approval-sheet"]',
  );

async function review(page: Page) {
  await page.getByRole("button", { name: "Review the signoff" }).click();
  await expect(pane(page).first()).toBeVisible();
}

const DECIDED = "Your decision on the signoff was recorded.";
const answered = (decision: string, comment: string | null = null) =>
  approval({
    status: "answered",
    decision,
    decisionComment: comment,
    decidedBy: uuid(1),
    decidedAt: iso(-30_000),
    version: 2,
  });

const decideAs = (state: State, decision: string) => {
  state.reply = async (route) => {
    const body = route.request().postDataJSON() as { comment?: string };
    state.approvals = [answered(decision, body.comment ?? null)];
    state.runStatus = decision === "approve" ? "running" : "canceled";
    await route.fulfill({ json: state.approvals[0] });
  };
};

test("an approval past the first page of steps still names its step", async ({ page }) => {
  await open(page, { stepsBefore: 25 });
  await expect(
    page.getByText("The signoff needs your approval before Bakery builds."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review the signoff" }))
    .toBeVisible();
});

test("an approval after five hundred steps is still named right", async ({ page }) => {
  await open(page, { stepsBefore: 500 });
  await expect(
    page.getByText("The signoff needs your approval before Bakery builds."),
  ).toBeVisible();
});

test("a run waiting at an approval step says so and offers the review", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Waiting for you", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText("The signoff needs your approval before Bakery builds."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review the signoff" }))
    .toBeVisible();
  await page.mouse.move(5, 5);
  await still(page, "step-approval-waiting");
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

test("the pane is titled by its step and leads with the workflow's question", async ({ page }) => {
  await open(page);
  await review(page);
  await still(page, "step-approval-pane");
  const region = page.locator('[data-ui-region="step-approval"]');
  await expect(region).toContainText(
    "Approve the design before Bakery builds.",
  );
  await expect(region).toContainText("the request expires");
  await expect(region).not.toContainText("Step ");
  await expect(region).not.toContainText("7 days");
  await expect(region.getByRole("link", { name: "See what this run wrote" }))
    .toBeVisible();
  for (const name of ["Reject", "Request changes", "Approve"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("the pane shows no document, however the run's artifacts look", async ({ page }) => {
  await open(page);
  await review(page);
  await expect(page.locator('[data-ui-region="step-approval"]')).not
    .toContainText("Reading the document");
  await expect(page.getByLabel("The signoff document")).toHaveCount(0);
});

test("Close is an icon button in the header, not a footer button", async ({ page }) => {
  await open(page);
  await review(page);
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(close).toHaveCount(1);
  await close.click();
  await expect(pane(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review the signoff" }))
    .toBeVisible();
});

test("Approve decides at once, closes the pane, announces it and says nothing is recorded", async ({ page }) => {
  const state = await open(page);
  decideAs(state, "approve");
  await review(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator('[data-ui-region="step-approval-announcement"]'))
    .toHaveText("Approved. The run goes on.");
  await expect(page.getByText(DECIDED)).toHaveCount(0);
  await expect(page.locator("#task-run-heading")).toBeFocused();
  expect(state.decisions).toHaveLength(1);
  expect(state.decisions[0].body).toEqual({
    decision: "approve",
    expectedVersion: 1,
  });
  expect(state.decisions[0].key).toBeTruthy();
});

test("Request changes confirms, needs a note, and shows the run's outcome", async ({ page }) => {
  const state = await open(page);
  decideAs(state, "request_changes");
  await review(page);
  await page.getByRole("button", { name: "Request changes" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Ask for changes to signoff?");
  await expect(dialog).toContainText(
    "This ends the run. Your note is recorded on the task for whoever starts the next run.",
  );
  await dialog.getByRole("button", { name: "Ask for changes" }).click();
  await expect(dialog.getByText("Say what should change.")).toBeVisible();
  expect(state.decisions).toHaveLength(0);
  await dialog.getByLabel("What should change?").fill("Cover refunds too.");
  await dialog.getByRole("button", { name: "Ask for changes" }).click();
  await expect(pane(page)).toHaveCount(0);
  expect(state.decisions[0].body).toEqual({
    decision: "request_changes",
    comment: "Cover refunds too.",
    expectedVersion: 1,
  });
  await expect(page.locator('[data-ui-region="step-approval-announcement"]'))
    .toHaveText("Changes asked for. The run has ended.");
  await expect(page.getByText("Changes requested", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("asked for changes: “Cover refunds too.”"))
    .toBeVisible();
  await expect(
    page.locator('[data-placement="line"]').filter({ hasText: "Ana Ruiz" }),
  ).toBeVisible();
  await expect(page.getByText("Canceled", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Run updates" })).not
    .toContainText("Canceled");
  await expect(page.getByRole("button", { name: "Run actions" })).toHaveCount(
    0,
  );
});

test("Reject confirms, its reason is optional, and the run reads Rejected", async ({ page }) => {
  const state = await open(page);
  decideAs(state, "reject");
  await review(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Reject signoff?");
  await expect(dialog).toContainText(
    "This ends the run, and nothing more is built from it. Your decision is recorded on the task.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(state.decisions).toHaveLength(0);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Reject",
    exact: true,
  }).click();
  await expect(pane(page)).toHaveCount(0);
  expect(state.decisions[0].body).toEqual({
    decision: "reject",
    expectedVersion: 1,
  });
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(page.getByText(/rejected signoff\./)).toBeVisible();
  await expect(page.getByText("Canceled", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Run updates" })).not
    .toContainText("Canceled");
  await expect(page.getByRole("button", { name: "Run actions" })).toHaveCount(
    0,
  );
});

test("a reason typed for Reject is sent", async ({ page }) => {
  const state = await open(page);
  decideAs(state, "reject");
  await review(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Why?").fill("Wrong scope.");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  expect(state.decisions[0].body).toEqual({
    decision: "reject",
    comment: "Wrong scope.",
    expectedVersion: 1,
  });
});

for (
  const [decision, sentence] of [
    ["approve", /already approved this/],
    ["request_changes", /already asked for changes/],
    ["reject", /already rejected this/],
  ] as const
) {
  test(`a 409 after someone decided names them: ${decision}`, async ({ page }) => {
    const state = await open(page);
    state.reply = async (route) => {
      state.approvals = [answered(decision)];
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: problem(409, "STATE_CONFLICT", "approval_decided"),
      });
    };
    await review(page);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    const region = page.locator('[data-ui-region="step-approval"]');
    await expect(region).toContainText("Ana Ruiz");
    await expect(region).toContainText(sentence);
  });
}

test("a 409 after a decision by someone unnamed says what was decided", async ({ page }) => {
  const state = await open(page);
  state.reply = async (route) => {
    state.approvals = [{ ...answered("request_changes"), decidedBy: uuid(77) }];
    await route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "STATE_CONFLICT", "approval_decided"),
    });
  };
  await review(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText("Someone already decided this: Changes requested."),
  ).toBeVisible();
});

const REFUSALS: [string, number, string | undefined, string][] = [
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
    decideAs(state, "approve");
    await state.reply!(route);
  };
  await review(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/may not have been recorded/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(pane(page)).toHaveCount(0);
  expect(state.decisions).toHaveLength(2);
  expect(state.decisions[1].key).toBe(state.decisions[0].key);
});

test("the pane has no accessibility violations", async ({ page }) => {
  await open(page);
  await review(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("the review as a phone shows it: the sheet, Approve there, then the run line", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await open(page);
  decideAs(state, "approve");
  await review(page);
  await expect(page.locator('[data-ui-region="step-approval-sheet"]'))
    .toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator('[data-ui-region="step-approval-sheet"]'))
    .toHaveCount(0);
  await expect(page.locator('[data-ui-region="step-approval-announcement"]'))
    .toHaveText("Approved. The run goes on.");
  expect(state.decisions).toHaveLength(1);
});
