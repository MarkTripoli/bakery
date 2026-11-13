import { createHash } from "node:crypto";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
const id = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const stepId = "00000000-0000-4000-8000-000000000021";
const run = {
  id: runId,
  taskId: id,
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
  status: "completed",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
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
  id: stepId,
  runId,
  stepKey: "publish",
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
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: "00000000-0000-4000-8000-000000000001",
  currentRunId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
};

const streamId = "00000000-0000-4000-8000-000000000030";
const stream = {
  streamId,
  organizationId: MOCK_ORGANIZATION_ID,
  applicationId: task.applicationId,
  repositoryId: task.repositoryId,
  jobId: "00000000-0000-4000-8000-000000000031",
  taskId: id,
  runStepId: stepId,
  conversationId: task.conversationId,
  logicalActor: "native:harness.implement",
  highwater: "3",
  closed: false,
  capture: "capturing",
  reason: null,
  archive: "pending",
  archiveFailure: null,
  archivedAt: null,
  historyExpiresAt: null,
  segments: [],
  // One producer: every batch belongs to the attempt below, so no attempt
  // marker is drawn.
  producers: [{
    writerGeneration: "1",
    attemptId: "00000000-0000-4000-8000-000000000032",
    attemptNo: 2,
  }],
  createdAt: task.createdAt,
};
function sendBatch(
  socket: WebSocketRoute,
  requestId: string,
  sequence: string,
  text: string,
  capture = "capturing",
  writerGeneration = "1",
) {
  socket.send(JSON.stringify({
    type: "output.batch",
    requestId,
    streamId,
    batch: {
      sessionId: streamId,
      writerGeneration,
      batchId: crypto.randomUUID(),
      sequence,
      parts: [{ itemId: crypto.randomUUID(), channel: "stdout", text }],
      capture,
      reason: capture === "truncated" ? "text-limit" : null,
      digest: "a".repeat(64),
    },
  }));
}
const attempt = {
  id: "00000000-0000-4000-8000-000000000032",
  jobId: stream.jobId,
  taskId: id,
  runStepId: stepId,
  workerHostId: "00000000-0000-4000-8000-000000000033",
  workerName: "atlas-01",
  attemptNo: 2,
  status: "running",
  isCurrent: true,
  leaseState: "active",
  leaseExpiresAt: "2026-10-11T18:00:00Z",
  startedAt: task.createdAt,
  endedAt: null,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  outcome: {
    resultStatus: null,
    reasonCode: null,
    exitCode: null,
    processExited: null,
    terminationStatus: null,
    exitedAt: null,
    usage: null,
  },
};
async function prepare(page: Page) {
  await mockAuthenticatedSession(page);
  await page.route(`**/v1/jobs/${stream.jobId}/attempts?*`, (route) => {
    expect(new URL(route.request().url()).searchParams.get("taskId")).toBe(id);
    return route.fulfill({ json: { items: [attempt], nextCursor: null } });
  });
  await page.route(
    `**/v1/tasks/${id}`,
    (route) =>
      route.fulfill({
        json: { ...task, status: "active", currentRunId: runId },
      }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({ json: { ...run, status: "running", finishedAt: null } }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{ ...step, status: "running", finishedAt: null }],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: { runId, actions: [] } }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/v1/output-streams?*", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("runStepId")).toBe(stepId);
    expect(url.searchParams.get("taskId")).toBe(id);
    expect(route.request().headers()["bakery-organization-id"]).toBe(
      MOCK_ORGANIZATION_ID,
    );
    return route.fulfill({
      json: { items: [stream], nextCursor: null, encodedBytes: 1000 },
    });
  });
  await page.route(
    "**/v1/sync*",
    (route) =>
      route.fulfill({
        json: {
          resourceState: {},
          highwater: "0",
          events: [],
          nextCursor: null,
          resetRequired: false,
        },
      }),
  );
}

