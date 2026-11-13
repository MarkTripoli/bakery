import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { rows, seedPlanRun, setRow, state } from "../helpers/plan-run.ts";

// #30 E3b-2b. When findNext appends a plan step's row it records the dispatch
// it decided beside the row. The engine's admit builds the worker job from that
// recorded dispatch (action, resolved input, requirements, declared attempts),
// and so does every later revalidation, such as a worker's claim.

const gate = (extra: Record<string, unknown> = {}) => ({
  id: "gate",
  needs: ["first"],
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
  ...extra,
});

const planWith = (extra: Record<string, unknown> = {}) =>
  compiled([noop("first"), gate(extra)], {
    repo: { type: "uuid", required: true },
  });

async function seedGate(
  fixture: WorkerFixture,
  extra: Record<string, unknown> = {},
) {
  // The run's own repository, so the dispatch's repositoryId is the run's.
  const probe = await seedPlanRun(fixture, await planWith(extra), {
    inputs: { repo: "00000000-0000-4000-8000-0000000000a1" },
  });
  const repo = (await fixture.pgDatabase.query<{ repositoryId: string }>(
    `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
    [probe.job.runId],
  )).rows[0].repositoryId;
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
      where id = $1`,
    [probe.job.runId, repo],
  );
  await setRow(fixture, probe, probe.firstKey, "completed", {});
  const key = await probe.repository.findNext(probe.job.runId, probe.owner);
  assert(key !== undefined);
  assertEquals(key.stepKey, "gate");
  return { ...probe, key, repo };
}

/** The `reason` of the state conflict a refused admission throws. */
async function conflictReason(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof StandardError, "a StandardError");
    assertEquals(error.code, "STATE_CONFLICT");
    return (error.params as { reason?: unknown } | undefined)?.reason;
  }
  throw new Error("expected the admission to be refused");
}

const jobsOf = async (fixture: WorkerFixture, runId: string, stepKey: string) =>
  (await fixture.pgDatabase.query<{
    id: string;
    action: string;
    maxAttempts: number;
    status: string;
    input: Record<string, unknown>;
    agentVersionId: string | null;
    requirements: { capabilities?: string[] };
  }>(
    `select job.id, job.action, job.max_attempts as "maxAttempts", job.status,
            job.input, job.agent_version_id as "agentVersionId",
            job.requirements
       from bakery.jobs job
       join bakery.run_steps step on step.id = job.run_step_id
      where step.run_id = $1 and step.step_key = $2`,
    [runId, stepKey],
  )).rows;

Deno.test("admit builds the job from the step's dispatch: action, resolved input, requirements and declared attempts", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture, {
      retry: { maxAttempts: 2, backoff: "1s", on: [] },
    });
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    assertEquals(admission.terminal, false);
    assert(admission.jobId !== undefined);
    const jobs = await jobsOf(fixture, seeded.job.runId, "gate");
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].id, admission.jobId);
    assertEquals(jobs[0].action, "quality.check");
    assertEquals(jobs[0].maxAttempts, 2);
    assertEquals(jobs[0].status, "queued");
    assertEquals(jobs[0].agentVersionId, null);
    assertEquals(jobs[0].input.repositoryId, seeded.repo);
    assertEquals(jobs[0].input.revision, "abc");
    assertEquals(jobs[0].input.checks, ["fmt"]);
    assert(jobs[0].requirements.capabilities?.includes("git"));
    const gateRow = (await rows(fixture, seeded)).find((row) =>
      row.stepKey === "gate"
    );
    assertEquals(gateRow?.status, "running");
    assertEquals((await state(fixture, seeded)).run.status, "running");
  }));

Deno.test("a step with no declared retry gets one attempt, not the repository option's three", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    await seeded.repository.admit(seeded.key, seeded.owner);
    const jobs = await jobsOf(fixture, seeded.job.runId, "gate");
    assertEquals(jobs.map((job) => job.maxAttempts), [1]);
  }));

Deno.test("admitting the same plan step again finds its job and creates no second one", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    const first = await seeded.repository.admit(seeded.key, seeded.owner);
    const again = await seeded.repository.admit(seeded.key, seeded.owner);
    assertEquals(again.jobId, first.jobId);
    assertEquals((await jobsOf(fixture, seeded.job.runId, "gate")).length, 1);
  }));

Deno.test("a plan row with no recorded dispatch is refused, never given a job", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    await fixture.pgDatabase.query(
      `insert into bakery.run_steps (organization_id, run_id, step_key, position, iteration, status, input)
       select organization_id, run_id, 'ghost', 99, 0, 'pending', '{}'::jsonb
         from bakery.run_steps where run_id = $1 limit 1`,
      [seeded.job.runId],
    );
    assertEquals(
      await conflictReason(() =>
        seeded.repository.admit(
          { ...seeded.key, stepKey: "ghost" },
          seeded.owner,
        )
      ),
      "workflow_plan_dispatch_invalid",
    );
    assertEquals((await jobsOf(fixture, seeded.job.runId, "ghost")).length, 0);
  }));

Deno.test("a recorded dispatch that names an agent the run never froze is refused before any job exists", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set dispatch = jsonb_set(dispatch, '{agentVersionId}', '"abcdefab-cdef-4abc-8def-abcdefabcdef"'::jsonb)
        where run_id = $1 and step_key = 'gate'`,
      [seeded.job.runId],
    );
    await assertRejects(
      () => seeded.repository.admit(seeded.key, seeded.owner),
      Error,
      "FROZEN_STEP_AGENT_MISSING",
    );
    assertEquals((await jobsOf(fixture, seeded.job.runId, "gate")).length, 0);
  }));

Deno.test("admission reads the dispatch recorded with the row, not a recomputation from the plan", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture, {
      retry: { maxAttempts: 2, backoff: "1s", on: [] },
    });
    // The frozen document is edited after the engine decided the step; the
    // decision stands, so the job is still the one that was decided.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{runtime,document,name}', '"changed"'::jsonb)
        where id = $1`,
      [seeded.job.runId],
    );
    await seeded.repository.admit(seeded.key, seeded.owner);
    const jobs = await jobsOf(fixture, seeded.job.runId, "gate");
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].action, "quality.check");
    assertEquals(jobs[0].maxAttempts, 2);
  }));

Deno.test("a worker can claim the plan step's job: claim revalidation reads the recorded dispatch", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    // The fixture's first job is done; only the plan step's job is left.
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'completed'
        where run_step_id in (select id from bakery.run_steps where run_id = $1 and step_key <> 'gate')`,
      [seeded.job.runId],
    );
    const worker = await registeredWorker(fixture, { name: "e3b2b-claim" });
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, admission.jobId);
    assertEquals(assignment.action, "quality.check");
  }));
