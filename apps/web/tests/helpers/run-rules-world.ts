/** The run page with its checks and the repository's current rules, for run-rules.spec.ts. */
import { expect, type Page, type Route } from "@playwright/test";
import { mockAuthenticatedSession } from "./mock-session.ts";

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const TASK_ID = uuid(12);
export const RUN_ID = uuid(20);
export const REPOSITORY_ID = uuid(5);
export const STEP_IMPLEMENT = uuid(21);
export const STEP_VERIFY = uuid(23);
export const RULES_A = "a1".repeat(32);
export const RULES_B = "b2".repeat(32);
export const CHECKS_A = "c3".repeat(32);
const BASE = "a7254e7".padEnd(40, "c");

const page_ = (items: unknown[]) => ({ items, nextCursor: null });

const task = {
  id: TASK_ID,
  applicationId: uuid(4),
  repositoryId: REPOSITORY_ID,
  conversationId: uuid(6),
  parentTaskId: null,
  title: "Add partial refunds",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: uuid(1),
  currentRunId: RUN_ID,
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

const run = (finished: boolean) => ({
  id: RUN_ID,
  taskId: TASK_ID,
  workflowVersionId: uuid(22),
  repositoryProfileId: uuid(30),
  repositoryProfileRevision: 4,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
  // Required since #921: the run's pinned environment.
  environment: "live",
  status: finished ? "completed" : "running",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: finished ? "2026-01-01T00:05:00.000Z" : null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  version: 1,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId: RUN_ID,
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

const step = (id: string, stepKey: string, n: number) => ({
  id,
  runId: RUN_ID,
  stepKey,
  iteration: 1,
  status: "completed",
  input: {},
  output: null,
  error: null,
  startedAt: `2026-01-01T00:00:0${n}.000Z`,
  finishedAt: `2026-01-01T00:00:0${n + 1}.000Z`,
  createdAt: `2026-01-01T00:00:0${n}.000Z`,
  updatedAt: `2026-01-01T00:00:0${n + 1}.000Z`,
  version: 1,
  handoffManifest: null,
});

export const check = (
  n: number,
  policyDigest: string,
  checkerDigest: string | null,
  runStepId: string | null,
  createdAt: string,
) => ({
  id: uuid(100 + n),
  runId: RUN_ID,
  runStepId,
  pullRequestId: null,
  checkId: `check-${n}`,
  checkName: `check-${n}`,
  kind: "command",
  ruleKey: null,
  headSha: "91d0aa3".padEnd(40, "b"),
  baseSha: BASE,
  profileDigest: null,
  policyDigest,
  subjectDigest: "a".repeat(64),
  checkerDigest,
  titleDigest: null,
  bodyDigest: null,
  mergeMessageDigest: null,
  commitSelectionDigest: null,
  result: "passed",
  reason: "verified",
  exitCode: 0,
  durationMs: 10,
  outputDigest: null,
  evidenceVersionId: null,
  providerRunId: null,
  createdAt,
  updatedAt: createdAt,
  version: 1,
});

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    status,
    detail: code,
    code,
    requestId: uuid(310),
    traceId: uuid(311),
    retryable: false,
  }),
});

export type World = {
  finished?: boolean;
  checks?: ReturnType<typeof check>[];
  /** Status for the checks read; 200 when left out. */
  checksStatus?: number;
  /** The rules in force now; `null` makes that read fail. */
  currentDigest?: string | null;
  hasFixedPolicy?: boolean;
  /**
   * A draft task with no run: Start run is answered with this refusal, as when
   * the repository's rules changed after the task was planned.
   */
  refusedStart?: {
    status: number;
    code: string;
    title: string;
    /** The server's plain reason, as it now sends it for a 412 on a changed policy. */
    reason?: string;
  };
};