test(
  "durable output reconnect resumes opaque cursor without duplicate lines or inferred review",
  async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await prepare(page);
    const subscriptions: { after: string | null }[] = [];
    await page.routeWebSocket("**/v1/events?*", (socket) => {
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        subscriptions.push(frame);
        if (subscriptions.length === 1) {
          sendBatch(
            socket,
            frame.requestId,
            "1",
            "first durable line [REDACTED]",
          );
          socket.send(
            JSON.stringify({
              type: "output.cursor",
              requestId: frame.requestId,
              streamId,
              cursor: "opaque-through-1",
              highwater: "3",
            }),
          );
          sendBatch(socket, frame.requestId, "2", "second durable line");
          socket.close({ code: 1012, reason: "restart" });
        } else {
          sendBatch(socket, frame.requestId, "2", "second durable line");
          sendBatch(
            socket,
            frame.requestId,
            "3",
            "<script>window.outputInjected = true</script>",
          );
          socket.send(
            JSON.stringify({
              type: "output.cursor",
              requestId: frame.requestId,
              streamId,
              cursor: "opaque-through-3",
              highwater: "3",
            }),
          );
        }
      });
    });
    await page.goto(`/tasks/${id}`);
    await expect(page.getByText("Saved through sequence 3", { exact: true }))
      .toBeVisible();
    await expect(page.getByRole("link", { name: "Back to task inbox" }))
      .toBeVisible();
    await expect(page.getByText("Persisted description", { exact: true }))
      .toBeVisible();
    const outputBox = await page.locator('[data-ui-component="runOutputView"]')
      .boundingBox();
    const inspectorBox = await page.locator(
      '[data-ui-component="artifactPane"]',
    ).boundingBox();
    expect(outputBox).not.toBeNull();
    expect(inspectorBox).not.toBeNull();
    if (outputBox && inspectorBox) {
      if ((page.viewportSize()?.width ?? 0) >= 1280) {
        expect(inspectorBox.x).toBeGreaterThanOrEqual(
          outputBox.x + outputBox.width,
        );
      } else {
        expect(inspectorBox.y).toBeGreaterThanOrEqual(
          outputBox.y + outputBox.height,
        );
      }
    }
    expect(subscriptions[0]?.after).toBeNull();
    expect(subscriptions[1]?.after).toBe("opaque-through-1");
    await expect(page.getByText("second durable line", { exact: true }))
      .toHaveCount(1);
    await expect(
      page.getByText("<script>window.outputInjected = true</script>", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, "outputInjected")))
      .toBe(false);
    await expect(
      page.getByText("first durable line [REDACTED]", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Observed repository state. No review or merge decision recorded.",
      ),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("task-run.png"),
      fullPage: true,
    });
  },
);

test("manual output reconnect retains the cursor and displayed lines", async ({ page }) => {
  await prepare(page);
  const subscriptions: { after: string | null }[] = [];
  await page.routeWebSocket("**/v1/events?*", (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type !== "output.subscribe") return;
      subscriptions.push(frame);
      if (subscriptions.length === 1) {
        sendBatch(socket, frame.requestId, "1", "retained before retry");
        socket.send(JSON.stringify({
          type: "output.cursor",
          requestId: frame.requestId,
          streamId,
          cursor: "manual-through-1",
          highwater: "2",
        }));
        socket.close({ code: 1012, reason: "restart" });
      } else if (subscriptions.length >= 3) {
        sendBatch(socket, frame.requestId, "1", "retained before retry");
        sendBatch(socket, frame.requestId, "2", "received after retry");
      }
    });
  });
  await page.goto(`/tasks/${id}`);
  await expect.poll(() => subscriptions.length).toBe(2);
  await expect(page.getByText("retained before retry", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByText("received after retry", { exact: true }))
    .toBeVisible();
  expect(subscriptions[2]?.after).toBe("manual-through-1");
  await expect(page.getByText("retained before retry", { exact: true }))
    .toHaveCount(1);
});

