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
import { createHash } from "node:crypto";
import { shot } from "./helpers/real-api.ts";
import { still } from "./helpers/stills.ts";

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
  displayName: "Alex Builder",
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
  /** The people the mention picker offers, as the server reads them. */
  candidates: {
    principalId: string;
    displayName: string;
    hasAccess: boolean;
    gainsAccessOnSend: boolean;
  }[];
  /** Reading the candidates answers this status. */
  candidatesStatus: number;
  /** The reader may share the conversation (the People added link). */
  canShare: boolean;
  /** People a mention opened the conversation to. */
  grants: Record<string, unknown>[];
  /** Taking a grant back answers this status (412 is the version conflict). */
  revokeStatus: number;
  revokes: { principalId: string; ifMatch: string | undefined }[];
  /** Who can give access to the conversation, for a writer who may not (up to three). */
  sharers: { principalId: string; displayName: string }[];
  /** Reading the sharers answers this status. */
  sharersStatus: number;
  /** The search texts the picker asked for. */
  searches: string[];
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
    candidates: [
      {
        principalId: "00000000-0000-4000-8000-0000000000a1",
        displayName: "Ana Ruiz",
        hasAccess: true,
        gainsAccessOnSend: false,
      },
      {
        principalId: "00000000-0000-4000-8000-0000000000a2",
        displayName: "Sam Patel",
        hasAccess: false,
        gainsAccessOnSend: true,
      },
      {
        principalId: "00000000-0000-4000-8000-0000000000a3",
        displayName: "Samir Okafor",
        hasAccess: false,
        gainsAccessOnSend: false,
      },
    ],
    candidatesStatus: 200,
    canShare: false,
    grants: [],
    revokeStatus: 200,
    revokes: [],
    sharers: [
      {
        principalId: "00000000-0000-4000-8000-0000000000e1",
        displayName: "Dana Lee",
      },
      {
        principalId: "00000000-0000-4000-8000-0000000000e2",
        displayName: "Omar Haddad",
      },
    ],
    sharersStatus: 200,
    searches: [],
    ...overrides,
  };
}

const page_ = <T>(items: T[]) => ({ items, nextCursor: null });

