import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  DELIVERY_GATE_STEP_KEY,
  DELIVERY_LOOP_STOPPED_CODE,
  findingFingerprint,
  REVIEW_LOOP_LIMITS,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  assertDeliveryCandidateMergeable,
} from "../../../apps/server/src/modules/delivery/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import type { ReviewerFinding } from "../../../apps/worker/src/review-report.ts";
import type { AuthenticatedClients } from "../durable-core/engine-admission.ts";
import { appDatabaseUrl, callJson } from "../deterministic-checks/e2e-world.ts";
import {
  assertChecksRanOnProductionHost,
  type CheckRow,
  driveRun,
  hostPrincipal,
  type JobObservation,
  type LoopScript,
  readChecks,
  readCycles,
  readDecisions,
  readGate,
  readSessions,
  readSteps,
  stepName,
  waitForTerminal,
  type World,
} from "./e2e-loop.ts";
import { type LoopRepository, startLoopRun } from "./e2e-world.ts";

/**
 * The four scenarios of the real-process proof (issue #94). Each starts a run
 * of `fixed-coding-reviewed`, lets the production worker run the brief and the
 * fixed checks for real, answers the model-backed jobs with the substitute
 * worker, and asserts what the server recorded: steps, check rows, review
 * cycles, findings, decisions, the delivery gate and the HTTP reads.
 *
 * - A, acceptance criterion 1: a failing required check, a clean review, repair
 *   to a good commit, passing checks, a clean review: the run completes after
 *   two cycles.
 * - B, acceptance criterion 2: a clean first candidate: no repair at all.
 * - C, acceptance criterion 3: the same blocking finding in two consecutive
 *   cycles stops the run; nothing approves it.
 * - D, acceptance criterion 3: a reviewer that fails stops the run.
 */

export type ScenarioContext = World & {
  readonly clients: AuthenticatedClients;
  readonly repository: LoopRepository;
  progress(message: string): void;
};

type Page<T> = { items: T[]; nextCursor: string | null };
type Item = Record<string, unknown>;

const LIMITS = {
  maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
  maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
  maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
};

const BLOCKER: ReviewerFinding = {
  severity: "blocker",
  category: "correctness",
  title: "The status file is never made ok",
  path: "status.txt",
  line: 1,
  detail: "status.txt must say ok before the candidate can be delivered.",
};

const jobsOf = (observed: readonly JobObservation[]) =>
  observed.map((job) => `${job.stepKey}@${job.iteration}:${job.action}`);

const strings = (value: unknown): string[] => {
  assert(Array.isArray(value), "an array was expected");
  return value as string[];
};

/** The rows of one step, in the order they were recorded. */
function rowsOf(checks: readonly CheckRow[], stepId: string): CheckRow[] {
  return checks.filter((row) => row.run_step_id === stepId);
}

