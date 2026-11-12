import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

// #30 E3b-1. The worker result path leaves a pinned plan run open; the engine
// ends it when the interpreter says the plan is finished or halted. This is
// that end: the run, its task, their events and the engine owner, together.

type Outcome = "completed" | "failed" | "canceled";

async function seedRun(
  fixture: WorkerFixture,
  options: { plan: boolean },
) {
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  if (options.plan) {
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = snapshot || jsonb_build_object('runtime', '{}'::jsonb)
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.runId],
    );
  }
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs set status = 'running'
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.runId],
  );
  await fixture.pgDatabase.query(
    `update bakery.tasks set status = 'active'
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.taskId],
  );
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
  });
  const owner = await repository.acquireEngineOwner(
    job.runId,
    `e3b1-${crypto.randomUUID()}`,
    60_000,
  );
  assert(owner !== undefined, "the engine owner is acquired");
  return { job, repository, owner };
}

async function snapshotOf(
  fixture: WorkerFixture,
  job: { runId: string; taskId: string },
) {
  const run = (await fixture.pgDatabase.query<{
    status: string;
    finishedAt: string | null;
    owner: string | null;
    version: number;
  }>(
    `select status, finished_at::text as "finishedAt",
            engine_owner_token as owner, version
       from bakery.workflow_runs where id = $1`,
    [job.runId],
  )).rows[0];
  const task = (await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.tasks where id = $1`,
    [job.taskId],
  )).rows[0];
  const events = (await fixture.pgDatabase.query<{ eventType: string }>(
    `select event_type as "eventType" from bakery.domain_events
      where aggregate_id in ($1, $2) and event_type in ('run.updated', 'tasks.updated')
      order by organization_sequence`,
    [job.runId, job.taskId],
  )).rows.map((row) => row.eventType);
  return { run, task, events };
}

for (const outcome of ["completed", "failed", "canceled"] as Outcome[]) {
  Deno.test(`the engine ends a pinned plan run as ${outcome}: run, task, events and owner together`, () =>
    withWorkerFixture(async (fixture) => {
      const { job, repository, owner } = await seedRun(fixture, { plan: true });
      const before = await snapshotOf(fixture, job);
      assertEquals(before.run.status, "running");

      await repository.finishPlanRun(job.runId, outcome, owner);

      const after = await snapshotOf(fixture, job);
      assertEquals(after.run.status, outcome);
      assert(after.run.finishedAt !== null, "finished_at is set");
      assertEquals(after.run.owner, null, "the engine owner is cleared");
      assertEquals(after.run.version, before.run.version + 1);
      assertEquals(after.task.status, outcome);
      assertEquals(
        after.events.slice(before.events.length).sort(),
        ["run.updated", "tasks.updated"],
      );
      // The owner is gone, so a second projection is refused rather than
      // applied twice.
      await assertRejects(
        () => repository.finishPlanRun(job.runId, outcome, owner),
      );
      assertEquals(
        (await snapshotOf(fixture, job)).run.version,
        after.run.version,
      );
    }));
}

Deno.test("the engine refuses to end a flat run: its rows decide that", () =>
  withWorkerFixture(async (fixture) => {
    const { job, repository, owner } = await seedRun(fixture, { plan: false });
    await assertRejects(
      () => repository.finishPlanRun(job.runId, "completed", owner),
      Error,
      "WORKFLOW_PLAN_RUN_REQUIRED",
    );
    const after = await snapshotOf(fixture, job);
    assertEquals(after.run.status, "running");
    assertEquals(after.task.status, "active");
  }));

Deno.test("an engine that lost its ownership cannot end the run, and says so by name", () =>
  withWorkerFixture(async (fixture) => {
    const { job, repository, owner } = await seedRun(fixture, { plan: true });
    const lost = "WORKFLOW_ENGINE_OWNER_LOST";
    await assertRejects(
      () =>
        repository.finishPlanRun(job.runId, "completed", {
          ...owner,
          token: "someone-else",
        }),
      Error,
      lost,
    );
    await assertRejects(
      () =>
        repository.finishPlanRun(job.runId, "completed", {
          ...owner,
          generation: String(BigInt(owner.generation) + 1n),
        }),
      Error,
      lost,
    );
    // A lease that ran out is lost too.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set engine_owner_lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [job.runId],
    );
    await assertRejects(
      () => repository.finishPlanRun(job.runId, "completed", owner),
      Error,
      lost,
    );
    const after = await snapshotOf(fixture, job);
    assertEquals(after.run.status, "running");
    assertEquals(after.task.status, "active");
  }));