async function mockWorld(page: Page, state: World) {
  await page.route(
    `**/v1/organizations/${organizationId}/effective-access`,
    (route) =>
      route.fulfill({
        json: {
          organizationId,
          role: "developer",
          capabilities: state.canShare ? ["conversation:share"] : [],
        },
      }),
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/conversations/${conversationId}/mention-candidates`,
    (route) => {
      const url = new URL(route.request().url());
      const text = (url.searchParams.get("query") ?? "").toLowerCase();
      state.searches.push(text);
      if (state.candidatesStatus !== 200) {
        return route.fulfill({
          status: state.candidatesStatus,
          contentType: "application/problem+json",
          json: problem(state.candidatesStatus, "UNAVAILABLE", true),
        });
      }
      const found = state.candidates.filter((entry) =>
        entry.displayName.toLowerCase().includes(text)
      );
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const next = from + limit;
      return route.fulfill({
        json: {
          items: found.slice(from, next),
          nextCursor: next < found.length ? String(next) : null,
        },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/conversations/${conversationId}/access/sharers`,
    (route) =>
      state.sharersStatus === 200
        ? route.fulfill({ json: { items: state.sharers } })
        : route.fulfill({
          status: state.sharersStatus,
          contentType: "application/problem+json",
          json: problem(state.sharersStatus, "UNAVAILABLE", false),
        }),
  );
  await page.route(
    (url) => url.pathname === `/v1/conversations/${conversationId}/access`,
    (route) => route.fulfill({ json: page_(state.grants) }),
  );
  await page.route(
    (url) =>
      /^\/v1\/conversations\/[^/]+\/access\/[^/]+\/revoke$/.test(url.pathname),
    (route) => {
      const request = route.request();
      const principal = new URL(request.url()).pathname.split("/")[5];
      state.revokes.push({
        principalId: principal,
        ifMatch: request.headers()["if-match"],
      });
      if (state.revokeStatus !== 200) {
        return route.fulfill({
          status: state.revokeStatus,
          contentType: "application/problem+json",
          json: problem(
            state.revokeStatus,
            state.revokeStatus === 412 ? "PRECONDITION_FAILED" : "UNAVAILABLE",
            false,
          ),
        });
      }
      const grant = state.grants.find((entry) =>
        entry.principalId === principal
      );
      state.grants = state.grants.filter((entry) =>
        entry.principalId !== principal
      );
      return route.fulfill({ json: { ...grant, revokedAt: stamp(59) } });
    },
  );
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
  page.getByRole("button", { name: `Approve plan, version ${n}`, exact: true });

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

for (const width of [1024, 1280]) {
  test(`the stage chips wrap, and nothing is cut or covered, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const strip = page.locator('[data-ui-component="workflowStageStrip"]');
    await expect(strip).toBeVisible();
    const stripBox = (await strip.boundingBox())!;
    const chips = strip.locator("li");
    await expect(chips).toHaveCount(4);
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (let index = 0; index < 4; index++) {
      const chip = chips.nth(index);
      boxes.push((await chip.boundingBox())!);
      // Every line of text inside a chip lies within the chip.
      expect(
        await chip.evaluate((element) => {
          const frame = element.getBoundingClientRect();
          return [...element.querySelectorAll("*")].every((child) => {
            const box = child.getBoundingClientRect();
            return box.right <= frame.right + 1 && box.left >= frame.left - 1;
          });
        }),
        `chip ${index + 1} keeps its text`,
      ).toBe(true);
      expect(boxes[index].x + boxes[index].width).toBeLessThanOrEqual(
        stripBox.x + stripBox.width + 1,
      );
    }
    // The Planning only switch is on no chip.
    const toggle = (await strip.getByText("Planning only").boundingBox())!;
    for (const [index, box] of boxes.entries()) {
      const covers = toggle.x < box.x + box.width - 1 &&
        toggle.x + toggle.width > box.x + 1 &&
        toggle.y < box.y + box.height - 1 &&
        toggle.y + toggle.height > box.y + 1;
      expect(covers, `the switch covers chip ${index + 1}`).toBe(false);
    }
  });
}

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
  await expect(transcript.getByText("A teammate")).toBeVisible();
  // Oldest first.
  const bodies = await transcript.locator("article").allTextContents();
  expect(bodies[0]).toContain("Let's make onboarding");
  expect(bodies.at(-1)).toContain("show missing checks");
  await expect(plan(page)).toContainText("Plan, version 3");
  await expect(plan(page).getByRole("listitem")).toHaveCount(3);
  await expect(plan(page)).toContainText("1. Select the repository");
  await expect(approve(page, 3)).toBeEnabled();
  await still(page, "plan-conversation");
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
  await expect(page.getByText("You approved plan, version 3")).toBeVisible();
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
  await expect(page.getByText("You approved plan, version 3")).toBeVisible();
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
  await expect(plan(page)).toContainText("Plan, version 4", {
    timeout: 15_000,
  });
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
  await expect(page.getByText("You rejected plan, version 3")).toBeVisible();
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
  await expect(page.getByText("Plan, version 3 is out of date")).toBeVisible();
  await expect(plan(page)).toContainText("Plan, version 4");
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
  await expect(page.getByText("You approved plan, version 3")).toBeVisible({
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
  await expect(page.getByText("Plan, version 3 is out of date")).toHaveCount(
    0,
  );
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
  // A disabled Send answer says why, under itself.
  await expect(page.getByText("Choose an answer first.")).toBeVisible();
  await page.getByLabel("Bakery only").check({ force: true });
  await expect(page.getByText("Choose an answer first.")).toHaveCount(0);
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
    .toContainText("You cannot redirect this run while it works");
  await expect(
    page.getByText("This machine cannot pause a run.")
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
    await expect(plan(page)).toContainText("Plan, version 3");
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
    await expect(page.getByText(/^You are offline\. Your draft/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeDisabled();
    await showPlan(page);
    await expect(approve(page, 3)).toBeDisabled();
    await hidePlan(page);
    await context.setOffline(false);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(page.getByText(/^You are offline\. Your draft/)).toHaveCount(
      0,
    );
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
    // Wait on state, not time: the plan is loaded when Approve is enabled, the
    // server answered when the mock has seen the decision, and only then is the
    // notice expected. A loaded host slows each step but cannot reorder them.
    await expect(approve(page, 3)).toBeEnabled({ timeout: 15_000 });
    await approve(page, 3).click();
    await expect.poll(() => state.decisions.length, { timeout: 15_000 })
      .toBe(1);
    await expect(page.getByText("Nothing was decided")).toBeVisible({
      timeout: 15_000,
    });
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
      page.getByRole("button", { name: "Send answer" }),
    ]);
    // The switch's touch target is its label (Switch.tsx makes the label the
    // frame), not the 16px input inside it: measure the label, and prove it by
    // tapping its edge.
    const planning = page.getByRole("switch", { name: "Planning only" });
    const frame = planning.locator("xpath=ancestor::label[1]");
    await frame.scrollIntoViewIfNeeded();
    const frameBox = await frame.boundingBox();
    expect(frameBox, "the switch's label has a box").not.toBeNull();
    expect(frameBox!.height).toBeGreaterThanOrEqual(44);
    expect(frameBox!.width).toBeGreaterThanOrEqual(44);
    const before = await planning.isChecked();
    await frame.click({
      position: { x: frameBox!.width - 2, y: frameBox!.height / 2 },
    });
    await expect(planning).toBeChecked({ checked: !before });
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
      "Approve plan, version 3",
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
    await expect(transcript.getByText("A teammate", { exact: true }))
      .toHaveCount(
        0,
      );
    await expect(transcript.locator('[data-variant="person"]').first())
      .toContainText("You");
    await expect(transcript.locator('[data-variant="agent"]')).toContainText(
      "Agent",
    );
    const people = page.locator('[data-ui-region="participants"]');
    await expect(people).toContainText("Participants (2)");
    await expect(people.getByRole("listitem")).toHaveCount(2);
    await expect(people.getByRole("listitem").first()).toContainText(
      "Alex Builder (you)",
    );
    await expect(people.getByRole("img", { name: "Dana Teammate" }))
      .toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("an unnamed teammate is 'A teammate', never part of an id, and the page still works", async ({ page }) => {
    await open(page, world());
    await showPlan(page);
    const people = page.locator('[data-ui-region="participants"]');
    await expect(people.getByText("A teammate")).toBeVisible();
    // The reader, with no name in the projection, is "You": not "You (you)".
    await expect(people.getByText("You", { exact: true })).toBeVisible();
    await expect(people).not.toContainText("00000000");
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
    await expect(page.getByText("Dana Teammate approved plan, version 3"))
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

test("the trail leads back to Workspace and Work and names the task as the current page", async ({ page, isMobile }) => {
  // The trail is in the top bar; a phone shows the page title there instead.
  test.skip(isMobile, "the top bar shows no trail on a phone");
  await open(page);
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  const links = trail.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveText("Workspace");
  await expect(links.nth(1)).toContainText("Work");
  await expect(links.first()).toHaveAttribute("href", "/tasks");
  await expect(links.nth(1)).toHaveAttribute("href", "/tasks");
  // The task's title, not its raw id, is the current page.
  const current = trail.locator("[aria-current=page]");
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Add repository onboarding");
  await page.mouse.move(900, 600);
  await shot(page, "breadcrumbs-task", [], {
    windowOnly: true,
    only: "desktop",
  });
});

// ---- #57 task page: the run leads the notice and the badge, plain failures,
// ---- Details, answer reasons, and the item 10 frame (stills below) ----

const runStepId = "00000000-0000-4000-8000-000000000021";
const patchBody =
  "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
const patchDigest = createHash("sha256").update(patchBody).digest("hex");
const runFixture = (status: string) => ({
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
  status,
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: ["completed", "failed", "canceled"].includes(status)
    ? "2026-01-01T00:02:00.000Z"
    : null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:02:00.000Z",
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
});
const stepFixture = {
  id: runStepId,
  runId,
  stepKey: "publish",
  iteration: 1,
  status: "completed",
  input: {},
  output: null,
  error: null,
  startedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: "2026-01-01T00:02:00.000Z",
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:02:00.000Z",
  version: 1,
};
const patchArtifact = {
  id: "00000000-0000-4000-8000-000000000050",
  taskId,
  artifactType: "patch",
  name: "candidate.patch",
  currentVersionId: "00000000-0000-4000-8000-000000000052",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  version: 1,
};
const notesArtifact = {
  id: "00000000-0000-4000-8000-000000000053",
  taskId,
  artifactType: "plan",
  name: "plan-notes.md",
  currentVersionId: "00000000-0000-4000-8000-000000000055",
  createdAt: "2026-01-01T00:01:10.000Z",
  updatedAt: "2026-01-01T00:01:10.000Z",
  version: 1,
};
const versionFixture = (
  artifact: typeof patchArtifact,
  id: string,
  revision: number,
  mediaType: string,
  sizeBytes: number,
) => ({
  id,
  artifactId: artifact.id,
  revision,
  runStepId,
  authorId: principalId,
  mediaType,
  sizeBytes,
  sha256: patchDigest,
  subjectHeadSha: null,
  subjectBaseSha: null,
  metadata: {},
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
  version: 1,
});

/** An active task whose current run has the given status, with two artifacts. */
async function openRun(
  page: Page,
  status: string,
  overrides: Partial<World> = {},
  steps: unknown[] = [stepFixture],
  run: Record<string, unknown> = {},
) {
  const state = world({
    task: {
      ...baseTask,
      status: "active",
      currentRunId: runId,
      approvalPolicy: { plan: "automatic" },
    },
    revisions: [],
    approvals: [],
    questions: [],
    ...overrides,
  });
  await mockWorld(page, state);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: { ...runFixture(status), ...run } }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: page_(steps) }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: page_([patchArtifact, notesArtifact]) }),
  );
  await page.route(
    `**/v1/artifacts/${patchArtifact.id}/versions*`,
    (route) =>
      route.fulfill({
        json: page_([
          versionFixture(
            patchArtifact,
            patchArtifact.currentVersionId,
            2,
            "text/x-diff",
            Buffer.byteLength(patchBody),
          ),
          versionFixture(
            patchArtifact,
            "00000000-0000-4000-8000-000000000060",
            1,
            "text/x-diff",
            Buffer.byteLength(patchBody),
          ),
        ]),
      }),
  );
  await page.route(
    `**/v1/artifacts/${notesArtifact.id}/versions*`,
    (route) =>
      route.fulfill({
        json: page_([
          versionFixture(
            notesArtifact,
            notesArtifact.currentVersionId,
            1,
            "text/markdown",
            40,
          ),
        ]),
      }),
  );
  await page.route(
    "**/v1/artifact-versions/*/content*",
    (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/x-diff",
          "content-length": String(Buffer.byteLength(patchBody)),
          etag: `"${patchDigest}"`,
        },
        body: patchBody,
      }),
  );
  await firstRender(
    () => page.goto(`/tasks/${taskId}`),
    (timeout) => expect(conversation(page)).toBeVisible({ timeout }),
  );
  return state;
}

for (
  const [status, notice] of [
    [
      "running",
      "A run is in progress. Your message is saved and the agent reads it at its next step.",
    ],
    [
      "blocked",
      "This run is blocked. Your message is saved and the agent reads it when the run continues.",
    ],
    ["failed", null],
    ["completed", null],
  ] as const
) {
  test(`the message notice follows the run: ${status}`, async ({ page }) => {
    await openRun(page, status);
    const composer = page.locator('[data-ui-region="composer"]');
    await expect(composer.getByRole("textbox")).toBeVisible();
    if (notice === null) {
      await expect(composer.getByText("A run is in progress.")).toHaveCount(0);
      await expect(composer.getByText(/^This run is blocked\./)).toHaveCount(0);
    } else {
      await expect(composer.getByText(notice, { exact: true })).toBeVisible();
    }
  });
}

test("a blocked run has one status, the reason, and no 'no steps' text", async ({ page }) => {
  await openRun(page, "blocked", {}, []);
  const section = page.locator("body");
  await expect(
    section.getByText("This run is waiting for another task to finish.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(section.getByText("No steps have been recorded.")).toHaveCount(
    0,
  );
  await expect(section.getByText("Blocked", { exact: true }).first())
    .toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) >= 744) {
    // The page's own status badge reads the same.
    await expect(page.getByText("Implementing", { exact: true })).toHaveCount(
      0,
    );
  }
});

test("Current run has one status badge, and the run id sits under Details", async ({ page }) => {
  await openRun(page, "running");
  const heading = page.getByRole("heading", { name: "Current run" });
  await expect(heading).toBeVisible();
  await expect(page.getByText("Running", { exact: true }).first())
    .toBeVisible();
  // The id is not on the page until Details is opened, and then it is short.
  const row = page.getByTestId("run-id-row");
  await expect(row).toBeHidden();
  await page.getByText("Details", { exact: true }).first().click();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Run ID");
  await expect(row).toContainText(runId.slice(0, 8));
  await expect(row).not.toContainText(runId.slice(0, 9));
});

test("a part of the page that did not load is a warning notice with an outline Try again", async ({ page }) => {
  await open(page, world({ messagesStatus: 500, sectionsStatus: 500 }));
  await expect(page.getByText("The conversation could not be loaded."))
    .toBeVisible();
  const retries = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retries.first()).toBeVisible();
  for (const retry of await retries.all()) {
    await expect(retry).toHaveAttribute("data-variant", "outline");
  }
});

test("the Planning only hint is visible under the switch", async ({ page }) => {
  await open(page);
  // On a phone the switch is in the plan sheet, so the hint goes there.
  if ((page.viewportSize()?.width ?? 1280) <= 743) {
    await showPlan(page);
    await page.mouse.move(200, 700);
    await shot(page, "task-plan-sheet-planning-only", [], { only: "mobile" });
  }
  await expect(
    page.getByText("Stop after the plan. No run starts from this task."),
  ).toBeVisible();
});

test("the Planning only switch never points at a description that is not there", async ({ page }) => {
  await open(page);
  await showPlan(page);
  const toggle = page.getByRole("switch", { name: "Planning only" });
  await expect(toggle).toBeVisible();
  const id = await toggle.getAttribute("aria-describedby");
  // Both layouts name their description now (design-ux, #57 item 14): the phone
  // carries the same line under its switch in the plan sheet.
  expect(id).toBeTruthy();
  await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
  await expect(toggle).toHaveAccessibleDescription(
    "Stop after the plan. No run starts from this task.",
  );
});

test("the artifact panel keeps its facts under Details and reads a patch as text", async ({ page }) => {
  await openRun(page, "completed");
  const pane = page.getByRole("complementary", { name: "Artifact" });
  const aside = (await pane.count()) > 0 ? pane : page.locator("body");
  await expect(aside.getByText("candidate.patch").first()).toBeVisible();
  await expect(aside.getByText("+new").first()).toBeVisible();
  await expect(aside.getByText("Preview unavailable")).toHaveCount(0);
  // Closed by default: no raw id, digest or step id on the page.
  await expect(aside.getByTestId("artifact-id-row")).toBeHidden();
  await aside.getByText("Details", { exact: true }).last().click();
  await expect(aside.getByTestId("artifact-id-row")).toContainText("ID");
  await expect(aside.getByTestId("artifact-fingerprint-row")).toContainText(
    "Fingerprint",
  );
  await expect(aside.getByText("Made by", { exact: true })).toBeVisible();
  // The step's name, not its id.
  await expect(aside.getByText(runStepId)).toHaveCount(0);
  await expect(aside.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    new RegExp(`/tasks/${taskId}/artifacts/`),
  );
});

// ---- stills for the #57 review (BAKERY_STILLS_DIR; nothing is written otherwise)

test("still: the task page with a failed run and two artifacts", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await openRun(page, "failed");
  await expect(page.getByText("candidate.patch").first()).toBeVisible();
  await still(page, "task-page-failed");
});

/** Scroll every scroller to its end; what is left over is the page scrolling as a whole. */
async function scrollEverythingToItsEnd(page: Page) {
  return await page.evaluate(() => {
    for (const node of Array.from(document.querySelectorAll("*"))) {
      if (!(node instanceof HTMLElement)) continue;
      if (
        /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
        node.scrollHeight > node.clientHeight + 1
      ) node.scrollTop = node.scrollHeight;
    }
    const root = document.scrollingElement as HTMLElement;
    const composer = document.querySelector('[data-ui-region="composer"]');
    return {
      overflow: root.scrollHeight - root.clientHeight,
      scrollTop: root.scrollTop,
      composerBottom: composer?.getBoundingClientRect().bottom ?? 0,
      windowHeight: globalThis.innerHeight,
    };
  });
}

for (
  const [label, width, height] of [["1440", 1440, 900], [
    "390",
    390,
    844,
  ]] as const
) {
  for (const status of ["running", "blocked", "failed", "completed"] as const) {
    test(`the task page is the window: it never scrolls as a whole (${label}, ${status})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openRun(page, status);
      await expect(page.getByRole("textbox", { name: "Message this task" }))
        .toBeVisible();
      await page.waitForTimeout(500);
      const result = await scrollEverythingToItsEnd(page);
      // The frame is exactly the window: the document has nothing to scroll,
      // and the message area ends inside it.
      expect(result.overflow).toBeLessThanOrEqual(0);
      expect(result.scrollTop).toBe(0);
      expect(result.composerBottom).toBeLessThanOrEqual(
        result.windowHeight + 1,
      );
    });
  }
}