test("expired output remains truthful and never silently resumes a retained tail", async ({ page }) => {
  await prepare(page);
  let subscriptions = 0;
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        subscriptions++;
        socket.send(
          JSON.stringify({
            type: "output.reset_required",
            requestId: frame.requestId,
            streamId,
            cursor: "archive-boundary",
            retainedFrom: "9",
            resumeAfter: "8",
            highwater: "20",
          }),
        );
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(
    page.getByRole("heading", { name: "History expired", exact: true }),
  )
    .toBeVisible();
  await expect(
    page.getByText(
      "Output history expired. Open an archived transcript when available.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(subscriptions).toBe(1);
});

test("expired output downloads exact archived segments and reports byte expiry", async ({ page }) => {
  await prepare(page);
  const versionId = "00000000-0000-4000-8000-000000000050";
  const bytes = Buffer.from(
    JSON.stringify({ batches: ["[REDACTED]", "durable archive"] }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  let expired = false;
  await page.route("**/v1/output-streams?*", (route) =>
    route.fulfill({
      json: {
        items: [{
          ...stream,
          archive: "archived",
          segments: [{
            segmentIndex: 0,
            firstSequence: "1",
            lastSequence: "8",
            sizeBytes: bytes.length,
            sha256: digest,
            completeness: "complete",
            artifactVersionId: versionId,
          }],
        }],
        nextCursor: null,
        encodedBytes: 1000,
      },
    }));
  await page.route(
    "**/v1/artifact-versions/" + versionId + "/content",
    (route) => {
      expect(route.request().headers()["bakery-organization-id"]).toBe(
        MOCK_ORGANIZATION_ID,
      );
      return expired
        ? route.fulfill({
          status: 410,
          contentType: "application/problem+json",
          json: {
            type: "urn:bakery:problem:ARTIFACT_CONTENT_EXPIRED",
            title: "Artifact content expired",
            status: 410,
            code: "ARTIFACT_CONTENT_EXPIRED",
            retryable: false,
            detail: "Collected bytes.",
            requestId: "archive-request",
            traceId: "archive-trace",
          },
        })
        : route.fulfill({
          body: bytes,
          headers: {
            "content-type": "application/json",
            "content-length": String(bytes.length),
            "content-digest": "sha-256=:" +
              createHash("sha256").update(bytes).digest("base64") + ":",
            etag: '"' + digest + '"',
          },
        });
    },
  );
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        socket.send(JSON.stringify({
          type: "output.reset_required",
          requestId: frame.requestId,
          streamId,
          cursor: "archive-boundary",
          retainedFrom: "9",
          resumeAfter: "8",
          highwater: "8",
        }));
      }),
  );
  await page.goto("/tasks/" + id);
  const archive = page.getByRole("button", {
    name: "Download transcript 1 · sequences 1–8",
    exact: true,
  });
  await expect(page.locator('[data-ui-component="runOutputPanel"]'))
    .toHaveAttribute("data-state", "reset");
  const download = page.waitForEvent("download");
  await archive.click();
  const downloaded = await download;
  const content = await downloaded.createReadStream();
  expect(content).not.toBeNull();
  const chunks: Buffer[] = [];
  if (!content) throw new Error("Archive download stream unavailable");
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expired = true;
  await archive.click();
  await expect(
    page.getByText(
      "Transcript bytes expired. Immutable version metadata remains available.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("capture truncation marker survives and output controls work on phones", async ({ page }) => {
  await prepare(page);
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        sendBatch(
          socket,
          frame.requestId,
          "1",
          "Native output truncated: display-byte-limit.",
          "truncated",
        );
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.locator('[data-ui-component="runOutputPanel"]'))
    .toHaveAttribute("data-state", "truncated");
  await expect(page.getByText("Truncated · sequence 1", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText("Native output truncated: display-byte-limit.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.locator('[data-ui-component="logViewer"]')).toBeFocused();
});

test("revoked output authority clears previously visible text", async ({ page }) => {
  await prepare(page);
  let revoke: (() => void) | undefined;
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        sendBatch(socket, frame.requestId, "1", "previously authorized output");
        revoke = () => socket.close({ code: 1008, reason: "revoked" });
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("previously authorized output", { exact: true }))
    .toBeVisible();
  revoke?.();
  await expect(page.getByText("previously authorized output", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByText("Output unavailable", { exact: true }))
    .toBeVisible();
});

test("revision preview verifies the exact immutable version bytes", async ({ page }) => {
  await prepare(page);
  const artifactId = "00000000-0000-4000-8000-000000000050";
  const versionId = "00000000-0000-4000-8000-000000000051";
  const patch =
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+<script>unsafe()</script>\n";
  const digest = createHash("sha256").update(patch).digest("hex");
  let responseBody = patch;
  const artifact = {
    id: artifactId,
    taskId: id,
    artifactType: "patch",
    name: "candidate.patch",
    currentVersionId: "00000000-0000-4000-8000-000000000052",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: 1,
  };
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [artifact], nextCursor: null } }),
  );
  await page.route(
    `**/v1/artifacts/${artifactId}/versions*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{
            id: versionId,
            artifactId,
            revision: 3,
            runStepId: stepId,
            authorId: task.createdBy,
            mediaType: "text/x-diff",
            sizeBytes: Buffer.byteLength(patch),
            sha256: digest,
            subjectHeadSha: "b".repeat(40),
            subjectBaseSha: "c".repeat(40),
            metadata: {},
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            version: 1,
          }],
          nextCursor: null,
        },
      }),
  );
  await page.route(`**/v1/artifact-versions/${versionId}/content*`, (route) => {
    expect(route.request().headers()["bakery-organization-id"]).toBe(
      MOCK_ORGANIZATION_ID,
    );
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/x-diff",
        "content-length": String(Buffer.byteLength(responseBody)),
        etag: `"${digest}"`,
      },
      body: responseBody,
    });
  });
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  await page.getByRole("button", { name: "View diff", exact: true }).click();
  // The version is a plain "Version 3"; its SHA-256 sits behind a fingerprint
  // row (first 12 characters and Copy), not in the main line.
  await expect(page.getByText("Version 3", { exact: true })).toBeVisible();
  const fingerprint = page.getByTestId("fingerprint-row");
  await expect(fingerprint).toContainText("Fingerprint");
  await expect(fingerprint).toContainText(digest.slice(0, 12));
  await expect(fingerprint).not.toContainText(digest.slice(0, 13));
  await expect(fingerprint.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByText("Patch: 1 files · +1 −1", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("1 files · +1 −1", { exact: true }))
    .toBeVisible();
  await expect(page.locator('[data-ui-component="codeBlock"]')).toContainText(
    "+<script>unsafe()</script>",
  );
  await expect(
    page.getByText(`${"c".repeat(40)} → ${"b".repeat(40)}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Observed repository state. No review or merge decision recorded.",
    ),
  ).toBeVisible();
  responseBody = patch.replace("unsafe", "tamper");
  await page.route("**/v1/sync*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    const changed = after !== "patch-recheck";
    return route.fulfill({
      json: {
        resourceState: {},
        highwater: "1",
        events: changed
          ? [{
            id: "00000000-0000-4000-8000-000000000059",
            sequence: "1",
            type: "run.completed",
            schemaVersion: 1,
            occurredAt: task.updatedAt,
            taskId: id,
            repositoryId: task.repositoryId,
            conversationId: task.conversationId,
            payload: { runId },
          }]
          : [],
        nextCursor: changed ? "patch-recheck" : null,
        resetRequired: false,
      },
    });
  });
  await expect(
    page.getByText("The changes could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-ui-component="codeBlock"]')).toHaveCount(0);
  await expect(page.getByText("1 files · +1 −1", { exact: true })).toHaveCount(
    0,
  );
});

for (
  const scenario of [
    {
      name: "exit",
      outcome: { resultStatus: "completed", exitCode: 0, processExited: true },
      status: "completed",
      leaseState: "closed",
      title: "Process exited · code 0",
    },
    {
      name: "timeout",
      outcome: { resultStatus: "timed_out" },
      status: "failed",
      leaseState: "closed",
      title: "Run timed out",
    },
    {
      name: "lost lease",
      outcome: { reasonCode: "lease_lost" },
      status: "lost",
      leaseState: "lost",
      title: "Task taken back",
    },
    {
      name: "cancel pending",
      outcome: {
        resultStatus: "canceled",
        processExited: false,
        terminationStatus: "pending",
      },
      status: "canceled",
      leaseState: "closed",
      title: "Cancellation pending",
    },
    {
      name: "cancel confirmed",
      outcome: {
        resultStatus: "canceled",
        processExited: true,
        terminationStatus: "confirmed",
        exitedAt: "2026-10-11T12:00:00Z",
      },
      status: "canceled",
      leaseState: "closed",
      title: "Run canceled",
    },
    {
      name: "quota reason",
      outcome: { resultStatus: "failed", reasonCode: "quota_exceeded" },
      status: "failed",
      leaseState: "closed",
      title: "Provider quota exceeded",
    },
  ] as const
) {
  test(`authoritative ${scenario.name} renders without inferred review`, async ({ page }) => {
    await prepare(page);
    await page.route(
      `**/v1/jobs/${stream.jobId}/attempts?*`,
      (route) =>
        route.fulfill({
          json: {
            items: [{
              ...attempt,
              status: scenario.status,
              leaseState: scenario.leaseState,
              outcome: { ...attempt.outcome, ...scenario.outcome },
            }],
            nextCursor: null,
          },
        }),
    );
    await page.routeWebSocket(
      "**/v1/events?*",
      (socket) =>
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message));
          if (frame.type === "output.subscribe") {
            sendBatch(
              socket,
              frame.requestId,
              "1",
              "output from a different worker says merged",
            );
          }
        }),
    );
    await page.goto(`/tasks/${id}`);
    await expect(
      page.getByRole("heading", { name: scenario.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("atlas-01", { exact: true })).toBeVisible();
    await expect(page.getByText("Try 2", { exact: true })).toBeVisible();
    await expect(page.getByText("Provider usage: unknown", { exact: true }))
      .toBeVisible();
    await expect(
      page.getByText(
        "Observed repository state. No review or merge decision recorded.",
      ),
    ).toBeVisible();
  });
}

