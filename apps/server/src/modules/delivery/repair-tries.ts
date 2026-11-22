import {
  isBlockingSeverity,
  REVIEW_SEVERITIES,
} from "@bakery/contracts/review-evidence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { formatMicroUsd, parseMicroUsd } from "../work/budget.ts";

/**
 * One repair try of a run's review and repair loop, derived from what the run
 * already recorded (issue #62): the review cycles and their findings, the
 * decision taken after each, and the steps and usage of the try. Nothing here is
 * stored; the read is the explanation a person sees when a loop stops.
 */
export type RepairTryRecord = {
  /** The review cycle that judged the try. */
  readonly id: string;
  /** One-based; try 1 is the first repair and the review that followed it. */
  readonly number: number;
  readonly decision: string;
  readonly reason: string;
  readonly fixedFindings: number;
  readonly cameBackFindings: number;
  readonly newFindings: number;
  readonly blockingFindings: number;
  readonly checksPassed: boolean;
  readonly startedAt: Date | null;
  readonly durationMs: number | null;
  readonly costUsd: string | null;
  readonly createdAt: Date;
};

/** A review cycle as the derivation reads it. */
export type TryCycle = {
  readonly id: string;
  readonly ordinal: number;
  readonly createdAt: Date;
  readonly blockingCount: number;
  /** Fingerprints of the cycle's blocking findings. */
  readonly blocking: readonly string[];
  /** The first decision taken after the cycle, or null when none was recorded. */
  readonly decision: {
    readonly decision: string;
    readonly reason: string;
    readonly failedChecks: number;
  } | null;
};

/** A step of the run, with the usage it recorded. */
export type TryStep = {
  readonly stepKey: string;
  readonly iteration: number;
  readonly startedAt: Date | null;
  /** Sum of the step's usage records as a decimal string, or null with none. */
  readonly costUsd: string | null;
};

/** Which try a step belongs to: `repair@2.check` is try 2; a flat run's iteration is its try. */
export function tryOfStep(
  step: Pick<TryStep, "stepKey" | "iteration">,
): number {
  const marked = /@(\d+)\./.exec(step.stepKey);
  return marked === null ? step.iteration : Number(marked[1]);
}

/**
 * Derives the tries of a run. The first review (ordinal 0) is not a try; each
 * later review judges the repair before it. "Fixed" and "came back" compare the
 * blocking fingerprints of a review with the one before it, so a finding is
 * counted once and a rewording is not a new finding.
 */
export function deriveRepairTries(
  cycles: readonly TryCycle[],
  steps: readonly TryStep[],
): RepairTryRecord[] {
  const byOrdinal = new Map(cycles.map((cycle) => [cycle.ordinal, cycle]));
  return cycles.filter((cycle) => cycle.ordinal >= 1).map((cycle) => {
    const earlier = new Set(byOrdinal.get(cycle.ordinal - 1)?.blocking ?? []);
    const now = new Set(cycle.blocking);
    const cameBack = [...now].filter((fingerprint) => earlier.has(fingerprint));
    const own = steps.filter((step) => tryOfStep(step) === cycle.ordinal);
    const starts = own.flatMap(({ startedAt }) =>
      startedAt === null ? [] : [startedAt.getTime()]
    );
    const startedAt = starts.length === 0
      ? null
      : new Date(Math.min(...starts));
    const costs = own.flatMap(({ costUsd }) =>
      costUsd === null ? [] : [costUsd]
    );
    return {
      id: cycle.id,
      number: cycle.ordinal,
      decision: cycle.decision?.decision ?? "stop",
      reason: cycle.decision?.reason ?? "review_failed",
      fixedFindings: earlier.size - cameBack.length,
      cameBackFindings: cameBack.length,
      newFindings: now.size - cameBack.length,
      blockingFindings: cycle.blockingCount,
      checksPassed: (cycle.decision?.failedChecks ?? 0) === 0,
      startedAt,
      durationMs: startedAt === null
        ? null
        : Math.max(0, cycle.createdAt.getTime() - startedAt.getTime()),
      costUsd: costs.length === 0 ? null : formatMicroUsd(
        costs.reduce((sum, cost) => sum + parseMicroUsd(cost, "cost"), 0n),
      ),
      createdAt: cycle.createdAt,
    };
  });
}

type CycleRow = {
  id: string;
  ordinal: number;
  created_at: Date;
  blocking_count: number;
  blocking: string[];
  decision: string | null;
  reason: string | null;
  failed_checks: number | null;
};

type StepRow = {
  step_key: string;
  iteration: number;
  started_at: Date | null;
  cost: string | null;
};

/** Reads and derives every try of one run, under an explicit organization. */
export async function readRepairTries(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<RepairTryRecord[]> {
  const blockingSeverities = REVIEW_SEVERITIES.filter(isBlockingSeverity);
  const cycles = await transaction.query<CycleRow>(
    `select cycle.id, cycle.ordinal, cycle.created_at, cycle.blocking_count,
            coalesce((
              select array_agg(finding.fingerprint order by finding.fingerprint)
                from bakery.review_findings finding
               where finding.organization_id = cycle.organization_id
                 and finding.review_cycle_id = cycle.id
                 and finding.severity = any($3::text[])
            ), '{}') as blocking,
            first.decision, first.reason, first.failed_checks
       from bakery.review_cycles cycle
       left join lateral (
         select decision.decision, decision.reason,
                jsonb_array_length(decision.failed_checks) as failed_checks
           from bakery.delivery_decisions decision
          where decision.organization_id = cycle.organization_id
            and decision.review_cycle_id = cycle.id
          order by decision.ordinal asc
          limit 1
       ) as first on true
      where cycle.organization_id = $1 and cycle.run_id = $2
      order by cycle.ordinal asc`,
    [input.organizationId, input.runId, blockingSeverities],
  );
  const steps = await transaction.query<StepRow>(
    `select step.step_key, step.iteration, step.started_at,
            (
              select sum(usage.cost_usd)::text from bakery.usage_records usage
               where usage.organization_id = step.organization_id
                 and usage.run_step_id = step.id
            ) as cost
       from bakery.run_steps step
      where step.organization_id = $1 and step.run_id = $2`,
    [input.organizationId, input.runId],
  );
  return deriveRepairTries(
    cycles.rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      createdAt: row.created_at,
      blockingCount: row.blocking_count,
      blocking: row.blocking,
      decision: row.decision === null || row.reason === null ? null : {
        decision: row.decision,
        reason: row.reason,
        failedChecks: row.failed_checks ?? 0,
      },
    })),
    steps.rows.map((row) => ({
      stepKey: row.step_key,
      iteration: row.iteration,
      startedAt: row.started_at,
      costUsd: row.cost,
    })),
  );
}