test("still: the task page at the window top and the very bottom", async ({ page }) => {
  const directory = process.env.BAKERY_STILLS_DIR;
  test.skip(!directory, "BAKERY_STILLS_DIR is not set");
  await openRun(page, "failed");
  await expect(page.getByText("candidate.patch").first()).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (
      const [label, width, height] of [["1440", 1440, 900], [
        "390",
        390,
        844,
      ]] as const
    ) {
      await page.setViewportSize({ width, height });
      await page.goto(`/tasks/${taskId}`);
      await expect(page.getByRole("textbox", { name: "Message this task" }))
        .toBeVisible();
      await page.waitForTimeout(800);
      await scrollEverythingToItsEnd(page);
      await page.screenshot({
        path: `${directory}/task-page-window-${label}-${scheme}-bottom.png`,
      });
      await page.evaluate(() => {
        for (const node of Array.from(document.querySelectorAll("*"))) {
          if (node instanceof HTMLElement && node.scrollTop > 0) {
            node.scrollTop = 0;
          }
        }
      });
      await page.screenshot({
        path: `${directory}/task-page-window-${label}-${scheme}-top.png`,
      });
    }
  }
});

test("still: a blocked run that waits on one task", async ({ page }) => {
  await openRun(page, "blocked", {}, [], {
    blockedReason: "dependency_incomplete",
    blockingTasks: [blockingTask(1, "Charge the first payment")],
  });
  await expect(page.getByRole("link", { name: "Charge the first payment" }))
    .toBeVisible();
  await still(page, "task-page-blocked-one-task", undefined, {
    scrollTo: page.getByRole("heading", { name: "Current run" }),
  });
});

