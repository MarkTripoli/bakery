import { assert } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  nextPlanStep,
  planRuntimeFromSnapshot,
} from "../../apps/server/src/modules/workflow-adapter/plan-state.ts";
import { pinWorkflowRuntime } from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import type { compiled } from "./workflow-interpreter.ts";
import { seedFundedModelJob } from "./funded-model-job.ts";
import type { WorkerFixture } from "./worker-execution.ts";

// Compiled-plan runs for the engine tests (#30 E3b-2): the funded fixture gives
// a run with one open row, and the plan is shaped so that row is its first
// dispatch.

export type Document = Awaited<ReturnType<typeof compiled>>;

export async function seedPlanRun(
  fixture: WorkerFixture,
  document: Document,
  options: { inputs?: Record<string, string | number | boolean> } = {},
) {
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const pin = await pinWorkflowRuntime(document);
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set status = 'running',
            snapshot = snapshot || jsonb_build_object(
              'inputs', $5::jsonb, 'task', '{}'::jsonb,
              'runtime', jsonb_build_object('pin', $3::jsonb, 'document', $4::jsonb))
      where organization_id = $1 and id = $2`,
    [
      fixture.organizationId,
      job.runId,
      JSON.stringify(pin),
      JSON.stringify(document),
      JSON.stringify(options.inputs ?? {}),
    ],
  );
  await fixture.pgDatabase.query(
    `update bakery.tasks set status = 'active' where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.taskId],
  );
  // The fixture's one open row becomes the plan's first step.
  const snapshot = (await fixture.pgDatabase.query<{ snapshot: unknown }>(
    `select snapshot from bakery.workflow_runs where id = $1`,
    [job.runId],
  )).rows[0].snapshot;
  const runtime = await planRuntimeFromSnapshot(snapshot);
  assert(runtime !== null);
  const first = nextPlanStep(runtime, {
    inputs: options.inputs ?? {},
    task: {},
    rows: [],
  });
  assert(first.kind === "dispatch");
  await fixture.pgDatabase.query(
    `update bakery.run_steps set step_key = $2 where run_id = $1`,
    [job.runId, first.step.key],
  );
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
  });
  const owner = await repository.acquireEngineOwner(
    job.runId,
    `e3b2a-${crypto.randomUUID()}`,
    60_000,
  );
  assert(owner !== undefined);
  const versionId = (await fixture.pgDatabase.query<{ id: string }>(
    `select workflow_version_id as id from bakery.workflow_runs where id = $1`,
    [job.runId],
  )).rows[0].id;
  return { job, repository, owner, firstKey: first.step.key, versionId };
}

export type Seeded = Awaited<ReturnType<typeof seedPlanRun>>;

export async function rows(fixture: WorkerFixture, seeded: Seeded) {
  return (await fixture.pgDatabase.query<
    { stepKey: string; status: string; position: number; input: unknown }
  >(
    `select step_key as "stepKey", status, position, input
       from bakery.run_steps where run_id = $1 order by position, id`,
    [seeded.job.runId],
  )).rows;
}

export async function state(fixture: WorkerFixture, seeded: Seeded) {
  const run = (await fixture.pgDatabase.query<
    { status: string; finishedAt: string | null; owner: string | null }
  >(
    `select status, finished_at::text as "finishedAt",
            engine_owner_token as owner
       from bakery.workflow_runs where id = $1`,
    [seeded.job.runId],
  )).rows[0];
  const task = (await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.tasks where id = $1`,
    [seeded.job.taskId],
  )).rows[0];
  return { run, task };
}

export const setRow = (
  fixture: WorkerFixture,
  seeded: Seeded,
  key: string,
  status: string,
  output: unknown = null,
) =>
  fixture.pgDatabase.query(
    `update bakery.run_steps
        set status = $3, output = $4::jsonb,
            finished_at = case when $3 in ('completed','failed','canceled') then now() else null end
      where run_id = $1 and step_key = $2`,
    [seeded.job.runId, key, status, JSON.stringify(output)],
  );

export const audit = async (fixture: WorkerFixture, seeded: Seeded) =>
  (await fixture.pgDatabase.query<{ code: string }>(
    `select details->>'code' as code from bakery.audit_events
      where resource_id = $1 and operation = 'workflow.plan_failed'`,
    [seeded.job.runId],
  )).rows.map((row) => row.code);
