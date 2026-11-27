import type { PgTransactionClient } from "../../platform/database.ts";
import { PLAN_LIMIT_REACHED_CODE } from "./bakery-postgres-store.ts";

export type RepeatLimitStop = Readonly<{
  repeatKey: string;
  iterations: number;
  allowed: number;
  max: number;
}>;

export async function readLimitStop(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RepeatLimitStop | undefined> {
  const latest = await transaction.query<
    { operation: string; details: Record<string, unknown> | null }
  >(
    `select operation, details from bakery.audit_events
      where organization_id = $1 and resource_type = 'workflow_run'
        and resource_id = $2
        and operation in ('workflow.plan_failed', 'runs.reopen')
      order by created_at desc, id desc limit 1`,
    [organizationId, runId],
  );
  const event = latest.rows[0];
  const details = event?.operation === "workflow.plan_failed"
    ? event.details
    : null;
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