test("still: a blocked run that waits on several tasks", async ({ page }) => {
  await openRun(page, "blocked", {}, [], {
    blockedReason: "dependency_incomplete",
    blockingTasks: [
      blockingTask(1, "Charge the first payment"),
      blockingTask(2, "Email the receipt"),
      blockingTask(3, "Close the ledger"),
    ],
  });
  await expect(page.getByText("Waiting for 3 tasks to finish:"))
    .toBeVisible();
  await still(page, "task-page-blocked-several-tasks", undefined, {
    scrollTo: page.getByRole("heading", { name: "Current run" }),
  });
});

test("still: a blocked run whose reason Bakery does not know", async ({ page }) => {
  await openRun(page, "blocked", {}, [], {
    blockedReason: "capacity_unavailable",
    blockingTasks: [],
  });
  await expect(
    page.getByText("This run is blocked. Bakery does not know why."),
  ).toBeVisible();
  await still(page, "task-page-blocked-unknown-reason", undefined, {
    scrollTo: page.getByRole("heading", { name: "Current run" }),
  });
});

test("still: a blocked run", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await openRun(page, "blocked", {}, []);
  await expect(
    page.getByText("This run is waiting for another task to finish."),
  ).toBeVisible();
  await still(page, "task-page-blocked");
});

test("still: the two load failures together", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await open(page, world({ messagesStatus: 500, sectionsStatus: 500 }));
  await expect(page.getByText("The conversation could not be loaded."))
    .toBeVisible();
  await still(page, "task-page-load-failures");
});

test("still: the Current run line with Details open", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await openRun(page, "running");
  await page.getByText("Details", { exact: true }).first().click();
  await expect(page.getByTestId("run-id-row")).toBeVisible();
  await still(page, "task-page-run-details");
});

test("still: the artifact panel with Details open and a patch preview", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await openRun(page, "completed");
  await expect(page.getByText("+new").first()).toBeVisible();
  await page.getByText("Details", { exact: true }).last().click();
  await expect(page.getByTestId("artifact-id-row")).toBeVisible();
  await still(page, "task-page-artifact-details");
});

test("still: the people with an unnamed teammate, and a disabled Send answer", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await open(page);
  await showPlan(page);
  await expect(page.getByText("Choose an answer first.")).toBeVisible();
  await still(page, "task-page-people-and-answer");
});

for (
  const [name, availability] of [
    ["enabled", { status: "ready", reasons: [] }],
    [
      "disabled",
      { status: "setup_required", reasons: ["coding_agent_unbound"] },
    ],
  ] as const
) {
  test(`still: Start run ${name}`, async ({ page }) => {
    test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
    const state = world();
    await mockWorld(page, state);
    await page.route("**/v1/workflow-presets*", (route) =>
      route.fulfill({
        json: page_([{
          id: "fixed-coding",
          revision: 1,
          digest: "a".repeat(64),
          nameKey: "workflowPresets.fixedCoding.name",
          steps: [{ id: "implement", uses: "harness.implement" }],
          defaultBudgetLimitUsd: "5.00",
          availability: { minimumBudgetLimitUsd: null, ...availability },
        }]),
      }));
    await firstRender(
      () => page.goto(`/tasks/${taskId}`),
      (timeout) => expect(conversation(page)).toBeVisible({ timeout }),
    );
    await showPlan(page);
    await approve(page, 3).click();
    await expect(page.getByText("You approved plan, version 3")).toBeVisible();
    const sheet = page.locator('[data-ui-region="plan-sheet"]');
    if (await sheet.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    }
    const start = page.getByRole("button", { name: "Start run", exact: true });
    await expect(start).toBeVisible();
    await expect(start)[name === "enabled" ? "toBeEnabled" : "toBeDisabled"]();
    await expect(start).toHaveAttribute(
      "data-variant",
      name === "enabled" ? "primary" : "outline",
    );
    await still(page, `task-page-start-run-${name}`);
  });
}

// ---- what a blocked run says (design-ux, #57 item 13): the reason and the
// tasks the server sends, said plainly, and unknown said as unknown.

const blockingTask = (n: number, title: string) => ({
  id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
  title,
  status: "active",
});

test("a blocked run that names one task waits on it, with the title as a link", async ({ page }) => {
  const waiting = blockingTask(1, "Charge the first payment");
  await openRun(page, "blocked", {}, [], {
    blockedReason: "dependency_incomplete",
    blockingTasks: [waiting],
  });
  const sentence = page.getByText("Waiting for", { exact: false }).first();
  await expect(sentence).toContainText("to finish.");
  const link = page.getByRole("link", { name: waiting.title });
  await expect(link).toHaveAttribute("href", `/tasks/${waiting.id}`);
  await expect(
    page.getByText("This run is waiting for another task to finish."),
  ).toHaveCount(0);
});

