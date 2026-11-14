import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockAuthenticatedSession,
  mockUserPreferences,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

const organizationId = "00000000-0000-4000-8000-000000000003";
const principalId = "00000000-0000-4000-8000-000000000001";
const otherPrincipalId = "00000000-0000-4000-8000-000000000002";
const applicationId = "00000000-0000-4000-8000-000000000004";
const repositoryId = "00000000-0000-4000-8000-000000000005";
const profileId = "00000000-0000-4000-8000-000000000006";
const conversationId = "00000000-0000-4000-8000-000000000008";
const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const draftKey =
  `bakery.taskConversation.draft:${organizationId}:${principalId}:${taskId}`;

const baseTask = {
  id: taskId,
  applicationId,
  repositoryId,
  conversationId,
  parentTaskId: null,
  title: "Add repository onboarding",
  description: "Choose a repository and check the worker toolchain.",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: principalId,
  currentRunId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 3,
  repositoryProfileId: profileId,
  repositoryProfileRevision: 1,
  repositoryProfileDigest: "b".repeat(64),
  observationId: null,
  observationDigest: null,
  baseSha: null,
  approvalPolicy: { plan: "human_approval" },
  planningOnly: false,
};

const stamp = (minute: number) =>
  `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

const message = (
  sequence: number,
  messageType: "user" | "assistant" | "system",
  body: string,
  authorId: string | null = messageType === "user" ? principalId : null,
) => ({
  id: `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, "0")}`,
  conversationId,
  authorId,
  agentSessionId: null,
  messageType,
  body,
  clientMessageId: `client-${sequence}`,
  replyToId: null,
  createdAt: stamp(sequence),
  updatedAt: stamp(sequence),
  version: 1,
  sequence: String(sequence),
  intent: messageType === "assistant"
    ? "agent_output"
    : messageType === "user"
    ? "agent_request"
    : "discussion",
  commentContext: null,
});

const turn = (
  status:
    | "queued"
    | "active"
    | "cancel_requested"
    | "completed"
    | "failed"
    | "canceled",
  extra: Record<string, unknown> = {},
) => ({
  id: "00000000-0000-4000-8000-000000000301",
  conversationId,
  triggerMessageId: message(1, "user", "x").id,
  agentSessionId: null,
  status,
  contextThroughSequence: null,
  finishedAt: null,
  failure: null,
  createdAt: stamp(5),
  updatedAt: stamp(5),
  version: 4,
  ...extra,
});

const steps = [
  {
    id: "s1",
    title: "Select the repository",
    detail: "Choose a repository and confirm its default branch.",
  },
  {
    id: "s2",
    title: "Verify the environment",
    detail: "Show every failed toolchain check together, with a retry action.",
  },
  {
    id: "s3",
    title: "Queue the first task",
    detail: "Wait until all required readiness checks pass.",
  },
];
const revision = (n: number, status = "proposed") => ({
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
  taskId,
  conversationId,
  revision: n,
  body: { title: "Repository onboarding", steps, repositoryId },
  digest: String(n).repeat(64).slice(0, 64),
  status,
  proposedByTurnId: null,
  supersedesRevision: n > 1 ? n - 1 : null,
  createdAt: stamp(10 + n),
  updatedAt: stamp(10 + n),
  version: 1,
});
const approval = (
  n: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
  kind: "approval",
  taskId,
  conversationId,
  turnId: null,
  runId: null,
  prompt: `Approve plan revision ${n}`,
  status: "open",
  subjectType: "plan_revision",
  subjectId: revision(n).id,
  subjectDigest: revision(n).digest,
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
  createdAt: stamp(12),
  updatedAt: stamp(12),
  version: 7,
  ...extra,
});
const question = (extra: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000601",
  taskId,
  runId: null,
  conversationId,
  prompt: "Which repositories should we import?",
  responseSchema: null,
  status: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: stamp(8),
  updatedAt: stamp(8),
  version: 2,
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
  ...extra,
});

const problem = (status: number, code: string, retryable = false) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: "The server refused the request.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable,
});

const teammate = {
  principalId: otherPrincipalId,
  principalType: "human",
  displayName: "Dana Teammate",
};
const me = {
  principalId,
  principalType: "human",
  displayName: "Mark Builder",
};

type World = {
  participants: Record<string, unknown>[];
  plans: Record<string, unknown>[];
  task: Record<string, unknown>;
  messages: ReturnType<typeof message>[];
  turns: ReturnType<typeof turn>[];
  revisions: ReturnType<typeof revision>[];
  approvals: ReturnType<typeof approval>[];
  questions: ReturnType<typeof question>[];
  messagesStatus: number;
  /** Status of the plan, approval and question list reads. */
  sectionsStatus: number;
  sent: { key: string | undefined; body: Record<string, unknown> }[];
  decisions: {
    id: string;
    key: string | undefined;
    body: Record<string, unknown>;
  }[];
  answers: {
    id: string;
    key: string | undefined;
    body: Record<string, unknown>;
  }[];
  cancels: { id: string; ifMatch: string | undefined }[];
  patches: { ifMatch: string | undefined; body: Record<string, unknown> }[];
  decideReply?: (route: Route) => Promise<void> | void;
  answerReply?: (route: Route) => Promise<void> | void;
  sendReply?: (route: Route, attempt: number) => Promise<void> | void;
  capabilities: { action: string; canRequest: boolean; reason: string }[];
};

function world(overrides: Partial<World> = {}): World {
  return {
    participants: [],
    plans: [],
    task: { ...baseTask },
    messages: [
      message(1, "user", "Let's make onboarding feel straightforward."),
      message(
        2,
        "assistant",
        "I reviewed the repository profile. The plan adds a readiness check.",
      ),
      message(
        3,
        "user",
        "Please show missing checks together.",
        otherPrincipalId,
      ),
    ],
    turns: [],
    revisions: [revision(3)],
    approvals: [approval(3)],
    questions: [question()],
    messagesStatus: 200,
    sectionsStatus: 200,
    sent: [],
    decisions: [],
    answers: [],
    cancels: [],
    patches: [],
    capabilities: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
      action,
      canRequest: action === "cancel",
      reason: action === "cancel" ? "allowed" : "unsupported",
    })),
    ...overrides,
  };
}

const page_ = <T>(items: T[]) => ({ items, nextCursor: null });

async function mockWorld(page: Page, state: World) {
  await page.route(`**/v1/tasks/${taskId}`, (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      state.patches.push({
        ifMatch: request.headers()["if-match"],
        body: request.postDataJSON(),
      });
      state.task = {
        ...state.task,
        ...request.postDataJSON(),
        version: Number(state.task.version) + 1,
      };
    }
    return route.fulfill({ json: state.task });
  });
  await page.route(
    `**/v1/conversations/${conversationId}/messages*`,
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        state.sent.push({
          key: request.headers()["idempotency-key"],
          body: request.postDataJSON(),
        });
        if (state.sendReply) {
          return state.sendReply(route, state.sent.length);
        }
        const body = request.postDataJSON() as { body: string; intent: string };
        const created = message(10 + state.sent.length, "user", body.body);
        state.messages.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      if (state.messagesStatus !== 200) {
        return route.fulfill({
          status: state.messagesStatus,
          contentType: "application/problem+json",
          json: problem(
            state.messagesStatus,
            state.messagesStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL",
          ),
        });
      }
      // Newest first, as the server pages them.
      return route.fulfill({
        json: page_(
          [...state.messages].sort((a, b) =>
            Number(b.sequence) - Number(a.sequence)
          ),
        ),
      });
    },
  );
  await page.route(
    `**/v1/conversations/${conversationId}/participants*`,
    (route) => route.fulfill({ json: page_(state.participants) }),
  );
  await page.route(
    "**/v1/coordination-plans*",
    (route) => route.fulfill({ json: page_(state.plans) }),
  );
  await page.route(
    `**/v1/conversations/${conversationId}/turns*`,
    (route) => route.fulfill({ json: page_(state.turns) }),
  );
  await page.route(`**/v1/conversation-turns/*/cancel`, (route) => {
    const request = route.request();
    const id = request.url().split("/conversation-turns/")[1].split("/")[0];
    state.cancels.push({ id, ifMatch: request.headers()["if-match"] });
    state.turns = [turn("cancel_requested", { version: 5 })];
    return route.fulfill({ json: state.turns[0] });
  });
  await page.route(
    "**/v1/plan-revisions*",
    (route) =>
      state.sectionsStatus === 200
        ? route.fulfill({ json: page_([...state.revisions].reverse()) })
        : route.fulfill({
          status: state.sectionsStatus,
          contentType: "application/problem+json",
          json: problem(
            state.sectionsStatus,
            state.sectionsStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL",
          ),
        }),
  );
  await page.route(
    "**/v1/approvals*",
    (route) =>
      state.sectionsStatus === 200
        ? route.fulfill({ json: page_(state.approvals) })
        : route.fulfill({
          status: state.sectionsStatus,
          contentType: "application/problem+json",
          json: problem(
            state.sectionsStatus,
            state.sectionsStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL",
          ),
        }),
  );
  await page.route("**/v1/approvals/*/decision", (route) => {
    const request = route.request();
    const id = request.url().split("/approvals/")[1].split("/")[0];
    state.decisions.push({
      id,
      key: request.headers()["idempotency-key"],
      body: request.postDataJSON(),
    });
    if (state.decideReply) return state.decideReply(route);
    const found = state.approvals.find((item) => item.id === id)!;
    const body = request.postDataJSON() as { decision: string };
    const decided = {
      ...found,
      status: "answered",
      decision: body.decision,
      version: found.version + 1,
    };
    state.approvals = state.approvals.map((item) =>
      item.id === id ? decided : item
    );
    return route.fulfill({ json: decided });
  });
  await page.route(
    "**/v1/questions*",
    (route) =>
      state.sectionsStatus === 200
        ? route.fulfill({ json: page_(state.questions) })
        : route.fulfill({
          status: state.sectionsStatus,
          contentType: "application/problem+json",
          json: problem(
            state.sectionsStatus,
            state.sectionsStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL",
          ),
        }),
  );
  await page.route("**/v1/questions/*/answer", (route) => {
    const request = route.request();
    const id = request.url().split("/questions/")[1].split("/")[0];
    state.answers.push({
      id,
      key: request.headers()["idempotency-key"],
      body: request.postDataJSON(),
    });
    if (state.answerReply) return state.answerReply(route);
    const answered = question({
      status: "answered",
      answer: (request.postDataJSON() as { answer: unknown }).answer,
      version: 3,
    });
    state.questions = [answered];
    return route.fulfill({ json: answered });
  });
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: { runId, actions: state.capabilities } }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: page_([]) }),
  );
  await page.route(
    "**/v1/workflow-presets*",
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

const conversation = (page: Page) =>
  page.getByRole("region", { name: "Conversation", exact: true });
const plan = (page: Page) => page.locator('[data-ui-region="plan-revision"]');
const approve = (page: Page, n: number) =>
  page.getByRole("button", { name: `Approve revision ${n}`, exact: true });

/**
 * On a phone the plan and its decisions open from a card in the transcript
 * (Paper 2J3V-0) instead of an inspector column, so a spec that works the
 * plan opens that sheet first.
 */
async function showPlan(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width >= 744) return;
  const sheet = page.locator('[data-ui-region="plan-sheet"]');
  if (await sheet.isVisible()) return;
  await page.locator('[data-ui-component="planSummaryCard"]').first().click();
  await expect(sheet).toBeVisible();
}

