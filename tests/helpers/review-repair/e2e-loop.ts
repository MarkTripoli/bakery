import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { ownedSystemdUnitOutput } from "../owned-process-group.ts";
import {
  type DeliveryCandidateEvaluation,
  evaluateDeliveryCandidate,
} from "../../../apps/server/src/modules/delivery/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import type { ReviewerFinding } from "../../../apps/worker/src/review-report.ts";
import type { DurableCoreStack } from "../durable-core/stack.ts";
import {
  assertWorkerRunning,
  type PresetWorkerHandle,
  until,
} from "../durable-core/preset-stack.ts";
import { appDatabaseUrl } from "../deterministic-checks/e2e-world.ts";
import {
  LOOP_ACTIONS,
  reviewReportFor,
  type StartedLoopRun,
  SubstituteWorker,
  TERMINAL_STATUSES,
} from "./e2e-world.ts";

/**
 * Drives one reviewed run to a terminal status with the substitute worker and
 * reads back what the server recorded. The script says what the model-backed
 * jobs report: the commit the implement step produced, the commit each repair
 * produces and what each review finds. The production worker runs the checks.
 */

export type ReviewVerdict =
  | { readonly findings: readonly ReviewerFinding[] }
  | { readonly fault: { code: string; retryable: boolean } };

export type LoopScript = {
  /** Commit the implement step reports as its head. */
  readonly implementHead: string;
  /** Commit each successive repair reports, in order. */
  readonly repairHeads: readonly string[];
  /** What each successive review reports, in order. */
  readonly reviews: readonly ReviewVerdict[];
  /** Base the harness steps report; the profile's inspected snapshot. */
  readonly baseSha: string;
};

/** What a substituted job was handed and what the substitute answered. */
export type JobObservation = {
  readonly action: string;
  readonly stepKey: string;
  readonly iteration: number;
  readonly jobId: string;
  readonly attemptId: string;
  readonly agentSessionId: string;
  readonly input: Record<string, unknown>;
  readonly answered: number;
};

export type World = {
  readonly stack: DurableCoreStack;
  readonly organizationId: string;
  readonly worker: SubstituteWorker;
  readonly production: PresetWorkerHandle;
};

type StepRow = {
  id: string;
  step_key: string;
  position: number;
  iteration: number;
  status: string;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
};

/** Steps of a run in the order the engine takes them. */
export async function readSteps(
  world: World,
  runId: string,
): Promise<StepRow[]> {
  return await world.stack.psql<StepRow>(
    `select id, step_key, position, iteration, status, output, error
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
      order by position, iteration, id`,
    [world.organizationId, runId],
  );
}

export const stepName = (step: Pick<StepRow, "step_key" | "iteration">) =>
  `${step.step_key}@${step.iteration}`;