test("a blocked run that names several tasks counts them and lists each as a link", async ({ page }) => {
  const waiting = [
    blockingTask(1, "Charge the first payment"),
    blockingTask(2, "Email the receipt"),
    blockingTask(3, "Close the ledger"),
  ];
  await openRun(page, "blocked", {}, [], {
    blockedReason: "dependency_incomplete",
    blockingTasks: waiting,
  });
  await expect(page.getByText("Waiting for 3 tasks to finish:"))
    .toBeVisible();
  for (const task of waiting) {
    await expect(page.getByRole("link", { name: task.title }))
      .toHaveAttribute("href", `/tasks/${task.id}`);
  }
  // The server caps the list, so the page says there may be more instead of
  // pretending the list is complete.
  await expect(page.getByText("and more")).toHaveCount(0);
});

test("a blocked run whose list is at the server's cap says there may be more", async ({ page }) => {
  const waiting = Array.from(
    { length: 25 },
    (_, index) => blockingTask(index + 1, `Waiting task ${index + 1}`),
  );
  await openRun(page, "blocked", {}, [], {
    blockedReason: "dependency_incomplete",
    blockingTasks: waiting,
  });
  await expect(page.getByText("Waiting for 25 tasks to finish:"))
    .toBeVisible();
  await expect(page.getByText("and more")).toBeVisible();
});

test("a blocked run whose reason the page does not know says it does not know", async ({ page }) => {
  await openRun(page, "blocked", {}, [], {
    blockedReason: "capacity_unavailable",
    blockingTasks: [],
  });
  await expect(
    page.getByText("This run is blocked. Bakery does not know why."),
  ).toBeVisible();
  await expect(
    page.getByText("This run is waiting for another task to finish."),
  ).toHaveCount(0);
});

/** Mentions in the task composer and the people they added (#73, UX revision 2). */
const ANA = "00000000-0000-4000-8000-0000000000a1";
const SAM = "00000000-0000-4000-8000-0000000000a2";
const messageBox = (page: Page) =>
  page.getByRole("textbox", { name: "Message this task" });
const refusal = (issues: { index: number; code: string }[]) => ({
  ...problem(422, "UNPROCESSABLE"),
  issues: issues.map(({ index, code }) => ({
    path: `/mentions/${index}`,
    code,
    message: code.replaceAll("_", " "),
  })),
});

test("typing @ opens the people you can mention: quiet rows, and one badge for anyone without access", async ({ page }) => {
  const state = await open(page);
  await messageBox(page).fill("@");
  const list = page.getByRole("listbox", { name: "People you can mention" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "Ana Ruiz", exact: true }))
    .toBeVisible();
  await expect(
    list.getByRole("option", { name: "Sam Patel, no access yet" }),
  ).toBeVisible();
  // Sam (the writer may share) and Samir (someone else has to) both wear it.
  await expect(list.getByText("No access yet")).toHaveCount(2);
  // Anyone without access can be chosen, whether or not the writer may share.
  const asks = list.getByRole("option", {
    name: "Samir Okafor, no access yet",
  });
  await expect(asks).toBeVisible();
  await expect(asks).not.toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByText(
      "You can give access when you send.",
    ),
  ).toBeVisible();
  // The field's focus ring stays clear of the toolbar and its Send under it.
  const field = await messageBox(page).boundingBox();
  const send = await page.getByRole("button", { name: "Send", exact: true })
    .boundingBox();
  if (field === null || send === null) throw new Error("no boxes");
  expect(send.y - (field.y + field.height)).toBeGreaterThanOrEqual(4);
  await page.mouse.move(700, 100);
  await still(page, "mentions-picker");
  await messageBox(page).fill("Hi @sa");
  await expect.poll(() => state.searches).toContain("sa");
  await expect(list.getByRole("option", { name: "Ana Ruiz", exact: true }))
    .toHaveCount(0);
});

test("choosing a person writes @Name, shows who will be notified and what Send gives, and sends mentions", async ({ page }) => {
  const state = await open(page);
  await messageBox(page).fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" })
    .click();
  await expect(messageBox(page)).toHaveValue("Hi @Sam Patel ");
  await expect(page.getByText("Sam Patel · no access yet")).toBeVisible();
  await expect(
    page.getByText("Sam Patel can't see this conversation. Give them access?"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "They will be able to read and reply in this conversation. Nothing else in the task is shared. This is the only access a mention can give here.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Don't mention Sam Patel" }),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "mentions-ready");
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0].body).toMatchObject({
    body: "Hi @Sam Patel",
    mentions: [SAM],
  });
});

test("the keys: arrows move, Enter chooses, Escape closes and keeps the text", async ({ page }) => {
  await open(page);
  const box = messageBox(page);
  await box.fill("@");
  await expect(page.getByRole("listbox")).toBeVisible();
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@Sam Patel ");
  await box.press("End");
  await box.pressSequentially("@");
  await expect(page.getByRole("listbox")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(box).toHaveValue("@Sam Patel @");
  // The third row has no access and the writer may not share: it is chosen too.
  await box.fill("@");
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@Samir Okafor ");
});

test("editing the inserted name drops its chip; the chip's button takes the @ name off; a typed @name mentions nobody", async ({ page }) => {
  const state = await open(page);
  const box = messageBox(page);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove mention of Ana Ruiz" }),
  ).toBeVisible();
  await box.fill("Hi @Ana Rui");
  await expect(
    page.getByRole("button", { name: "Remove mention of Ana Ruiz" }),
  ).toHaveCount(0);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Remove mention of Ana Ruiz" })
    .click();
  await expect(box).not.toHaveValue(/@Ana Ruiz/);
  // A name typed by hand is just text.
  await box.fill("Thanks @Ana Ruiz");
  await expect(page.getByText("Will be notified")).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0].body).not.toHaveProperty("mentions");
});

test("a refused mention writes nothing: the draft stays, the name turns red, Send waits until it is removed", async ({ page }) => {
  const state = world();
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([{ index: 0, code: "mention_not_member" }]),
    });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" })
    .click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  const alert = page.getByRole("alert").filter({ hasText: "Not sent." });
  await expect(alert).toHaveText(
    "Not sent. Sam Patel is no longer a member of Fixture Org. Remove the mention.",
  );
  await expect(box).toHaveValue("Hi @Sam Patel ");
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeDisabled();
  // A refused person gains nothing: the chip is the name only and no line
  // says Send gives them access.
  await expect(page.getByText("Sam Patel · no access yet")).toHaveCount(0);
  await expect(page.getByText(/Give them access\?/)).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "mentions-refused");
  await page.getByRole("button", { name: "Remove mention of Sam Patel" })
    .click();
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeEnabled();
});

test("when the server says the writer may not share after all, nothing is sent and the block asks someone who can", async ({ page }) => {
  const state = world();
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([{ index: 0, code: "mention_share_forbidden" }]),
    });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" })
    .click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect(
    page.getByText(
      "Not sent. Sam Patel can't see this conversation, and you can no longer give access to it.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Dana Lee or Omar Haddad can. Ask one of them here, or send without the mention.",
    ),
  ).toBeVisible();
  // Nothing is red: the draft stays and the block says what to do.
  await expect(page.getByRole("alert").filter({ hasText: "Not sent." }))
    .toHaveCount(0);
  await expect(box).toHaveValue("Hi @Sam Patel ");
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeDisabled();
  await expect(
    page.getByText(
      "Ask Dana Lee or Omar Haddad, or remove the mention to send.",
    ),
  )
    .toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "mentions-share-lost");
  await page.getByRole("button", { name: "Remove mention of Sam Patel" })
    .click();
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeEnabled();
});

