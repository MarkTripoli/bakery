import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { revertStepWrites } from "../knowledge/storage-working-areas.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * "Revert this step's writes" (chapter 25 section 17.6, O48, #448 slice S5):
 * undoes the Bakery Files writes the agent of one workflow step made, across
 * every iteration and attempt of the step, failed ones included.
 *
 * Who, and why:
 * - A person holding run control over the run, the same authority that stops,
 *   steers or takes over its steps (the catalog's `run:control`).
 * - Never an agent session. An agent must not undo another step's writes, and
 *   undoing its own would let it erase what a reviewer is meant to see, so
 *   the undo is refused to every agent session.
 * - Only while no attempt of the step is live: a live agent could write again
 *   between the undo and its end.
 *
 * The reversal itself, all or nothing, is revertStepWrites.
 */

const LIVE_ATTEMPT_STATUSES = ["leased", "running", "canceling"];

type RevertInput = Readonly<{ reason?: string }>;

export async function revertRunStepWrites(
  context: ActionContext,
  rawInput: unknown,
) {
  if (context.agentSession !== undefined) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = (rawInput ?? {}) as RevertInput;
  const runId = context.params.id;
  const stepKey = context.params.stepKey;
  if (!runId || !stepKey) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  // Run first, then its steps, then the jobs: the order the engine locks them.
  const run = await transaction.query<{ id: string }>(
    `select id from bakery.workflow_runs
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, runId],
  );
  if (!run.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const steps = await transaction.query<{ id: string }>(
    `select id from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
      order by iteration
        for update`,
    [organizationId, runId, stepKey],
  );
  if (steps.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const attempts = await transaction.query<{ id: string; status: string }>(
    `select attempt.id, attempt.status
       from bakery.jobs job
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
      where job.organization_id = $1 and job.run_step_id = any($2::uuid[])`,
    [organizationId, steps.rows.map((step) => step.id)],
  );
  if (
    attempts.rows.some((attempt) =>
      LIVE_ATTEMPT_STATUSES.includes(attempt.status)
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "attempt_live" },
    });
  }

  const result = await revertStepWrites(
    context,
    attempts.rows.map((attempt) => attempt.id),
  );
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runSteps.revertWrites",
    resourceType: "run_step",
    resourceId: steps.rows[steps.rows.length - 1].id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      runId,
      stepKey,
      reverted: result.reverted,
      entries: result.entries,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  });
  return { runId, stepKey, ...result };
}
