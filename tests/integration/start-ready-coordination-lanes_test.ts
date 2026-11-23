import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { runLaneDispatch } from "../../apps/server/src/modules/work/coordination-dispatch-workflow.ts";
import {
  type CoordinationFixture,
  fourLaneSpec,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  createPlan,
  finishRun,
  materialize,
  type Plan,
  planOf,
  publishOutput,
  reconcileTask,
} from "../helpers/coordination-lanes.ts";

// #422: a lane that names what it runs is started by the engine once its
// prerequisites are done, and only while the plan has room. The dispatcher is
// the consumer of `coordination.lanes_dispatch_requested`, which materializing
// and every lane's end write through the outbox.

/** A published workflow with no inputs, so a lane's static run inputs fit every child. */
async function publishFreeWorkflow(fx: CoordinationFixture) {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const spec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "lane-free",
    inputs: {},
    steps: [{
      id: "flow",
      steps: [{ id: "review", uses: "workflow.noop", with: {} }],
    }],
  };
  await fx.owner`
    insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
    values (${workflowId}, ${fx.organizationId}, ${`lane-${
    workflowId.slice(0, 8)
  }`}, 'Lane', true, 1)`;
  await fx.owner`
    insert into bakery.workflow_versions (
      id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
      digest, status, created_by, version
    ) values (${versionId}, ${fx.organizationId}, ${workflowId}, 1, '',
      ${fx.owner.json(spec)}, ${await sha256Hex(canonicalJson(spec))},
      'published', ${fx.admin.principalId}, 1)`;
  await fx.owner`
    update bakery.workflow_definitions set active_version_id = ${versionId}
     where organization_id = ${fx.organizationId} and id = ${workflowId}`;
  return workflowId;
}

/** The four-lane plan with every lane naming what it runs. */
function runningSpec(workflowId: string, maxConcurrency = 2) {
  const spec = fourLaneSpec();
  return {
    ...spec,
    maxConcurrency,
    lanes: spec.lanes.map((lane) => ({ ...lane, run: { workflowId } })),
  };
}

/**
 * Delivers every recorded lane dispatch request to its consumer, each in its
 * own transaction, as the Inngest function would; the consumer is idempotent, so
 * earlier requests may be delivered again. Returns the lanes started, in order.
 */
async function deliverLaneDispatches(fx: CoordinationFixture) {
  const requests = await fx.owner`
    select event.payload ->> 'planId' as plan_id, event.trace_id
      from bakery.domain_events event
      join bakery.outbox outbox on outbox.event_id = event.id
     where event.organization_id = ${fx.organizationId}
       and event.event_type = 'coordination.lanes_dispatch_requested'
       and outbox.destination = 'inngest'
       and outbox.delivery_key = 'coordination-plan:' || event.aggregate_id || ':lane-dispatch:' || event.aggregate_version
     order by event.organization_sequence`;
  const started: string[] = [];
  const refused: { laneKey: string; code: string }[] = [];
  for (const request of requests) {
    const result = await runLaneDispatch(fx.ownerPg, {
      organizationId: fx.organizationId,
      planId: request.plan_id,
      traceId: request.trace_id,
    });
    started.push(...result.started);
    refused.push(...result.refused);
  }
  return { started, refused, requests: requests.length };
}

const taskRun = async (fx: CoordinationFixture, taskId: string) =>
  (await fx.owner<{ runId: string | null; status: string }[]>`
    select current_run_id as "runId", status from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`)[0];

/** Ends a lane the way a worker would: output committed, run and task completed, plan reconciled. */
async function finishLane(
  fx: CoordinationFixture,
  plan: Plan,
  key: string,
  outputName?: string,
) {
  const taskId = childOf(plan, key);
  const { runId } = await taskRun(fx, taskId);
  assert(runId !== null, `${key} has no run to finish`);
  if (outputName) await publishOutput(fx, taskId, outputName);
  await finishRun(fx, runId, taskId);
  await reconcileTask(fx, taskId);
}

Deno.test("materializing a plan starts the lane with nothing before it, and each lane that becomes ready once it ends (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const workflowId = await publishFreeWorkflow(fx);
    const parent = await fx.insertTask("lanes that run");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, runningSpec(workflowId)))).id,
    );
    // The engine started nothing yet: it was asked to, in the same transaction.
    for (const key of ["contract", "web", "mobile", "integration"]) {
      assertEquals((await taskRun(fx, childOf(plan, key))).runId, null, key);
    }
    const first = await deliverLaneDispatches(fx);
    assert(first.requests >= 1);
    assertEquals(first.started, ["contract"]);
    assertEquals(first.refused, []);
    assert((await taskRun(fx, childOf(plan, "contract"))).runId !== null);
    assertEquals((await taskRun(fx, childOf(plan, "web"))).runId, null);
    // Delivered again, and once more after: the contract lane is not ready any
    // more, so nothing starts twice.
    assertEquals((await deliverLaneDispatches(fx)).started, []);

    // The contract lane ends: the lanes that were waiting on it become ready and
    // both fit the plan's two places.
    await finishLane(fx, plan, "contract", "contract");
    assertEquals((await deliverLaneDispatches(fx)).started, ["web", "mobile"]);
    assert((await taskRun(fx, childOf(plan, "web"))).runId !== null);
    assert((await taskRun(fx, childOf(plan, "mobile"))).runId !== null);
    assertEquals((await taskRun(fx, childOf(plan, "integration"))).runId, null);

    // The last lane waits for both writers' outputs, then starts by itself.
    await finishLane(fx, plan, "web", "patch");
    assertEquals((await deliverLaneDispatches(fx)).started, []);
    await finishLane(fx, plan, "mobile", "patch");
    assertEquals((await deliverLaneDispatches(fx)).started, ["integration"]);
  } finally {
    await fx.close();
  }
});

