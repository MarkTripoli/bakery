import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { reconcileCoordinationForTerminalTask } from "../../apps/server/src/modules/work/coordination-projection.ts";
import {
  admitFundedModelRun as admit,
  admitRefusedFundedModelRun,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import {
  type CoordinationFixture,
  openCoordinationFixture,
  threeLaneSpec,
} from "../helpers/coordination-fixture.ts";

type Lane = {
  laneKey: string;
  childTaskId: string | null;
  reusedFromLaneId: string | null;
  status: string;
  repositoryId: string;
};
type Plan = {
  id: string;
  revision: number;
  status: string;
  digest: string;
  lanes: Lane[];
};

async function createPlan(
  fx: CoordinationFixture,
  parentTaskId: string,
  spec: unknown,
  extra: Record<string, unknown> = {},
) {
  return await fx.send(fx.developer, "POST", "/v1/coordination-plans", {
    body: { parentTaskId, spec, ...extra },
  });
}

async function planOf(response: Response, status = 201): Promise<Plan> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Plan;
}

async function materialize(fx: CoordinationFixture, id: string) {
  return await planOf(
    await fx.send(
      fx.developer,
      "POST",
      `/v1/coordination-plans/${id}/materialize`,
      {
        body: {},
      },
    ),
  );
}

const lane = (plan: Plan, key: string) => {
  const found = plan.lanes.find((l) => l.laneKey === key);
  assert(found, `lane ${key}`);
  return found;
};