async function readAll(
  ctx: ScenarioContext,
  path: string,
  pageSize = 1,
): Promise<{ items: Item[]; pages: number }> {
  const items: Item[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `limit=${pageSize}${
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
    }`;
    const page: Page<Item> = await callJson<Page<Item>>(
      ctx.clients.consumer,
      "GET",
      `${path}?${query}`,
      200,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null && pages < 20);
  return { items, pages };
}

async function taskStatus(
  ctx: ScenarioContext,
  taskId: string,
): Promise<string> {
  const rows = await ctx.stack.psql<{ status: string }>(
    `select status from bakery.tasks where organization_id = $1 and id = $2`,
    [ctx.organizationId, taskId],
  );
  return rows[0]!.status;
}

/** Distinct sessions per model-backed step, and the cycle rows' provenance. */
async function assertProvenance(
  ctx: ScenarioContext,
  runId: string,
  implementing: readonly string[],
): Promise<void> {
  const sessions = await readSessions(ctx, runId);
  const ids = [...sessions.values()];
  assertEquals(new Set(ids).size, ids.length, "every step has its own session");
  const cycles = await readCycles(ctx, runId);
  const principal = await hostPrincipal(ctx, ctx.worker.workerHostId);
  cycles.forEach((cycle, ordinal) => {
    assertEquals(cycle.reviewer_session_id, sessions.get(`review@${ordinal}`));
    assertEquals(
      cycle.implementer_session_id,
      sessions.get(implementing[ordinal]),
    );
    assertNotEquals(cycle.reviewer_session_id, cycle.implementer_session_id);
    // The substitute is one host, so reviewer and implementer share a
    // principal. That is allowed; what the server records is both.
    assertEquals(cycle.reviewer_principal_id, principal);
    assertEquals(cycle.implementer_principal_id, principal);
  });
}

async function mergeRefusal(
  ctx: ScenarioContext,
  runId: string,
): Promise<readonly string[]> {
  const appPg = openPgDatabase(appDatabaseUrl(ctx.stack));
  try {
    try {
      await withPgTransaction(
        appPg,
        (transaction) =>
          assertDeliveryCandidateMergeable(transaction, {
            organizationId: ctx.organizationId,
            runId,
          }),
      );
    } catch (error) {
      assert(error instanceof StandardError, String(error));
      assertEquals(error.code, "STATE_CONFLICT");
      assertEquals(error.params?.reason, "delivery_candidate_blocked");
      return error.params?.blockedReasons as string[];
    }
  } finally {
    await closePgDatabase(appPg);
  }
  throw new Error("the delivery gate let a blocked candidate through");
}

/**
 * Scenario A. C1 fails the required `unit` check, the first review is clean,
 * so the decision is repair with the failed check run as evidence; the repair
 * reaches C2, the checks pass and the second review is clean.
 */
export async function repairThenProceed(ctx: ScenarioContext) {
  const { commits } = ctx.repository;
  const run = await startLoopRun(ctx.clients, ctx.repository, {
    title: "Scenario A: failing check, repair, clean",
  });
  ctx.progress(`A run ${run.runId} started`);
  const script: LoopScript = {
    baseSha: commits.base,
    implementHead: commits.broken,
    repairHeads: [commits.fixed],
    reviews: [{ findings: [] }, { findings: [] }],
  };
  const observed = await driveRun(ctx, run, script);
  const status = await waitForTerminal(ctx, run.runId);
  ctx.progress(`A run ${status}`);
  assertEquals(status, "completed");
  assertEquals(await taskStatus(ctx, run.taskId), "completed");

  assertEquals(jobsOf(observed), [
    "implement@0:harness.implement",
    "review@0:review.independent",
    "repair@1:harness.repair",
    "review@1:review.independent",
  ]);
  const steps = await readSteps(ctx, run.runId);
  assertEquals(
    steps.map((step) => `${stepName(step)}:${step.status}`),
    [
      "brief@0:completed",
      "implement@0:completed",
      "check@0:completed",
      "review@0:completed",
      "repair@1:completed",
      "check@1:completed",
      "review@1:completed",
    ],
  );
  const stepId = (name: string) =>
    steps.find((step) => stepName(step) === name)!.id;

  // The checks ran for real, once per iteration, against the real commits.
  const checks = await readChecks(ctx, run.runId);
  await assertChecksRanOnProductionHost(ctx, run.runId);
  const first = rowsOf(checks, stepId("check@0"));
  const second = rowsOf(checks, stepId("check@1"));
  const outcome = (rows: readonly CheckRow[]) =>
    Object.fromEntries(
      rows.map((row) => [row.check_id, `${row.result}/${row.reason}`]),
    );
  assertEquals(outcome(first), {
    unit: "failed/exit_nonzero",
    lint: "passed/verified",
  });
  assertEquals(outcome(second), {
    unit: "passed/verified",
    lint: "passed/verified",
  });
  assert(first.every((row) => row.head_sha === commits.broken));
  assert(second.every((row) => row.head_sha === commits.fixed));
  const failedUnit = first.find((row) => row.check_id === "unit")!;
  assertEquals(failedUnit.exit_code, 3);
  const checkOutputs = steps.filter((step) => step.step_key === "check");
  assertEquals(checkOutputs[0].output?.allRequired, false);
  assertEquals(checkOutputs[0].output?.failedCheckIds, [failedUnit.id]);
  assertEquals(checkOutputs[1].output?.allRequired, true);
  assertEquals(checkOutputs[1].output?.failedCheckIds, []);

  // The reviewer saw the candidate and the check rows of its own iteration.
  const [implement, review0, repair1, review1] = observed;
  assertEquals(review0.input.revision, commits.broken);
  assertEquals(
    [...strings(review0.input.evidence)].sort(),
    first.map(({ id }) => id).sort(),
  );
  // The repair is handed the failed check run as evidence, and no finding.
  assertEquals(repair1.input.revision, commits.broken);
  assertEquals(repair1.input.findings, []);
  assertEquals(repair1.input.failedChecks, [{
    checkRunId: failedUnit.id,
    checkId: "unit",
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 3,
  }]);
  assertEquals(review1.input.revision, commits.fixed);
  assertEquals(
    [...strings(review1.input.evidence)].sort(),
    second.map(({ id }) => id).sort(),
  );
  assertNotEquals(implement.agentSessionId, repair1.agentSessionId);

  // Two cycles, two decisions: repair with the failed check, then proceed.
  const cycles = await readCycles(ctx, run.runId);
  assertEquals(cycles.map((cycle) => cycle.ordinal), [0, 1]);
  assertEquals(cycles.map((cycle) => cycle.head_sha), [
    commits.broken,
    commits.fixed,
  ]);
  assert(cycles.every((cycle) => cycle.base_sha === commits.base));
  assertEquals(cycles.map((cycle) => cycle.status), ["approved", "approved"]);
  assertEquals(
    cycles.map((cycle) => [cycle.finding_count, cycle.blocking_count]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assertEquals(cycles.map((cycle) => cycle.run_step_id), [
    stepId("review@0"),
    stepId("review@1"),
  ]);
  await assertProvenance(ctx, run.runId, ["implement@0", "repair@1"]);
  const decisions = await readDecisions(ctx, run.runId);
  assertEquals(
    decisions.map(({ ordinal, decision, reason, head_sha }) => [
      ordinal,
      decision,
      reason,
      head_sha,
    ]),
    [
      [0, "repair", "repair_selected", commits.broken],
      [1, "proceed", "clean", commits.fixed],
    ],
  );
  assertEquals(decisions[0].failed_checks, [{
    checkRunId: failedUnit.id,
    checkId: "unit",
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 3,
  }]);
  assertEquals(decisions[1].failed_checks, []);
  assertEquals(decisions.map((row) => row.review_cycle_id), [
    cycles[0].id,
    cycles[1].id,
  ]);
  assertEquals(decisions.map((row) => row.blocking_fingerprints), [[], []]);
  // The bounds the loop ran under were frozen into the run at admission.
  assertEquals(decisions.map((row) => row.limits), [LIMITS, LIMITS]);

  // The gate: the repaired candidate is the one the second decision judged.
  const gate = await readGate(ctx, run.runId);
  assertEquals([gate.mergeBlocked, gate.reasons], [false, []]);
  assertEquals(gate.candidate, { headSha: commits.fixed });
  assertEquals(gate.checks?.blocked, false);
  assertEquals(gate.review?.status, "approved");
  assertEquals(gate.decision?.decision, "proceed");

  // The three list operations over HTTP, one row per page.
  const reviews = await readAll(ctx, `/v1/runs/${run.runId}/reviews`);
  assertEquals(reviews.pages >= 2, true);
  assertEquals(reviews.items.map((item) => item.ordinal), [0, 1]);
  assertEquals(reviews.items.map((item) => item.status), [
    "approved",
    "approved",
  ]);
  assertEquals(reviews.items.map((item) => item.headSha), [
    commits.broken,
    commits.fixed,
  ]);
  const listed = await readAll(
    ctx,
    `/v1/runs/${run.runId}/delivery-decisions`,
  );
  assertEquals(
    listed.items.map((item) => [item.ordinal, item.decision, item.reason]),
    [[0, "repair", "repair_selected"], [1, "proceed", "clean"]],
  );
  assertEquals(
    (listed.items[0].failedChecks as Item[]).map((check) => check.checkRunId),
    [failedUnit.id],
  );
  assertEquals(
    (await readAll(ctx, `/v1/reviews/${cycles[0].id}/findings`)).items,
    [],
  );
  return {
    scenario: "A repair then proceed",
    runId: run.runId,
    status,
    steps: steps.map((step) => `${stepName(step)}:${step.status}`),
    checks: { first: outcome(first), second: outcome(second) },
    cycles: cycles.map((cycle) => `${cycle.ordinal}:${cycle.status}`),
    decisions: decisions.map((row) =>
      `${row.ordinal}:${row.decision}/${row.reason}`
    ),
    failedCheckRunInDecision: decisions[0].failed_checks[0].checkRunId,
    gate: { mergeBlocked: gate.mergeBlocked, reasons: gate.reasons },
  };
}

/** Scenario B. A clean first candidate yields no repair and a proceed. */
export async function cleanSeed(ctx: ScenarioContext) {
  const { commits } = ctx.repository;
  const run = await startLoopRun(ctx.clients, ctx.repository, {
    title: "Scenario B: clean candidate",
  });
  ctx.progress(`B run ${run.runId} started`);
  const observed = await driveRun(ctx, run, {
    baseSha: commits.base,
    implementHead: commits.fixed,
    repairHeads: [],
    reviews: [{ findings: [] }],
  });
  const status = await waitForTerminal(ctx, run.runId);
  ctx.progress(`B run ${status}`);
  assertEquals(status, "completed");
  assertEquals(await taskStatus(ctx, run.taskId), "completed");
  assertEquals(jobsOf(observed), [
    "implement@0:harness.implement",
    "review@0:review.independent",
  ]);
  const steps = await readSteps(ctx, run.runId);
  assertEquals(
    steps.map((step) => `${stepName(step)}:${step.status}`),
    [
      "brief@0:completed",
      "implement@0:completed",
      "check@0:completed",
      "review@0:completed",
    ],
  );
  // Zero repair rows: the on-demand step was never created.
  assertEquals(steps.filter((step) => step.step_key === "repair").length, 0);
  const checks = await readChecks(ctx, run.runId);
  await assertChecksRanOnProductionHost(ctx, run.runId);
  assertEquals(checks.length, 2);
  assert(checks.every((row) => row.result === "passed"));
  assert(checks.every((row) => row.head_sha === commits.fixed));
  const check = steps.find((step) => step.step_key === "check")!;
  assertEquals(check.output?.allRequired, true);
  const cycles = await readCycles(ctx, run.runId);
  assertEquals(cycles.map((cycle) => [cycle.ordinal, cycle.status]), [
    [0, "approved"],
  ]);
  await assertProvenance(ctx, run.runId, ["implement@0"]);
  const decisions = await readDecisions(ctx, run.runId);
  assertEquals(
    decisions.map(({ ordinal, decision, reason }) => [
      ordinal,
      decision,
      reason,
    ]),
    [[0, "proceed", "clean"]],
  );
  // The seed evidence is still what the gate reads: the same two rows.
  const gate = await readGate(ctx, run.runId);
  assertEquals([gate.mergeBlocked, gate.reasons], [false, []]);
  assertEquals(
    gate.checks?.evaluations.map((evaluation) => evaluation.rowId).sort(),
    checks.map(({ id }) => id).sort(),
  );
  assertEquals(
    (await readAll(ctx, `/v1/runs/${run.runId}/reviews`)).items.length,
    1,
  );
  return {
    scenario: "B clean seed",
    runId: run.runId,
    status,
    steps: steps.map((step) => `${stepName(step)}:${step.status}`),
    repairRows: 0,
    cycles: cycles.map((cycle) => `${cycle.ordinal}:${cycle.status}`),
    decisions: decisions.map((row) =>
      `${row.ordinal}:${row.decision}/${row.reason}`
    ),
    gate: { mergeBlocked: gate.mergeBlocked, reasons: gate.reasons },
  };
}

/**
 * Scenario C. The checks pass, but the reviewer reports the same blocking
 * finding in two consecutive cycles (the line moved, the issue did not), so the
 * loop stops instead of repairing again.
 */
export async function repeatedBlocker(ctx: ScenarioContext) {
  const { commits } = ctx.repository;
  const run = await startLoopRun(ctx.clients, ctx.repository, {
    title: "Scenario C: repeated blocker",
  });
  ctx.progress(`C run ${run.runId} started`);
  const observed = await driveRun(ctx, run, {
    baseSha: commits.base,
    implementHead: commits.fixed,
    repairHeads: [commits.followUp],
    reviews: [
      { findings: [BLOCKER] },
      { findings: [{ ...BLOCKER, line: 2 }] },
    ],
  });
  const status = await waitForTerminal(ctx, run.runId);
  ctx.progress(`C run ${status}`);
  assertEquals(status, "failed");
  assertEquals(await taskStatus(ctx, run.taskId), "failed");
  assertEquals(jobsOf(observed), [
    "implement@0:harness.implement",
    "review@0:review.independent",
    "repair@1:harness.repair",
    "review@1:review.independent",
  ]);
  const fingerprint = await findingFingerprint({
    path: BLOCKER.path,
    category: BLOCKER.category,
    title: BLOCKER.title,
  });

  const steps = await readSteps(ctx, run.runId);
  assertEquals(
    steps.map((step) => `${stepName(step)}:${step.status}`),
    [
      "brief@0:completed",
      "implement@0:completed",
      "check@0:completed",
      "review@0:completed",
      "repair@1:completed",
      "check@1:completed",
      "review@1:completed",
      `${DELIVERY_GATE_STEP_KEY}@1:failed`,
    ],
  );
  const decisions = await readDecisions(ctx, run.runId);
  assertEquals(
    decisions.map(({ ordinal, decision, reason }) => [
      ordinal,
      decision,
      reason,
    ]),
    [[0, "repair", "repair_selected"], [1, "stop", "repeated_blocker"]],
  );
  assertEquals(decisions.map((row) => row.blocking_fingerprints), [
    [fingerprint],
    [fingerprint],
  ]);
  const gateStep = steps.at(-1)!;
  assertEquals(gateStep.error, {
    code: DELIVERY_LOOP_STOPPED_CODE,
    reason: "repeated_blocker",
    decisionId: decisions[1].id,
  });

  // The repair was handed the blocker, not a failed check (the checks passed).
  const repair = observed[2];
  assertEquals(repair.input.revision, commits.fixed);
  assertEquals(repair.input.failedChecks, []);
  assertEquals(
    (repair.input.findings as Item[]).map((finding) => finding.fingerprint),
    [fingerprint],
  );

  const cycles = await readCycles(ctx, run.runId);
  assertEquals(cycles.map((cycle) => [cycle.status, cycle.blocking_count]), [
    ["changes_requested", 1],
    ["changes_requested", 1],
  ]);
  assertEquals(cycles.map((cycle) => cycle.head_sha), [
    commits.fixed,
    commits.followUp,
  ]);
  await assertProvenance(ctx, run.runId, ["implement@0", "repair@1"]);
  await assertChecksRanOnProductionHost(ctx, run.runId);

  // Nothing approved the candidate: no approved cycle, no proceed decision,
  // and the gate refuses it with the stop reason.
  const approved = await ctx.stack.psql<{ count: string }>(
    `select count(*)::text as count from bakery.review_cycles
      where organization_id = $1 and run_id = $2 and status = 'approved'`,
    [ctx.organizationId, run.runId],
  );
  assertEquals(approved[0].count, "0");
  assert(decisions.every((row) => row.decision !== "proceed"));
  const gate = await readGate(ctx, run.runId);
  assertEquals(gate.mergeBlocked, true);
  assertEquals(gate.reasons, ["decision_stop:repeated_blocker"]);
  assertEquals(await mergeRefusal(ctx, run.runId), [
    "decision_stop:repeated_blocker",
  ]);

  // The findings are readable, and the earlier one is still open because the
  // later cycle repeats it.
  const first = await readAll(ctx, `/v1/reviews/${cycles[0].id}/findings`);
  const second = await readAll(ctx, `/v1/reviews/${cycles[1].id}/findings`);
  assertEquals(first.items.map((item) => [item.fingerprint, item.status]), [
    [fingerprint, "open"],
  ]);
  assertEquals(second.items.map((item) => [item.fingerprint, item.status]), [
    [fingerprint, "open"],
  ]);
  assertEquals(second.items[0].line, 2);
  const listed = await readAll(
    ctx,
    `/v1/runs/${run.runId}/delivery-decisions`,
  );
  assertEquals(
    listed.items.map((item) => [item.decision, item.reason]),
    [["repair", "repair_selected"], ["stop", "repeated_blocker"]],
  );
  return {
    scenario: "C repeated blocker",
    runId: run.runId,
    status,
    steps: steps.map((step) => `${stepName(step)}:${step.status}`),
    cycles: cycles.map((cycle) => `${cycle.ordinal}:${cycle.status}`),
    decisions: decisions.map((row) =>
      `${row.ordinal}:${row.decision}/${row.reason}`
    ),
    deliveryGateError: gateStep.error,
    gate: { mergeBlocked: gate.mergeBlocked, reasons: gate.reasons },
    approvedCycles: Number(approved[0].count),
  };
}

/** Scenario D. A reviewer that fails for good stops the run with a decision. */
export async function reviewerUnavailable(ctx: ScenarioContext) {
  const { commits } = ctx.repository;
  const run = await startLoopRun(ctx.clients, ctx.repository, {
    title: "Scenario D: reviewer unavailable",
  });
  ctx.progress(`D run ${run.runId} started`);
  const observed = await driveRun(ctx, run, {
    baseSha: commits.base,
    implementHead: commits.fixed,
    repairHeads: [],
    reviews: [{ fault: { code: "REVIEWER_UNAVAILABLE", retryable: false } }],
  });
  const status = await waitForTerminal(ctx, run.runId);
  ctx.progress(`D run ${status}`);
  assertEquals(status, "failed");
  assertEquals(jobsOf(observed), [
    "implement@0:harness.implement",
    "review@0:review.independent",
  ]);
  const steps = await readSteps(ctx, run.runId);
  assertEquals(
    steps.map((step) => `${stepName(step)}:${step.status}`),
    [
      "brief@0:completed",
      "implement@0:completed",
      "check@0:completed",
      "review@0:failed",
      `${DELIVERY_GATE_STEP_KEY}@0:failed`,
    ],
  );
  await assertChecksRanOnProductionHost(ctx, run.runId);
  // No review ran, so there is no cycle and no finding; the stop is a decision.
  assertEquals((await readCycles(ctx, run.runId)).length, 0);
  const decisions = await readDecisions(ctx, run.runId);
  assertEquals(
    decisions.map((
      { ordinal, decision, reason, review_cycle_id, head_sha },
    ) => [
      ordinal,
      decision,
      reason,
      review_cycle_id,
      head_sha,
    ]),
    [[0, "stop", "reviewer_unavailable", null, commits.fixed]],
  );
  assertEquals(steps.at(-1)!.error, {
    code: DELIVERY_LOOP_STOPPED_CODE,
    reason: "reviewer_unavailable",
    decisionId: decisions[0].id,
  });
  const gate = await readGate(ctx, run.runId);
  assertEquals(gate.mergeBlocked, true);
  assertEquals(gate.reasons, ["decision_stop:reviewer_unavailable"]);
  assertEquals(
    (await readAll(ctx, `/v1/runs/${run.runId}/reviews`)).items.length,
    0,
  );
  return {
    scenario: "D reviewer unavailable",
    runId: run.runId,
    status,
    steps: steps.map((step) => `${stepName(step)}:${step.status}`),
    decisions: decisions.map((row) =>
      `${row.ordinal}:${row.decision}/${row.reason}`
    ),
    gate: { mergeBlocked: gate.mergeBlocked, reasons: gate.reasons },
  };
}