Deno.test("a plan's capacity bounds how many of its lanes run at once (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const workflowId = await publishFreeWorkflow(fx);
    const parent = await fx.insertTask("one place");
    const plan = await materialize(
      fx,
      (await planOf(
        await createPlan(fx, parent, runningSpec(workflowId, 1)),
      )).id,
    );
    assertEquals((await deliverLaneDispatches(fx)).started, ["contract"]);
    await finishLane(fx, plan, "contract", "contract");
    // Two lanes are ready and the plan has one place: the first in plan order.
    assertEquals((await deliverLaneDispatches(fx)).started, ["web"]);
    assertEquals((await taskRun(fx, childOf(plan, "mobile"))).runId, null);
    // Asked again while web still runs: still only web.
    assertEquals((await deliverLaneDispatches(fx)).started, []);
    // Web ends and frees the place, so the dispatcher is asked again and starts mobile.
    await finishLane(fx, plan, "web", "patch");
    assertEquals((await deliverLaneDispatches(fx)).started, ["mobile"]);
  } finally {
    await fx.close();
  }
});

Deno.test("a plan whose lanes name nothing to run asks for nothing and starts nothing (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("lanes started by hand");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, fourLaneSpec()))).id,
    );
    const delivered = await deliverLaneDispatches(fx);
    assertEquals(delivered.requests, 0);
    assertEquals(delivered.started, []);
    assertEquals((await taskRun(fx, childOf(plan, "contract"))).runId, null);
  } finally {
    await fx.close();
  }
});

Deno.test("a lane that names a workflow the organization does not have refuses the plan (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("unknown workflow");
    const spec = runningSpec(crypto.randomUUID());
    const response = await createPlan(fx, parent, spec);
    assertEquals(response.status, 422);
    const body = await response.text();
    assert(body.includes("lane_workflow_unknown"), body);
  } finally {
    await fx.close();
  }
});

Deno.test("a lane that names another organization's published workflow refuses the plan, naming nothing of that organization (#422)", async () => {
  const fx = await openCoordinationFixture();
  const otherOrganizationId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  try {
    await fx.seedAliases();
    const now = new Date();
    await fx.owner`
      insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${otherOrganizationId}, 'other', ${
      "other-" + otherOrganizationId
    }, '{}'::jsonb, ${now}, ${now}, 1)`;
    // A published, enabled workflow in the other organization: it exists, but
    // not for this plan's organization, so the lookup must not find it.
    const versionId = crypto.randomUUID();
    const spec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "lane-free",
      inputs: {},
      steps: [{
        id: "flow",
        steps: [{ id: "review", uses: "workflow.noop", with: {} }],
      }],
    };
    await fx.owner`
      insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
      values (${workflowId}, ${otherOrganizationId}, ${
      "lane-" + workflowId.slice(0, 8)
    }, 'Lane', true, 1)`;
    await fx.owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
        digest, status, created_by, version
      ) values (${versionId}, ${otherOrganizationId}, ${workflowId}, 1, '',
        ${fx.owner.json(spec)}, ${await sha256Hex(canonicalJson(spec))},
        'published', ${fx.admin.principalId}, 1)`;
    await fx.owner`
      update bakery.workflow_definitions set active_version_id = ${versionId}
       where organization_id = ${otherOrganizationId} and id = ${workflowId}`;

    const parent = await fx.insertTask("another organization's workflow");
    const response = await createPlan(fx, parent, runningSpec(workflowId));
    const body = await response.text();
    assertEquals(response.status, 422, body);
    assert(body.includes("lane_workflow_unknown"), body);
    assertEquals(body.includes(otherOrganizationId), false);
  } finally {
    await fx.owner`
      update bakery.workflow_definitions set active_version_id = null
       where organization_id = ${otherOrganizationId}`;
    await fx.owner`
      delete from bakery.workflow_versions where organization_id = ${otherOrganizationId}`;
    await fx.owner`
      delete from bakery.workflow_definitions where organization_id = ${otherOrganizationId}`;
    await fx
      .owner`delete from bakery.organizations where id = ${otherOrganizationId}`;
    await fx.close();
  }
});

Deno.test("a plan canceled after its dispatch was requested starts no lane (#422)", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const workflowId = await publishFreeWorkflow(fx);
    const parent = await fx.insertTask("canceled before dispatch");
    const plan = await materialize(
      fx,
      (await planOf(await createPlan(fx, parent, runningSpec(workflowId)))).id,
    );
    await fx.owner`
      update bakery.coordination_plans set status = 'canceled'
       where organization_id = ${fx.organizationId} and id = ${plan.id}`;
    const delivered = await deliverLaneDispatches(fx);
    assert(delivered.requests >= 1, "a dispatch request must exist to deliver");
    assertEquals(delivered.started, []);
    for (const key of ["contract", "web", "mobile", "integration"]) {
      assertEquals((await taskRun(fx, childOf(plan, key))).runId, null, key);
    }
  } finally {
    await fx.close();
  }
});
