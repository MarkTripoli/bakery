/**
 * A compiled-plan run, read the way the review and repair loop reads a flat one
 * (issue #397).
 *
 * The loop's helpers (`candidateHeadSha`, `candidateProducer`, `harnessStepKeys`
 * and the four `$delivery` resolvers) read a run through its frozen spec: an
 * ordered list of `{ id, uses }` steps. A plan run freezes no such list, because
 * the engine appends its steps as the plan decides them, so this module builds
 * the same list from the rows the run actually has: one entry per dispatched
 * step, in the order the engine appended them, naming the step key (qualified,
 * `repair@2.repair_review`) and the action its dispatch recorded. Feeding that
 * view to the existing helpers keeps one definition of "the candidate", "the
 * implementing steps" and each `$delivery` reference for both kinds of run; no
 * second implementation of any of them exists.
 *
 * The functions here only read. They never name a template or a preset.
 */
import { buildWorkflowPlan } from "@bakery/contracts/workflow-compiler";
import type { WorkflowSemanticDocument } from "@bakery/contracts/workflow-compiler";
import { deliveryFactsFrom } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import { formatMicroUsd, parseMicroUsd } from "../work/budget.ts";

type JsonRecord = Record<string, unknown>;

const recordOf = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

/** True for a run snapshot that froze a compiled plan (it carries `runtime`). */
export function isPlanRunSnapshot(snapshot: unknown): boolean {
  const frozen = recordOf(snapshot);
  return frozen !== undefined && Object.hasOwn(frozen, "runtime");
}

/** One dispatched step of a plan run: its key and the action it recorded. */
export type PlanRunStep = Readonly<{ stepKey: string; action: string }>;

type StepRow = { step_key: string; action: string | null };

/**
 * The run's dispatched steps in the order they were appended. A row with no
 * recorded action (a wait, or a row nothing dispatched) is not a step the loop
 * reads and is left out.
 */
export async function loadPlanRunSteps(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<readonly PlanRunStep[]> {
  const result = await transaction.query<StepRow>(
    `select step_key, dispatch ->> 'action' as action
       from bakery.run_steps
      where organization_id = $1 and run_id = $2
      order by position, id`,
    [input.organizationId, input.runId],
  );
  return result.rows.flatMap((row) =>
    typeof row.action === "string" && row.action.length > 0
      ? [{ stepKey: row.step_key, action: row.action }]
      : []
  );
}

/**
 * The snapshot with a frozen spec made of the run's dispatched steps, which is
 * what the flat helpers read. Every other section of the snapshot is kept as
 * frozen. `stepActions` is emptied so each step's output name comes from the
 * action registry, which is the one place an action's output is defined.
 */
export function planRunView(
  snapshot: unknown,
  steps: readonly PlanRunStep[],
): unknown {
  const frozen = recordOf(snapshot);
  if (frozen === undefined) return snapshot;
  return {
    ...frozen,
    workflow: {
      ...(recordOf(frozen.workflow) ?? {}),
      normalizedSpec: {
        steps: steps.map(({ stepKey, action }) => ({
          id: stepKey,
          uses: action,
        })),
      },
    },
    stepActions: {},
  };
}

/** The run's snapshot as the review loop reads it: a plan run's view, else as is. */
export async function loopSnapshotOf(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly snapshot: unknown;
  },
): Promise<unknown> {
  if (!isPlanRunSnapshot(input.snapshot)) return input.snapshot;
  return planRunView(
    input.snapshot,
    await loadPlanRunSteps(transaction, input),
  );
}

/**
 * What the run will reserve for one more repair and review: the frozen
 * reservations of the plan's repair and review agents, in micro-USD. A step's
 * own agent wins over the fallback bound to its action; an action the plan does
 * not use, or an agent that is unbilled, reserves nothing.
 *
 * A further cycle runs the body of a repeat (the reviewed preset's repair and
 * review iterations), not its seed and not the steps that ran once before the
 * loop, so an action that sits in a body reserves the body's steps and nothing
 * else. A step bound to its own agent can carry a different reservation from
 * the action's fallback, which is why the cycle is summed over steps rather
 * than read from the first step that names the action. When an action has no
 * body step the plan runs it once outside a loop, so its steps are reserved as
 * they were before; reserving too much stops a loop early, never mid-round.
 */
export function planNextCycleReservation(snapshot: unknown): bigint {
  const frozen = recordOf(snapshot);
  const document = recordOf(frozen?.runtime)?.document;
  if (frozen === undefined || document === undefined) return 0n;
  const plan = buildWorkflowPlan(document as WorkflowSemanticDocument);
  const fallbacks = recordOf(frozen.planActionAgents) ?? {};
  const agents = recordOf(frozen.planAgents) ?? {};
  const reservation = (
    step: (typeof plan.steps)[number],
  ): bigint => {
    const action = step.action ?? "";
    const own = step.agentVersionId;
    const fallback = fallbacks[action];
    const agentId = own ?? (typeof fallback === "string" ? fallback : null);
    if (agentId === null) return 0n;
    const billing = recordOf(
      recordOf(recordOf(agents[agentId])?.config)?.billing,
    );
    const amount = billing?.maxUsdReservation;
    return amount === undefined
      ? 0n
      : parseMicroUsd(amount, "max_usd_reservation");
  };
  // The steps one more cycle runs for an action: every body step of a repeat
  // (no seed iteration, so it runs again), else every step of the action. A
  // forEach is not a cycle: a step inside one only is not a body step.
  const cycleSteps = (action: string) => {
    const matching = plan.steps.filter((candidate) =>
      candidate.kind === "action" && candidate.action === action
    );
    const body = matching.filter((candidate) =>
      candidate.loops.some((loop) => loop.kind === "repeat") &&
      candidate.loops.every((loop) => !loop.seed)
    );
    return body.length > 0 ? body : matching;
  };
  return [
    ...cycleSteps("harness.repair"),
    ...cycleSteps("review.independent"),
  ].reduce((total, step) => total + reservation(step), 0n);
}

/** Decimal USD of {@link planNextCycleReservation}, as the budget headroom reads it. */
export function planNextCycleUsd(snapshot: unknown): string {
  return formatMicroUsd(planNextCycleReservation(snapshot));
}

/**
 * The `$delivery` object a plan's step inputs and conditions read, or
 * `undefined` while the run has no candidate yet (so a plan that reads it too
 * early fails with `delivery_unresolved` instead of a silent null). A field
 * whose evidence does not exist yet is absent and reads as null.
 */
export function planDeliveryFrom(
  snapshot: unknown,
  stepOutputs: unknown,
): Record<string, unknown> | undefined {
  const facts = deliveryFactsFrom(snapshot, stepOutputs);
  return Object.hasOwn(facts, "headSha") ? facts : undefined;
}