async function hidePlan(page: Page) {
  const sheet = page.locator('[data-ui-region="plan-sheet"]');
  if (await sheet.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
}

async function open(page: Page, state: World = world()) {
  await mockWorld(page, state);
  await firstRender(
    () => page.goto(`/tasks/${taskId}`),
    (timeout) => expect(conversation(page)).toBeVisible({ timeout }),
  );
  return state;
}

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

test("renders the transcript with attribution, plan, question and stage strip", async ({ page }) => {
  await open(page);
  await showPlan(page);
  const transcript = page.getByRole("log", { name: "Conversation transcript" });
  await expect(transcript.getByText("Let's make onboarding")).toBeVisible();
  await expect(transcript.locator('[data-variant="person"]').first())
    .toContainText("You");
  await expect(transcript.locator('[data-variant="agent"]')).toContainText(
    "Agent",
  );
  await expect(transcript.getByText("Teammate 00000000")).toBeVisible();
  // Oldest first.
  const bodies = await transcript.locator("article").allTextContents();
  expect(bodies[0]).toContain("Let's make onboarding");
  expect(bodies.at(-1)).toContain("show missing checks");
  await expect(plan(page)).toContainText("Revision 3");
  await expect(plan(page).getByRole("listitem")).toHaveCount(3);
  await expect(plan(page)).toContainText("1. Select the repository");
  await expect(approve(page, 3)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Request changes", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject", exact: true }))
    .toBeVisible();
  await expect(page.getByText("Which repositories should we import?"))
    .toBeVisible();
  const strip = page.locator('[data-ui-region="stage-strip"]');
  await expect(strip.locator('[data-stage="plan"]')).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(strip.locator('[data-stage="plan"]')).toContainText(
    "Waits for your approval",
  );
  await expect(strip.locator('[data-stage="implement"]')).toContainText(
    "Automatic",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the brief is not a synthetic transcript message", async ({ page }) => {
  await open(page);
  await expect(page.locator('[data-ui-region="task-brief"]')).toContainText(
    "Choose a repository and check the worker toolchain.",
  );
  await expect(
    page.getByRole("log").locator("article", { hasText: "Task brief" }),
  ).toHaveCount(0);
});

