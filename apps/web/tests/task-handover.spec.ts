import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";

// #72: a running step with a saved point shows "Hand over to a new session".
// The card says how the new session will carry on before the click (the server's
// own decision on `handoffManifests.get`), lists what it is given, and the click
// sends the run version the card was drawn from. The reads and the continue are
// mocked with the shapes of `handoffManifests.get`, `handoffManifests.continue`,
// `runSteps.list` (`handoffManifest`) and `storageFiles.byVersion`.

registerPageHealth(test);

const EVIDENCE = process.env.BAKERY_EVIDENCE_DIR;
const SCHEME = process.env.BAKERY_EVIDENCE_SCHEME === "dark"
  ? "dark"
  : process.env.BAKERY_EVIDENCE_SCHEME === "light"
  ? "light"
  : null;

/**
 * A still of the page tall enough to hold the card: it sits in the scrolling
 * conversation pane, so a one-screen capture would cut it off.
 */
async function still(page: Page, name: string) {
  if (!EVIDENCE) return;
  if (SCHEME) await page.emulateMedia({ colorScheme: SCHEME });
  const phone = test.info().project.name === "mobile";
  const original = page.viewportSize();
  await page.setViewportSize(
    phone ? { width: 390, height: 2400 } : { width: 1440, height: 1800 },
  );
  await expect(card(page)).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE}/${name}--${phone ? "mobile" : "desktop"}.png`,
    animations: "disabled",
  });
  if (original) await page.setViewportSize(original);
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const taskId = uuid(12);
const runId = uuid(20);
const stepId = uuid(21);
const manifestId = uuid(70);
const SHA = "a7254e7".padEnd(40, "c");
const RUN_VERSION = 4;
const DOC_OPEN = uuid(81);
const DOC_HIDDEN = uuid(82);
const DOC_PLAIN = uuid(83);
const SESSION = uuid(41);

const run = {
  id: runId,
  taskId,
  workflowVersionId: uuid(22),
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: SHA,
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
  version: RUN_VERSION,
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
const task = {
  id: taskId,
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
  baseSha: SHA,
};

const page_ = <T>(items: T[]) => ({ items, nextCursor: null });
/** A problem answer as the server sends it (`application/problem+json`). */
const problemReply = (
  route: Route,
  status: number,
  code: string,
  reason?: string,
) =>
  route.fulfill({
    status,
    contentType: "application/problem+json",
    body: JSON.stringify(problem(status, code, reason)),
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

type Decision = {
  decisionMode: "exact_harness_resume" | "fresh_session" | null;
  freshReason: string | null;
};

function storedManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    mode: "exact_harness_resume",
    goal: "Make the refund total round half up and add the missing test.",
    nextAction: "Run the payments suite and fix what fails.",
    decisions: ["Keep the public API", "No new dependency"],
    repository: {
      commitSha: SHA,
      baseSha: SHA,
      uncommittedPatch: { artifactId: uuid(90), versionId: uuid(91) },
      binaryChanges: [],
      captureStatus: "complete",
    },
    context: {
      artifactRefs: [
        { artifactId: uuid(92), versionId: DOC_OPEN, sha256: "b".repeat(64) },
        { artifactId: uuid(93), versionId: DOC_HIDDEN, sha256: "c".repeat(64) },
        { artifactId: uuid(94), versionId: DOC_PLAIN, sha256: "d".repeat(64) },
        { artifactId: uuid(95), versionId: uuid(84), sha256: "e".repeat(64) },
      ],
    },
    tests: [
      {
        command: "pnpm test payments",
        result: "failed",
        evidenceVersionId: null,
      },
      { command: "pnpm lint", result: "passed", evidenceVersionId: uuid(95) },
    ],
    pendingEffects: [],
    checkpoint: { sequence: "12", digest: "d".repeat(64), safeBoundary: true },
    ...over,
  };
}

type World = {
  decision: Decision;
  manifest: Record<string, unknown>;
  safeBoundary: boolean;
  status: string;
  stepHasManifest: boolean;
  canControl: boolean;
  continues: { key: string; body: Record<string, unknown> }[];
  /** Who the server recorded as having handed the step over, once it is. */
  continuedBy: string | null;
  reply?: (route: Route) => Promise<void>;
  reads: number;
};

function world(over: Partial<World> = {}): World {
  return {
    decision: { decisionMode: "exact_harness_resume", freshReason: null },
    manifest: storedManifest(),
    safeBoundary: true,
    status: "pending",
    stepHasManifest: true,
    canControl: true,
    continues: [],
    continuedBy: "Ana Silva",
    reads: 0,
    ...over,
  };
}

async function open(page: Page, w: World) {
  await mockAuthenticatedSession(page);
  await page.route(`**/v1/tasks/${taskId}`, (r) => r.fulfill({ json: task }));
  await page.route(`**/v1/runs/${runId}`, (r) => r.fulfill({ json: run }));
  await page.route(`**/v1/runs/${runId}/steps*`, (r) =>
    r.fulfill({
      json: page_([{
        id: stepId,
        runId,
        stepKey: "implement",
        iteration: 1,
        status: "running",
        input: {},
        output: null,
        error: null,
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: null,
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
        version: 1,
        handoffManifest: w.stepHasManifest
          ? {
            id: manifestId,
            status: w.status,
            savedAt: "2026-01-01T00:00:30.000Z",
          }
          : null,
      }]),
    }));
  await page.route(`**/v1/runs/${runId}/controls`, (r) =>
    r.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: w.canControl,
          reason: w.canControl ? "allowed" : "authority_unavailable",
        })),
      },
    }));
  await page.route(`**/v1/handoff-manifests/${manifestId}`, (r) => {
    w.reads += 1;
    return r.fulfill({
      json: {
        id: manifestId,
        taskId,
        runId,
        runStepId: stepId,
        sourceAttemptId: uuid(71),
        sourceFence: "1",
        mode: "exact_harness_resume",
        digest: "e".repeat(64),
        safeBoundary: w.safeBoundary,
        status: w.status,
        manifest: w.manifest,
        createdAt: "2026-01-01T00:00:30.000Z",
        machineName: "build-box-01",
        ...(w.status === "continued"
          ? {
            decisionMode: null,
            freshReason: null,
            continuedMode: w.decision.decisionMode ?? "fresh_session",
            continuedFreshReason: w.decision.freshReason,
            continuedByName: w.continuedBy,
            continuedAt: "2026-01-01T00:05:00.000Z",
          }
          : w.decision),
      },
    });
  });
  await page.route(
    `**/v1/handoff-manifests/${manifestId}/continuations`,
    async (r) => {
      w.continues.push({
        key: r.request().headers()["idempotency-key"] ?? "",
        body: r.request().postDataJSON() as Record<string, unknown>,
      });
      if (w.reply) return await w.reply(r);
      // The server records the hand-over: the step's saved point is now used.
      w.status = "continued";
      await r.fulfill({
        status: 201,
        json: {
          id: uuid(72),
          manifestId,
          runId,
          runStepId: stepId,
          jobId: uuid(73),
          sourceAttemptId: uuid(71),
          previousFence: "1",
          newFence: "2",
          mode: w.decision.decisionMode ?? "fresh_session",
          freshReason: w.decision.freshReason,
          admittedAt: new Date().toISOString(),
        },
      });
    },
  );
  await page.route(/\/v1\/storage\/file-versions\/[^/]+$/, (r) => {
    const version = new URL(r.request().url()).pathname.split("/").pop()!;
    if (version !== DOC_OPEN) {
      return r.fulfill({
        status: 404,
        json: problem(404, "RESOURCE_NOT_FOUND"),
      });
    }
    return r.fulfill({
      json: {
        file: {
          id: uuid(92),
          parentId: null,
          path: "/specs/refund-rules.md",
          name: "refund-rules.md",
          displayName: null,
          kind: "file",
          policy: "record",
          kindName: null,
          mediaType: "text/markdown",
          sizeBytes: 100,
          artifactId: uuid(92),
          pinned: false,
          contentRemoved: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        versionId: DOC_OPEN,
        revision: 3,
        isCurrent: true,
      },
    });
  });
  // A document that is not a storage file is read through its own artifact and
  // version reads; one with no artifact access is not readable at all.
  await page.route(/\/v1\/artifacts\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop()!;
    if (id === uuid(95)) return problemReply(r, 500, "INTERNAL_ERROR");
    if (id !== uuid(94)) {
      return problemReply(r, 404, "RESOURCE_NOT_FOUND");
    }
    return r.fulfill({
      json: {
        id,
        taskId,
        artifactType: "research",
        name: "refund-plan.pdf",
        currentVersionId: DOC_PLAIN,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        pinnedAt: null,
        pinnedBy: null,
      },
    });
  });
  // The pinned version is not on the first page: it is found by paging on.
  await page.route(/\/v1\/artifacts\/[^/]+\/versions(\?.*)?$/, (r) => {
    const url = new URL(r.request().url());
    const item = (id: string, revision: number) => ({
      id,
      artifactId: uuid(94),
      revision,
      runStepId: null,
      authorId: uuid(5),
      mediaType: "application/pdf",
      sizeBytes: 10,
      sha256: "d".repeat(64),
      subjectHeadSha: null,
      subjectBaseSha: null,
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
      retentionClass: "evidence",
      expiresAt: null,
      purgedAt: null,
      publicationStatus: "current",
      refusedKindVersionId: null,
      refusedRuleType: null,
      refusedReason: null,
    });
    return r.fulfill({
      json: url.searchParams.get("cursor") === "page-2"
        ? { items: [item(DOC_PLAIN, 2)], nextCursor: null }
        : { items: [item(uuid(86), 5)], nextCursor: "page-2" },
    });
  });
  // The step has a session, as a running step does, so the timeline and the
  // card speak of the same one.
  await page.route("**/v1/sessions?*", (r) =>
    r.fulfill({
      json: {
        items: [{
          id: SESSION,
          runStepId: stepId,
          conversationId: task.conversationId,
          agentVersionId: uuid(42),
          harness: "claude",
          status: "running",
          resumeRef: null,
          parentSessionId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
          adapterCapabilities: {},
        }],
        nextCursor: null,
      },
    }));
  await page.route(
    (url) => url.pathname.endsWith(`/v1/sessions/${SESSION}/feed`),
    (r) => r.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/sessions/${SESSION}/feed/stream`, () => {});
  const empty = (route: Route) => route.fulfill({ json: page_([]) });
  for (
    const pattern of [
      "**/v1/artifacts?*",
      "**/v1/conversations/*/messages*",
      "**/v1/conversations/*/turns*",
      "**/v1/conversations/*/participants*",
      "**/v1/plan-revisions*",
      "**/v1/questions*",
      "**/v1/coordination-plans*",
      "**/v1/approvals?*",
      "**/v1/pull-requests?*",
      "**/v1/merge-attempts?*",
      `**/v1/runs/${runId}/checks*`,
      `**/v1/runs/${runId}/reviews*`,
      `**/v1/runs/${runId}/delivery-decisions*`,
      `**/v1/runs/${runId}/route-continuations`,
    ]
  ) await page.route(pattern, empty);
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
  await page.goto(`/tasks/${taskId}`);
}

