import { StandardError, unprocessable } from "@bakery/contracts/http";
import { REVIEW_LOOP_LIMITS } from "@bakery/contracts/review-evidence";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";
import { appendDecision } from "../work/human-approval-store.ts";
import { reopenFailedRun } from "../work/run-reopen.ts";
import { PLAN_LIMIT_REACHED_CODE } from "../workflow-adapter/bakery-postgres-store.ts";
import { LIMIT_DECISION_SUBJECT_KIND } from "./plan-host.ts";
import { isPlanRunSnapshot } from "./plan-run-view.ts";
import { REPAIR_ALLOWANCE_OPERATION } from "./repair-allowance.ts";

export type RepeatLimitStop = {
  readonly repeatKey: string;
  readonly iterations: number;
  readonly allowed: number;
  readonly max: number;
};

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function readLimitStop(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RepeatLimitStop | undefined> {
  const failure = await transaction.query<
    { details: Record<string, unknown> | null }
  >(
    `select details from bakery.audit_events
      where organization_id = $1 and operation = 'workflow.plan_failed'
        and resource_id = $2
      order by created_at desc, id desc limit 1`,
    [organizationId, runId],
  );
  const details = failure.rows[0]?.details;
  if (!details || details.code !== PLAN_LIMIT_REACHED_CODE) return undefined;
  const { repeatKey, iterations, allowed, max } = details;
  if (
    typeof repeatKey !== "string" || !Number.isInteger(iterations) ||
    !Number.isInteger(allowed) || !Number.isInteger(max)
  ) return undefined;
  return {
    repeatKey,
    iterations: iterations as number,
    allowed: allowed as number,
    max: max as number,
  };
}

export async function findRepeatLimitStop(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RepeatLimitStop | undefined> {
  const run = await transaction.query<{ status: string }>(
    `select status from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  if (run.rows[0]?.status !== "failed") return undefined;
  return await readLimitStop(transaction, organizationId, runId);
}

export async function allowMoreRepeatRounds(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly runId: string;
    readonly tries: number;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<
  { decisionId: string; repeatKey: string; addedTries: number }
> {
  const { organizationId, runId } = input;
  if (
    !Number.isInteger(input.tries) || input.tries < 1 ||
    input.tries > REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling
  ) throw unprocessable(["tries"], "repair_tries_out_of_range");

  const run = await transaction.query<
    { snapshot: unknown; status: string; task_id: string }
  >(
    `select snapshot, status, task_id from bakery.workflow_runs
      where organization_id = $1 and id = $2 for update`,
    [organizationId, runId],
  );
  const row = run.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!isPlanRunSnapshot(row.snapshot)) conflict("not_a_plan_run");
  const stop = row.status === "failed"
    ? await readLimitStop(transaction, organizationId, runId)
    : undefined;
  if (stop === undefined) conflict("run_not_stopped_by_limit");
  const remaining = stop.max - stop.allowed;
  if (remaining < 1) conflict("repeat_at_max");
  const addedTries = Math.min(input.tries, remaining);

  const decision = await appendDecision(transaction, {
    organizationId,
    taskId: row.task_id,
    runId,
    kind: "limit_change",
    subjectKind: LIMIT_DECISION_SUBJECT_KIND,
    subjectId: runId,
    decidedBy: input.principalId,
    detail: {
      repeatKey: stop.repeatKey,
      previous: stop.allowed,
      next: stop.allowed + addedTries,
      addedTries,
      max: stop.max,
    },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: input.principalId,
    operation: REPAIR_ALLOWANCE_OPERATION,
    resourceType: "workflow_run",
    resourceId: runId,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      limitDecisionId: decision.id,
      repeatKey: stop.repeatKey,
      addedTries,
    },
  });
  await reopenFailedRun(transaction, {
    organizationId,
    runId,
    principalId: input.principalId,
    requestId: input.requestId,
    traceId: input.traceId,
    reason: "repeat_limit_allowed",
  });
  return { decisionId: decision.id, repeatKey: stop.repeatKey, addedTries };
}