test("the draft persists across reload and is never sent until Send", async ({ page }) => {
  const state = await open(page);
  const box = page.getByRole("textbox", { name: "Message this task" });
  await box.fill("A private thought");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message this task" }))
    .toHaveValue("A private thought");
  expect(state.sent).toHaveLength(0);
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    draftKey,
  );
  expect(stored).toContain("A private thought");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("A private thought").last()).toBeVisible();
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0].body).toMatchObject({
    body: "A private thought",
    intent: "discussion",
  });
  expect(state.sent[0].key).toBe(state.sent[0].body.clientMessageId);
  await expect(page.getByRole("textbox", { name: "Message this task" }))
    .toHaveValue("");
});

test("Ask agent sends an agent request", async ({ page }) => {
  const state = await open(page);
  await page.getByLabel("Ask agent", { exact: true }).check({ force: true });
  await page.getByRole("textbox", { name: "Message this task" }).fill(
    "Draft a plan",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0].body).toMatchObject({ intent: "agent_request" });
});

test("an unknown send outcome retries the same message id once", async ({ page }) => {
  const state = world();
  state.sendReply = (route, attempt) =>
    attempt === 1
      ? route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        json: problem(503, "UNAVAILABLE", true),
      })
      : route.fulfill({
        status: 201,
        json: message(40, "user", "Resilient"),
      });
  await open(page, state);
  await page.getByRole("textbox", { name: "Message this task" }).fill(
    "Resilient",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("send outcome is unknown")).toBeVisible();
  await page.getByRole("button", { name: "Retry send" }).click();
  await expect.poll(() => state.sent.length).toBe(2);
  expect(state.sent[1].key).toBe(state.sent[0].key);
  expect(state.sent[1].body.clientMessageId).toBe(
    state.sent[0].body.clientMessageId,
  );
});

test("queued and active turns show status and cancel is bound to the version", async ({ page }) => {
  const state = world({ turns: [turn("queued")] });
  await open(page, state);
  await expect(page.locator('[data-ui-region="turn-status"]')).toContainText(
    "Agent turn queued",
  );
  state.turns = [turn("active")];
  await expect(page.locator('[data-ui-region="turn-status"]')).toContainText(
    "The agent is working",
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: "Cancel turn" }).click();
  await expect.poll(() => state.cancels.length).toBe(1);
  expect(state.cancels[0].ifMatch).toBe('"v4"');
  await expect(page.locator('[data-ui-region="turn-status"]')).toContainText(
    "Cancel requested",
  );
});

test("a failed turn shows its failure", async ({ page }) => {
  await open(
    page,
    world({
      turns: [turn("failed", {
        failure: {
          type: "about:blank",
          title: "Failed",
          status: 500,
          detail: "No coordinator agent harness is configured",
          code: "coordinator_unavailable",
          requestId: "00000000-0000-4000-8000-000000000110",
          traceId: "00000000-0000-4000-8000-000000000111",
          retryable: false,
        },
      })],
    }),
  );
  await expect(page.getByText("No coordinator agent harness is configured"))
    .toBeVisible();
});

test("approve sends the exact approval id and version", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  await approve(page, 3).click();
  await expect.poll(() => state.decisions.length).toBe(1);
  expect(state.decisions[0].id).toBe(approval(3).id);
  expect(state.decisions[0].body).toEqual({
    decision: "approve",
    expectedVersion: 7,
  });
  await expect(page.getByText("You approved revision 3")).toBeVisible();
  await expect(approve(page, 3)).toHaveCount(0);
});

test("Start run right after approving still carries the approval id", async ({ page }) => {
  const state = world();
  await mockWorld(page, state);
  // The start form reads the approval id from the approvals list. Hold that
  // read after the decision so a start before it lands would send no id.
  let holdApprovals = false;
  await page.route("**/v1/approvals*", async (route) => {
    if (holdApprovals) await new Promise((done) => setTimeout(done, 1_500));
    return route.fallback();
  });
  await page.route("**/v1/workflow-presets*", (route) =>
    route.fulfill({
      json: page_([{
        id: "fixed-coding",
        revision: 1,
        digest: "a".repeat(64),
        nameKey: "workflowPresets.fixedCoding.name",
        steps: [{ id: "implement", uses: "harness.implement" }],
        defaultBudgetLimitUsd: "5.00",
        availability: {
          minimumBudgetLimitUsd: null,
          status: "ready",
          reasons: [],
        },
      }]),
    }));
  const runs: Record<string, unknown>[] = [];
  await page.route(`**/v1/tasks/${taskId}/runs`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    runs.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: problem(409, "STATE_CONFLICT") });
  });
  await firstRender(
    () => page.goto(`/tasks/${taskId}`),
    (timeout) => expect(conversation(page)).toBeVisible({ timeout }),
  );
  await showPlan(page);
  holdApprovals = true;
  await approve(page, 3).click();
  await expect(page.getByText("You approved revision 3")).toBeVisible();
  // On a phone the plan is a sheet over the page; close it to reach the form.
  const sheet = page.locator('[data-ui-region="plan-sheet"]');
  if (await sheet.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
  const start = page.getByRole("button", { name: "Start run", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ approvalId: approval(3).id });
});

test("request changes needs a comment and sends it with the decision", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  const send = page.getByRole("button", { name: "Send change request" });
  await expect(send).toBeDisabled();
  await page.getByRole("textbox", { name: "What should change?" }).fill(
    "Split step two",
  );
  await send.click();
  await expect.poll(() => state.decisions.length).toBe(1);
  expect(state.decisions[0].body).toEqual({
    decision: "request_changes",
    comment: "Split step two",
    expectedVersion: 7,
  });
});

test("an accepted change request closes the form and the next revision is decidable", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  await page.getByRole("textbox", { name: "What should change?" }).fill(
    "Split step two",
  );
  await page.getByRole("button", { name: "Send change request" }).click();
  await expect.poll(() => state.decisions.length).toBe(1);
  await expect(page.getByRole("textbox", { name: "What should change?" }))
    .toHaveCount(0);
  // The agent answers the change request with a newer revision.
  state.revisions = [revision(3, "superseded"), revision(4)];
  state.approvals = [
    approval(3, {
      status: "superseded",
      decision: "request_changes",
      version: 8,
    }),
    approval(4, { version: 2 }),
  ];
  await expect(plan(page)).toContainText("Revision 4", { timeout: 15_000 });
  await expect(approve(page, 4)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Request changes", exact: true }),
  )
    .toBeEnabled();
  await expect(page.getByRole("textbox", { name: "What should change?" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send change request" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Keep reviewing" }))
    .toHaveCount(0);
});

