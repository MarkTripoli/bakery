import {
  DELIVERY_GATE_STEP_KEY,
  DELIVERY_LOOP_STOPPED_CODE,
  type DeliveryDecisionReason,
} from "@bakery/contracts/review-evidence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { reviewLoopSteps } from "./loop-steps.ts";

/**
 * The two ways a decision changes the shape of a run. Both only insert
 * `run_steps` rows, which the application role may do at any time; the engine
 * picks the lowest open `(position, iteration, id)` row, so a row appended
 * above the run's highest position runs after everything already there.
 */

/** Rows of one appended iteration, in the order the engine will run them. */
export type AppendedIteration = ReadonlyArray<{
  readonly stepKey: string;
  readonly position: number;
  readonly iteration: number;
}>;

/** Highest position any step of the run holds, or -1 for a run with none. */
async function highestPosition(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<number> {
  const result = await transaction.query<{ position: number }>(
    `select coalesce(max(position), -1) as position
       from bakery.run_steps
      where organization_id = $1 and run_id = $2`,
    [input.organizationId, input.runId],
  );
  return Number(result.rows[0]?.position ?? -1);
}

/**
 * Appends the next repair iteration: a `repair`, a `check` and a `review` row,
 * `pending`, at `iteration = ordinal + 1` and at positions above every step the
 * run already has, in that order. The step keys are the ones of the spec steps
 * that run `harness.repair`, `quality.check` and `review.independent`, and the
 * stored input is the spec's own template: admission ignores it and derives the
 * real job input from the frozen spec when the engine claims the step, so
 * the row only needs to show what the step will be given. Nothing is skipped or
 * rewritten; a second call with the same ordinal hits the
 * `(run, step key, iteration)` unique key and fails.
 */
export async function appendIteration(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly snapshot: unknown;
    /** Ordinal of the decision that selected this repair. */
    readonly ordinal: number;
  },
): Promise<AppendedIteration> {
  const steps = reviewLoopSteps(input.snapshot);
  const base = await highestPosition(transaction, input);
  const iteration = input.ordinal + 1;
  const appended: Array<{
    stepKey: string;
    position: number;
    iteration: number;
  }> = [];
  for (
    const [offset, step] of [steps.repair, steps.check, steps.review].entries()
  ) {
    const position = base + 1 + offset;
    await transaction.query(
      `insert into bakery.run_steps (
         organization_id, run_id, step_key, position, iteration, status, input
       ) values ($1, $2, $3, $4, $5, 'pending', $6::jsonb)`,
      [
        input.organizationId,
        input.runId,
        step.key,
        position,
        iteration,
        JSON.stringify(step.input ?? {}),
      ],
    );
    appended.push({ stepKey: step.key, position, iteration });
  }
  return appended;
}

/**
 * Appends the step that records a stopped loop: `delivery_gate`, already
 * `failed`, carrying `{code, reason, decisionId}` as its error. The run roll-up
 * fails the run and its task because a step failed, with no new run status;
 * the review step that led here stays `completed`. The step is inserted
 * finished, so the engine never claims it.
 */
export async function appendStopGate(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    /** Ordinal of the decision that stopped the loop. */
    readonly ordinal: number;
    readonly reason: DeliveryDecisionReason;
    readonly decisionId: string;
  },
): Promise<void> {
  const position = await highestPosition(transaction, input) + 1;
  await transaction.query(
    `insert into bakery.run_steps (
       organization_id, run_id, step_key, position, iteration, status, input,
       error, started_at, finished_at
     ) values (
       $1, $2, $3, $4, $5, 'failed', '{}'::jsonb, $6::jsonb, now(), now()
     )`,
    [
      input.organizationId,
      input.runId,
      DELIVERY_GATE_STEP_KEY,
      position,
      input.ordinal,
      JSON.stringify({
        code: DELIVERY_LOOP_STOPPED_CODE,
        reason: input.reason,
        decisionId: input.decisionId,
      }),
    ],
  );
}