for (const outcome of ["completed", "failed"] as Outcome[]) {
  Deno.test(`ending a pinned plan run as ${outcome} reconciles the coordination lane its task belongs to`, () =>
    withWorkerFixture(async (fixture) => {
      const db = fixture.pgDatabase;
      const org = fixture.organizationId;
      const { job, repository, owner } = await seedRun(fixture, { plan: true });
      const scope = (await db.query<{ repository_id: string }>(
        `select repository_id from bakery.tasks where organization_id = $1 and id = $2`,
        [org, job.taskId],
      )).rows[0];
      try {
        const conversationId = crypto.randomUUID();
        const parent = crypto.randomUUID();
        await db.query(
          `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
         values ($1, $2, $3, $4, 'parent', $5)`,
          [
            conversationId,
            org,
            job.applicationId,
            scope.repository_id,
            fixture.principalId,
          ],
        );
        await db.query(
          `insert into bakery.tasks (id, organization_id, application_id, repository_id, conversation_id, title, description, task_type, status, priority, created_by)
         values ($1, $2, $3, $4, $5, 'parent', '', 'epic', 'draft', 50, $6)`,
          [
            parent,
            org,
            job.applicationId,
            scope.repository_id,
            conversationId,
            fixture.principalId,
          ],
        );
        const planId = crypto.randomUUID();
        const spec = {
          lanes: [{
            key: "api",
            repositoryAlias: "api",
            title: "api",
            instructions: "",
            prerequisites: [],
            outputs: [],
            inputs: [],
          }],
          maxConcurrency: 1,
          join: "all-required",
          failurePolicy: "stop-dependent",
        };
        await db.query(
          `insert into bakery.coordination_plans (id, organization_id, application_id, parent_task_id, revision, spec, digest, status, created_by)
         values ($1, $2, $3, $4, 1, $5::jsonb, $6, 'materialized', $7)`,
          [
            planId,
            org,
            job.applicationId,
            parent,
            JSON.stringify(spec),
            "c".repeat(64),
            fixture.principalId,
          ],
        );
        await db.query(
          `insert into bakery.coordination_lanes (organization_id, application_id, plan_id, lane_key, position, repository_id, child_task_id, prerequisites, declared_outputs, lane_digest, status)
         values ($1, $2, $3, 'api', 0, $4, $5, '{}'::text[], '[]'::jsonb, $6, 'ready')`,
          [
            org,
            job.applicationId,
            planId,
            scope.repository_id,
            job.taskId,
            "d".repeat(64),
          ],
        );

        await repository.finishPlanRun(job.runId, outcome, owner);

        const lane = (await db.query<{ status: string }>(
          `select status from bakery.coordination_lanes where plan_id = $1 and lane_key = 'api'`,
          [planId],
        )).rows[0];
        assertEquals(lane.status, outcome);
      } finally {
        // The shared worker teardown does not know the coordination tables.
        for (const table of ["coordination_lanes", "coordination_plans"]) {
          await db.query(
            `delete from bakery.${table} where organization_id = $1`,
            [org],
          );
        }
      }
    }));
}

Deno.test("an outcome outside the three ends is refused before anything is read", () =>
  withWorkerFixture(async (fixture) => {
    const { job, repository, owner } = await seedRun(fixture, { plan: true });
    await assertRejects(
      () => repository.finishPlanRun(job.runId, "blocked" as Outcome, owner),
      Error,
      "WORKFLOW_PLAN_OUTCOME_INVALID",
    );
    assertEquals((await snapshotOf(fixture, job)).run.status, "running");
  }));

Deno.test("an unknown run is not found", () =>
  withWorkerFixture(async (fixture) => {
    const { repository, owner } = await seedRun(fixture, { plan: true });
    await assertRejects(
      () => repository.finishPlanRun(crypto.randomUUID(), "completed", owner),
    );
  }));
