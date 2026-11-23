import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { internalContext, liveActor } from "../workflows/automations/start.ts";
import { SplitFactSchema } from "./coordination-plan.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../workflow-adapter/engine-steps.ts";
import {
  createStepPlanCommand,
  materializeCoordinationPlanCommand,
} from "./coordination-command.ts";

/**
 * The `coordination.split` step (#422, docs/technical-design/25-one-engine.md
 * section 5, change 3): the parent run's own step owns a plan of child work
 * items. The engine settles it in its admission, as it settles a tool call, so
 * no worker runs it and the plan is made as the person who started the run.
 *
 * The step creates the plan once and materializes it: its origin names the
 * version, the step and nothing else, so a step looked at again is the same
 * request and finds its plan instead of making a second. The engine then starts
 * the lanes that name what they run (`coordination-dispatch.ts`), and the step
 * waits for the plan's terminal projection: completed completes it, a plan that
 * fails, is partially delivered or is canceled fails it with a fixed code, and a
 * plan still running leaves it pending to be looked at again.
 *
 * A canceled parent run does not cancel its plan yet: the plan is canceled
 * through its own operation.
 */

export const SPLIT_ACTION = "coordination.split";

type PlanView = Readonly<{
  id: string;
  status: string;
  lanes: readonly Readonly<{ status: string }>[];
}>;

/** The output contract of the action, resolved by name as the runtime resolves every action output. */
function splitOutputSchema(): { parse(value: unknown): unknown } {
  const schema = (contractSchemas as unknown as Record<
    string,
    { parse(value: unknown): unknown } | undefined
  >).SplitOutput;
  if (schema === undefined) throw new StandardError({ code: "INTERNAL" });
  return schema;
}

function failed(code: string, message: string): EngineStepResult {
  return { kind: "failed", code, message };
}

/** The plan's end states that are not success, each with its fixed code. */
const FAILED_PLAN_CODES: Readonly<Record<string, string>> = Object.freeze({
  failed: "SPLIT_PLAN_FAILED",
  partially_delivered: "SPLIT_PLAN_PARTIALLY_DELIVERED",
  canceled: "SPLIT_PLAN_CANCELED",
  superseded: "SPLIT_PLAN_SUPERSEDED",
});