export async function openRun(page: Page, world: World = {}) {
  await mockAuthenticatedSession(page);
  let checksStatus = world.checksStatus ?? 200;
  const handle = (path: string, json: unknown) =>
    page.route(path, (route: Route) => route.fulfill({ json }));
  await handle(
    `**/v1/tasks/${TASK_ID}`,
    world.refusedStart
      ? { ...task, currentRunId: null, repositoryProfileId: uuid(30) }
      : task,
  );
  if (world.refusedStart) {
    const refusal = world.refusedStart;
    await handle(
      "**/v1/workflow-presets*",
      page_([{
        id: "fixed-coding",
        revision: 1,
        digest: "a".repeat(64),
        nameKey: "workflowPresets.fixedCoding.name",
        steps: [{ id: "brief", uses: "task.brief" }],
        defaultBudgetLimitUsd: "5.00",
        availability: {
          minimumBudgetLimitUsd: null,
          status: "ready",
          reasons: [],
        },
      }]),
    );
    await page.route(
      `**/v1/tasks/${TASK_ID}/runs`,
      (route: Route) =>
        route.request().method() === "POST"
          ? route.fulfill({
            status: refusal.status,
            contentType: "application/problem+json",
            json: {
              type: "about:blank",
              title: refusal.title,
              status: refusal.status,
              code: refusal.code,
              detail: "The server refused the request.",
              requestId: uuid(310),
              traceId: uuid(311),
              retryable: false,
              ...(refusal.reason ? { reason: refusal.reason } : {}),
            },
          })
          : route.fallback(),
    );
  }
  await handle(`**/v1/runs/${RUN_ID}`, run(world.finished ?? false));
  await handle(
    `**/v1/runs/${RUN_ID}/steps*`,
    page_([
      step(STEP_IMPLEMENT, "implement", 2),
      step(STEP_VERIFY, "verify", 4),
    ]),
  );
  await handle(`**/v1/runs/${RUN_ID}/controls`, {
    runId: RUN_ID,
    actions: [],
  });
  await handle("**/v1/artifacts?*", page_([]));
  await handle("**/v1/runs/*/reviews*", page_([]));
  await handle("**/v1/runs/*/delivery-decisions*", page_([]));
  await handle("**/v1/approvals?*", page_([]));
  await handle("**/v1/pull-requests?*", page_([]));
  // The conversation beside the run reads these; unstubbed they fail and the
  // page shows "could not be loaded" banners that are not this feature's.
  await handle(`**/v1/conversations/${uuid(6)}/messages*`, page_([]));
  await handle(`**/v1/conversations/${uuid(6)}/participants*`, page_([]));
  await handle(`**/v1/conversations/${uuid(6)}/turns*`, page_([]));
  await handle("**/v1/coordination-plans*", page_([]));
  await handle("**/v1/plan-revisions*", page_([]));
  await handle("**/v1/questions*", page_([]));
  await handle("**/v1/output-streams?*", page_([]));
  if (!world.refusedStart) await handle("**/v1/workflow-presets*", page_([]));
  await handle("**/v1/sync*", {
    resourceState: {},
    highwater: "0",
    events: [],
    nextCursor: "cursor-0",
    resetRequired: false,
  });
  await page.route(
    `**/v1/runs/${RUN_ID}/checks*`,
    (route: Route) =>
      checksStatus === 200
        ? route.fulfill({ json: page_(world.checks ?? []) })
        : route.fulfill(problem(checksStatus, "INTERNAL_ERROR")),
  );
  await page.route(
    `**/v1/repositories/${REPOSITORY_ID}/rules`,
    (route) =>
      world.currentDigest === null
        ? route.fulfill(problem(500, "INTERNAL_ERROR"))
        : route.fulfill({
          json: {
            repositoryId: REPOSITORY_ID,
            profileId: uuid(30),
            profileRevision: 4,
            organizationRevision: 1,
            entries: [],
            supersededOverrides: [],
            digest: world.currentDigest ?? RULES_A,
            repositoryVersion: 1,
            checkers: { state: "configured", unavailableRuleKeys: [] },
            providerProtection: { state: "unknown", reason: "not_checked" },
            ...(world.hasFixedPolicy === undefined
              ? {}
              : { hasFixedPolicy: world.hasFixedPolicy }),
          },
        }),
  );
  await page.goto(`/tasks/${TASK_ID}`);
  await expect(
    page.getByRole("heading", {
      name: world.refusedStart ? "Start a run" : "Current run",
    }),
  ).toBeVisible();
  return {
    recoverChecks: () => {
      checksStatus = 200;
    },
  };
}
