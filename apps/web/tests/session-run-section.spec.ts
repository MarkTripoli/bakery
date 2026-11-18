import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

// #405: the agent thread mounted in the run section, for the selected step,
// where the raw output used to be. Everything the browser asks for is stubbed;
// the session feed and its stream are the real routes' shapes.

const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const runningStepId = "00000000-0000-4000-8000-000000000021";
const doneStepId = "00000000-0000-4000-8000-000000000022";
const sessionId = "00000000-0000-4000-8000-000000000040";
const stamp = "2026-01-01T00:00:00.000Z";

const task = {
  id: taskId,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "active",
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
const run = {
  id: runId,
  taskId,
  workflowVersionId: "00000000-0000-4000-8000-000000000023",
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: "00000000-0000-4000-8000-000000000001",
  inngestRunId: null,
  status: "running",
  budgetLimitUsd: "10.00",
  startedAt: stamp,
  finishedAt: null,
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
  finishedAt: status === "running" ? null : stamp,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
});
const session = (runStepId: string, status: string) => ({
  id: sessionId,
  runStepId,
  conversationId: task.conversationId,
  agentVersionId: "00000000-0000-4000-8000-000000000041",
  harness: "codex",
  status,
  resumeRef: null,
  parentSessionId: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  adapterCapabilities: {},
});

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const base = (sequence: number, kind: string, minutes: number) => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  sessionId,
  sequence: String(sequence),
  kind,
  occurredAt: minutesAgo(minutes),
  redacted: false,
  message: null,
  terminal: null,
  status: null,
  tool: null,
  fileChange: null,
  artifact: null,
  usage: null,
  deliveredInput: null,
});
const feed = [
  {
    ...base(1, "message", 15),
    message: {
      messageId: "22222221-2222-4222-8222-222222222222",
      authorId: "33333333-3333-4333-8333-333333333333",
      authorKind: "person",
      messageType: "user",
      body: "Add a retry to the upload step and run the tests.",
    },
  },
  {
    ...base(2, "delivered_input", 15),
    deliveredInput: {
      messageId: "44444442-4444-4444-8444-444444444444",
      body: "Add a retry to the upload step and run the tests.",
    },
  },
  {
    ...base(3, "message", 14),
    message: {
      messageId: "22222223-2222-4222-8222-222222222222",
      authorId: null,
      authorKind: "agent",
      messageType: "assistant",
      body: "I will read the upload step first, then add a retry and a test.",
    },
  },
  {
    ...base(4, "file_change", 13),
    fileChange: {
      path: "apps/server/src/modules/upload/retry.ts",
      change: "modified",
    },
  },
  {
    ...base(5, "tool", 5),
    tool: { callId: "call-9", name: "run_tests", phase: "started", ok: null },
  },
];

type Options = {
  stepStatuses?: [string, string];
  sessionsByStep?: Record<string, ReturnType<typeof session>[]>;
  feedStatus?: number;
  streamStatus?: number | "pending";
};

async function prepare(page: Page, options: Options = {}) {
  const [runningStatus, doneStatus] = options.stepStatuses ??
    ["running", "completed"];
  const sessionsByStep = options.sessionsByStep ?? {
    [runningStepId]: [session(runningStepId, "active")],
    [doneStepId]: [],
  };
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
          step(runningStepId, "implement", runningStatus),
          step(doneStepId, "publish", doneStatus),
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
  await page.route(
    "**/v1/output-streams?*",
    (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, encodedBytes: 0 } }),
  );
  await page.route("**/v1/sync*", (route) =>
    route.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: null,
        resetRequired: false,
      },
    }));
  await page.route("**/v1/sessions?*", (route) => {
    const stepId =
      new URL(route.request().url()).searchParams.get("runStepId") ?? "";
    expect(route.request().headers()["bakery-organization-id"]).toBe(
      MOCK_ORGANIZATION_ID,
    );
    return route.fulfill({
      json: { items: sessionsByStep[stepId] ?? [], nextCursor: null },
    });
  });
  await page.route(
    (url) => url.pathname.endsWith(`/v1/sessions/${sessionId}/feed`),
    (route) =>
      options.feedStatus
        ? route.fulfill({
          status: options.feedStatus,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Server error",
            status: options.feedStatus,
            code: "INTERNAL_ERROR",
          }),
        })
        : route.fulfill({ json: { items: feed, nextCursor: null } }),
  );
  await page.route(`**/v1/sessions/${sessionId}/feed/stream`, (route) => {
    if (
      options.streamStatus === undefined || options.streamStatus === "pending"
    ) {
      // A live stream that has nothing new to say: the request stays open.
      return;
    }
    return route.fulfill({
      status: options.streamStatus,
      contentType: "application/problem+json",
      body: JSON.stringify({
        title: "Unavailable",
        status: options.streamStatus,
      }),
    });
  });
}