async function runStatus(world: World, runId: string): Promise<string> {
  const rows = await world.stack.psql<{ status: string }>(
    `select status from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [world.organizationId, runId],
  );
  return rows[0]!.status;
}

async function diagnostics(world: World, runId: string): Promise<string> {
  const steps = await world.stack.psql(
    `select step.step_key, step.iteration, step.status, step.error,
            job.status as job_status, job.action, job.requirements
       from bakery.run_steps step
       left join bakery.jobs job
         on job.organization_id = step.organization_id
        and job.run_step_id = step.id
      where step.organization_id = $1 and step.run_id = $2
      order by step.position, step.iteration`,
    [world.organizationId, runId],
  );
  const hosts = await world.stack.psql(
    `select name, capabilities, status from bakery.worker_hosts
      where organization_id = $1`,
    [world.organizationId],
  );
  return `${JSON.stringify({ steps, hosts })}\n${
    ownedSystemdUnitOutput(world.production.unit).slice(-3000)
  }`;
}

async function stepOfJob(
  world: World,
  jobId: string,
): Promise<{ stepKey: string; iteration: number }> {
  const rows = await world.stack.psql<
    { step_key: string; iteration: number }
  >(
    `select step.step_key, step.iteration
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
      where job.organization_id = $1 and job.id = $2`,
    [world.organizationId, jobId],
  );
  assert(rows[0], `job ${jobId} has no step`);
  return { stepKey: rows[0].step_key, iteration: rows[0].iteration };
}

const RUN_TIMEOUT_MS = 240_000;
const POLL_MS = 250;

/**
 * Claims and answers the run's model-backed jobs until the run is terminal.
 * Returns what each substituted job was handed, in the order they ran. Any
 * answer the server does not accept with 200 fails the proof, except where the
 * script's review verdict is a fault (that answer is accepted too).
 */
export async function driveRun(
  world: World,
  run: StartedLoopRun,
  script: LoopScript,
): Promise<JobObservation[]> {
  const observed: JobObservation[] = [];
  let repairs = 0;
  let reviews = 0;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  try {
    for (;;) {
      const assignment = await world.worker.claim(LOOP_ACTIONS);
      if (assignment === null) {
        if (TERMINAL_STATUSES.includes(await runStatus(world, run.runId))) {
          return observed;
        }
        if (Date.now() > deadline) {
          throw new Error("REVIEW_LOOP_E2E_RUN_TIMEOUT");
        }
        await assertWorkerRunning(world.production);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      const { stepKey, iteration } = await stepOfJob(world, assignment.jobId);
      assert(assignment.agentSessionId, `${stepKey} has no server session`);
      let response: Response;
      switch (assignment.action) {
        case "harness.implement":
          response = await world.worker.result(assignment, {
            status: "completed",
            result: {
              headSha: script.implementHead,
              baseSha: script.baseSha,
              sessionId: assignment.agentSessionId,
              artifacts: [],
            },
          });
          break;
        case "harness.repair": {
          const headSha = script.repairHeads[repairs++];
          assert(headSha, "the script has no commit for this repair");
          response = await world.worker.result(assignment, {
            status: "completed",
            result: {
              headSha,
              baseSha: script.baseSha,
              sessionId: assignment.agentSessionId,
              artifacts: [],
            },
          });
          break;
        }
        case "review.independent": {
          const verdict = script.reviews[reviews++];
          assert(verdict, "the script has no verdict for this review");
          response = "fault" in verdict
            ? await world.worker.result(assignment, {
              status: "failed",
              fault: SubstituteWorker.fault(
                verdict.fault.code,
                verdict.fault.retryable,
              ),
            })
            : await world.worker.result(assignment, {
              status: "completed",
              result: await reviewReportFor(assignment, verdict.findings),
            });
          break;
        }
        default:
          throw new Error(
            `REVIEW_LOOP_E2E_UNEXPECTED_ACTION:${assignment.action}`,
          );
      }
      const answered = response.status;
      const text = await response.text();
      assertEquals(
        answered,
        200,
        `${stepKey}@${iteration} ${assignment.action}: ${text}`,
      );
      observed.push({
        action: assignment.action,
        stepKey,
        iteration,
        jobId: assignment.jobId,
        attemptId: assignment.attemptId,
        agentSessionId: assignment.agentSessionId,
        input: assignment.input,
        answered,
      });
    }
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n${await diagnostics(world, run.runId)}`,
    );
  }
}

/** Waits until the run is terminal and its steps stop changing. */
export async function waitForTerminal(
  world: World,
  runId: string,
): Promise<string> {
  const status = await until(`run ${runId} terminal`, 60_000, async () => {
    const current = await runStatus(world, runId);
    return TERMINAL_STATUSES.includes(current) ? current : undefined;
  }, () => assertWorkerRunning(world.production));
  return status;
}

export type CycleRow = {
  id: string;
  ordinal: number;
  run_step_id: string;
  job_id: string | null;
  reviewer_session_id: string;
  reviewer_principal_id: string;
  implementer_session_id: string;
  implementer_principal_id: string;
  head_sha: string;
  base_sha: string;
  policy_digest: string;
  status: string;
  finding_count: number;
  blocking_count: number;
};

export type DecisionRow = {
  id: string;
  ordinal: number;
  review_cycle_id: string | null;
  decision: string;
  reason: string;
  head_sha: string;
  failed_checks: Array<Record<string, unknown>>;
  blocking_fingerprints: string[];
  limits: Record<string, number>;
};

export type CheckRow = {
  id: string;
  run_step_id: string | null;
  check_id: string;
  result: string;
  reason: string;
  exit_code: number | null;
  head_sha: string;
  output_digest: string | null;
};

export async function readCycles(
  world: World,
  runId: string,
): Promise<CycleRow[]> {
  return await world.stack.psql<CycleRow>(
    `select id, ordinal, run_step_id, job_id, reviewer_session_id,
            reviewer_principal_id, implementer_session_id,
            implementer_principal_id, head_sha, base_sha, policy_digest,
            status, finding_count, blocking_count
       from bakery.review_cycles
      where organization_id = $1 and run_id = $2 order by ordinal`,
    [world.organizationId, runId],
  );
}

export async function readDecisions(
  world: World,
  runId: string,
): Promise<DecisionRow[]> {
  return await world.stack.psql<DecisionRow>(
    `select id, ordinal, review_cycle_id, decision, reason, head_sha,
            failed_checks, blocking_fingerprints, limits
       from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2 order by ordinal`,
    [world.organizationId, runId],
  );
}

