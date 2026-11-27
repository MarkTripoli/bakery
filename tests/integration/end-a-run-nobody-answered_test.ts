import { assert, assertEquals } from "@std/assert";
import { createPeopleTagStepRunner } from "../../apps/server/src/modules/work/people-tag-step.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { composeEngineStepRunners } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { noop, type Step, workflow } from "../helpers/workflow-interpreter.ts";

async function planOf(steps: Step[]) {
  const result = await compileWorkflowDocument(
    workflow(steps, { version: { type: "uuid", required: true } }),
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.document;
}

const review = (onExpiry?: "stop" | "continue"): Step => ({
  id: "notify",
  uses: "people.tag",
  needs: ["first"],
  with: {
    intent: "review",
    recipientRunRole: "starter",
    artifactVersionId: "$input.version",
    wait: true,
    ...(onExpiry === undefined ? {} : { onExpiry }),
  },
});

async function atTheReview(fixture: WorkerFixture, notify: Step) {
  const version = crypto.randomUUID();
  const seeded = await seedPlanRun(
    fixture,
    await planOf([noop("first"), notify, noop("after", { needs: ["notify"] })]),
    { inputs: { version } },
  );
  await setRow(fixture, seeded, seeded.firstKey, "completed", {});
  const artifactId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, 'document', $4)`,
    [
      artifactId,
      fixture.organizationId,
      seeded.job.taskId,
      `doc-${artifactId}`,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions (
       id, organization_id, artifact_id, task_id, author_id, revision, content,
       sha256, size_bytes, media_type, run_step_id)
     select $1, $2, $3, $4, $5, 1, 'hi'::bytea, $6, 2, 'text/plain', step.id
       from bakery.run_steps step
      where step.run_id = $7 and step.step_key = 'first'`,
    [
      version,
      fixture.organizationId,
      artifactId,
      seeded.job.taskId,
      fixture.principalId,
      "0".repeat(64),
      seeded.job.runId,
    ],
  );
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
    engineSteps: composeEngineStepRunners([
      createPeopleTagStepRunner({ database: fixture.pgDatabase }),
    ]),
  });
  return { seeded, repository };
}

async function askedThenExpired(
  fixture: WorkerFixture,
  at: Awaited<ReturnType<typeof atTheReview>>,
) {
  const { seeded, repository } = at;
  const key = await repository.findNext(seeded.job.runId, seeded.owner);
  assert(key !== undefined);
  assertEquals(key.stepKey, "notify");
  assertEquals(await repository.admit(key, seeded.owner), {
    key,
    terminal: false,
  });
  await fixture.pgDatabase.query(
    `update bakery.person_requests set expires_at = now() - interval '1 minute'
      where organization_id = $1 and run_id = $2`,
    [fixture.organizationId, seeded.job.runId],
  );
  await fixture.pgDatabase.query(
    `update bakery.run_steps set dispatch = dispatch - 'stepRetryAt'
      where run_id = $1 and step_key = 'notify'`,
    [seeded.job.runId],
  );
  await repository.admit(key, seeded.owner);
  return await repository.findNext(seeded.job.runId, seeded.owner);
}

const stateOf = async (fixture: WorkerFixture, runId: string) => {
  const run = (await fixture.pgDatabase.query<{
    run: string;
    task: string;
  }>(
    `select run.status as run, task.status as task
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
      where run.id = $1`,
    [runId],
  )).rows[0];
  const steps = (await fixture.pgDatabase.query<{
    key: string;
    status: string;
    output: unknown;
  }>(
    `select step_key as key, status, output from bakery.run_steps
      where run_id = $1 order by position, id`,
    [runId],
  )).rows;
  const requests = (await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.person_requests where run_id = $1`,
    [runId],
  )).rows.map((row) => row.status);
  return { ...run, steps, requests };
};

Deno.test("a review nobody answers by its expiry ends the run needs_human, and nothing is approved", () =>
  withWorkerFixture(async (fixture) => {
    const at = await atTheReview(fixture, review());
    assertEquals(await askedThenExpired(fixture, at), undefined);
    const state = await stateOf(fixture, at.seeded.job.runId);
    assertEquals(state.run, "needs_human");
    assertEquals(state.task, "waiting_input");
    assertEquals(state.requests, ["expired"]);
    assertEquals(
      state.steps.map((step) => [step.key, step.status]),
      [["first", "completed"], ["notify", "needs_human"]],
    );
    assertEquals(state.steps[1]!.output, { outcome: "expired", asked: 1 });
    const approvals = await fixture.pgDatabase.query(
      `select 1 from bakery.decisions_ledger
        where run_id = $1 and kind not like 'request%'`,
      [at.seeded.job.runId],
    );
    assertEquals(approvals.rows.length, 0);
  }));

Deno.test("a review that says stop on expiry ends the same way as one that says nothing", () =>
  withWorkerFixture(async (fixture) => {
    const at = await atTheReview(fixture, review("stop"));
    assertEquals(await askedThenExpired(fixture, at), undefined);
    assertEquals(
      (await stateOf(fixture, at.seeded.job.runId)).run,
      "needs_human",
    );
  }));

Deno.test("a review that continues on expiry completes expired and the run goes on to the next step", () =>
  withWorkerFixture(async (fixture) => {
    const at = await atTheReview(fixture, review("continue"));
    const next = await askedThenExpired(fixture, at);
    assertEquals(next?.stepKey, "after");
    const state = await stateOf(fixture, at.seeded.job.runId);
    assertEquals(state.run, "running");
    assertEquals(state.requests, ["expired"]);
    const notify = state.steps.find((step) => step.key === "notify");
    assertEquals(notify?.status, "completed");
    assertEquals(notify?.output, { outcome: "expired", asked: 1 });
  }));