test("three timed-out attempts end on the timeout heading with the history kept", async ({ page }) => {
  await prepare(page);
  const timedOut = { resultStatus: "failed", reasonCode: "timeout" };
  await page.route(
    `**/v1/jobs/${stream.jobId}/attempts?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [3, 2, 1].map((number) => ({
            ...attempt,
            id: `00000000-0000-4000-8000-00000000005${number}`,
            attemptNo: number,
            workerName: number === 3 ? "atlas-01" : `earlier-worker-${number}`,
            status: "failed",
            isCurrent: number === 3,
            leaseState: "closed",
            outcome: { ...attempt.outcome, ...timedOut },
          })),
          nextCursor: null,
        },
      }),
  );
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  await expect(
    page.getByRole("heading", { name: "Run timed out", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Execution identity" }).getByText(
      "Try 3",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("atlas-01", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Try", exact: true })
      .locator("option"),
  ).toHaveText([
    "Current try",
    "Try 3",
    "Try 2",
    "Try 1",
  ]);
});

test("printed output cannot invent quota or replace trusted worker identity", async ({ page }) => {
  await prepare(page);
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "output.subscribe") {
          sendBatch(
            socket,
            frame.requestId,
            "1",
            "PROVIDER_QUOTA_EXCEEDED worker evil-machine process exited reviewed merged",
          );
        }
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("atlas-01", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Provider quota exceeded", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /^Process exited/ }),
  ).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", {
    name: "Download displayed output",
    exact: true,
  }).click();
  expect((await downloadEvent).suggestedFilename()).toBe(
    `output-${streamId}.txt`,
  );
});

test("current artifact metadata advances without reloading the task", async ({ page }) => {
  await prepare(page);
  const artifactId = "00000000-0000-4000-8000-000000000060";
  let revision = 3;
  const artifactBytes = (value: number) =>
    String(value).repeat(2 * 1024 * 1024);
  const artifactDigest = (value: number) =>
    createHash("sha256").update(artifactBytes(value)).digest("hex");
  const currentVersionId = () =>
    `00000000-0000-4000-8000-00000000006${revision}`;
  await page.route("**/v1/sync*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    const changed = revision === 4 && after !== "artifact-4";
    return route.fulfill({
      json: {
        resourceState: {},
        highwater: revision === 4 ? "1" : "0",
        events: changed
          ? [{
            id: "00000000-0000-4000-8000-000000000069",
            sequence: "1",
            type: "run.completed",
            schemaVersion: 1,
            occurredAt: task.updatedAt,
            taskId: id,
            repositoryId: task.repositoryId,
            conversationId: task.conversationId,
            payload: { runId },
          }]
          : [],
        nextCursor: changed ? "artifact-4" : null,
        resetRequired: false,
      },
    });
  });
  await page.route("**/v1/artifacts?*", (route) =>
    route.fulfill({
      json: {
        items: [{
          id: artifactId,
          taskId: id,
          artifactType: "patch",
          name: "changing.patch",
          currentVersionId: currentVersionId(),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          version: revision,
        }],
        nextCursor: null,
      },
    }));
  await page.route(
    `**/v1/artifacts/${artifactId}/versions*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{
            id: currentVersionId(),
            artifactId,
            revision,
            runStepId: stepId,
            authorId: task.createdBy,
            mediaType: "text/x-diff",
            sizeBytes: 2 * 1024 * 1024,
            sha256: artifactDigest(revision),
            subjectHeadSha: "b".repeat(40),
            subjectBaseSha: "c".repeat(40),
            metadata: {},
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            version: revision,
          }],
          nextCursor: null,
        },
      }),
  );
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  const card = page.locator('[data-ui-component="runArtifactSummary"]');
  await expect(card.getByText("r3", { exact: true })).toBeVisible();
  revision = 4;
  await expect(card.getByText("r4", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(card.getByText("r3", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Download", exact: true }))
    .toBeEnabled();
  await page.route(
    `**/v1/artifact-versions/${currentVersionId()}/content*`,
    (route) => {
      expect(route.request().headers()["bakery-organization-id"]).toBe(
        MOCK_ORGANIZATION_ID,
      );
      return route.fulfill({
        headers: {
          "content-type": "text/x-diff",
          "content-length": String(2 * 1024 * 1024),
          etag: `"${artifactDigest(4)}"`,
        },
        body: artifactBytes(4),
      });
    },
  );
  const downloadEvent = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download", exact: true }).click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe("changing.patch");
  const received = await downloaded.createReadStream();
  expect(received).not.toBeNull();
  const receivedHash = createHash("sha256");
  for await (const chunk of received!) receivedHash.update(chunk);
  expect(receivedHash.digest("hex")).toBe(artifactDigest(4));
});

async function routeAsideArtifacts(
  page: Page,
  artifacts: readonly {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly runStepId: string;
  }[],
  pageSize = Number.POSITIVE_INFINITY,
) {
  await prepare(page);
  const versionOf = (artifactId: string) => {
    const index = artifacts.findIndex((item) => item.id === artifactId);
    return `00000000-0000-4000-8000-0000000007${index}1`;
  };
  await page.route("**/v1/artifacts?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const type = params.get("artifactType");
    const offset = Number(params.get("cursor") ?? "0");
    const matching = artifacts.filter((item) =>
      type === null || item.type === type
    );
    const end = Math.min(offset + pageSize, matching.length);
    return route.fulfill({
      json: {
        items: matching.slice(offset, end)
          .map((item) => ({
            id: item.id,
            taskId: id,
            artifactType: item.type,
            name: item.name,
            currentVersionId: versionOf(item.id),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            version: 1,
          })),
        nextCursor: end < matching.length ? String(end) : null,
      },
    });
  });
  for (const item of artifacts) {
    await page.route(
      `**/v1/artifacts/${item.id}/versions*`,
      (route) =>
        route.fulfill({
          json: {
            items: [{
              id: versionOf(item.id),
              artifactId: item.id,
              revision: 1,
              runStepId: item.runStepId,
              authorId: task.createdBy,
              mediaType: "text/x-diff",
              sizeBytes: 4,
              sha256: createHash("sha256").update(item.name).digest("hex"),
              subjectHeadSha: "b".repeat(40),
              subjectBaseSha: "c".repeat(40),
              metadata: {},
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              version: 1,
            }],
            nextCursor: null,
          },
        }),
    );
    await page.route(
      `**/v1/artifact-versions/${versionOf(item.id)}/extract*`,
      (route) =>
        route.fulfill({
          json: {
            versionId: versionOf(item.id),
            sha256: createHash("sha256").update(item.name).digest("hex"),
            startByte: 0,
            endByte: 4,
            text: item.name,
            hasMore: false,
          },
        }),
    );
  }
  await page.routeWebSocket("**/v1/events?*", () => {});
}

test("aside previews this run's patch, not a newer log or a prior run's patch", async ({ page }) => {
  await routeAsideArtifacts(page, [
    {
      id: "00000000-0000-4000-8000-000000000071",
      type: "log",
      name: "transcript.log",
      runStepId: stepId,
    },
    {
      id: "00000000-0000-4000-8000-000000000072",
      type: "patch",
      name: "prior-run.patch",
      runStepId: "00000000-0000-4000-8000-0000000000ff",
    },
    {
      id: "00000000-0000-4000-8000-000000000073",
      type: "patch",
      name: "this-run.patch",
      runStepId: stepId,
    },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("heading", { name: "this-run.patch" }))
    .toBeVisible();
  await expect(pane.getByText("prior-run.patch")).toHaveCount(0);
  await expect(pane.getByText("transcript.log")).toHaveCount(0);
  // text/x-diff is not extractable media: metadata only, no inline preview.
  await expect(pane.getByText("Preview unavailable for this media type."))
    .toBeVisible();
});

test("aside pages past other runs' patches to find this run's patch", async ({ page }) => {
  await routeAsideArtifacts(page, [
    {
      id: "00000000-0000-4000-8000-000000000072",
      type: "patch",
      name: "prior-run.patch",
      runStepId: "00000000-0000-4000-8000-0000000000ff",
    },
    {
      id: "00000000-0000-4000-8000-000000000073",
      type: "patch",
      name: "this-run.patch",
      runStepId: stepId,
    },
  ], 1);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("heading", { name: "this-run.patch" }))
    .toBeVisible();
  await expect(pane.getByText("prior-run.patch")).toHaveCount(0);
});

test("aside is empty when only a prior run published a patch", async ({ page }) => {
  await routeAsideArtifacts(page, [
    {
      id: "00000000-0000-4000-8000-000000000071",
      type: "log",
      name: "transcript.log",
      runStepId: stepId,
    },
    {
      id: "00000000-0000-4000-8000-000000000072",
      type: "patch",
      name: "prior-run.patch",
      runStepId: "00000000-0000-4000-8000-0000000000ff",
    },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane).toBeVisible();
  await expect(pane.getByText("This run has published no artifact yet."))
    .toBeVisible();
  await expect(pane.getByText("prior-run.patch")).toHaveCount(0);
  await expect(pane.getByText("transcript.log")).toHaveCount(0);
});

test("current attempt selection returns from historical pages", async ({ page }) => {
  await prepare(page);
  await page.route(`**/v1/jobs/${stream.jobId}/attempts?*`, (route) => {
    const historical = new URL(route.request().url()).searchParams.has(
      "cursor",
    );
    return route.fulfill({
      json: historical
        ? {
          items: [1, 0].map((number) => ({
            ...attempt,
            id: `00000000-0000-4000-8000-00000000004${number}`,
            attemptNo: number + 1,
            workerName: "historical-worker",
            isCurrent: false,
          })),
          nextCursor: null,
        }
        : { items: [attempt], nextCursor: "older-attempts" },
    });
  });
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("atlas-01", { exact: true })).toBeVisible();
  await page.locator("button:enabled").filter({ hasText: /^Next$/ }).click();
  await expect(page.getByText("historical-worker", { exact: true }))
    .toBeVisible();
  await page.getByRole("combobox", { name: "Try", exact: true })
    .selectOption("");
  await expect(page.getByText("atlas-01", { exact: true })).toBeVisible();
  await expect(page.getByText("historical-worker", { exact: true }))
    .toHaveCount(0);
});

test("verified provider receipt renders known usage without guessing missing values", async ({ page }) => {
  await prepare(page);
  await page.route(
    `**/v1/jobs/${stream.jobId}/attempts?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{
            ...attempt,
            outcome: {
              ...attempt.outcome,
              usage: {
                inputTokens: "128",
                outputTokens: "64",
                costUsd: "0.012",
              },
            },
          }],
          nextCursor: null,
        },
      }),
  );
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  await expect(
    page.getByText(
      "Provider usage: 128 input tokens · 64 output tokens · USD 0.012",
      { exact: true },
    ),
  ).toBeVisible();
});

test("output step defaults to the running step, not an empty earlier step", async ({ page }) => {
  const briefId = "00000000-0000-4000-8000-0000000000b1";
  const requested: string[] = [];
  await prepare(page);
  await page.route(`**/v1/runs/${runId}/steps*`, (route) =>
    route.fulfill({
      json: {
        items: [
          { ...step, id: briefId, stepKey: "brief", status: "completed" },
          {
            ...step,
            id: stepId,
            stepKey: "implement",
            status: "running",
            finishedAt: null,
          },
        ],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/output-streams?*", (route) => {
    const url = new URL(route.request().url());
    requested.push(url.searchParams.get("runStepId") ?? "");
    return route.fulfill({
      json: {
        items: url.searchParams.get("runStepId") === stepId ? [stream] : [],
        nextCursor: null,
        encodedBytes: 0,
      },
    });
  });
  await page.goto(`/tasks/${id}`);
  await expect(page.getByLabel("Output step")).toHaveValue(stepId);
  expect(requested.every((value) => value === stepId)).toBe(true);
});

test("a failed step with no output stream still shows its outcome", async ({ page }) => {
  await prepare(page);
  await page.route(`**/v1/runs/${runId}/steps*`, (route) =>
    route.fulfill({
      json: {
        items: [{ ...step, stepKey: "implement", status: "failed" }],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/output-streams?*", (route) =>
    route.fulfill({
      json: { items: [], nextCursor: null, encodedBytes: 32 },
    }));
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  const empty = page.getByText("No output stream recorded for this step.");
  await expect(empty).toBeVisible();
  // Scope to the output panel's notice; the timeline also renders "Failed".
  await expect(
    page.locator(".ui-inline-notice--warning").filter({ hasText: /^Failed$/ }),
  ).toBeVisible();
});

test("a quota-failed step with no stream shows the quota heading", async ({ page }) => {
  await prepare(page);
  await page.route(`**/v1/runs/${runId}/steps*`, (route) =>
    route.fulfill({
      json: {
        items: [{
          ...step,
          stepKey: "implement",
          status: "failed",
          error: { code: "quota_exceeded", message: "sk-secret-free-text" },
        }],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/output-streams?*", (route) =>
    route.fulfill({
      json: { items: [], nextCursor: null, encodedBytes: 32 },
    }));
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText(/Provider quota exceeded/).first()).toBeVisible();
  await expect(page.getByText("sk-secret-free-text")).toHaveCount(0);
});

test("a run without an admission pin shows the workspace base it started from", async ({ page }) => {
  await prepare(page);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: {
          ...run,
          status: "running",
          finishedAt: null,
          baseSha: null,
          workspaceBaseSha: "d".repeat(40),
        },
      }),
  );
  await page.route("**/v1/output-streams?*", (route) =>
    route.fulfill({
      json: { items: [], nextCursor: null, encodedBytes: 32 },
    }));
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.goto(`/tasks/${id}`);
  const revision = page.locator('[data-ui-component="revisionSummary"]').filter(
    {
      hasText: "Changes",
    },
  );
  await expect(revision).toContainText("ddddddd");
  // Short form only: the full 40-character commit is not the label.
  await expect(revision).not.toContainText("d".repeat(40));
});

const retriedProducers = [
  {
    writerGeneration: "1",
    attemptId: "00000000-0000-4000-8000-000000000041",
    attemptNo: 1,
  },
  {
    writerGeneration: "2",
    attemptId: "00000000-0000-4000-8000-000000000042",
    attemptNo: 2,
  },
];

/** Texts of the output log's rows, in order. */
const logRows = (page: Page) =>
  page.locator('[data-ui-component="logViewer"] li').allInnerTexts();

test("a retried job's output names the attempt that wrote each line", async ({ page }) => {
  await prepare(page);
  await page.route("**/v1/output-streams?*", (route) =>
    route.fulfill({
      json: {
        items: [{ ...stream, producers: retriedProducers }],
        nextCursor: null,
        encodedBytes: 1000,
      },
    }));
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        sendBatch(socket, frame.requestId, "1", "first attempt line one");
        sendBatch(socket, frame.requestId, "2", "first attempt line two");
        sendBatch(
          socket,
          frame.requestId,
          "3",
          "second attempt line",
          "capturing",
          "2",
        );
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("second attempt line", { exact: true }))
    .toBeVisible();
  const rows = await logRows(page);
  const position = (text: string) =>
    rows.findIndex((row) => row.includes(text));
  expect(rows).toHaveLength(5);
  expect(rows[0]).toContain("Try 1");
  expect(rows[0]).toContain("Output from this try starts here.");
  expect(position("first attempt line one")).toBe(1);
  expect(position("first attempt line two")).toBe(2);
  expect(rows[3]).toContain("Try 2");
  expect(position("second attempt line")).toBe(4);
  // The downloaded text is the committed bytes: no marker enters it.
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download displayed output" }).click();
  const content = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  if (!content) throw new Error("Output download stream unavailable");
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text).toContain("first attempt line one");
  expect(text).toContain("second attempt line");
  expect(text).not.toContain("Output from this try starts here.");
});

test("a stream written by one attempt shows no attempt marker", async ({ page }) => {
  await prepare(page);
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        sendBatch(socket, frame.requestId, "1", "only line one");
        sendBatch(socket, frame.requestId, "2", "only line two");
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("only line two", { exact: true })).toBeVisible();
  expect(await logRows(page)).toHaveLength(2);
  await expect(page.getByText("Output from this try starts here."))
    .toHaveCount(0);
});

test("a retry that began after the list loaded reloads the list once and names its attempt", async ({ page }) => {
  await prepare(page);
  let listReads = 0;
  await page.route("**/v1/output-streams?*", (route) => {
    listReads += 1;
    const producers = listReads === 1
      ? retriedProducers
      : [...retriedProducers, {
        writerGeneration: "3",
        attemptId: "00000000-0000-4000-8000-000000000043",
        attemptNo: 3,
      }];
    return route.fulfill({
      json: {
        items: [{ ...stream, producers }],
        nextCursor: null,
        encodedBytes: 1000,
      },
    });
  });
  await page.routeWebSocket(
    "**/v1/events?*",
    (socket) =>
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type !== "output.subscribe") return;
        sendBatch(socket, frame.requestId, "1", "line from attempt one");
        sendBatch(
          socket,
          frame.requestId,
          "2",
          "line from attempt two",
          "capturing",
          "2",
        );
        sendBatch(
          socket,
          frame.requestId,
          "3",
          "line from attempt three",
          "capturing",
          "3",
        );
      }),
  );
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("line from attempt three", { exact: true }))
    .toBeVisible();
  await expect.poll(async () => (await logRows(page)).join("|"))
    .toContain("Try 3");
  const rows = await logRows(page);
  expect(rows.filter((row) => row.includes("Unlisted try")))
    .toHaveLength(0);
  expect(rows).toHaveLength(6);
  expect(listReads).toBe(2);
  await page.waitForTimeout(500);
  expect(listReads).toBe(2);
});