export async function readChecks(
  world: World,
  runId: string,
): Promise<CheckRow[]> {
  return await world.stack.psql<CheckRow>(
    `select id, run_step_id, check_id, result, reason, exit_code, head_sha,
            output_digest
       from bakery.check_runs
      where organization_id = $1 and run_id = $2
      order by created_at, id`,
    [world.organizationId, runId],
  );
}

export async function readSessions(
  world: World,
  runId: string,
): Promise<Map<string, string>> {
  const rows = await world.stack.psql<
    { id: string; step_key: string; iteration: number }
  >(
    `select session.id, step.step_key, step.iteration
       from bakery.agent_sessions session
       join bakery.run_steps step
         on step.organization_id = session.organization_id
        and step.id = session.run_step_id
      where step.organization_id = $1 and step.run_id = $2`,
    [world.organizationId, runId],
  );
  return new Map(rows.map((row) => [stepName(row), row.id]));
}

/** The delivery gate as a merge consumer reads it, with the application role. */
export async function readGate(
  world: World,
  runId: string,
): Promise<DeliveryCandidateEvaluation> {
  const appPg = openPgDatabase(appDatabaseUrl(world.stack));
  try {
    return await withPgTransaction(
      appPg,
      (transaction) =>
        evaluateDeliveryCandidate(transaction, {
          organizationId: world.organizationId,
          runId,
        }),
    );
  } finally {
    await closePgDatabase(appPg);
  }
}

/** Model-backed actions of the loop: only the substitute worker runs them. */
const SUBSTITUTED_ACTIONS = [
  "harness.implement",
  "harness.repair",
  "review.independent",
];

/**
 * Pins which host ran what. Every check row of the run names the attempt that
 * recorded it, and that attempt, like every `quality.check` and `task.brief`
 * attempt of the run, belongs to the production worker's host (the one
 * enrolled with git, shell and browser). No such attempt belongs to the
 * substitute, and every model-backed attempt belongs to the substitute and to
 * none of the production worker's. So a check row cannot come from the scripted
 * substitute, whatever it was told to report.
 */
export async function assertChecksRanOnProductionHost(
  world: World,
  runId: string,
): Promise<void> {
  const hosts = await world.stack.psql<
    { id: string; capabilities: string[] }
  >(
    `select id, capabilities from bakery.worker_hosts
      where organization_id = $1 and name = $2`,
    [world.organizationId, world.production.name],
  );
  assertEquals(hosts.length, 1, "the production worker host is not recorded");
  const production = hosts[0];
  assertEquals([...production.capabilities].sort(), [
    "browser",
    "git",
    "shell",
  ]);
  assertNotEquals(production.id, world.worker.workerHostId);

  // Every check row was recorded by an attempt of the production host.
  const rows = await world.stack.psql<
    { id: string; worker_host_id: string | null }
  >(
    `select check_run.id, attempt.worker_host_id
       from bakery.check_runs check_run
       left join bakery.job_attempts attempt
         on attempt.organization_id = check_run.organization_id
        and attempt.id = check_run.attempt_id
      where check_run.organization_id = $1 and check_run.run_id = $2
      order by check_run.created_at, check_run.id`,
    [world.organizationId, runId],
  );
  assert(rows.length > 0, "the run recorded no check rows");
  assertEquals(
    rows.filter((row) => row.worker_host_id !== production.id),
    [],
    "a check row was recorded by an attempt of another host",
  );

  // Every attempt of the run, by action, and the host that held it.
  const attempts = await world.stack.psql<
    { action: string; worker_host_id: string }
  >(
    `select job.action, attempt.worker_host_id
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
      where step.organization_id = $1 and step.run_id = $2`,
    [world.organizationId, runId],
  );
  const hostsOf = (actions: readonly string[]) =>
    new Set(
      attempts.filter(({ action }) => actions.includes(action))
        .map(({ worker_host_id }) => worker_host_id),
    );
  assertEquals(
    [...hostsOf(["quality.check", "task.brief"])],
    [production.id],
    "quality.check and task.brief run on the production host only",
  );
  assert(
    attempts.some(({ action }) => action === "quality.check"),
    "the run has no quality.check attempt",
  );
  assertEquals(
    [...hostsOf(SUBSTITUTED_ACTIONS)],
    [world.worker.workerHostId],
    "the model-backed actions run on the substitute host only",
  );
}

/** The principal of the host that owns `workerHostId`. */
export async function hostPrincipal(
  world: World,
  workerHostId: string,
): Promise<string> {
  const rows = await world.stack.psql<{ principal_id: string }>(
    `select principal_id from bakery.worker_hosts
      where organization_id = $1 and id = $2`,
    [world.organizationId, workerHostId],
  );
  assert(rows[0], "the substitute host is not recorded");
  return rows[0].principal_id;
}
