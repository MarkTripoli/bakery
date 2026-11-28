import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";

registerPageHealth(test);

const EVIDENCE = process.env.BAKERY_EVIDENCE_DIR;
const SCHEME = process.env.BAKERY_EVIDENCE_SCHEME === "dark"
  ? "dark"
  : process.env.BAKERY_EVIDENCE_SCHEME === "light"
  ? "light"
  : null;

async function still(page: Page, name: string, needsCard = true) {
  if (!EVIDENCE) return;
  if (SCHEME) await page.emulateMedia({ colorScheme: SCHEME });
  const phone = test.info().project.name === "mobile";
  const original = page.viewportSize();
  await page.setViewportSize(
    phone ? { width: 390, height: 2400 } : { width: 1440, height: 1800 },
  );
  if (needsCard) await expect(card(page)).toBeVisible();
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
const secondStepId = uuid(23);
const secondManifestId = uuid(74);
const SHA = "a7254e7".padEnd(40, "c");
const RUN_VERSION = 4;
const DOC_OPEN = uuid(81);
const DOC_HIDDEN = uuid(82);
const DOC_PLAIN = uuid(83);
const DOC_ENDLESS = uuid(88);
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
        {
          artifactId: uuid(96),
          versionId: DOC_ENDLESS,
          sha256: "g".repeat(64),
        },
        { artifactId: uuid(94), versionId: uuid(87), sha256: "f".repeat(64) },
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
  continuedBy: string | null;
  reply?: (route: Route) => Promise<void>;
  reads: number;
  secondStep?: boolean;
  given?: Record<string, unknown>;
  givenFailures?: number;
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

function secondStep() {
  return {
    id: secondStepId,
    runId,
    stepKey: "review",
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
    handoffManifest: {
      id: secondManifestId,
      status: "pending",
      savedAt: "2026-01-01T00:00:30.000Z",
    },
  };
}

async function open(page: Page, w: World) {
  await mockAuthenticatedSession(page);
  await page.route(`**/v1/tasks/${taskId}`, (r) => r.fulfill({ json: task }));
  await page.route(`**/v1/runs/${runId}`, (r) => r.fulfill({ json: run }));
  await page.route(`**/v1/runs/${runId}/steps*`, (r) =>
    r.fulfill({
      json: page_([...(w.secondStep ? [secondStep()] : []), {
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
  await page.route("**/v1/runs?*", (r) => r.fulfill({ json: page_([run]) }));
  await page.route(
    `**/v1/runs/${runId}/requests/mine*`,
    (r) => r.fulfill({ json: page_([]) }),
  );
  await page.route(`**/v1/runs/${runId}/steps/*/given`, (r) => {
    if ((w.givenFailures ?? 0) > 0) {
      w.givenFailures! -= 1;
      return problemReply(r, 500, "INTERNAL_ERROR");
    }
    const stepKey = new URL(r.request().url()).pathname.split("/").at(-2)!;
    return r.fulfill({
      json: {
        stepKey,
        startedAt: "2026-01-01T00:00:02.000Z",
        ranAnAgent: false,
        facts: [],
        factsOmitted: 0,
        documents: [],
        documentsHidden: 0,
        documentsGone: 0,
        documentsUnchecked: 0,
        ...(stepKey === "implement" ? w.given : {}),
      },
    });
  });
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
  await page.route(/\/v1\/artifacts\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop()!;
    if (id === uuid(95)) return problemReply(r, 500, "INTERNAL_ERROR");
    if (id !== uuid(94) && id !== uuid(96)) {
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
    const artifactId = url.pathname.split("/").at(-2);
    if (artifactId === uuid(96)) {
      const cursor = url.searchParams.get("cursor");
      const next = cursor === null ? 1 : Number(cursor) + 1;
      return r.fulfill({
        json: { items: [item(uuid(100 + next), next)], nextCursor: `${next}` },
      });
    }
    return r.fulfill({
      json: url.searchParams.get("cursor") === "page-2"
        ? { items: [item(DOC_PLAIN, 2)], nextCursor: null }
        : { items: [item(uuid(86), 5)], nextCursor: "page-2" },
    });
  });
  await page.route("**/v1/sessions?*", (r) =>
    r.fulfill({
      json: {
        items: [{
          id: SESSION,
          runStepId: stepId,
          conversationId: task.conversationId,
          agentVersionId: uuid(42),
          harness: "claude_code",
          status: "finished",
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
    (r) =>
      r.fulfill({
        json: { items: [], nextCursor: null },
      }),
  );
  await page.route(`**/v1/sessions/${SESSION}/feed/stream`, () => {});
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.route(
    "**/v1/output-streams?*",
    (r) =>
      r.fulfill({ json: { items: [], nextCursor: null, encodedBytes: 0 } }),
  );
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
    await expect(
      given.getByRole("link", { name: "refund-rules.md, version 3" }),
    )
      .toHaveAttribute("href", `/files/versions/${DOC_OPEN}`);
    await expect(
      given.getByRole("link", { name: "refund-plan.pdf, version 2" }),
    ).toHaveAttribute("href", `/files/versions/${DOC_PLAIN}`);
    await expect(page.getByTestId("documents-unchecked")).toHaveText(
      "2 could not be checked right now.",
    );
    await expect(page.getByTestId("documents-gone")).toHaveText(
      "1 is no longer available.",
    );
    await expect(page.getByTestId("documents-hidden")).toHaveText(
      "1 more that you do not have access to.",
    );
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
    await expect(page.getByText(
      "Ana Silva handed this step to a new session. It picked up exactly where it stopped.",
    )).toBeVisible();
    await still(page, "timeline-exact", false);
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
    await still(page, "timeline-fresh", false);
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
    await expect(page.getByText(
      "Handed over. The old session has stopped. The new one starts when Bakery knows whether 2 outside actions happened.",
    )).toBeVisible();
    await expect(page.getByTestId("handover-notice")).toHaveCount(0);
    await still(page, "handed-over-waiting", false);
  });

  test("a later reader sees who the server recorded, not their own name", async ({ page }) => {
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
    await still(page, "member-no-button", false);
  });

  test("more than five decisions show five and a Show all", async ({ page }) => {
    const decisions = Array.from(
      { length: 8 },
      (_, index) => `Keep decision number ${index + 1}`,
    );
    await open(
      page,
      world({ manifest: storedManifest({ decisions }) }),
    );
    await button(page).click();
    const given = page.getByTestId("handover-given");
    await expect(given).toContainText("Decisions it must keep · 8");
    await expect(given).toContainText("Keep decision number 5");
    await expect(given).not.toContainText("Keep decision number 6");
    await still(page, "decisions-show-all");
    await given.getByRole("button", { name: "Show all 8" }).click();
    await expect(given).toContainText("Keep decision number 8");
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
    await expect(page.getByTestId("handover-confirm")).toBeEnabled();
    await expect(page.getByTestId("handover-blocked")).toHaveText(
      "Its changes are still being saved.",
    );
    await page.getByTestId("handover-confirm").click();
    await expect(page.getByTestId("handover-blocked")).toBeFocused();
    expect(w.continues).toHaveLength(0);
    await still(page, "saving-blocked");
  });

  test("a saved point that is not found says there is none yet", async ({ page }) => {
    const w = world();
    await open(page, w);
    await page.route(
      `**/v1/handoff-manifests/${manifestId}`,
      (r) => problemReply(r, 404, "RESOURCE_NOT_FOUND"),
    );
    await button(page).click();
    await expect(page.getByTestId("handover-gone")).toHaveText(
      "This step has no saved point to hand over from yet.",
    );
    await expect(page.getByTestId("handover-retry")).toHaveCount(0);
    await expect(page.locator("#handover-heading")).toBeFocused();
  });

  test("a failed read says so, keeps the entry button, and Try again draws the card", async ({ page }) => {
    const w = world();
    await open(page, w);
    let calls = 0;
    await page.route(`**/v1/handoff-manifests/${manifestId}`, (r) => {
      calls += 1;
      return calls === 1
        ? problemReply(r, 500, "INTERNAL_ERROR")
        : r.fallback();
    });
    await button(page).click();
    const notice = page.getByTestId("handover-read-failed");
    await expect(notice).toHaveText(
      "Bakery could not read the saved point. The session is still working on this step.",
    );
    await expect(page.getByTestId("handover-gone")).toHaveCount(0);
    await expect(button(page)).toBeVisible();
    await expect(page.getByTestId("handover-keep")).toBeEnabled();
    await still(page, "read-failed");
    await page.getByTestId("handover-retry").click();
    await expect(page.getByTestId("handover-way")).toBeVisible();
    await expect(page.locator("#handover-heading")).toBeFocused();
  });

  test("Try again keeps the notice and buttons, shows the button loading, and keeps focus on it after a second failure", async ({ page }) => {
    const w = world();
    await open(page, w);
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/v1/handoff-manifests/${manifestId}`, async (r) => {
      calls += 1;
      if (calls === 2) await held;
      return problemReply(r, 500, "INTERNAL_ERROR");
    });
    await button(page).click();
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    const retry = page.getByTestId("handover-retry");
    await retry.click();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    await expect(page.getByTestId("handover-keep")).toBeEnabled();
    await expect(card(page).getByText("Reading the saved point")).toHaveCount(
      0,
    );
    await expect(page.locator("#handover-heading")).toBeVisible();
    release();
    await expect(retry).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    await expect(retry).toBeFocused();
  });

  test("after Try again, another step's card shows loading, not the failed read", async ({ page }) => {
    const w = world({ secondStep: true });
    await open(page, w);
    await page.route(
      `**/v1/handoff-manifests/${manifestId}`,
      (r) => problemReply(r, 500, "INTERNAL_ERROR"),
    );
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      `**/v1/handoff-manifests/${secondManifestId}`,
      async (r) => {
        await held;
        return r.fulfill({
          json: {
            id: secondManifestId,
            taskId,
            runId,
            runStepId: secondStepId,
            sourceAttemptId: uuid(71),
            sourceFence: "1",
            mode: "exact_harness_resume",
            digest: "e".repeat(64),
            safeBoundary: true,
            status: "pending",
            manifest: w.manifest,
            createdAt: "2026-01-01T00:00:30.000Z",
            machineName: "build-box-01",
            decisionMode: "exact_harness_resume",
            freshReason: null,
            continuedMode: null,
            continuedFreshReason: null,
            continuedByName: null,
            continuedAt: null,
          },
        });
      },
    );
    await page.locator('[data-step-key="implement"]').click();
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    await page.getByTestId("handover-retry").click();
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    await page.getByTestId("handover-keep").click();
    await page.locator('[data-step-key="review"]').click();
    await expect(page.getByText("Reading the saved point")).toBeVisible();
    await expect(page.getByTestId("handover-read-failed")).toHaveCount(0);
    release();
    await expect(page.getByTestId("handover-way")).toBeVisible();
  });

  test("a dropped connection says so after the automatic retry", async ({ page }) => {
    const w = world();
    await open(page, w);
    let calls = 0;
    await page.route(`**/v1/handoff-manifests/${manifestId}`, (r) => {
      calls += 1;
      return r.abort();
    });
    await button(page).click();
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("handover-retry")).toBeVisible();
  });

  test("offline, the card says so, offers no Try again, and draws when back online", async ({ page, context }) => {
    const w = world();
    await open(page, w);
    await expect(button(page)).toBeVisible();
    await context.setOffline(true);
    await button(page).click();
    await expect(page.getByTestId("handover-read-failed")).toHaveText(
      "The saved point is read again by itself when you are back online.",
    );
    await expect(page.getByTestId("handover-retry")).toHaveCount(0);
    await expect(card(page).getByRole("progressbar")).toHaveCount(0);
    await still(page, "read-offline");
    await context.setOffline(false);
    await expect(page.getByTestId("handover-way")).toBeVisible();
  });

  test("back online, the card does not take focus from where the person is", async ({ page, context }) => {
    const w = world();
    await open(page, w);
    await expect(button(page)).toBeVisible();
    await context.setOffline(true);
    await button(page).click();
    await expect(page.getByTestId("handover-read-failed")).toBeVisible();
    const composer = page.getByPlaceholder("Message this task…");
    await composer.focus();
    await context.setOffline(false);
    await expect(page.getByTestId("handover-way")).toBeVisible();
    await expect(composer).toBeFocused();
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
        if (reason === "already_continued") {
          await still(page, "someone-already", false);
        }
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
      expect(w.continues[1]!.key).toBe(w.continues[0]!.key);
    });
  });
});

const fact = (n: number, state = "given") => ({
  memoryId: uuid(300 + n),
  wording: `Refunds over ${n}00 euros need a second approval.`,
  recordedAt: "2025-12-01T10:00:00.000Z",
  state,
});

const givenAll = {
  ranAnAgent: true,
  documents: [{
    artifactVersionId: DOC_OPEN,
    state: "available",
    name: "refund-rules.md",
    kind: "plan",
    version: 3,
    sizeBytes: 2048,
  }],
  documentsHidden: 1,
  facts: [
    fact(1, "corrected_since"),
    fact(2, "stopped_since"),
    fact(3),
    fact(4),
    fact(5),
    fact(6),
  ],
  factsOmitted: 2,
};

const givenButton = (page: Page) =>
  page.getByRole("button", { name: "What it was given: Implement" });
const givenPanel = (page: Page) =>
  page.getByRole("dialog", { name: "Given to the agent · Implement" });

test.describe("what a step was given", () => {
  test("lists the documents and facts the step started with, and Escape returns to the row", async ({ page }) => {
    await open(page, world({ stepHasManifest: false, given: givenAll }));
    await givenButton(page).click();
    const panel = givenPanel(page);
    await expect(panel).toContainText("As given when this step started,");
    await expect(panel).toContainText("Documents · 2");
    await expect(
      panel.getByRole("link", { name: "refund-rules.md, version 3" }),
    ).toHaveAttribute("href", `/files/versions/${DOC_OPEN}`);
    await expect(panel).toContainText("Plan · 2 kB");
    await expect(panel.getByTestId("documents-hidden")).toHaveText(
      "1 more that you do not have access to.",
    );
    await expect(panel).toContainText("Remembered facts · 6");
    await expect(panel).toContainText("corrected since");
    await expect(panel).toContainText("no longer used");
    await expect(panel.getByRole("link", { name: "See the fact" }))
      .toHaveAttribute("href", new RegExp(`fact=${uuid(301)}`));
    await expect(panel).not.toContainText("Refunds over 600 euros");
    await expect(panel.getByTestId("given-omitted")).toHaveText(
      "2 more facts were left out to fit the agent's limit. The agent did not see them.",
    );
    await still(page, "step-given", false);
    expect(
      (await new AxeBuilder({ page }).include('[data-testid="step-given"]')
        .analyze()).violations,
    ).toEqual([]);
    await panel.getByRole("button", { name: "Show all 6" }).click();
    await expect(panel).toContainText("Refunds over 600 euros");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(givenButton(page)).toBeFocused();
  });

  test("a step that ran no agent, or an earlier pass, offers nothing", async ({ page }) => {
    await open(
      page,
      world({
        stepHasManifest: false,
        given: { ranAnAgent: true, startedAt: "2026-01-01T00:09:00.000Z" },
      }),
    );
    await expect(page.getByText("Running").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(givenButton(page)).toHaveCount(0);
  });

  test("a step given nothing more says so", async ({ page }) => {
    await open(
      page,
      world({ stepHasManifest: false, given: { ranAnAgent: true } }),
    );
    await givenButton(page).click();
    await expect(givenPanel(page)).toContainText(
      "Nothing besides the step's own instructions.",
    );
  });

  test("a failed read says so and Try again reads it again", async ({ page }) => {
    await open(
      page,
      world({ stepHasManifest: false, given: givenAll, givenFailures: 2 }),
    );
    await givenButton(page).click();
    const panel = givenPanel(page);
    await expect(panel).toContainText(
      "Bakery could not read what this step was given.",
    );
    await still(page, "step-given-failed", false);
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(panel).toContainText("Documents · 2");
  });
});
