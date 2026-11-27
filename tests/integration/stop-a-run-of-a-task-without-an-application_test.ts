import { assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { adminRequest } from "../helpers/worker-execution.ts";
import { seedPlanRun } from "../helpers/plan-run.ts";
import { compiled } from "../helpers/workflow-interpreter.ts";

async function appLessWaitingRun(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
) {
  const document = await compiled([
    { id: "hold", wait: { duration: "1h" } },
  ], {});
  const seeded = await seedPlanRun(fixture, document, { inputs: {} });
  await fixture.pgDatabase.query(
    `update bakery.tasks as task
        set application_id = null, repository_id = null,
            repository_profile_id = null, repository_profile_revision = null,
            repository_profile_digest = null, observation_id = null,
            observation_digest = null, base_sha = null
       from bakery.workflow_runs as run
      where run.id = $1
        and task.organization_id = run.organization_id
        and task.id = run.task_id`,
    [seeded.job.runId],
  );
  return seeded.job.runId;
}

async function control(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  runId: string,
  action: "pause" | "cancel",
) {
  const response = await adminRequest(
    fixture,
    `/v1/runs/${runId}/controls`,
    { action },
    { idempotencyKey: crypto.randomUUID() },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

Deno.test("a run of a task with no application answers its controls and can be cancelled", () =>
  withWorkerFixture(async (fixture) => {
    const runId = await appLessWaitingRun(fixture);
    const paused = await control(fixture, runId, "pause");
    assertEquals([paused.status, paused.body.code], [409, "STATE_CONFLICT"]);
    const canceled = await control(fixture, runId, "cancel");
    assertEquals([canceled.status, canceled.body.status], [201, "canceled"]);
  }));