test("a refusal that says the person has no access after all brings the offer back, starting Not sent", async ({ page }) => {
  const state = world();
  state.sendReply = (route, attempt) =>
    attempt === 1
      ? route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        json: refusal([{ index: 0, code: "mention_no_thread_access" }]),
      })
      : route.fulfill({ status: 201, json: message(41, "user", "Hi") });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(
      "Not sent. Ana Ruiz can't see this conversation. Give them access?",
    ),
  ).toBeVisible();
  // Not the document's sentence, and not a red refusal with no way forward.
  await expect(page.getByText(/can't see this document/)).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "Not sent." }))
    .toHaveCount(0);
  await expect(page.getByText("Ana Ruiz · no access yet")).toBeVisible();
  await expect(box).toHaveValue("Hi @Ana Ruiz ");
  await page.mouse.move(700, 100);
  await still(page, "mentions-not-sent-offer");
  // The same button gives the access and sends.
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect.poll(() => state.sent.length).toBe(2);
  expect(state.sent[1].body).toMatchObject({ mentions: [ANA] });
});

test("the Not sent wording goes when the refused person is swapped for someone else", async ({ page }) => {
  const state = world();
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([{ index: 0, code: "mention_no_thread_access" }]),
    });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(
      "Not sent. Ana Ruiz can't see this conversation. Give them access?",
    ),
  ).toBeVisible();
  // Swap her for Sam, who also needs access: no send involving Sam has failed.
  await page.getByRole("button", { name: "Remove mention of Ana Ruiz" })
    .click();
  await box.press("End");
  await box.pressSequentially("@sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await expect(
    page.getByText("Sam Patel can't see this conversation. Give them access?", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Not sent\./)).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "mentions-swapped-offer");
});

test("the Not sent wording of the cannot-share block goes the same way", async ({ page }) => {
  const state = world();
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([{ index: 0, code: "mention_share_forbidden" }]),
    });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect(
    page.getByText(
      "Not sent. Sam Patel can't see this conversation, and you can no longer give access to it.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove mention of Sam Patel" })
    .click();
  await box.press("End");
  await box.pressSequentially("@sam");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
  await expect(
    page.getByText(
      "Samir Okafor can't see this conversation, and you can't give access to it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/^Not sent\./)).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "mentions-swapped-block");
});

test("the other refusals use their own sentence, and several are counted", async ({ page }) => {
  const state = world();
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([{ index: 0, code: "mention_not_member" }]),
    });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("@sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" })
    .click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent." }))
    .toHaveText(
      "Not sent. Sam Patel is no longer a member of Fixture Org. Remove the mention.",
    );
  state.sendReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: refusal([
        { index: 0, code: "mention_not_member" },
        { index: 1, code: "mention_not_member" },
      ]),
    });
  await box.press("End");
  await box.pressSequentially("@an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Remove mention of Sam Patel" })
    .click();
  await box.press("End");
  await box.pressSequentially("@sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" })
    .click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent." }))
    .toHaveText(
      "Not sent. 2 people can't be mentioned. Remove the red names to send.",
    );
});

test("no one found, a failed read with Try again, and the limit of 20 people", async ({ page }) => {
  const state = await open(page);
  const box = messageBox(page);
  await box.fill("@zzz");
  await expect(page.getByText("No one found in Fixture Org.")).toBeVisible();
  state.candidatesStatus = 503;
  await box.fill("@sa");
  await expect(page.getByText("People could not be loaded.")).toBeVisible();
  state.candidatesStatus = 200;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("option", { name: /Sam Patel/ })).toBeVisible();
  // Twenty people in one message is the most there can be.
  state.candidates = Array.from({ length: 22 }, (_, index) => ({
    principalId: `00000000-0000-4000-8000-00000000b${
      String(index).padStart(3, "0")
    }`,
    displayName: `Person ${String(index + 1).padStart(2, "0")}`,
    hasAccess: true,
    gainsAccessOnSend: false,
  }));
  await box.fill("@");
  for (let index = 0; index < 20; index += 1) {
    await expect(page.getByRole("listbox")).toBeVisible();
    await box.press("Enter");
    await box.press("End");
    await box.pressSequentially("@");
  }
  await expect(
    page.getByText("You can mention up to 20 people in one message."),
  ).toBeVisible();
});

const NO_ACCESS = [
  "Ana Ruiz",
  "Sam Patel",
  "Lee Wu",
  "Kim Oh",
  "Dana Lee",
  "Omar Haddad",
];
const noAccessWorld = () =>
  world({
    candidates: NO_ACCESS.map((displayName, index) => ({
      principalId: `00000000-0000-4000-8000-0000000000d${index}`,
      displayName,
      hasAccess: false,
      gainsAccessOnSend: true,
    })),
  });