const thread = (page: Page) =>
  page.locator('[data-ui-component="sessionThread"]');
const now = (page: Page) =>
  page.locator('[data-ui-component="sessionNowLine"]');

test("the selected step shows its session as the thread, with raw output folded under it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(thread(page)).toBeVisible({ timeout: 20_000 });
  // The running step is the default one, and its newest turn is open.
  await expect(page.getByText("I will read the upload step first"))
    .toBeVisible();
  await expect(page.getByText("Delivered to the agent")).toBeVisible();
  await expect(page.getByText("run_tests")).toBeVisible();
  // The raw output is reachable, under the thread, closed.
  const raw = page.locator("details", { hasText: "Raw output" });
  await expect(raw).toBeVisible();
  await expect(raw).not.toHaveAttribute("open", "");
  // One live region for the step: the now line, naming the running tool.
  await expect(now(page)).toHaveCount(1);
  await expect(now(page)).toContainText("Running run_tests…");
  await still(page, "run-section-running");
});

test("another step selected: the line names the running step and selecting it switches", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(thread(page)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Output step").selectOption(doneStepId);
  await expect(page.getByText("This step has no agent session.")).toBeVisible();
  const line = now(page);
  await expect(line).toContainText("implement: Running run_tests…");
  await still(page, "run-section-other-step-now");
  await line.getByRole("button").click();
  await expect(page.getByLabel("Output step")).toHaveValue(runningStepId);
  await expect(thread(page)).toBeVisible();
});

test("a step with no session shows its raw output, open, and says why", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, {
    stepStatuses: ["completed", "completed"],
    sessionsByStep: { [runningStepId]: [], [doneStepId]: [] },
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("This step has no agent session.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("details", { hasText: "Raw output" }))
    .toHaveAttribute(
      "open",
      "",
    );
  // No running step, no line.
  await expect(now(page)).toHaveCount(0);
  await still(page, "run-section-no-session");
});

test("a session that cannot be read says so, offers Try again and still offers the raw output", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { feedStatus: 500 });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("This session could not load.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Try again" }).first())
    .toBeVisible();
  await expect(page.locator("details", { hasText: "Raw output" }))
    .toHaveAttribute(
      "open",
      "",
    );
});

test("a dropped stream keeps the thread and says the connection was lost", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, { streamStatus: 503 });
  await page.goto(`/tasks/${taskId}`);
  await expect(thread(page)).toBeVisible({ timeout: 20_000 });
  await expect(now(page)).toContainText("Connection lost. Reconnecting…", {
    timeout: 20_000,
  });
  await expect(page.getByText("I will read the upload step first"))
    .toBeVisible();
});

test("raw output opened under the thread does not announce", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(thread(page)).toBeVisible({ timeout: 20_000 });
  await page.locator("details", { hasText: "Raw output" }).locator("summary")
    .click();
  await expect(
    page.locator("details", { hasText: "Raw output" }).locator(
      "[role=status], [aria-live]",
    ),
  ).toHaveCount(0);
  await still(page, "run-section-raw-output-open");
});