export function createSplitStepRunner(
  deps: Readonly<{ database: PgDatabase }>,
): EngineStepRunner {
  async function run(request: EngineStepRequest): Promise<EngineStepResult> {
    const parsed = contractSchemas.SplitInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "SPLIT_INPUT_INVALID",
        "The step input does not match the split contract.",
      );
    }
    // The split is a fact of the bakery.split kind: the plan spec itself.
    const fact = SplitFactSchema.safeParse(parsed.data.split);
    if (!fact.success) {
      return failed(
        "SPLIT_INPUT_INVALID",
        "The split is not a bakery.split fact.",
      );
    }
    const input = {
      split: fact.data,
      budgetLimitUsd: parsed.data.budgetLimitUsd,
    };
    const trace = { requestId: crypto.randomUUID(), traceId: request.traceId };
    try {
      const plan = await withPgTransaction(deps.database, async (tx) => {
        const actor = await liveActor(
          tx,
          request.organizationId,
          request.requestedBy,
        );
        if (actor === null) return "actor_unavailable" as const;
        const version = await tx.query<
          { workflow_id: string; workflow_version_id: string }
        >(
          `select v.workflow_id, v.id as workflow_version_id
             from bakery.workflow_runs r
             join bakery.workflow_versions v
               on v.organization_id = r.organization_id
              and v.id = r.workflow_version_id
            where r.organization_id = $1 and r.id = $2`,
          [request.organizationId, request.runId],
        );
        const origin = version.rows[0];
        if (!origin) return "run_unknown" as const;
        const key = `${request.runId}:${request.stepKey}`;
        // The step's own plan, if an earlier look made one. A canceled plan is
        // not "live" to creation, so creating again would make a second plan and
        // start its lanes again: the step finds its plan first and never creates
        // over it.
        const nodeId = request.stepKey.slice(0, 64);
        const own = await tx.query<{ id: string; status: string }>(
          `select id, status from bakery.coordination_plans
            where organization_id = $1 and parent_task_id = $2
              and origin ->> 'kind' = 'saved_workflow' and origin ->> 'nodeId' = $3
            order by revision desc limit 1`,
          [request.organizationId, request.taskId, nodeId],
        );
        let planId = own.rows[0]?.id;
        let status = own.rows[0]?.status;
        if (planId === undefined) {
          const created = await createStepPlanCommand(
            internalContext(tx, actor, trace, {}, {
              operation: "coordinationPlans.create",
              idempotencyKey: `split:${key}`,
              target: "/v1/coordination-plans",
            }),
            {
              parentTaskId: request.taskId,
              spec: input.split,
              budgetLimitUsd: input.budgetLimitUsd,
              origin: {
                kind: "saved_workflow",
                workflowId: origin.workflow_id,
                workflowVersionId: origin.workflow_version_id,
                nodeId,
              },
            },
          ) as unknown as { id: string };
          planId = created.id;
          status = "planned";
        }
        // Materializing replays on a plan whose lanes all have their children; a
        // plan that ended is left as it is.
        if (status === "planned") {
          await materializeCoordinationPlanCommand(
            internalContext(tx, actor, trace, { id: planId }, {
              operation: "coordinationPlans.materialize",
              idempotencyKey: `split-materialize:${key}`,
              target: `/v1/coordination-plans/${planId}/materialize`,
            }),
            {},
          );
        }
        // The projection as it stands now, not as a command answered.
        const view = await tx.query<
          { status: string; lane_status: string | null }
        >(
          `select p.status, l.status as lane_status
             from bakery.coordination_plans p
             left join bakery.coordination_lanes l
               on l.organization_id = p.organization_id and l.plan_id = p.id
            where p.organization_id = $1 and p.id = $2`,
          [request.organizationId, planId],
        );
        return {
          id: planId,
          status: view.rows[0]?.status ?? "failed",
          lanes: view.rows.flatMap((row) =>
            row.lane_status === null ? [] : [{ status: row.lane_status }]
          ),
        } satisfies PlanView;
      });
      if (plan === "actor_unavailable") {
        return failed(
          "SPLIT_ACTOR_UNAVAILABLE",
          "The person who started the run can no longer create a plan, so no plan was made.",
        );
      }
      if (plan === "run_unknown") {
        return failed("SPLIT_RUN_UNKNOWN", "The run has no workflow version.");
      }
      if (plan.status === "completed") {
        return {
          kind: "completed",
          output: splitOutputSchema().parse({
            planId: plan.id,
            status: plan.status,
            lanes: plan.lanes.length,
            completedLanes: plan.lanes.filter((lane) =>
              lane.status === "completed"
            ).length,
          }),
        };
      }
      const code = FAILED_PLAN_CODES[plan.status];
      if (code !== undefined) {
        return failed(
          code,
          `The plan ended ${plan.status.replaceAll("_", " ")}.`,
        );
      }
      // Planned or materialized, with lanes still to run: look again.
      return { kind: "pending" };
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      // A refusal the same input will meet again fails the step with a fixed
      // code; the plan's own issue codes stay on the plan operation.
      return failed(
        "SPLIT_PLAN_INVALID",
        "The plan was refused before anything was created.",
      );
    }
  }

  return {
    handles: (action) => action === SPLIT_ACTION,
    run(request) {
      if (request.action !== SPLIT_ACTION) {
        return Promise.resolve(
          failed(
            "SPLIT_ACTION_UNKNOWN",
            "This runner does not own that action.",
          ),
        );
      }
      return run(request);
    },
  };
}