for (const count of [3, 6]) {
  test(`${count} people without access: one question that counts them, the chips are the only list`, async ({ page }) => {
    await open(page, noAccessWorld());
    const box = messageBox(page);
    for (const name of NO_ACCESS.slice(0, count)) {
      await box.press("End");
      await box.pressSequentially(`@${name.slice(0, 3)}`);
      await page.getByRole("option", { name: `${name}, no access yet` })
        .click();
    }
    await expect(
      page.getByText(
        `${count} people can't see this conversation. Give them access?`,
      ),
    ).toBeVisible();
    await expect(
      page.getByText("To leave someone out, remove their name above."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Give access to ${count} people and send`,
        exact: true,
      }),
    ).toBeVisible();
    // The chips name everyone; the offer lists no one a second time.
    await expect(page.getByRole("button", { name: /^Remove mention of / }))
      .toHaveCount(count);
    const offer = page.getByRole("status").filter({
      hasText: "Give them access?",
    });
    await expect(offer.getByRole("button")).toHaveCount(0);
    // The draft field grows with its text: nothing of it is cut off.
    const clipped = await box.evaluate((el) =>
      el.scrollHeight - el.clientHeight
    );
    expect(clipped, "the draft field clips its text").toBeLessThanOrEqual(1);
    await page.mouse.move(700, 100);
    await still(page, `mentions-several${count}`);
  });
}

test("while the access is being given and the message sent, the offer cannot be changed", async ({ page }) => {
  const state = world();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.sendReply = async (route) => {
    await gate;
    await route.fulfill({ status: 201, json: message(41, "user", "Hi") });
  };
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  // The block is read-only: "Don't mention" would rewrite a draft already sent.
  await expect(page.getByRole("button", { name: "Don't mention Sam Patel" }))
    .toBeDisabled();
  release();
  await expect.poll(() => state.sent.length).toBe(1);
});

test("not mentioning someone keeps the name as words and drops the chip and the offer", async ({ page }) => {
  await open(page);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await expect(box).toHaveValue("Hi @Sam Patel ");
  await page.getByRole("button", { name: "Don't mention Sam Patel" }).click();
  await expect(box).toHaveValue("Hi Sam Patel ");
  await expect(page.getByText("Sam Patel · no access yet")).toHaveCount(0);
  await expect(page.getByText(/Give them access\?/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "mentions-declined");
});

const DANA = "00000000-0000-4000-8000-0000000000e1";
const askWorld = (overrides: Partial<World> = {}) =>
  world({
    candidates: [
      {
        principalId: ANA,
        displayName: "Ana Ruiz",
        hasAccess: true,
        gainsAccessOnSend: false,
      },
      {
        principalId: "00000000-0000-4000-8000-0000000000a3",
        displayName: "Samir Okafor",
        hasAccess: false,
        gainsAccessOnSend: false,
      },
    ],
    ...overrides,
  });
const SAM_GRANT = {
  id: "00000000-0000-4000-8000-0000000000c1",
  conversationId,
  principalId: SAM,
  displayName: "Sam Patel",
  grantedById: ANA,
  grantedByName: "Ana Ruiz",
  sourceMessageId: "00000000-0000-4000-8000-000000000101",
  grantedAt: stamp(5),
  revokedAt: null,
  version: 4,
};

test("a person the writer may not give access to can be chosen: the block names who can be asked, and Ask swaps the mention", async ({ page }) => {
  const state = await open(page, askWorld());
  const box = messageBox(page);
  await box.fill("Hi @sam");
  await expect(
    page.getByText("Someone else has to give access. You will see who."),
  ).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "mentions-picker-ask");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
  await expect(box).toHaveValue("Hi @Samir Okafor ");
  await expect(page.getByText("Samir Okafor · no access yet")).toBeVisible();
  await expect(
    page.getByText(
      "Samir Okafor can't see this conversation, and you can't give access to it.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Dana Lee or Omar Haddad can. Ask one of them here, or send without the mention.",
    ),
  ).toBeVisible();
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  const reason = page.getByText(
    "Ask Dana Lee or Omar Haddad, or remove the mention to send.",
  );
  await expect(reason).toBeVisible();
  // The reason is a line of its own: the footnote text after it starts below it.
  const below = await reason.evaluate((element) => {
    let node: Node | null = element.nextSibling;
    while (
      node !== null &&
      !(node.nodeType === Node.TEXT_NODE &&
        (node.textContent ?? "").trim() !== "")
    ) node = node.nextSibling;
    if (node === null) throw new Error("no footnote text after the reason");
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects()[0].top -
      element.getBoundingClientRect().bottom;
  });
  expect(below).toBeGreaterThanOrEqual(-1);
  await page.mouse.move(700, 100);
  await still(page, "mentions-cannot-share");
  await page.getByRole("button", { name: "Ask Dana Lee" }).click();
  const line = "@Dana Lee can you give Samir Okafor access to this?";
  await expect(box).toHaveValue(`Hi Samir Okafor \n${line}`);
  // The new line is selected, so typing replaces it.
  await expect.poll(() =>
    box.evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd)
    )
  ).toBe(line);
  await expect(page.getByText("Samir Okafor · no access yet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove mention of Dana Lee" }))
    .toBeVisible();
  await expect(page.getByText(/you can't give access to it/)).toHaveCount(0);
  await expect(send).toBeEnabled();
  await page.mouse.move(700, 100);
  await still(page, "mentions-asked");
  await send.click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0].body).toMatchObject({ mentions: [DANA] });
});

test("when no one can be asked, the block says so and Send stays off", async ({ page }) => {
  await open(page, askWorld({ sharers: [] }));
  await messageBox(page).fill("@sam");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
  await expect(
    page.getByText(
      "No one in Fixture Org can give access to this conversation. Remove the mention to send.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Remove the mention to send.", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeDisabled();
  await page.mouse.move(700, 100);
  await still(page, "mentions-nobody");
});

test("when the read of who can be asked fails, the block says so, can read again, and Send stays off", async ({ page }) => {
  const state = askWorld({ sharersStatus: 503 });
  await open(page, state);
  await messageBox(page).fill("@sam");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
  await expect(
    page.getByText(
      "We could not find who can give access. Try again, or remove the mention to send.",
    ),
  ).toBeVisible();
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  // The reason under Send stays while the read has failed.
  await expect(page.getByText("Remove the mention to send.", { exact: true }))
    .toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "mentions-sharers-failed");
  // It is not a dead end: Try again reads once more.
  state.sharersStatus = 200;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText(
      "Dana Lee or Omar Haddad can. Ask one of them here, or send without the mention.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Dana Lee" }))
    .toBeVisible();
  await expect(send).toBeDisabled();
});

test("the way out of the block: Don't mention keeps the name as words; several people say how to leave someone out", async ({ page }) => {
  await open(page, askWorld());
  const box = messageBox(page);
  await box.fill("Hi @sam");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
  // After the Ask buttons, as in the offer.
  const ask = await page.getByRole("button", { name: "Ask Omar Haddad" })
    .boundingBox();
  const decline = page.getByRole("button", {
    name: "Don't mention Samir Okafor",
  });
  const declineBox = await decline.boundingBox();
  if (ask === null || declineBox === null) throw new Error("no boxes");
  // Its touch frame may overlap the buttons by a pixel or two; its middle is below them.
  expect(declineBox.y + declineBox.height / 2).toBeGreaterThanOrEqual(
    ask.y + ask.height,
  );
  await decline.click();
  await expect(box).toHaveValue("Hi Samir Okafor ");
  await expect(page.getByText("Samir Okafor · no access yet")).toHaveCount(0);
  await expect(page.getByText(/you can't give access to it/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeEnabled();
});

test("several people the writer may not share with: one caption, no second Don't mention", async ({ page }) => {
  const second = {
    principalId: "00000000-0000-4000-8000-0000000000a4",
    displayName: "Lee Wu",
    hasAccess: false,
    gainsAccessOnSend: false,
  };
  const state = askWorld();
  state.candidates.push(second);
  await open(page, state);
  const box = messageBox(page);
  for (const name of ["Samir Okafor", "Lee Wu"]) {
    await box.press("End");
    await box.pressSequentially(`@${name.slice(0, 3)}`);
    await page.getByRole("option", { name: `${name}, no access yet` })
      .click();
  }
  await expect(
    page.getByText(
      "2 people can't see this conversation, and you can't give access to them.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("To leave someone out, remove their name above."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Don't mention / }))
    .toHaveCount(0);
});

test("after a send that gave access: the line, Undo access, and what happened", async ({ page }) => {
  const state = world({ grants: [SAM_GRANT] });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  const line = page.getByText(
    "Sent. Sam Patel can now read and reply in this conversation.",
  );
  await expect(line).toBeVisible();
  // Good news is not warning-coloured.
  const block = page.locator('[data-ui-component="accessOffer"]');
  await expect(block).toHaveAttribute("data-tone", "success");
  await page.mouse.move(700, 100);
  await still(page, "mentions-sent");
  // The undo fails first: the line stays, with what happened.
  state.revokeStatus = 503;
  await page.getByRole("button", { name: "Undo access" }).click();
  await expect(
    page.getByText("Access was not removed. Nothing changed. Try again."),
  ).toBeVisible();
  await expect(line).toBeVisible();
  // A failed undo keeps the warning colour.
  await expect(block).toHaveAttribute("data-tone", "warning");
  await page.mouse.move(700, 100);
  await still(page, "mentions-undo-failed");
  state.revokeStatus = 200;
  await page.getByRole("button", { name: "Undo access" }).click();
  const undone = page.getByText(
    "Access removed. Sam Patel can no longer open this conversation. Your message stays.",
  );
  await expect(undone).toBeVisible();
  await expect(block).toHaveAttribute("data-tone", "success");
  expect(state.revokes.at(-1)).toEqual({ principalId: SAM, ifMatch: '"v4"' });
  await page.mouse.move(700, 100);
  await still(page, "mentions-undone");
  // Typing again ends the block.
  await box.fill("Next");
  await expect(undone).toHaveCount(0);
});

test("a send that gave no access to anyone has no Undo, and typing ends the line", async ({ page }) => {
  const state = await open(page);
  const box = messageBox(page);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  await expect(page.getByRole("button", { name: "Undo access" }))
    .toHaveCount(0);
  await expect(page.getByText(/^Sent\. /)).toHaveCount(0);
});

test("when the server fails while giving access, nothing is lost and the button tries again", async ({ page }) => {
  const state = world();
  state.sendReply = (route, attempt) =>
    attempt === 1
      ? route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        json: problem(400, "VALIDATION_FAILED", false),
      })
      : route.fulfill({ status: 201, json: message(41, "user", "Hi") });
  await open(page, state);
  const box = messageBox(page);
  await box.fill("Hi @sa");
  await page.getByRole("option", { name: "Sam Patel, no access yet" }).click();
  await page.getByRole("button", { name: "Give access and send", exact: true })
    .click();
  await expect(
    page.getByText(
      "Not sent, and no access was given. Something went wrong on our side. Your message is still here. Sam Patel still can't see this conversation.",
    ),
  ).toBeVisible();
  await expect(box).toHaveValue("Hi @Sam Patel ");
  if ((page.viewportSize()?.width ?? 1440) >= 744) {
    // The long retry button does not squeeze the help: it keeps two lines and
    // the button drops to its own line, as on the phone.
    const hint = page.locator(".ui-message-composer__hint");
    const lines = await hint.evaluate((element) =>
      element.getBoundingClientRect().height /
      parseFloat(getComputedStyle(element).lineHeight)
    );
    expect(lines).toBeLessThanOrEqual(2.1);
    const hintBox = await hint.boundingBox();
    const retry = await page.getByRole("button", {
      name: "Try again: give access and send",
    }).boundingBox();
    if (hintBox === null || retry === null) throw new Error("no boxes");
    expect(retry.y).toBeGreaterThanOrEqual(hintBox.y + hintBox.height - 1);
  }
  await page.mouse.move(700, 100);
  await still(page, "mentions-failed");
  await page.getByRole("button", {
    name: "Try again: give access and send",
    exact: true,
  }).click();
  await expect.poll(() => state.sent.length).toBe(2);
});

test("people a mention added: the link, the list, and taking access back after asking", async ({ page }) => {
  const state = world({
    canShare: true,
    grants: [{
      id: "00000000-0000-4000-8000-0000000000c1",
      conversationId,
      principalId: SAM,
      displayName: "Sam Patel",
      grantedById: ANA,
      grantedByName: "Ana Ruiz",
      sourceMessageId: "00000000-0000-4000-8000-000000000101",
      grantedAt: stamp(5),
      revokedAt: null,
      version: 4,
    }],
  });
  await open(page, state);
  await page.getByRole("button", { name: "1 person was added by a mention" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "People added to this conversation",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "They were mentioned here. They can read and reply in this conversation only.",
    ),
  ).toBeVisible();
  await expect(dialog.getByText("Sam Patel", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Mentioned by Ana Ruiz on /)).toBeVisible();
  // On a phone the buttons sit under the text, not beside it.
  const phone = (page.viewportSize()?.width ?? 1440) < 744;
  const text = await dialog.getByText(/Mentioned by Ana Ruiz on /)
    .boundingBox();
  const remove = await dialog.getByRole("button", {
    name: "Remove access for Sam Patel",
  }).boundingBox();
  if (text === null || remove === null) throw new Error("no boxes");
  if (phone) expect(remove.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
  await page.mouse.move(700, 100);
  await still(page, "mentions-added");
  await dialog.getByRole("button", { name: "Remove access for Sam Patel" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(
    confirm.getByText("Remove Sam Patel's access to this conversation?"),
  )
    .toBeVisible();
  await expect(
    confirm.getByText(
      "Sam Patel will no longer be able to read or reply here. Their messages stay.",
    ),
  ).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove access" }).click();
  await expect.poll(() => state.revokes.length).toBe(1);
  expect(state.revokes[0]).toEqual({ principalId: SAM, ifMatch: '"v4"' });
  await expect(page.getByText("Removed Sam Patel's access.")).toBeVisible();
  await expect(dialog.getByText("No one was added by a mention."))
    .toBeVisible();
});

test("Show message for a message that is not loaded says how to load it", async ({ page }) => {
  const state = world({
    canShare: true,
    grants: [{
      id: "00000000-0000-4000-8000-0000000000c1",
      conversationId,
      principalId: SAM,
      displayName: "Sam Patel",
      grantedById: ANA,
      grantedByName: "Ana Ruiz",
      // An older message the page has not loaded.
      sourceMessageId: "00000000-0000-4000-8000-000000000999",
      grantedAt: stamp(5),
      revokedAt: null,
      version: 4,
    }],
  });
  await open(page, state);
  await page.getByRole("button", { name: "1 person was added by a mention" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "People added to this conversation",
  });
  await dialog.getByRole("button", { name: "Show message" }).click();
  await expect(
    dialog.getByText(
      "That message is not loaded yet. Use Load earlier messages at the top of the conversation, then try again.",
    ),
  ).toBeVisible();
  // A conversation has no threads to open.
  await expect(dialog.getByText(/thread/)).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "mentions-added-not-shown");
});

test("a change to someone's access is said plainly, and the link is for people who may share", async ({ page }) => {
  const grant = {
    id: "00000000-0000-4000-8000-0000000000c1",
    conversationId,
    principalId: SAM,
    displayName: "Sam Patel",
    grantedById: ANA,
    grantedByName: "Ana Ruiz",
    sourceMessageId: null,
    grantedAt: stamp(5),
    revokedAt: null,
    version: 4,
  };
  const state = world({ canShare: true, grants: [grant], revokeStatus: 412 });
  await open(page, state);
  await page.getByRole("button", { name: "1 person was added by a mention" })
    .click();
  await page.getByRole("button", { name: "Remove access for Sam Patel" })
    .click();
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Remove access",
  }).click();
  await expect(
    page.getByText(
      "Sam Patel's access changed just now. The list is up to date.",
    ),
  ).toBeVisible();
  const reader = await page.context().newPage();
  await mockAuthenticatedSession(reader);
  await mockWorld(reader, world({ canShare: false, grants: [grant] }));
  await reader.goto(`/tasks/${taskId}`);
  await expect(conversation(reader)).toBeVisible();
  await expect(reader.getByRole("button", { name: /added by a mention/ }))
    .toHaveCount(0);
  await reader.close();
});
