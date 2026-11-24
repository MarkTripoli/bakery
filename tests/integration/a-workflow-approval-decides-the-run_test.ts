import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  type CoordinationFixture,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";

const spec = {
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "sign-off",
  inputs: { taskId: { type: "uuid", required: true } },
  steps: [{
    id: "flow",
    steps: [
      { id: "first", uses: "workflow.noop", with: {} },
      {
        id: "signoff",
        uses: "human.approval",
        with: { prompt: "Ship it?" },
      },
      { id: "after", uses: "workflow.noop", with: {} },
    ],
  }],
};

type Approval = { id: string; version: number; status: string };

async function startAtTheSignOff(
  fx: CoordinationFixture,
  workflowVersionId: string,
) {
  const taskId = await fx.insertTask("sign-off", { repo: "api" });
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  const started = await fx.sendTask(
    fx.developer,
    "POST",
    `/v1/tasks/${taskId}/runs`,
    {
      body: {
        workflowVersionId,
        repositoryProfileId: pinned[0].id,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { taskId },
      },
    },
  );
  const text = await started.text();
  assertEquals(started.status, 201, text);
  const run = JSON.parse(text) as { id: string };
  const engine = createBakeryPostgresWorkflowRepository({
    database: fx.appPg,
    maxAttempts: 1,
  });
  const owner = await engine.acquireEngineOwner(
    run.id,
    crypto.randomUUID(),
    60_000,
  );
  assert(owner);
  const first = await engine.findNext(run.id, owner);
  assert(first, "the run reaches its first step");
  await fx.owner`
    update bakery.run_steps
       set status = 'completed', output = '{}'::jsonb, finished_at = now()
     where organization_id = ${fx.organizationId} and run_id = ${run.id}
       and step_key = ${first.stepKey}`;
  const signoff = await engine.findNext(run.id, owner);
  assert(signoff, "the run reaches the sign-off");
  const step = await fx.owner`
    select status, dispatch #>> '{wait,approvalId}' as approval_id
      from bakery.run_steps
     where organization_id = ${fx.organizationId} and run_id = ${run.id}
       and step_key = ${signoff.stepKey}`;
  assertEquals(step[0].status, "waiting");
  const approvalId = step[0].approval_id as string;
  assert(approvalId, "the wait pins the approval the engine created");
  const cookie = await fx.cookieFor(fx.developer);
  const call = (method: string, path: string, body?: unknown) =>
    fx.productionApp.fetch(
      new Request(`${fx.publicBaseUrl}${path}`, {
        method,
        headers: {
          cookie,
          origin: fx.publicBaseUrl,
          "Bakery-Organization-Id": fx.organizationId,
          "content-type": "application/json",
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": crypto.randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const listed = await call("GET", `/v1/approvals?taskId=${taskId}&limit=100`);
  const listText = await listed.text();
  assertEquals(listed.status, 200, listText);
  const approval = (JSON.parse(listText) as { items: Approval[] }).items.find(
    (item) => item.id === approvalId,
  );
  assert(approval, "the sign-off is in the task's approvals");
  assertEquals(approval.status, "open");
  const decide = async (decision: string, comment?: string) => {
    const response = await call(
      "POST",
      `/v1/approvals/${approvalId}/decision`,
      {
        decision,
        expectedVersion: approval.version,
        ...(comment === undefined ? {} : { comment }),
      },
    );
    assertEquals(response.status, 200, await response.text());
  };
  const runRow = async () =>
    (await fx.owner`
      select status, outcome from bakery.workflow_runs
       where organization_id = ${fx.organizationId} and id = ${run.id}`)[0];
  const stepStatus = async () =>
    (await fx.owner`
      select status from bakery.run_steps
       where organization_id = ${fx.organizationId} and run_id = ${run.id}
         and step_key = ${signoff.stepKey}`)[0].status as string;
  return { engine, owner, run, signoff, decide, runRow, stepStatus };
}

Deno.test("approving a workflow's sign-off lets a run started by runs.create go on", async () => {
  const fx = await openCoordinationFixture();
  try {
    const { workflowVersionId } = await fx.publishWorkflowVersion(spec);
    const at = await startAtTheSignOff(fx, workflowVersionId);
    assertEquals(
      await at.engine.completeApprovalWait(at.signoff, at.owner),
      false,
    );
    await at.decide("approve");
    assertEquals(
      await at.engine.completeApprovalWait(at.signoff, at.owner),
      true,
    );
    assertEquals(await at.stepStatus(), "completed");
    const next = await at.engine.findNext(at.run.id, at.owner);
    assert(next, "the run goes on after the sign-off");
    assert(next.stepKey.endsWith("after"), next.stepKey);
    assertEquals((await at.runRow()).status, "running");
    await at.engine.releaseEngineOwner(at.owner);
  } finally {
    await fx.close();
  }
});

for (
  const [decision, outcome, comment] of [
    ["request_changes", "changes_requested", "Split the migration."],
    ["reject", "rejected", undefined],
  ] as const
) {
  Deno.test(`a sign-off answered ${decision} ends the run as ${outcome}`, async () => {
    const fx = await openCoordinationFixture();
    try {
      const { workflowVersionId } = await fx.publishWorkflowVersion(spec);
      const at = await startAtTheSignOff(fx, workflowVersionId);
      await at.decide(decision, comment);
      const ended = await at.runRow();
      assertEquals([ended.status, ended.outcome], ["canceled", outcome]);
      await at.engine.completeApprovalWait(at.signoff, at.owner);
      assertEquals(await at.engine.findNext(at.run.id, at.owner), undefined);
      assertEquals(await at.stepStatus(), "completed");
      await at.engine.releaseEngineOwner(at.owner);
    } finally {
      await fx.close();
    }
  });
}
