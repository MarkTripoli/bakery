/**
 * What the review and repair loop tells the engine about a compiled-plan run
 * (issue #397). The engine reads it through an injected `PlanHostReader`, so
 * the kernel imports nothing from this module: the host composes the two where
 * it builds the engine.
 *
 * - `delivery` is `$delivery`: the four references the loop defines, resolved
 *   from the run's own rows by the same helpers a flat step uses. It is absent
 *   while the run has no candidate, so a plan that reads it too early fails
 *   with `delivery_unresolved`.
 * - `repeatExtra` is what a person allowed past a repeat's own bound (issue #62):
 *   the engine raises that repeat by it, and the document stays as pinned.
 * - `halt` ends the run failed when the loop recorded a stop: a repeated
 *   blocker, an exhausted bound or budget, an unavailable reviewer. A plan's
 *   `repeat` runs the repair and its own `max` bounds it; a stop the plan
 *   cannot see on its own is this.
 *
 * A run that froze no review loop answers with nothing, so a plan with no
 * review is exactly what it was.
 */
import { reviewLoopFromSnapshot } from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  loadRepairAllowances,
  loadStepOutputs,
  readLatestDecision,
} from "./review-store.ts";
import { loopSnapshotOf, planDeliveryFrom } from "./plan-run-view.ts";
import type { PlanHostFacts } from "../workflow-adapter/bakery-postgres-store.ts";

/** The failure code a plan run ends with when its review loop recorded a stop. */
export const PLAN_DELIVERY_STOPPED_CODE = "delivery_loop_stopped";

export const LIMIT_DECISION_SUBJECT_KIND = "workflow_run";

async function loadLimitExtras(
  transaction: PgTransactionClient,
  run: { readonly organizationId: string; readonly runId: string },
): Promise<Record<string, number>> {
  const decisions = await transaction.query<
    { detail: { repeatKey?: unknown; addedTries?: unknown } | null }
  >(
    `select detail from bakery.decisions_ledger
      where organization_id = $1 and subject_kind = $2 and subject_id = $3
        and kind = 'limit_change'
      order by decided_at, id`,
    [run.organizationId, LIMIT_DECISION_SUBJECT_KIND, run.runId],
  );
  const extras: Record<string, number> = {};
  for (const { detail } of decisions.rows) {
    if (
      typeof detail?.repeatKey === "string" &&
      typeof detail.addedTries === "number"
    ) {
      extras[detail.repeatKey] = (extras[detail.repeatKey] ?? 0) +
        detail.addedTries;
    }
  }
  return extras;
}

/** The host's facts about one plan run, for the engine's next decision. */
export async function readPlanHost(
  transaction: PgTransactionClient,
  run: {
    readonly organizationId: string;
    readonly runId: string;
    readonly runSnapshot: unknown;
  },
): Promise<PlanHostFacts> {
  const { organizationId, runId } = run;
  const limitExtras = await loadLimitExtras(transaction, run);
  if (reviewLoopFromSnapshot(run.runSnapshot) === null) {
    return Object.keys(limitExtras).length === 0
      ? {}
      : { repeatExtra: limitExtras };
  }
  const latest = await readLatestDecision(transaction, {
    organizationId,
    runId,
  });
  if (latest?.decision === "stop") return { halt: PLAN_DELIVERY_STOPPED_CODE };
  const snapshot = await loopSnapshotOf(transaction, {
    organizationId,
    runId,
    snapshot: run.runSnapshot,
  });
  const stepOutputs = await loadStepOutputs(transaction, {
    organizationId,
    runId,
  });
  const delivery = planDeliveryFrom(snapshot, stepOutputs);
  const repeatExtra: Record<string, number> = { ...limitExtras };
  for (
    const allowance of await loadRepairAllowances(transaction, {
      organizationId,
      runId,
    })
  ) {
    repeatExtra[allowance.repeatKey] = (repeatExtra[allowance.repeatKey] ?? 0) +
      allowance.addedTries;
  }
  return {
    ...(delivery === undefined
      ? {}
      : { delivery: delivery as PlanHostFacts["delivery"] }),
    ...(Object.keys(repeatExtra).length === 0 ? {} : { repeatExtra }),
  };
}