test("reject records the decision and removes the controls", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(() => state.decisions.length).toBe(1);
  expect(state.decisions[0].body).toEqual({
    decision: "reject",
    expectedVersion: 7,
  });
  await expect(page.getByText("You rejected revision 3")).toBeVisible();
});

test("approving an obsolete revision is refused with a conflict and the new revision shows", async ({ page }) => {
  const state = world();
  state.decideReply = (route) => {
    // Someone requested changes; a newer revision replaced this one.
    state.revisions = [revision(3, "superseded"), revision(4)];
    state.approvals = [
      approval(3, { status: "superseded", version: 8 }),
      approval(4, { version: 2 }),
    ];
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "STATE_CONFLICT"),
    });
  };
  await open(page, state);
  await showPlan(page);
  await approve(page, 3).click();
  await expect(page.getByText("Revision 3 is obsolete")).toBeVisible();
  await expect(plan(page)).toContainText("Revision 4");
  await expect(approve(page, 3)).toHaveCount(0);
  await expect(approve(page, 4)).toBeEnabled();
  await approve(page, 4).click();
  await expect.poll(() => state.decisions.length).toBe(2);
  expect(state.decisions[1].id).toBe(approval(4).id);
  expect(state.decisions[1].body).toMatchObject({ expectedVersion: 2 });
});

test("an unknown decision outcome retries the same key", async ({ page }) => {
  const state = world();
  let attempts = 0;
  state.decideReply = (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        json: problem(503, "UNAVAILABLE", true),
      })
      : route.fulfill({
        json: approval(3, { status: "answered", decision: "approve" }),
      });
  };
  await open(page, state);
  await showPlan(page);
  await approve(page, 3).click();
  await expect(page.getByText("may not have been recorded")).toBeVisible();
  await page.getByRole("button", { name: "Retry decision" }).click();
  await expect.poll(() => state.decisions.length).toBe(2);
  expect(state.decisions[1].key).toBe(state.decisions[0].key);
});

test("an unknown outcome on revision 3 never leaks into revision 4", async ({ page }) => {
  const state = world();
  state.decideReply = (route) => {
    if (state.decisions.length > 1) {
      return route.fulfill({
        json: approval(4, { status: "answered", decision: "reject" }),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      json: problem(503, "UNAVAILABLE", true),
    });
  };
  await open(page, state);
  await showPlan(page);
  await approve(page, 3).click();
  await expect(page.getByText("may not have been recorded")).toBeVisible();
  // A newer revision arrives while the outcome is still unknown.
  state.revisions = [revision(3, "superseded"), revision(4)];
  state.approvals = [
    approval(3, { status: "superseded", version: 8 }),
    approval(4, { version: 2 }),
  ];
  await expect(approve(page, 4)).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(() => state.decisions.length).toBe(2);
  expect(state.decisions[0].id).toBe(approval(3).id);
  expect(state.decisions[1].id).toBe(approval(4).id);
  expect(state.decisions[1].body).toEqual({
    decision: "reject",
    expectedVersion: 2,
  });
  expect(state.decisions[1].key).not.toBe(state.decisions[0].key);
});

test("an unknown outcome the server applied settles to the recorded decision", async ({ page }) => {
  const state = world();
  state.decideReply = (route) => {
    // The server recorded the approval, but the reply never arrived.
    state.revisions = [revision(3, "approved")];
    state.approvals = [
      approval(3, {
        status: "answered",
        decision: "approve",
        decidedBy: principalId,
        version: 8,
      }),
    ];
    return route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      json: problem(503, "UNAVAILABLE", true),
    });
  };
  await open(page, state);
  await showPlan(page);
  await approve(page, 3).click();
  await expect(page.getByText("You approved revision 3")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("may not have been recorded")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry decision" }))
    .toHaveCount(0);
  expect(state.decisions.length).toBe(1);
});

test("a change-request comment never carries into the next revision", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  await page.getByRole("textbox", { name: "What should change?" }).fill(
    "Split step two",
  );
  // A newer revision arrives before the comment is sent.
  state.revisions = [revision(3, "superseded"), revision(4)];
  state.approvals = [
    approval(3, { status: "superseded", version: 8 }),
    approval(4, { version: 2 }),
  ];
  await expect(approve(page, 4)).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "What should change?" }))
    .toHaveValue("");
  await expect(page.getByRole("button", { name: "Send change request" }))
    .toBeDisabled();
  expect(state.decisions.length).toBe(0);
});

test("an idempotency payload mismatch is an error, not an obsolete revision", async ({ page }) => {
  const state = world();
  state.decideReply = (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "IDEMPOTENCY_PAYLOAD_MISMATCH"),
    });
  await open(page, state);
  await showPlan(page);
  await approve(page, 3).click();
  await expect(page.getByText("Revision 3 is obsolete")).toHaveCount(0);
  await expect(page.getByText("Your decision was not recorded")).toBeVisible();
});

test("a revision with no open approval shows no decision controls", async ({ page }) => {
  await open(page, world({ approvals: [] }));
  await expect(plan(page)).toContainText("No approval request is open");
  await expect(approve(page, 3)).toHaveCount(0);
});

test("answering a question sends the option to questions.answer", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  const send = page.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await page.getByLabel("Bakery only").check({ force: true });
  await send.click();
  await expect.poll(() => state.answers.length).toBe(1);
  expect(state.answers[0].id).toBe(question().id);
  expect(state.answers[0].body).toEqual({ answer: { optionId: "bakery" } });
  await expect(page.getByText("Recorded answer")).toBeVisible();
  await expect(page.getByText("Bakery only").last()).toBeVisible();
});

test("a conflicting answer shows the conflict and the recorded answer", async ({ page }) => {
  const state = world();
  state.answerReply = (route) => {
    state.questions = [
      question({
        status: "answered",
        answer: { optionId: "choose" },
        version: 3,
      }),
    ];
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "STATE_CONFLICT"),
    });
  };
  await open(page, state);
  await showPlan(page);
  await page.getByLabel("Bakery only").check({ force: true });
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Someone already answered")).toBeVisible();
  await expect(page.getByText("Choose repositories").last()).toBeVisible();
  await expect(page.locator(".ui-question-card__status")).toHaveText(
    "Answered",
  );
});

test("planning-only toggles through tasks.update with the task version", async ({ page }) => {
  const state = await open(page);
  await showPlan(page);
  const toggle = page.getByRole("switch", { name: "Planning only" });
  await expect(toggle).not.toBeChecked();
  await toggle.check({ force: true });
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({
    ifMatch: '"v3"',
    body: { planningOnly: true },
  });
  await expect(toggle).toBeChecked();
  await page.reload();
  await showPlan(page);
  await expect(page.getByRole("switch", { name: "Planning only" }))
    .toBeChecked();
});

