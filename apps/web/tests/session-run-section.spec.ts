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
  handoffManifest: null,
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

const streamId = "00000000-0000-4000-8000-000000000030";
const jobId = "00000000-0000-4000-8000-000000000031";
const attemptId = "00000000-0000-4000-8000-000000000032";
/** The step's raw output stream, so the disclosure under the thread has real lines. */
const streamFor = (runStepId: string) => ({
  streamId,
  organizationId: MOCK_ORGANIZATION_ID,
  applicationId: task.applicationId,
  repositoryId: task.repositoryId,
  jobId,
  taskId,
  runStepId,
  conversationId: task.conversationId,
  logicalActor: "native:harness.implement",
  highwater: "1",
  closed: false,
  capture: "capturing",
  reason: null,
  archive: "pending",
  archiveFailure: null,
  archivedAt: null,
  historyExpiresAt: null,
  segments: [],
  producers: [{ writerGeneration: "1", attemptId, attemptNo: 1 }],
  createdAt: stamp,
});
const attemptFor = (runStepId: string) => ({
  id: attemptId,
  jobId,
  taskId,
  runStepId,
  workerHostId: "00000000-0000-4000-8000-000000000033",
  workerName: "atlas-01",
  attemptNo: 1,
  status: "running",
  isCurrent: true,
  leaseState: "active",
  leaseExpiresAt: "2026-10-11T18:00:00Z",
  startedAt: stamp,
  endedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  outcome: {
    resultStatus: null,
    reasonCode: null,
    exitCode: null,
    processExited: null,
    terminationStatus: null,
    exitedAt: null,
    usage: null,
  },
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
  // Anything not stubbed below is an empty list, so the page around the run
  // section shows no error banners that are not this spec's subject.
  await page.route(
    "**/v1/**",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
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
  await page.route("**/v1/output-streams?*", (route) => {
    const runStepId =
      new URL(route.request().url()).searchParams.get("runStepId") ?? "";
    return route.fulfill({
      json: {
        items: [streamFor(runStepId)],
        nextCursor: null,
        encodedBytes: 1000,
      },
    });
  });
  await page.route("**/v1/jobs/" + jobId + "/attempts?*", (route) => {
    return route.fulfill({
      json: {
        items: [attemptFor(runningStepId), attemptFor(doneStepId)],
        nextCursor: null,
      },
    });
  });
  await page.routeWebSocket("**/v1/events?*", (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type !== "output.subscribe") return;
      socket.send(JSON.stringify({
        type: "output.batch",
        requestId: frame.requestId,
        streamId,
        batch: {
          sessionId: streamId,
          writerGeneration: "1",
          batchId: crypto.randomUUID(),
          sequence: "1",
          parts: [{
            itemId: crypto.randomUUID(),
            channel: "stdout",
            text: "$ pnpm test upload\n 12 passed",
          }],
          capture: "capturing",
          reason: null,
          digest: "a".repeat(64),
        },
      }));
    });
  });
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

test(
  "the selected step shows its session as the thread, with raw output folded under it",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page);
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    // The running step is the default one, and its newest turn is open.
    await expect(page.getByText("I will read the upload step first"))
      .toBeVisible();
    await expect(page.getByText("Delivered to the agent")).toBeVisible();
    await expect(thread(page).getByText("run_tests").first()).toBeVisible();
    // The raw output is reachable, under the thread, closed.
    const raw = page.locator("details", { hasText: "Raw output" });
    await expect(raw).toBeVisible();
    await expect(raw).not.toHaveAttribute("open", "");
    // One live region for the step: the now line, naming the running tool.
    await expect(now(page)).toHaveCount(1);
    await expect(now(page)).toContainText("Running run_tests…");
    await still(page, "run-section-running", undefined, {
      scrollTo: thread(page).or(
        page.getByText("This step has no agent session."),
      ).first(),
    });
  },
);

test(
  "another step selected: the line names the running step and selecting it switches",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page);
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("combobox", { name: "Step" }).selectOption(doneStepId);
    await expect(page.getByText("This step has no agent session."))
      .toBeVisible();
    const line = now(page);
    await expect(line).toContainText("implement: Running run_tests…");
    await still(page, "run-section-other-step-now", undefined, {
      scrollTo: thread(page).or(
        page.getByText("This step has no agent session."),
      ).first(),
    });
    await line.getByRole("button").click();
    await expect(page.getByRole("combobox", { name: "Step" })).toHaveValue(
      runningStepId,
    );
    await expect(thread(page)).toBeVisible();
  },
);

test(
  "a step with no session shows its raw output, open, and says why",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page, {
      stepStatuses: ["completed", "completed"],
      sessionsByStep: { [runningStepId]: [], [doneStepId]: [] },
    });
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByText("This step has no agent session.")).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    await expect(page.locator("details", { hasText: "Raw output" }))
      .toHaveAttribute(
        "open",
        "",
      );
    // No running step, no line.
    await expect(now(page)).toHaveCount(0);
    await still(page, "run-section-no-session", undefined, {
      scrollTo: thread(page).or(
        page.getByText("This step has no agent session."),
      ).first(),
    });
  },
);