const button = (page: Page) => page.getByTestId("handover-open");
const card = (page: Page) => page.getByTestId("handover-card");

test.describe("hand over a running step to a new session", () => {
  test("an exact pick-up will be tried; the card lists what the new session is given, and the click sends the run version", async ({ page }) => {
    const w = world();
    await open(page, w);
    await expect(button(page)).toHaveText("Hand over to a new session");
    await button(page).click();
    await expect(
      card(page).getByRole("heading", {
        name: 'Hand over "Implement" to a new session',
      }),
    ).toBeVisible();
    await expect(card(page)).toContainText(
      "The session on build-box-01 stops and a new one carries on with this step.",
    );
    await expect(page.getByTestId("handover-way")).toHaveAttribute(
      "data-way",
      "exact",
    );
    await expect(page.getByTestId("handover-way")).toContainText(
      "It will try to pick up exactly where it stopped",
    );
    const given = page.getByTestId("handover-given");
    await expect(given).toContainText(
      "Make the refund total round half up and add the missing test.",
    );
    await expect(given).toContainText(
      "Run the payments suite and fix what fails.",
    );
    await expect(given).toContainText("Decisions it must keep · 2");
    await expect(given).toContainText("Keep the public API");
    await expect(given).toContainText(
      "Commit a7254e7c and the changes not committed yet. All saved.",
    );
    await expect(given).toContainText("pnpm test payments");
    await expect(given).toContainText("Failed");
    await expect(given).toContainText("Passed");
    await expect(given).toContainText(
      "None waiting. Everything the session did outside Bakery is confirmed.",
    );
    // A document the reader may open is named with its exact version; one they
    // may not is counted and never named.
    await expect(
      given.getByRole("link", { name: "refund-rules.md, version 3" }),
    )
      .toHaveAttribute("href", `/files/versions/${DOC_OPEN}`);
    // An artifact that is not a storage file is named through its own read.
    await expect(
      given.getByRole("link", { name: "refund-plan.pdf, version 2" }),
    ).toHaveAttribute("href", `/files/versions/${DOC_PLAIN}`);
    // A document that could not be read is said so, never dropped.
    await expect(page.getByTestId("handover-documents-unchecked")).toHaveText(
      "1 could not be checked right now.",
    );
    await expect(page.getByTestId("handover-documents-hidden")).toHaveText(
      "1 more that you do not have access to.",
    );
    // Reading the card admits nothing.
    expect(w.continues).toHaveLength(0);
    await still(page, "handover-exact");
    const axe = await new AxeBuilder({ page }).include(
      '[data-testid="handover"]',
    ).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);

    await page.getByTestId("handover-confirm").click();
    await expect(card(page)).toHaveCount(0);
    expect(w.continues).toHaveLength(1);
    expect(w.continues[0]!.body).toEqual({ runVersion: RUN_VERSION });
    expect(w.continues[0]!.key).toBeTruthy();
    // The timeline says what happened, and by whom.
    await expect(page.getByText(
      "Ana Silva handed this step to a new session. It picked up exactly where it stopped.",
    )).toBeVisible();
  });

  test("a fresh start says why before the click, and again on the timeline after it", async ({ page }) => {
    const w = world({
      decision: {
        decisionMode: "fresh_session",
        freshReason: "native_evidence_mismatch",
      },
    });
    await open(page, w);
    await button(page).click();
    const way = page.getByTestId("handover-way");
    await expect(way).toHaveAttribute("data-way", "fresh");
    await expect(way).toContainText("It will start fresh from a summary");
    await expect(page.getByTestId("handover-reason")).toHaveText(
      "The saved session does not match the code, the agent version or the machine it stopped on.",
    );
    await still(page, "handover-fresh");
    await page.getByTestId("handover-confirm").click();
    await expect(page.getByText(
      "Ana Silva handed this step to a new session. It started fresh from a summary: The saved session does not match the code, the agent version or the machine it stopped on.",
    )).toBeVisible();
  });

  test("outside actions not yet confirmed are counted, and make the card say fresh with that reason", async ({ page }) => {
    const w = world({
      decision: {
        decisionMode: "fresh_session",
        freshReason: "effects_unresolved",
      },
      manifest: storedManifest({
        pendingEffects: [
          { effectId: uuid(1), state: "uncertain" },
          { effectId: uuid(2), state: "submitted" },
        ],
      }),
    });
    await open(page, w);
    await button(page).click();
    await expect(page.getByTestId("handover-reason")).toHaveText(
      "Bakery does not know yet whether 2 outside actions happened. The new session starts once it does.",
    );
    await expect(page.getByTestId("handover-given")).toContainText(
      "2 not confirmed",
    );
    await still(page, "handover-outside");
    await page.getByTestId("handover-confirm").click();
    await expect(page.getByTestId("handover-notice")).toContainText(
      "Handed over. The old session has stopped. The new one starts when Bakery knows whether 2 outside actions happened.",
    );
  });

  test("a later reader sees who the server recorded, not their own name", async ({ page }) => {
    // The page is opened after the hand-over: nothing was done in this tab.
    await open(
      page,
      world({
        status: "continued",
        decision: {
          decisionMode: "fresh_session",
          freshReason: "boundary_unsafe",
        },
      }),
    );
    await expect(page.getByText(
      "Ana Silva handed this step to a new session. It started fresh from a summary:",
      { exact: false },
    )).toBeVisible();
    await expect(page.getByText("Fixture Admin handed", { exact: false }))
      .toHaveCount(0);
    // No button: the saved point is already used.
    await expect(button(page)).toHaveCount(0);
  });

  test("a hand-over by someone who has no name now reads as Someone", async ({ page }) => {
    await open(page, world({ status: "continued", continuedBy: null }));
    await expect(page.getByText(
      "Someone handed this step to a new session.",
      { exact: false },
    )).toBeVisible();
  });

  test("Keep this session closes the card and sends nothing", async ({ page }) => {
    const w = world();
    await open(page, w);
    await button(page).click();
    await page.getByTestId("handover-keep").click();
    await expect(card(page)).toHaveCount(0);
    await expect(button(page)).toBeFocused();
    expect(w.continues).toHaveLength(0);
  });

  test("no button without a saved point, for a person who may not control the run, or once the point is used", async ({ page }) => {
    await open(page, world({ stepHasManifest: false }));
    await expect(
      page.getByTestId("task-run-section").or(
        page.getByRole("heading", { name: "Run" }),
      ).first(),
    )
      .toBeVisible();
    await expect(button(page)).toHaveCount(0);
  });

  test("a person who may not control the run is not offered the button", async ({ page }) => {
    await open(page, world({ canControl: false }));
    await expect(
      page.getByRole("heading", { name: "Add partial refunds" }).first(),
    )
      .toBeVisible();
    await expect(button(page)).toHaveCount(0);
  });

  test("a saved point already used is not offered again", async ({ page }) => {
    await open(page, world({ status: "continued" }));
    await expect(
      page.getByRole("heading", { name: "Add partial refunds" }).first(),
    )
      .toBeVisible();
    await expect(button(page)).toHaveCount(0);
  });

  test("changes still being saved turn Hand over off, with the reason", async ({ page }) => {
    const w = world({
      manifest: storedManifest({
        repository: {
          commitSha: SHA,
          baseSha: SHA,
          uncommittedPatch: null,
          binaryChanges: [],
          captureStatus: "paused",
        },
      }),
    });
    await open(page, w);
    await button(page).click();
    await expect(page.getByTestId("handover-confirm")).toBeDisabled();
    await expect(page.getByTestId("handover-blocked")).toHaveText(
      "Its changes are still being saved.",
    );
  });

  test("a saved point that cannot be read says there is none yet", async ({ page }) => {
    const w = world();
    await open(page, w);
    await page.route(
      `**/v1/handoff-manifests/${manifestId}`,
      (r) =>
        r.fulfill({ status: 404, json: problem(404, "RESOURCE_NOT_FOUND") }),
    );
    await button(page).click();
    await expect(page.getByTestId("handover-gone")).toHaveText(
      "This step has no saved point to hand over from yet.",
    );
  });

  test.describe("refusals", () => {
    const refuse = (status: number, code: string, reason?: string) =>
    async (
      route: Route,
    ) => {
      await problemReply(route, status, code, reason);
    };

    test("a changed run redraws the card with the message and reads the saved point again", async ({ page }) => {
      const w = world({ reply: refuse(412, "PRECONDITION_FAILED") });
      await open(page, w);
      await button(page).click();
      const before = w.reads;
      await page.getByTestId("handover-confirm").click();
      await expect(page.getByTestId("handover-problem")).toHaveText(
        "This run changed while you were looking. Check it again, then hand over.",
      );
      await expect(card(page)).toBeVisible();
      await expect.poll(() => w.reads).toBeGreaterThan(before);
    });

    for (
      const [reason, text] of [
        ["already_continued", "Someone already handed this step over."],
        ["fence_moved", "Someone already handed this step over."],
        [
          "source_not_live",
          "The session has already stopped. Bakery restarts the step by itself.",
        ],
        [
          "run_not_active",
          "This step is no longer running, so there is nothing to hand over.",
        ],
        [
          "manifest_blocked",
          "This saved point was refused before and cannot be used. The session carries on.",
        ],
        [
          "awaiting_reconciliation",
          "This step is already waiting for Bakery to confirm an outside action.",
        ],
        [
          "attempt_budget_exhausted",
          "This step has used all its tries. Start the run again to continue.",
        ],
      ] as const
    ) {
      test(`${reason} closes the card and says so on the step`, async ({ page }) => {
        const w = world({ reply: refuse(409, "STATE_CONFLICT", reason) });
        await open(page, w);
        await button(page).click();
        await page.getByTestId("handover-confirm").click();
        await expect(page.getByTestId("handover-notice")).toContainText(text);
        await expect(card(page)).toHaveCount(0);
      });
    }

    test("a capture still being saved keeps the card open to try again", async ({ page }) => {
      const w = world({
        reply: refuse(409, "STATE_CONFLICT", "capture_incomplete"),
      });
      await open(page, w);
      await button(page).click();
      await page.getByTestId("handover-confirm").click();
      await expect(page.getByTestId("handover-problem")).toHaveText(
        "The session's changes are not fully saved yet. Try again in a moment.",
      );
      await expect(card(page)).toBeVisible();
    });

    test("any other failure says nothing changed, keeps the card, and a lost answer is retried with the same key", async ({ page }) => {
      let attempts = 0;
      const w = world({
        reply: async (route) => {
          attempts += 1;
          if (attempts === 1) return await route.abort();
          await route.fulfill({
            status: 500,
            json: { ...problem(500, "INTERNAL_ERROR") },
          });
        },
      });
      await open(page, w);
      await button(page).click();
      await page.getByTestId("handover-confirm").click();
      await expect(page.getByTestId("handover-problem")).toHaveText(
        "Not handed over. Nothing changed. Try again.",
      );
      await expect(card(page)).toBeVisible();
      await still(page, "handover-refused");
      await page.getByTestId("handover-confirm").click();
      await expect.poll(() => w.continues.length).toBe(2);
      // The answer to the first never arrived: the same hand-over, the same key.
      expect(w.continues[1]!.key).toBe(w.continues[0]!.key);
    });
  });
});