test("unsupported steering is explicit in the run controls while a run is active", async ({ page }) => {
  const activeTask = {
    ...baseTask,
    status: "active",
    currentRunId: runId,
    approvalPolicy: { plan: "automatic" },
  };
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
    requestedBy: principalId,
    inngestRunId: null,
    status: "running",
    budgetLimitUsd: "10.00",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
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
        settledUsd: "0",
        availableUsd: "10",
        unknownCount: 0,
      },
    },
  };
  const state = world({ task: activeTask });
  await mockWorld(page, state);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: page_([]) }),
  );
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("A run is in progress.")).toBeVisible();
  await expect(page.locator('[data-ui-region="steering-unsupported"]'))
    .toContainText("Live steering is not supported");
  await expect(
    page.getByText("This worker's adapter does not support this control.")
      .first(),
  ).toBeVisible();
  // Questions to the agent are still accepted and saved to the conversation.
  await page.getByRole("textbox", { name: "Message this task" }).fill(
    "How is it going?",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
});

test(
  "the artifact section of a run with no artifact is an inset pane section",
  async ({ page }, testInfo) => {
    // The inspector is a sheet on a phone; the inline pane is the desktop surface.
    test.skip(testInfo.project.name === "mobile", "desktop inspector only");
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
      requestedBy: principalId,
      inngestRunId: null,
      status: "running",
      budgetLimitUsd: "10.00",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
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
          settledUsd: "0",
          availableUsd: "10",
          unknownCount: 0,
        },
      },
    };
    const state = world({
      task: {
        ...baseTask,
        status: "active",
        currentRunId: runId,
        approvalPolicy: { plan: "automatic" },
      },
    });
    await mockWorld(page, state);
    await page.route(
      `**/v1/runs/${runId}`,
      (route) => route.fulfill({ json: run }),
    );
    await page.route(
      `**/v1/runs/${runId}/steps*`,
      (route) => route.fulfill({ json: page_([]) }),
    );
    await page.goto(`/tasks/${taskId}`);
    const inspector = page.getByRole("complementary", { name: "Plan" });
    const artifact = inspector.getByRole("complementary", { name: "Artifact" });
    const notice = artifact.getByText(
      "This run has published no artifact yet.",
    );
    await expect(notice).toBeVisible();
    // No stray brief heading: the brief is the first transcript entry.
    await expect(inspector.getByRole("heading", { name: "Task brief" }))
      .toHaveCount(0);
    // The pane body and the notice both sit at least 16px inside the inspector.
    const box = await inspector.boundingBox();
    expect(box).not.toBeNull();
    for (
      const target of [
        artifact.locator('[data-ui-component="artifactPane"]'),
        notice,
      ]
    ) {
      const inner = await target.boundingBox();
      expect(inner).not.toBeNull();
      expect(inner!.x - box!.x).toBeGreaterThanOrEqual(16);
      expect(box!.x + box!.width - (inner!.x + inner!.width))
        .toBeGreaterThanOrEqual(16);
    }
    // Heading levels never skip: every inspector heading is an h2.
    const levels = await inspector.getByRole("heading").evaluateAll((nodes) =>
      nodes.map((node) => Number(node.tagName.slice(1)))
    );
    expect(levels.length).toBeGreaterThan(0);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  },
);

test("a finished run invites discussing the results", async ({ page }) => {
  await open(
    page,
    world({
      task: { ...baseTask, status: "completed", currentRunId: runId },
    }),
  );
  await expect(page.getByText("The run has finished.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message this task" }))
    .toBeEnabled();
});

test("long transcripts page with Load earlier messages", async ({ page }) => {
  const state = world();
  await mockWorld(page, state);
  await page.route(
    `**/v1/conversations/${conversationId}/messages*`,
    (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      return route.fulfill({
        json: cursor
          ? {
            items: [message(1, "user", "Earliest message")],
            nextCursor: null,
          }
          : {
            items: [message(5, "assistant", "Latest message")],
            nextCursor: "next",
          },
      });
    },
  );
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("Latest message")).toBeVisible();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Earliest message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load earlier messages" }))
    .toHaveCount(0);
});

test.describe("route states", () => {
  test("empty", async ({ page }) => {
    await open(
      page,
      world({ messages: [], revisions: [], approvals: [], questions: [] }),
    );
    await expect(page.getByText("No messages yet.")).toBeVisible();
    await expect(plan(page)).toHaveCount(0);
  });

  test("loading", async ({ page }) => {
    const state = world();
    await mockWorld(page, state);
    await page.route(
      `**/v1/conversations/${conversationId}/messages*`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fallback();
      },
    );
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByText("Loading the conversation")).toBeVisible();
  });

  test("error with retry", async ({ page }) => {
    const state = world({ messagesStatus: 500 });
    await open(page, state);
    await expect(page.getByText("The conversation could not be loaded."))
      .toBeVisible();
    state.messagesStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Let's make onboarding")).toBeVisible();
  });

  test("forbidden", async ({ page }) => {
    await open(page, world({ messagesStatus: 403 }));
    await expect(page.getByText("You do not have access to this conversation."))
      .toBeVisible();
  });

  test("plan, approval and question read failures show a notice with retry", async ({ page }) => {
    await page.clock.install();
    const state = world({ sectionsStatus: 500 });
    await open(page, state);
    await showPlan(page);
    await expect(
      page.getByText("could not be loaded. What is shown may be out"),
    )
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    // Pause timers so a 3 s section poll cannot recover and unmount the notice before the click.
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 250);
    state.sectionsStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await page.clock.resume();
    await expect(plan(page)).toContainText("Revision 3");
    await expect(
      page.getByText("could not be loaded. What is shown may be out"),
    )
      .toHaveCount(0);
  });

  test("plan, approval and question forbidden shows a forbidden notice", async ({ page }) => {
    await open(page, world({ sectionsStatus: 403 }));
    await showPlan(page);
    await expect(
      page.getByText("You do not have access to the plan, approvals"),
    )
      .toBeVisible();
  });

  test("stale keeps the last transcript and offers refresh", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByText("Let's make onboarding")).toBeVisible();
    state.messagesStatus = 500;
    await showPlan(page);
    await page.getByLabel("Planning only").focus();
    await hidePlan(page);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await expect(page.getByText("This conversation changed elsewhere"))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Let's make onboarding")).toBeVisible();
    state.messagesStatus = 200;
    await page.getByRole("button", { name: "Refresh conversation" }).click();
    await expect(page.getByText("This conversation changed elsewhere"))
      .toHaveCount(0);
  });

  test("offline disables sending and decisions, then reconnects", async ({ page, context }) => {
    await open(page);
    await page.getByRole("textbox", { name: "Message this task" }).fill("x");
    await context.setOffline(true);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("offline")));
    await expect(page.getByText("You are offline.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeDisabled();
    await showPlan(page);
    await expect(approve(page, 3)).toBeDisabled();
    await hidePlan(page);
    await context.setOffline(false);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(page.getByText("You are offline.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeEnabled();
  });

  test("conflict on a decision shows the conflict state", async ({ page }) => {
    const state = world();
    state.decideReply = (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: problem(409, "STATE_CONFLICT"),
      });
    await open(page, state);
    await showPlan(page);
    await approve(page, 3).click();
    await expect(page.getByText("Nothing was decided")).toBeVisible();
  });

  test("long copy wraps without horizontal scroll", async ({ page }) => {
    const long = "Unbroken".repeat(40) + " " +
      "Long sentence of text. ".repeat(30);
    const state = world();
    state.messages.push(message(9, "assistant", long));
    state.questions = [question({ prompt: long })];
    state.revisions = [{
      ...revision(3),
      body: {
        title: long.slice(0, 200),
        steps: [{ id: "a", title: long.slice(0, 250), detail: long }],
        repositoryId,
      },
    }];
    await open(page, state);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
});

for (const locale of ["en-XA", "ar-XB"]) {
  test(`conversation reflows at 320px in ${locale}`, async ({ page }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: [value],
      });
    }, locale);
    await mockUserPreferences(page, {
      effectiveLocale: locale,
      direction: locale === "ar-XB" ? "rtl" : "ltr",
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await mockWorld(page, world());
    await page.goto(`/tasks/${taskId}`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar-XB" ? "rtl" : "ltr",
    );
    await expect(page.locator('[data-ui-region="task-conversation"]'))
      .toBeVisible();
    await showPlan(page);
    await expect(page.locator('[data-ui-region="plan-revision"]'))
      .toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
}

test("keyboard reaches the plan decisions and the composer in order", async ({ page }) => {
  await open(page);
  await showPlan(page);
  await approve(page, 3).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Request changes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Reject", exact: true }))
    .toBeFocused();
  // Space activates the focused control.
  await page.getByRole("button", { name: "Request changes", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "What should change?" }))
    .toBeVisible();
  await hidePlan(page);
  await page.getByRole("textbox", { name: "Message this task" }).focus();
  await page.keyboard.type("hello");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("hello").last()).toBeVisible();
});

