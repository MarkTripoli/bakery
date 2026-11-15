import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  fourLaneSpec,
  fourLaneWorkflowDocument,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  completeLane,
  createFromWorkflow,
  createPlan,
  getPlan,
  laneOf,
  materialize,
  type Plan,
  planOf,
  runInputs,
  startRun,
} from "../helpers/coordination-lanes.ts";
import { withOwnedPostgresEnv } from "./helpers/stack.ts";

const TICKET = {
  kind: "ticket",
  provider: "jira",
  reference: "BAK-100",
  url: "https://tickets.example.test/BAK-100",
};

/** What a plan shows regardless of which origin created it. */
function structure(plan: Plan) {
  return {
    digest: plan.digest,
    lanes: plan.lanes.map((lane) => ({
      key: lane.laneKey,
      repositoryId: lane.repositoryId,
      prerequisites: lane.prerequisites,
      laneDigest: lane.laneDigest,
    })),
  };
}

Deno.test("ad hoc, ticket and saved-workflow requests share one coordination boundary", () =>
  withOwnedPostgresEnv("coordination-semantics", async () => {
    const fx = await openCoordinationFixture();
    try {
      await fx.seedAliases();
      const saved = await fx.publishWorkflowVersion(fourLaneWorkflowDocument());
      const spec = fourLaneSpec();
      const parents = {
        ad_hoc: await fx.insertTask("ad hoc parent"),
        ticket: await fx.insertTask("ticket parent"),
        saved_workflow: await fx.insertTask("saved parent"),
      };

      // AC1: the equivalent request through each origin yields the same plan
      // structure; only the origin label differs.
      const created = {
        ad_hoc: await planOf(await createPlan(fx, parents.ad_hoc, spec)),
        ticket: await planOf(
          await createPlan(fx, parents.ticket, spec, { origin: TICKET }),
        ),
        saved_workflow: await planOf(
          await createFromWorkflow(fx, {
            parentTaskId: parents.saved_workflow,
            workflowVersionId: saved.workflowVersionId,
            nodeId: "delivery",
          }),
        ),
      };
      assertEquals(created.ad_hoc.origin, { kind: "ad_hoc" });
      assertEquals(created.ticket.origin, TICKET);
      assertEquals(created.saved_workflow.origin, {
        kind: "saved_workflow",
        workflowId: saved.workflowId,
        workflowVersionId: saved.workflowVersionId,
        nodeId: "delivery",
      });
      assertEquals(
        structure(created.ticket),
        structure(created.ad_hoc),
        "ticket origin changes no digest, scope or prerequisite",
      );
      assertEquals(
        structure(created.saved_workflow),
        structure(created.ad_hoc),
        "saved origin maps to the same digest, scope and prerequisites",
      );

      // One child per lane, parented to its own parent: same structure,
      // distinct child identities.
      const plans: Record<string, Plan> = {};
      for (const [kind, plan] of Object.entries(created)) {
        plans[kind] = await materialize(fx, plan.id);
      }
      const allChildren = Object.values(plans).flatMap((plan) =>
        plan.lanes.map((lane) => lane.childTaskId as string)
      );
      assertEquals(new Set(allChildren).size, 12, "no child is shared");
      for (const [kind, plan] of Object.entries(plans)) {
        const rows = await fx.owner`
        select id, parent_task_id, repository_id from bakery.tasks
         where organization_id = ${fx.organizationId}
           and parent_task_id = ${parents[kind as keyof typeof parents]}`;
        assertEquals(rows.length, 4, `${kind}: one child per lane`);
        for (const row of rows) {
          assertEquals(
            laneOf(plan, laneKeyOfChild(plan, row.id as string)).repositoryId,
            row.repository_id,
          );
        }
      }
      assertEquals(
        structure(plans.saved_workflow),
        structure(plans.ad_hoc),
        "materialization keeps the same structure",
      );

      // Dependency order holds for every origin: an early start is refused and
      // writes no run; each lane starts only once its prerequisites committed.
      for (const plan of Object.values(plans)) {
        const early = await startRun(fx, childOf(plan, "integration"));
        assertEquals(early.status, 409);
        assertEquals(
          (await early.json()).reason,
          "lane_prerequisite_incomplete",
        );
        assertEquals((await startRun(fx, childOf(plan, "web"))).status, 409);
        await completeLane(fx, plan, "contract", "contract");
        const web = await completeLane(fx, plan, "web", "patch");
        assertEquals(
          (await runInputs(fx, web.runId)).map((i) => i.fromLane),
          ["contract"],
        );
        assertEquals(
          (await startRun(fx, childOf(plan, "integration"))).status,
          409,
          "integration waits for the second writer",
        );
        await completeLane(fx, plan, "mobile", "patch");
        const integration = await completeLane(fx, plan, "integration");
        assertEquals(
          (await runInputs(fx, integration.runId)).map((i) =>
            `${i.fromLane}/${i.outputKey}`
          ).sort(),
          ["mobile/patch", "web/patch"],
          "the final consumer receives both writers' typed outputs",
        );
        const finished = await getPlan(fx, plan.id);
        assertEquals(finished.status, "completed");
        assert(finished.lanes.every((lane) => lane.status === "completed"));
      }

      // Equal-origin replay returns the same plan; another origin on the same
      // parent is refused and never replaces or relabels it.
      const replays = [
        await planOf(await createPlan(fx, parents.ad_hoc, spec)),
        await planOf(
          await createPlan(fx, parents.ticket, spec, { origin: TICKET }),
        ),
        await planOf(
          await createFromWorkflow(fx, {
            parentTaskId: parents.saved_workflow,
            workflowVersionId: saved.workflowVersionId,
            nodeId: "delivery",
          }),
        ),
      ];
      assertEquals(
        replays.map((plan) => plan.id),
        [created.ad_hoc.id, created.ticket.id, created.saved_workflow.id],
      );
      const conflicts = [
        await createPlan(fx, parents.ad_hoc, spec, { origin: TICKET }),
        await createPlan(fx, parents.ticket, spec),
        await createFromWorkflow(fx, {
          parentTaskId: parents.ticket,
          workflowVersionId: saved.workflowVersionId,
          nodeId: "delivery",
        }),
        await createPlan(fx, parents.saved_workflow, spec),
      ];
      for (const response of conflicts) {
        const body = await response.json();
        assertEquals(response.status, 409, JSON.stringify(body));
        assertEquals(body.reason, "coordination_plan_origin_conflict");
      }
      for (const kind of Object.keys(parents) as (keyof typeof parents)[]) {
        const rows = await fx.owner`
        select count(*)::int as count from bakery.coordination_plans
         where organization_id = ${fx.organizationId}
           and parent_task_id = ${parents[kind]}`;
        assertEquals(rows[0].count, 1, `${kind}: still one revision`);
      }
      assertNotEquals(created.ad_hoc.id, created.ticket.id);

      // Republishing the workflow (a new version of the same definition whose
      // node maps to the same spec) is the same request: it replays the plan.
      // A different workflow definition with the same node is another origin.
      const republished = await fx.publishWorkflowVersion(
        fourLaneWorkflowDocument(),
        { workflowId: saved.workflowId, revision: 2 },
      );
      const afterRepublish = await planOf(
        await createFromWorkflow(fx, {
          parentTaskId: parents.saved_workflow,
          workflowVersionId: republished.workflowVersionId,
          nodeId: "delivery",
        }),
      );
      assertEquals(afterRepublish.id, created.saved_workflow.id);
      const otherWorkflow = await fx.publishWorkflowVersion(
        fourLaneWorkflowDocument(),
      );
      const otherOrigin = await createFromWorkflow(fx, {
        parentTaskId: parents.saved_workflow,
        workflowVersionId: otherWorkflow.workflowVersionId,
        nodeId: "delivery",
      });
      const otherBody = await otherOrigin.json();
      assertEquals(otherOrigin.status, 409, JSON.stringify(otherBody));
      assertEquals(otherBody.reason, "coordination_plan_origin_conflict");

      // Typed refusals for a node the boundary cannot take.
      const refusals: [string, Record<string, unknown>][] = [
        ["workflow_node_not_parallel", { nodeId: "define" }],
        ["workflow_node_not_parallel", { nodeId: "nowhere" }],
      ];
      for (const [code, patch] of refusals) {
        const response = await createFromWorkflow(fx, {
          parentTaskId: await fx.insertTask("refused"),
          workflowVersionId: saved.workflowVersionId,
          nodeId: "delivery",
          ...patch,
        });
        assertEquals(response.status, 422);
        assert((await response.text()).includes(code));
      }
    } finally {
      await fx.close();
    }
  }));

function laneKeyOfChild(plan: Plan, childTaskId: string): string {
  const found = plan.lanes.find((lane) => lane.childTaskId === childTaskId);
  assert(found, `child ${childTaskId} belongs to a lane`);
  return found.laneKey;
}