/** Marks a child completed and commits a named artifact on it. */
async function completeChild(
  fx: CoordinationFixture,
  taskId: string,
  artifactName?: string,
  artifactType = "patch",
) {
  await fx.owner`
    update bakery.tasks set status = 'completed', version = version + 1
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  if (!artifactName) return null;
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const sha = "a".repeat(64);
  await fx.owner`
    insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
    values (${artifactId}, ${fx.organizationId}, ${taskId}, ${artifactType}, ${artifactName})`;
  await fx.owner`
    insert into bakery.artifact_versions (
      id, organization_id, artifact_id, task_id, author_id, revision, content,
      sha256, size_bytes, media_type
    ) values (${versionId}, ${fx.organizationId}, ${artifactId}, ${taskId},
      ${fx.admin.principalId}, 1, ${new Uint8Array([
    1,
    2,
    3,
  ])}, ${sha}, 3, 'application/json')`;
  await fx.owner`
    update bakery.artifacts set current_version_id = ${versionId}
     where organization_id = ${fx.organizationId} and id = ${artifactId}`;
  return { artifactId, versionId, sha };
}

async function startRun(fx: CoordinationFixture, taskId: string) {
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  return await fx.sendTask(fx.developer, "POST", `/v1/tasks/${taskId}/runs`, {
    body: {
      workflowVersionId: fx.workflowVersionId,
      repositoryProfileId: pinned[0].id,
      executionMode: "repository",
      budgetLimitUsd: "0.005000",
      inputs: { taskId },
    },
  });
}

async function admission(fx: CoordinationFixture, runId: string) {
  const rows = await fx.owner`
    select snapshot->'admission'->>'reason' as reason,
           snapshot->'coordination' as coordination, status
      from bakery.workflow_runs
     where organization_id = ${fx.organizationId} and id = ${runId}`;
  return rows[0];
}

Deno.test("coordination plans: aliases, validation, materialization, handoffs, failure and revisions", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();

    // AC2: ambiguous aliases, cycles, unknown aliases, shared writable
    // checkouts, undeclared handoffs and scope violations never dispatch.
    const rejectionParent = await fx.insertTask("rejections");
    await fx.send(
      fx.admin,
      "PUT",
      `/v1/applications/${fx.applicationId}/repository-roles`,
      {
        body: {
          alias: "shared",
          role: "backend",
          repositoryId: fx.repositories.api.repositoryId,
        },
      },
    );
    await fx.send(
      fx.admin,
      "PUT",
      `/v1/applications/${fx.applicationId}/repository-roles`,
      {
        body: {
          alias: "shared",
          role: "frontend",
          repositoryId: fx.repositories.web.repositoryId,
        },
      },
    );
    const spec = threeLaneSpec();
    const withLane = (index: number, patch: Record<string, unknown>) => ({
      ...spec,
      lanes: spec.lanes.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    });
    const rejected: [string, unknown][] = [
      ["alias_ambiguous", withLane(2, { repositoryAlias: "shared" })],
      ["alias_unknown", withLane(2, { repositoryAlias: "nowhere" })],
      ["dependency_cycle", withLane(0, { prerequisites: ["web"] })],
      ["shared_writable_checkout", withLane(2, { repositoryAlias: "api" })],
      ["input_not_declared_upstream", withLane(0, { outputs: [] })],
    ];
    for (const [code, candidate] of rejected) {
      const response = await createPlan(fx, rejectionParent, candidate);
      const body = await response.json();
      assertEquals(response.status, 422, JSON.stringify(body));
      assert(
        JSON.stringify(body).includes(code),
        `${code} missing from ${JSON.stringify(body)}`,
      );
    }
    const none = await fx.owner`
      select count(*)::int as count from bakery.coordination_plans
       where organization_id = ${fx.organizationId}
         and parent_task_id = ${rejectionParent}`;
    assertEquals(none[0].count, 0);

    // A parent that links only web cannot coordinate api.
    const scopedParent = await fx.insertTask("scoped");
    const link = await fx.send(
      fx.developer,
      "PUT",
      `/v1/tasks/${scopedParent}/repositories`,
      {
        body: {
          repositoryId: fx.repositories.web.repositoryId,
          role: "frontend",
          required: true,
          provenance: "user",
        },
      },
    );
    assertEquals(link.status, 200, await link.clone().text());
    const outOfScope = await createPlan(fx, scopedParent, spec);
    assertEquals(outOfScope.status, 422);
    assert((await outOfScope.text()).includes("repository_out_of_scope"));

    // A repository of another application cannot be aliased at all.
    const foreignAlias = await fx.send(
      fx.admin,
      "PUT",
      `/v1/applications/${fx.applicationId}/repository-roles`,
      {
        body: {
          alias: "foreign",
          role: "backend",
          repositoryId: fx.repositories.foreign.repositoryId,
        },
      },
    );
    assertEquals(foreignAlias.status, 404);

    // AC1: independent lanes overlap; the dependant waits for typed outputs.
    const parent = await fx.insertTask("happy");
    const created = await planOf(await createPlan(fx, parent, spec));
    assertEquals(created.revision, 1);
    assertEquals(created.status, "planned");
    assert(created.lanes.every((l) => l.childTaskId === null));
    const duplicate = await planOf(await createPlan(fx, parent, spec));
    assertEquals(duplicate.id, created.id, "same spec is not a new revision");

    const [first, second] = await Promise.all([
      materialize(fx, created.id),
      materialize(fx, created.id),
    ]);
    assertEquals(
      first.lanes.map((l) => l.childTaskId),
      second.lanes.map((l) => l.childTaskId),
    );
    assertEquals(first.status, "materialized");
    const children = first.lanes.map((l) => l.childTaskId as string);
    const taskRows = await fx.owner`
      select id, parent_task_id, repository_id, repository_profile_id
        from bakery.tasks
       where organization_id = ${fx.organizationId} and parent_task_id = ${parent}`;
    assertEquals(taskRows.length, 3, "children are created exactly once");
    for (const row of taskRows) {
      const owned = first.lanes.find((l) => l.childTaskId === row.id);
      assert(owned);
      assertEquals(row.repository_id, owned.repositoryId);
      assertNotEquals(row.repository_profile_id, null);
    }
    const dependencies = await fx.owner`
      select task_id, depends_on_task_id from bakery.task_dependencies
       where organization_id = ${fx.organizationId} and task_id = any(${children})`;
    assertEquals(dependencies.length, 1);
    assertEquals(dependencies[0].task_id, lane(first, "web").childTaskId);
    assertEquals(
      dependencies[0].depends_on_task_id,
      lane(first, "api").childTaskId,
    );
    const links = await fx.owner`
      select count(*)::int as count from bakery.task_repositories
       where organization_id = ${fx.organizationId} and task_id = ${parent}`;
    assertEquals(links[0].count, 3);

    const apiRun = await startRun(fx, lane(first, "api").childTaskId as string);
    const mobileRun = await startRun(
      fx,
      lane(first, "mobile").childTaskId as string,
    );
    assertEquals(apiRun.status, 201, await apiRun.clone().text());
    assertEquals(mobileRun.status, 201);
    assertEquals((await apiRun.json()).status, "queued");
    assertEquals(
      (await mobileRun.json()).status,
      "queued",
      "independent lanes overlap",
    );
    // An early start of the dependant is refused and writes nothing: no run,
    // task still draft, and the lane projection shows it waiting.
    const webChild = lane(first, "web").childTaskId as string;
    const early = await startRun(fx, webChild);
    assertEquals(early.status, 409);
    // The problem body carries only the STATE_CONFLICT code; the reason is a
    // server-side param (lane_prerequisite_incomplete).
    const untouched = await fx.owner`
      select t.status, t.current_run_id,
             (select count(*)::int from bakery.workflow_runs r
               where r.organization_id = t.organization_id
                 and r.task_id = t.id) as runs
        from bakery.tasks t
       where t.organization_id = ${fx.organizationId} and t.id = ${webChild}`;
    assertEquals(untouched[0].status, "draft");
    assertEquals(untouched[0].current_run_id, null);
    assertEquals(untouched[0].runs, 0);
    const waitingView = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/coordination-plans/${first.id}`,
    )).json() as Plan;
    assertEquals(lane(waitingView, "web").status, "waiting");

    // Same lane on the same plan: starts after the prerequisites commit outputs.
    await completeChild(
      fx,
      lane(first, "api").childTaskId as string,
      "contract",
    );
    const afterOutputs = await startRun(fx, webChild);
    assertEquals(afterOutputs.status, 201, await afterOutputs.clone().text());
    assertEquals((await afterOutputs.json()).status, "queued");

    // Committed outputs release the dependant with typed artifact inputs.
    const ready = await planOf(
      await createPlan(fx, await fx.insertTask("handoff"), spec),
    );
    const readyPlan = await materialize(fx, ready.id);
    const artifact = await completeChild(
      fx,
      lane(readyPlan, "api").childTaskId as string,
      "contract",
    );
    assert(artifact);
    const released = await startRun(
      fx,
      lane(readyPlan, "web").childTaskId as string,
    );
    const releasedBody = await released.json();
    assertEquals(released.status, 201, JSON.stringify(releasedBody));
    assertEquals(releasedBody.status, "queued");
    const snapshot = await admission(fx, releasedBody.id);
    assertEquals(snapshot.coordination.inputs.length, 1);
    assertEquals(
      snapshot.coordination.inputs[0].artifactId,
      artifact.artifactId,
    );
    assertEquals(
      snapshot.coordination.inputs[0].artifactVersionId,
      artifact.versionId,
    );
    assertEquals(snapshot.coordination.inputs[0].sha256, artifact.sha);

    // A completed prerequisite without its declared output still waits.
    const missing = await planOf(
      await createPlan(fx, await fx.insertTask("missing"), spec),
    );
    const missingPlan = await materialize(fx, missing.id);
    await completeChild(fx, lane(missingPlan, "api").childTaskId as string);
    const missingRun = await startRun(
      fx,
      lane(missingPlan, "web").childTaskId as string,
    );
    assertEquals(missingRun.status, 409);

    // Stop-dependent failure, independent lanes continue, partial delivery.
    const failing = await planOf(
      await createPlan(fx, await fx.insertTask("failure"), spec),
    );
    const failingPlan = await materialize(fx, failing.id);
    await fx.owner`
      update bakery.tasks set status = 'failed', version = version + 1
       where organization_id = ${fx.organizationId}
         and id = ${lane(failingPlan, "api").childTaskId}`;
    const stopped = await startRun(
      fx,
      lane(failingPlan, "web").childTaskId as string,
    );
    assertEquals(stopped.status, 409);
    const inflight = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/coordination-plans/${failing.id}`,
    )).json() as Plan;
    assertEquals(lane(inflight, "web").status, "stopped");
    assertEquals(inflight.status, "materialized", "mobile can still finish");
    await completeChild(fx, lane(failingPlan, "mobile").childTaskId as string);
    const delivered = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/coordination-plans/${failing.id}`,
    )).json() as Plan;
    assertEquals(delivered.status, "partially_delivered");

    // AC3: a new revision reuses completed evidence; cancel keeps it.
    const revisionParent = await fx.insertTask("revisions");
    const rev1 = await materialize(
      fx,
      (await planOf(await createPlan(fx, revisionParent, spec))).id,
    );
    const apiChild = lane(rev1, "api").childTaskId as string;
    await completeChild(fx, apiChild, "contract");
    const changed = await planOf(
      await createPlan(
        fx,
        revisionParent,
        threeLaneSpec({ mobileInstructions: "scope changed" }),
      ),
    );
    assertEquals(changed.revision, 2);
    const rev2 = await materialize(fx, changed.id);
    assertEquals(
      lane(rev2, "api").childTaskId,
      apiChild,
      "completed lane is reused",
    );
    assertEquals(
      lane(rev2, "api").reusedFromLaneId,
      lane(rev1, "api").laneKey === "api"
        ? (await fx
          .owner`select id from bakery.coordination_lanes where plan_id = ${rev1.id} and lane_key = 'api'`)[
            0
          ].id
        : null,
    );
    assertEquals(lane(rev2, "api").status, "completed");
    assertNotEquals(
      lane(rev2, "mobile").childTaskId,
      lane(rev1, "mobile").childTaskId,
    );
    const superseded = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/coordination-plans/${rev1.id}`,
    )).json() as Plan;
    assertEquals(superseded.status, "superseded");
    const oldMobile = await fx.owner`
      select status from bakery.tasks
       where organization_id = ${fx.organizationId}
         and id = ${lane(rev1, "mobile").childTaskId}`;
    assertEquals(oldMobile[0].status, "canceled");

    const cancel = await planOf(
      await fx.send(
        fx.developer,
        "POST",
        `/v1/coordination-plans/${rev2.id}/cancel`,
        { body: {} },
      ),
    );
    assertEquals(cancel.status, "canceled");
    assertEquals(lane(cancel, "api").status, "completed", "evidence stays");
    assertEquals(lane(cancel, "mobile").status, "canceled");
    const apiAfter = await fx.owner`
      select status from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${apiChild}`;
    assertEquals(apiAfter[0].status, "completed");
    const again = await planOf(
      await fx.send(
        fx.developer,
        "POST",
        `/v1/coordination-plans/${rev2.id}/cancel`,
        { body: {} },
      ),
    );
    assertEquals(again.status, "canceled");
    const inactive = await fx.send(
      fx.developer,
      "POST",
      `/v1/coordination-plans/${rev2.id}/materialize`,
      { body: {} },
    );
    assertEquals(inactive.status, 409);

    // Audit and domain events exist for every write.
    const audited = await fx.owner`
      select distinct operation from bakery.audit_events
       where organization_id = ${fx.organizationId}
         and operation like 'coordinationPlans.%' or operation like 'applicationRepositoryRoles.%' or operation like 'taskRepositories.%'`;
    const operations = audited.map((r) => r.operation as string);
    for (
      const operation of [
        "coordinationPlans.create",
        "coordinationPlans.materialize",
        "coordinationPlans.cancel",
        "applicationRepositoryRoles.set",
        "taskRepositories.set",
      ]
    ) assert(operations.includes(operation), operation);
    const events = await fx.owner`
      select distinct event_type from bakery.domain_events
       where organization_id = ${fx.organizationId}
         and event_type like 'coordinationPlan.%'`;
    const types = events.map((r) => r.event_type as string);
    for (
      const type of [
        "coordinationPlan.created",
        "coordinationPlan.materialized",
        "coordinationPlan.canceled",
      ]
    ) assert(types.includes(type), type);

    // Lists are paged and tenant scoped.
    const list = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/coordination-plans?parentTaskId=${revisionParent}`,
    )).json();
    assertEquals(list.items.length, 2);
    const roles = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/applications/${fx.applicationId}/repository-roles`,
    )).json();
    assert(roles.items.length >= 3);
    const repositories = await (await fx.send(
      fx.developer,
      "GET",
      `/v1/tasks/${parent}/repositories`,
    )).json();
    assertEquals(repositories.items.length, 3);
  } finally {
    await fx.close();
  }
});

Deno.test("coordination plans share one budget ceiling and retries never multiply it", async () => {
  const fx = await openCoordinationFixture();
  try {
    await seedProviderPricingSnapshot(fx.ownerPg);
    const first = await seedRun(
      fx.ownerPg,
      fx.organizationId,
      fx.admin.principalId,
      {
        reservationUsd: "0.1",
        stepKey: "plan-first",
      },
    );
    const second = await seedRun(
      fx.ownerPg,
      fx.organizationId,
      fx.admin.principalId,
      {
        reservationUsd: "0.1",
        stepKey: "plan-second",
        applicationId: first.applicationId,
      },
    );
    // Plan, lanes and parent share the funded application (composite FKs).
    const parentConversation = crypto.randomUUID();
    const parent = crypto.randomUUID();
    await fx.owner`
      insert into bakery.conversations (id, organization_id, application_id, title, created_by)
      values (${parentConversation}, ${fx.organizationId}, ${first.applicationId}, 'budget parent', ${fx.admin.principalId})`;
    await fx.owner`
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, title, description,
        task_type, status, priority, created_by
      ) values (${parent}, ${fx.organizationId}, ${first.applicationId},
        ${parentConversation}, 'budget parent', '', 'epic', 'draft', 50,
        ${fx.admin.principalId})`;
    const planId = crypto.randomUUID();
    const digest = "b".repeat(64);
    await fx.owner`
      insert into bakery.coordination_plans (
        id, organization_id, application_id, parent_task_id, revision, spec,
        digest, budget_limit_usd, status, created_by
      ) values (${planId}, ${fx.organizationId}, ${first.applicationId}, ${parent}, 1,
        '{}'::jsonb, ${digest}, '0.15', 'materialized', ${fx.admin.principalId})`;
    for (const [position, run] of [first, second].entries()) {
      await fx.owner`
        insert into bakery.coordination_lanes (
          organization_id, application_id, plan_id, lane_key, position, repository_id,
          child_task_id, lane_digest, status
        ) values (${fx.organizationId}, ${first.applicationId}, ${planId}, ${`lane-${position}`}, ${position},
          ${run.repositoryId}, ${run.taskId}, ${digest}, 'ready')`;
    }
    const admitted = await admit(fx.ownerPg, first);
    const heldAfterFirst = await planSpend(fx, planId);
    assertEquals(heldAfterFirst, "0.1");

    // A retry of the same step reuses its reservation: nothing is added.
    const retried = await admit(fx.ownerPg, first);
    assertEquals(
      retried.installationReservationId,
      admitted.installationReservationId,
    );
    assertEquals(await planSpend(fx, planId), "0.1");

    // A sibling lane that would push the plan past 0.15 is refused.
    // The refusal is deterministic, so it fails the run with a stable code.
    const refusal = await admitRefusedFundedModelRun(fx.ownerPg, second);
    assertEquals(refusal.terminal, true);
    assertEquals(refusal.jobId, undefined);
    assertEquals(
      await stepErrorCode(fx, second.runStepId),
      "PLAN_BUDGET_CAP_EXCEEDED",
    );
    assertEquals(await planSpend(fx, planId), "0.1");
    const refused = await fx.owner`
      select count(*)::int as count from bakery.budget_action_intents
       where organization_id = ${fx.organizationId} and run_id = ${second.runId}`;
    assertEquals(refused[0].count, 0);
  } finally {
    await fx.close();
  }
});

async function stepErrorCode(fx: CoordinationFixture, runStepId: string) {
  const rows = await fx.owner`
    select status, error->>'code' as code from bakery.run_steps
     where organization_id = ${fx.organizationId} and id = ${runStepId}`;
  assertEquals(rows[0].status, "failed");
  return rows[0].code;
}

async function planSpend(fx: CoordinationFixture, planId: string) {
  const rows = await fx.owner`
    select coalesce(sum(a.reserved_usd + a.settled_usd), 0)::text as total
      from bakery.budget_accounts a
      join bakery.workflow_runs r
        on r.organization_id = a.organization_id and r.id = a.run_id
      join bakery.coordination_lanes l
        on l.organization_id = r.organization_id and l.child_task_id = r.task_id
     where a.scope = 'run' and l.plan_id = ${planId}`;
  return String(Number(rows[0].total));
}

Deno.test("coordination plan ceiling includes parent task spend", async () => {
  const fx = await openCoordinationFixture();
  try {
    await seedProviderPricingSnapshot(fx.ownerPg);
    const parentRun = await seedRun(
      fx.ownerPg,
      fx.organizationId,
      fx.admin.principalId,
      { reservationUsd: "0.1", stepKey: "plan-parent" },
    );
    const childRun = await seedRun(
      fx.ownerPg,
      fx.organizationId,
      fx.admin.principalId,
      {
        reservationUsd: "0.1",
        stepKey: "plan-child",
        applicationId: parentRun.applicationId,
      },
    );
    const parent = parentRun.taskId;
    const planId = crypto.randomUUID();
    const digest = "b".repeat(64);
    await fx.owner`
      insert into bakery.coordination_plans (
        id, organization_id, application_id, parent_task_id, revision, spec,
        digest, budget_limit_usd, status, created_by
      ) values (${planId}, ${fx.organizationId}, ${parentRun.applicationId}, ${parent}, 1,
        '{}'::jsonb, ${digest}, '0.15', 'materialized', ${fx.admin.principalId})`;
    await fx.owner`
      insert into bakery.coordination_lanes (
        organization_id, application_id, plan_id, lane_key, position, repository_id,
        child_task_id, lane_digest, status
      ) values (${fx.organizationId}, ${parentRun.applicationId}, ${planId}, 'lane-0', 0,
        ${childRun.repositoryId}, ${childRun.taskId}, ${digest}, 'ready')`;

    // The parent run consumes the shared ceiling.
    const admitted = await admit(fx.ownerPg, parentRun);
    assert(admitted.jobId);
    assertEquals(await planSpend(fx, planId), "0");

    // The child would push parent + child spend past the shared 0.15.
    const refusal = await admitRefusedFundedModelRun(fx.ownerPg, childRun);
    assertEquals(refusal.terminal, true);
    assertEquals(refusal.jobId, undefined);
    assertEquals(
      await stepErrorCode(fx, childRun.runStepId),
      "PLAN_BUDGET_CAP_EXCEEDED",
    );
    const reserved = await fx.owner`
      select coalesce(sum(a.reserved_usd + a.settled_usd), 0)::text as total
        from bakery.budget_accounts a
       where a.organization_id = ${fx.organizationId}`;
    assertEquals(String(Number(reserved[0].total)), "0.1");
    const refused = await fx.owner`
      select count(*)::int as count from bakery.budget_action_intents
       where organization_id = ${fx.organizationId} and run_id = ${childRun.runId}`;
    assertEquals(refused[0].count, 0);
  } finally {
    await fx.close();
  }
});

Deno.test("coordination plans: terminal hook, typed handoff by type and cancel without a worker", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const spec = threeLaneSpec();

    // F3: a child reaching a terminal state persists plan and lane status and
    // emits coordinationPlan.updated.
    const hookPlan = await materialize(
      fx,
      (await planOf(await createPlan(fx, await fx.insertTask("hook"), spec)))
        .id,
    );
    await completeChild(fx, lane(hookPlan, "mobile").childTaskId as string);
    await fx.owner`
      update bakery.tasks set status = 'failed', version = version + 1
       where organization_id = ${fx.organizationId}
         and id = ${lane(hookPlan, "api").childTaskId}`;
    await withPgTransaction(fx.ownerPg, async (transaction) => {
      await reconcileCoordinationForTerminalTask(transaction, {
        organizationId: fx.organizationId,
        taskId: lane(hookPlan, "api").childTaskId as string,
        traceId: "terminal-hook-trace",
      });
    });
    const stored = await fx.owner`
      select status from bakery.coordination_plans where id = ${hookPlan.id}`;
    assertEquals(stored[0].status, "partially_delivered");
    const storedLanes = await fx.owner`
      select lane_key, status from bakery.coordination_lanes
       where plan_id = ${hookPlan.id} order by position`;
    assertEquals(
      Object.fromEntries(storedLanes.map((l) => [l.lane_key, l.status])),
      { api: "failed", web: "stopped", mobile: "completed" },
    );
    const updates = await fx.owner`
      select count(*)::int as count from bakery.domain_events
       where organization_id = ${fx.organizationId}
         and event_type = 'coordinationPlan.updated'
         and aggregate_id = ${hookPlan.id}`;
    assertEquals(updates[0].count >= 1, true);

    // F9: the handoff matches the artifact by declared type and name.
    const typedPlan = await materialize(
      fx,
      (await planOf(await createPlan(fx, await fx.insertTask("typed"), spec)))
        .id,
    );
    const typedApi = lane(typedPlan, "api").childTaskId as string;
    const typedWeb = lane(typedPlan, "web").childTaskId as string;
    await completeChild(fx, typedApi, "contract", "report");
    const wrongType = await startRun(fx, typedWeb);
    assertEquals(wrongType.status, 409, "wrong artifact type is not a handoff");
    const right = await completeChild(fx, typedApi, "contract", "patch");
    assert(right);
    const typedRun = await startRun(fx, typedWeb);
    assertEquals(typedRun.status, 201, await typedRun.clone().text());
    const typedSnapshot = await admission(fx, (await typedRun.json()).id);
    assertEquals(
      typedSnapshot.coordination.inputs[0].artifactId,
      right.artifactId,
    );

    // F8: cancel with a queued run and no live worker cancels run and task and
    // emits the run and task events.
    const cancelPlan = await materialize(
      fx,
      (await planOf(await createPlan(fx, await fx.insertTask("cancel"), spec)))
        .id,
    );
    const mobileChild = lane(cancelPlan, "mobile").childTaskId as string;
    const mobileRun = await startRun(fx, mobileChild);
    assertEquals(mobileRun.status, 201);
    const mobileRunId = (await mobileRun.json()).id as string;
    const canceled = await planOf(
      await fx.send(
        fx.developer,
        "POST",
        `/v1/coordination-plans/${cancelPlan.id}/cancel`,
        { body: {} },
      ),
    );
    assertEquals(canceled.status, "canceled");
    const runRow = await fx.owner`
      select status from bakery.workflow_runs where id = ${mobileRunId}`;
    assertEquals(runRow[0].status, "canceled");
    const events = await fx.owner`
      select event_type from bakery.domain_events
       where organization_id = ${fx.organizationId}
         and aggregate_id in (${mobileRunId}, ${mobileChild})`;
    const types = events.map((e) => e.event_type);
    assert(types.includes("run.updated"), "run.updated emitted");
    assert(types.includes("tasks.updated"), "tasks.updated emitted");
  } finally {
    await fx.close();
  }
});