test(
  "conversation controls are at least 44px with a coarse pointer",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "44px applies to coarse pointers; the fine-pointer lane keeps token sizes",
    );
    await open(page);
    const check = async (targets: Locator[]) => {
      for (const control of targets) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        const name = await control.evaluate((element) =>
          element.outerHTML.slice(0, 90)
        );
        expect(box!.height, name).toBeGreaterThanOrEqual(44);
        expect(box!.width, name).toBeGreaterThanOrEqual(44);
      }
    };
    await check([
      page.getByRole("button", { name: "Send", exact: true }),
      page.getByRole("textbox", { name: "Message this task" }),
    ]);
    await showPlan(page);
    await check([
      approve(page, 3),
      page.getByRole("button", { name: "Request changes", exact: true }),
      page.getByRole("button", { name: "Reject", exact: true }),
      page.getByRole("switch", { name: "Planning only" }),
      page.getByRole("button", { name: "Send answer" }),
    ]);
  },
);

for (const scheme of ["light", "dark"] as const) {
  test(`the planning-only switch shows a visible track in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await showPlan(page);
    const toggle = page.getByRole("switch", { name: "Planning only" });
    await toggle.scrollIntoViewIfNeeded();
    const track = () =>
      toggle.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return {
          appearance: getComputedStyle(element).appearance,
          background: style.backgroundColor,
          width: style.width,
        };
      });
    const off = await track();
    expect(off.appearance).toBe("none");
    expect(off.width).toBe("32px");
    const directory = process.env.BAKERY_FS26_SHOTS;
    const area = page.locator('[data-ui-region="stage-strip"]');
    if (directory) {
      await area.screenshot({ path: `${directory}/switch-${scheme}-off.png` });
    }
    await toggle.check({ force: true });
    await expect.poll(async () => (await track()).background).not.toBe(
      off.background,
    );
    if (directory) {
      await area.screenshot({ path: `${directory}/switch-${scheme}-on.png` });
    }
  });
}

test("reduced motion and dark scheme stay accessible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

const themeKey = "bakery.theme.v1";

async function surfaces(page: Page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const read = (selector: string) => {
      const element = document.querySelector(selector) ?? document.body;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopColor,
      };
    };
    const luminance = (rgb: string) => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const shell = read("body");
    const transcript = read('[data-ui-region="task-conversation"]');
    const composer = read('[data-ui-region="composer"] textarea');
    return {
      theme: root.dataset.theme,
      scheme: getComputedStyle(root).colorScheme,
      canvas: getComputedStyle(root).getPropertyValue("--color-canvas").trim()
        .toLowerCase(),
      border: getComputedStyle(root).getPropertyValue("--color-border").trim()
        .toLowerCase(),
      shell,
      transcript,
      composer,
      textLuminance: luminance(transcript.color),
      shellLuminance: luminance(shell.background),
    };
  });
}

test("System theme follows the emulated scheme and re-themes without reload", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "system");
  }, themeKey);
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await surfaces(page);
  expect(dark.scheme).toBe("dark");
  expect(dark.canvas).toBe("#0b0e14");
  expect(dark.border).toBe("#2d3542");
  expect(dark.shellLuminance).toBeLessThan(0.2);
  expect(dark.textLuminance).toBeGreaterThan(0.5);

  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const light = await surfaces(page);
  expect(light.scheme).toBe("light");
  expect(light.canvas).toBe("#f5f6f8");
  expect(light.border).toBe("#e3e6eb");
  expect(light.shellLuminance).toBeGreaterThan(0.8);
  expect(light.textLuminance).toBeLessThan(0.5);
  expect(light.shell.background).not.toBe(dark.shell.background);
  expect(light.transcript.color).not.toBe(dark.transcript.color);
  expect(light.composer.color).not.toBe(dark.composer.color);
  expect(light.composer.border).not.toBe(dark.composer.border);
  // The same document survived the switch: no reload happened.
  expect(
    await page.evaluate(() =>
      (window as unknown as { __noReload?: boolean }).__noReload
    ),
  ).toBe(true);
  await expect(conversation(page)).toBeVisible();
});

type Stop = { name: string; radio: boolean };

/** Tab through the page once and return every focus stop with its name. */
async function tabStops(page: Page): Promise<Stop[]> {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur()
  );
  const stops: Stop[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const element = document.activeElement as
          | (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> })
          | null;
        if (!element || element === document.body) {
          return { name: "", radio: false };
        }
        const name = element.getAttribute("aria-label") ??
          element.labels?.[0]?.textContent ?? element.textContent ?? "";
        return {
          name: name.trim(),
          radio: element.getAttribute("type") === "radio" ||
            element.getAttribute("role") === "radio",
        };
      }),
    );
  }
  return stops;
}

/**
 * The plan's own focus sequence: from the first question option through
 * Reject. Anything between that exists only in one layout (sheet chrome) is
 * dropped by name.
 */
async function planTabOrder(page: Page): Promise<string[]> {
  const stops = await tabStops(page);
  // The sheet traps focus, so its stops cycle; unique stops in first-seen
  // order, rotated to start at the first question option, give one lap.
  const unique: Stop[] = [];
  for (const stop of stops) {
    if (!unique.some((seen) => seen.name === stop.name)) unique.push(stop);
  }
  const first = unique.findIndex((stop) =>
    stop.radio && stop.name === "Bakery only"
  );
  expect(first, JSON.stringify(stops)).toBeGreaterThanOrEqual(0);
  const lap = [...unique.slice(first), ...unique.slice(0, first)];
  const last = lap.findIndex((stop) => stop.name === "Reject");
  expect(last, JSON.stringify(stops)).toBeGreaterThan(0);
  const sheetOnly = ["Close plan", "Planning only"];
  return lap.slice(0, last + 1).map((stop) => stop.name).filter((name) =>
    !sheetOnly.includes(name)
  );
}

test(
  "200% zoom keeps the conversation reachable, unclipped and in focus order",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "200% of a phone is narrower than the 320px reflow floor, which the en-XA/ar-XB cases cover",
    );
    await page.addInitScript((key) => {
      localStorage.setItem(key, "system");
    }, themeKey);
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page);
    await showPlan(page);
    await page.getByLabel("Bakery only").check({ force: true });
    const baseline = await planTabOrder(page);
    const lightAxe = await (async () => {
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      return (await new AxeBuilder({ page }).analyze()).violations.map((v) =>
        v.id
      );
    })();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // 1280x800 at 100% is a 640x400 CSS-pixel viewport at 200% zoom.
    await page.setViewportSize({ width: 640, height: 400 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(conversation(page)).toBeVisible();
    await showPlan(page);
    await expect(plan(page)).toBeVisible();
    await expect(approve(page, 3)).toBeEnabled();
    const send = page.getByRole("button", { name: "Send answer" });
    await expect(send).toBeDisabled();
    // Operate the question: choosing an option enables Send answer.
    await page.getByLabel("Bakery only").check({ force: true });
    await expect(send).toBeEnabled();
    const controls = [
      approve(page, 3),
      page.getByRole("button", { name: "Request changes", exact: true }),
      page.getByRole("button", { name: "Reject", exact: true }),
      send,
      page.getByRole("radio", { name: "Bakery only" }),
    ];
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      await expect(control).toBeInViewport({ ratio: 1 });
      const box = await control.boundingBox();
      const viewport = page.viewportSize()!;
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      // No ancestor clips or covers the control: the hit target is the control.
      expect(
        await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return !!hit &&
            (element.contains(hit) || hit.contains(element) ||
              !!element.closest("label")?.contains(hit));
        }),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    const zoomed = await planTabOrder(page);
    expect(zoomed).toEqual(baseline);
    expect(zoomed.slice(-3)).toEqual([
      "Approve revision 3",
      "Request changes",
      "Reject",
    ]);
    expect(zoomed.length).toBeGreaterThanOrEqual(5);
    // Axe at 200% zoom in System dark finds nothing the 100% light case lacks.
    const zoomAxe = (await new AxeBuilder({ page }).analyze()).violations
      .map((v) => v.id);
    expect(zoomAxe.filter((id) => !lightAxe.includes(id))).toEqual([]);
    // Operable: the approval decision opens its form.
    await page.getByRole("button", { name: "Request changes", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "What should change?" }))
      .toBeVisible();
    // The composer stays reachable at 200%: dismiss the sheet, then type.
    await hidePlan(page);
    const composer = page.getByRole("textbox", { name: "Message this task" });
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeInViewport({ ratio: 1 });
    await composer.fill("zoom check");
    await expect(composer).toHaveValue("zoom check");
    await composer.fill("");
    await expect(composer).toHaveValue("");
  },
);

test("Plan first creates the task with a human-approved plan stage and starts no run", async ({ page }) => {
  const state = world();
  await mockWorld(page, state);
  const created: { key: string | undefined; body: Record<string, unknown> }[] =
    [];
  let runCalls = 0;
  await page.route("**/v1/repositories?*", (route) =>
    route.fulfill({
      json: {
        items: [{
          id: repositoryId,
          applicationId,
          slug: "web",
          integrationConnectionId: "00000000-0000-4000-8000-000000000007",
          providerRepoId: "1",
          owner: "example",
          name: "web",
          defaultBranch: "main",
          activeProfileId: profileId,
          archivedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
        }],
        nextCursor: null,
      },
    }));
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: page_([]) }),
  );
  await page.route("**/v1/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    return route.fulfill({ status: 201, json: state.task });
  });
  await page.route(`**/v1/tasks/${taskId}/runs`, (route) => {
    runCalls += 1;
    return route.fulfill({ status: 500, json: problem(500, "INTERNAL") });
  });
  await page.goto("/tasks/new");
  await page.getByRole("combobox", { name: /^Repository/ }).selectOption(
    repositoryId,
  );
  await page.getByRole("textbox", { name: /^Title/ }).fill("Plan this");
  await page.getByRole("textbox", { name: /^Description/ }).fill("Describe it");
  await page.getByRole("checkbox", { name: "Plan first" }).check({
    force: true,
  });
  await expect(page.getByRole("radio", { name: /Fixed coding/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Create task and plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(created).toHaveLength(1);
  expect(created[0].body).toMatchObject({
    title: "Plan this",
    approvalPolicy: { plan: "human_approval" },
  });
  expect(runCalls).toBe(0);
  await expect(conversation(page)).toBeVisible();
});

/** A scripted /v1/events server: hello, then a cursor for every subscribe. */
type Stream = {
  subscribes: Record<string, unknown>[];
  push: () => void;
  drop: () => void;
};
async function mockStream(page: Page): Promise<Stream> {
  const connections: WebSocketRoute[] = [];
  const requests = new Map<WebSocketRoute, string>();
  const stream: Stream = { subscribes: [], push: () => {}, drop: () => {} };
  let sequence = 1;
  const cursor = (socket: WebSocketRoute) => {
    sequence += 1;
    socket.send(JSON.stringify({
      type: "cursor",
      requestId: requests.get(socket),
      cursor: `cursor-${sequence}`,
      highwater: String(sequence),
    }));
  };
  await page.routeWebSocket(/\/v1\/events/, (socket) => {
    connections.push(socket);
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectionId: crypto.randomUUID(),
      highwater: "1",
      retainedFrom: "0",
    }));
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type !== "subscribe") return;
      stream.subscribes.push(frame);
      requests.set(socket, String(frame.requestId));
      cursor(socket);
    });
  });
  stream.push = () => {
    const socket = connections.at(-1);
    if (socket) cursor(socket);
  };
  stream.drop = () => connections.at(-1)?.close();
  return stream;
}

test.describe("participants and live updates", () => {
  test("names every author from the participant projection and lists them", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    await open(page, state);
    await showPlan(page);
    const transcript = page.getByRole("log", {
      name: "Conversation transcript",
    });
    await expect(transcript.getByText("Dana Teammate")).toBeVisible();
    await expect(transcript.getByText("Teammate 00000000")).toHaveCount(0);
    await expect(transcript.locator('[data-variant="person"]').first())
      .toContainText("You");
    await expect(transcript.locator('[data-variant="agent"]')).toContainText(
      "Agent",
    );
    const people = page.locator('[data-ui-region="participants"]');
    await expect(people).toContainText("Participants (2)");
    await expect(people.getByRole("listitem")).toHaveCount(2);
    await expect(people.getByRole("listitem").first()).toContainText(
      "Mark Builder (you)",
    );
    await expect(people.getByRole("img", { name: "Dana Teammate" }))
      .toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("an unnamed teammate keeps a short id and the page still works", async ({ page }) => {
    await open(page, world());
    await showPlan(page);
    await expect(
      page.locator('[data-ui-region="participants"]').getByText(
        "Teammate 00000000",
      ),
    ).toBeVisible();
  });

  test("a second participant's message, decision and answer appear without reload", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    const stream = await mockStream(page);
    await open(page, state);
    await showPlan(page);
    await expect.poll(() => stream.subscribes.length).toBe(1);
    expect(stream.subscribes[0].scopes).toEqual([
      { type: "task", id: taskId },
      { type: "conversation", id: conversationId },
    ]);
    await expect(approve(page, 3)).toBeVisible();
    state.messages.push(
      message(4, "user", "I looked at it too.", otherPrincipalId),
    );
    state.approvals = [approval(3, {
      status: "answered",
      decision: "approve",
      decidedBy: otherPrincipalId,
    })];
    state.questions = [question({
      status: "answered",
      answer: { optionId: "bakery" },
      answeredBy: otherPrincipalId,
    })];
    state.task = { ...state.task, planningOnly: true, version: 4 };
    stream.push();
    await expect(page.getByRole("log").getByText("I looked at it too."))
      .toBeVisible();
    await expect(page.getByText("Dana Teammate approved revision 3"))
      .toBeVisible();
    await expect(approve(page, 3)).toHaveCount(0);
    await expect(page.getByText("Answered by Dana Teammate")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Planning only" }))
      .toBeChecked();
  });

  test("a second participant's planning-only change shows live and survives a reconnect", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    const stream = await mockStream(page);
    await open(page, state);
    await showPlan(page);
    await expect.poll(() => stream.subscribes.length).toBe(1);
    const toggle = page.getByRole("switch", { name: "Planning only" });
    await expect(toggle).not.toBeChecked();
    // The teammate turns planning-only on: delivered by the live event.
    state.task = { ...state.task, planningOnly: true, version: 4 };
    stream.push();
    await expect(toggle).toBeChecked();
    // The stream drops and the teammate turns it off meanwhile: the page says
    // the feed is lost, and the return re-reads the task without a reload.
    stream.drop();
    await expect(page.locator('[data-ui-region="live-lost"]')).toBeVisible();
    state.task = { ...state.task, planningOnly: false, version: 5 };
    await expect.poll(() => stream.subscribes.length, { timeout: 15_000 })
      .toBe(2);
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-ui-region="live-lost"]')).toHaveCount(0);
    // Reading never wrote: this participant sent no task update.
    expect(state.patches).toHaveLength(0);
  });

  test("a dropped stream is announced and everything is re-read when it returns", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    const stream = await mockStream(page);
    await open(page, state);
    await expect.poll(() => stream.subscribes.length).toBe(1);
    stream.drop();
    await expect(page.locator('[data-ui-region="live-lost"]')).toBeVisible();
    state.messages.push(
      message(5, "user", "While you were away.", otherPrincipalId),
    );
    await expect.poll(() => stream.subscribes.length, { timeout: 15_000 })
      .toBe(2);
    await expect(page.getByRole("log").getByText("While you were away."))
      .toBeVisible();
    await expect(page.locator('[data-ui-region="live-lost"]')).toHaveCount(0);
  });

  test("a stale answer after a teammate answered shows the conflict and the recorded answer", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    state.answerReply = (route) => {
      state.questions = [question({
        status: "answered",
        answer: { optionId: "choose" },
        answeredBy: otherPrincipalId,
        version: 3,
      })];
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: problem(409, "STATE_CONFLICT"),
      });
    };
    await open(page, state);
    await showPlan(page);
    await page.getByLabel("Bakery only").check({ force: true });
    await page.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByText("Someone already answered")).toBeVisible();
    await expect(page.getByText("Answered by Dana Teammate")).toBeVisible();
    await expect(page.getByText("Choose repositories")).toBeVisible();
    await expect(page.locator(".ui-question-card__status")).toHaveText(
      "Answered",
    );
    expect(state.answers).toHaveLength(1);
  });

  test("the draft stays private while a teammate writes", async ({ page }) => {
    const state = world({ participants: [teammate, me] });
    const stream = await mockStream(page);
    await open(page, state);
    await expect.poll(() => stream.subscribes.length).toBe(1);
    const box = page.getByRole("textbox", { name: "Message this task" });
    await box.fill("Not yet");
    state.messages.push(message(6, "user", "From Dana.", otherPrincipalId));
    stream.push();
    await expect(page.getByRole("log").getByText("From Dana.")).toBeVisible();
    await expect(box).toHaveValue("Not yet");
    expect(state.sent).toHaveLength(0);
  });
});

test("the trail leads back to Work and names the task as the current page", async ({ page, isMobile }) => {
  // The trail is in the top bar; a phone shows the page title there instead.
  test.skip(isMobile, "the top bar shows no trail on a phone");
  await open(page);
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail.getByRole("link")).toHaveCount(1);
  await expect(trail.getByRole("link")).toHaveAttribute("href", "/tasks");
  await expect(trail.locator("[aria-current=page]")).toHaveCount(1);
  await page.mouse.move(900, 600);
  await shot(page, "breadcrumbs-task");
});