test(
  "a session that cannot be read says so, offers Try again and still offers the raw output",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
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
  },
);

test(
  "a dropped stream keeps the thread and says the connection was lost",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page, { streamStatus: 503 });
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    await expect(now(page)).toContainText("Connection lost. Reconnecting…", {
      timeout: 20_000,
    });
    await expect(page.getByText("I will read the upload step first"))
      .toBeVisible();
  },
);

test(
  "raw output opened under the thread does not announce",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
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
    await still(page, "run-section-raw-output-open", undefined, {
      scrollTo: page.locator("details", { hasText: "Raw output" }).locator(
        "summary",
      ),
    });
  },
);

test(
  "the now line sits in the footer above the composer, and stays in view",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page);
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    const line = page.locator(
      '.ui-task-detail__composer [data-ui-component="sessionNowLine"]',
    );
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Running run_tests…");
    // It stays on screen however far the page is scrolled, directly above the composer.
    await page.mouse.wheel(0, 4000);
    await expect(line).toBeInViewport();
    const geometry = await page.evaluate(() => {
      const now = document.querySelector(
        '[data-ui-component="sessionNowLine"]',
      )!
        .getBoundingClientRect();
      const composer = document.querySelector(".ui-message-composer")!
        .getBoundingClientRect();
      return { nowBottom: now.bottom, composerTop: composer.top };
    });
    expect(geometry.nowBottom).toBeLessThanOrEqual(geometry.composerTop);
    await expect(page.locator('[data-ui-component="sessionNowLine"]'))
      .toHaveCount(1);
  },
);

test(
  "a new session for the step restarts the stream on that session",
  async ({ page }) => {
    const nextSessionId = "00000000-0000-4000-8000-000000000042";
    const streamed: string[] = [];
    let replaced = false;
    await page.clock.install();
    await prepare(page);
    // Routes registered later win: the step's session list changes once told to.
    await page.route("**/v1/sessions?*", (route) => {
      const stepId =
        new URL(route.request().url()).searchParams.get("runStepId") ?? "";
      const current = replaced
        ? {
          ...session(runningStepId, "active"),
          id: nextSessionId,
          createdAt: "2026-01-02T00:00:00.000Z",
        }
        : session(runningStepId, "active");
      return route.fulfill({
        json: {
          items: stepId === runningStepId ? [current] : [],
          nextCursor: null,
        },
      });
    });
    await page.route(
      `**/v1/sessions/${nextSessionId}/feed`,
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(/\/v1\/sessions\/[^/]+\/feed\/stream/, (route) => {
      streamed.push(
        /sessions\/([^/]+)\/feed\/stream/.exec(route.request().url())![1],
      );
      // The stream stays open, saying nothing.
    });
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => streamed).toEqual([sessionId]);
    replaced = true;
    await page.clock.fastForward(11_000);
    // The thread follows the new session, not the one it started on.
    await expect.poll(() => streamed).toContain(nextSessionId);
  },
);

test(
  "a session longer than the thread holds says only its newest events are shown",
  async ({ page }) => {
    await prepare(page);
    const long = Array.from({ length: 1_105 }, (_, index) => ({
      ...base(index + 1, "tool", 5),
      tool: {
        callId: `call-${index}`,
        name: "run_tests",
        phase: "started",
        ok: null,
      },
    }));
    await page.route(
      (url) => url.pathname.endsWith(`/v1/sessions/${sessionId}/feed`),
      (route) => {
        // The history comes in pages of a hundred, as the real route gives it.
        const at = Number(
          new URL(route.request().url()).searchParams.get("cursor") ?? "0",
        );
        const items = long.slice(at, at + 100);
        return route.fulfill({
          json: {
            items,
            nextCursor: at + 100 < long.length ? String(at + 100) : null,
          },
        });
      },
    );
    await page.goto(`/tasks/${taskId}`);
    await expect(thread(page)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText("This session is long, so the thread shows only"),
    ).toBeVisible();
    // The first line of a shortened thread says it starts partway through.
    await expect(thread(page).getByText("Earlier events are not shown"))
      .toBeVisible();
    await expect(thread(page).getByText("Session started")).toHaveCount(0);
    await still(page, "run-section-truncated", undefined, {
      scrollTo: page.getByText(
        "This session is long, so the thread shows only",
      ),
    });
  },
);

test("a failed artifacts read is a compact error with a secondary Try again", async ({ page }) => {
  await prepare(page);
  await page.route("**/v1/artifacts?*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/problem+json",
      json: {
        type: "about:blank",
        title: "INTERNAL",
        status: 500,
        code: "INTERNAL",
        detail: "The server refused the request.",
        requestId: "00000000-0000-4000-8000-000000000110",
        traceId: "00000000-0000-4000-8000-000000000111",
        retryable: true,
      },
    }));
  await page.goto(`/tasks/${taskId}`);
  const error = page.locator('[data-ui-component="errorState"]', {
    hasText: "Artifacts could not be loaded",
  });
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(error.getByRole("button", { name: "Try again", exact: true }))
    .toHaveClass(/secondary/);
});
