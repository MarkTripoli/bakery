import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CoordinationPlanSpec,
  topologicalOrder,
} from "./coordination-plan.ts";
import type { PlanRecord } from "./coordination-projection.ts";
import { type LaneRow, loadPlanLanes } from "./coordination-query.ts";
import {
  type CurrentOutput,
  currentOutputForInput,
  isInputStale,
  loadConsumedInputs,
  loadCurrentOutputs,
  outputLookupKey,
} from "./coordination-stale.ts";

/** Completed lanes of earlier revisions per lane key, nearest revision first. */
async function reusableLanes(
  transaction: PgTransactionClient,
  organizationId: string,
  plan: PlanRecord,
): Promise<Map<string, LaneRow[]>> {
  const earlier = await transaction.query<{ id: string }>(
    `select id from bakery.coordination_plans
      where organization_id = $1 and parent_task_id = $2 and revision < $3
      order by revision desc`,
    [organizationId, plan.parent_task_id, plan.revision],
  );
  const reusable = new Map<string, LaneRow[]>();
  if (earlier.rows.length === 0) return reusable;
  const grouped = await loadPlanLanes(
    transaction,
    organizationId,
    earlier.rows.map((row) => row.id),
  );
  for (const { id } of earlier.rows) {
    for (const lane of grouped.get(id) ?? []) {
      if (lane.child_task_id !== null && lane.child_status === "completed") {
        const list = reusable.get(lane.lane_key) ?? [];
        // One child can appear in several revisions through reuse.
        if (!list.some((c) => c.child_task_id === lane.child_task_id)) {
          list.push(lane);
        }
        reusable.set(lane.lane_key, list);
      }
    }
  }
  return reusable;
}

/**
 * Which pending lanes reuse a completed child of an earlier revision. A lane
 * is reusable only when its lane digest matches, its candidate child is not
 * stale (its latest completed run consumed the current committed version of
 * every upstream output it used, judged against the upstream child this
 * revision keeps) and no lane upstream of it, direct or transitive, gets a
 * fresh child in this revision. Reworking `web` and `mobile` therefore also
 * reworks the `integration` consumer, so the new revision settles instead of
 * going stale again.
 */
export async function decideLaneReuse(
  transaction: PgTransactionClient,
  organizationId: string,
  plan: PlanRecord,
  spec: CoordinationPlanSpec,
  lanes: readonly LaneRow[],
): Promise<Map<string, LaneRow>> {
  const candidates = await reusableLanes(transaction, organizationId, plan);
  const decided = new Map<string, LaneRow>();
  if (candidates.size === 0) return decided;
  const candidateChildren = [
    ...new Set(
      [...candidates.values()].flat().map((lane) =>
        lane.child_task_id as string
      ),
    ),
  ];
  const consumed = await loadConsumedInputs(
    transaction,
    organizationId,
    candidateChildren,
  );
  const outputs = await loadCurrentOutputs(
    transaction,
    organizationId,
    [
      ...new Set([
        ...candidateChildren,
        ...lanes.flatMap((lane) => lane.child_task_id ?? []),
      ]),
    ],
  );
  const laneByKey = new Map(lanes.map((lane) => [lane.lane_key, lane]));
  const specByKey = new Map(spec.lanes.map((lane) => [lane.key, lane]));
  const fresh = new Set<string>();
  const childOf = (key: string): string | null =>
    decided.get(key)?.child_task_id ?? laneByKey.get(key)?.child_task_id ??
      null;
  for (const key of topologicalOrder(spec.lanes).order) {
    const lane = laneByKey.get(key);
    // A lane that already has its child is kept as it is.
    if (!lane || lane.child_task_id !== null) continue;
    const upstreamFresh = (specByKey.get(key)?.prerequisites ?? []).some((p) =>
      fresh.has(p)
    );
    const chosen = upstreamFresh ? undefined : (candidates.get(key) ?? [])
      .find((candidate) => {
        if (candidate.lane_digest !== lane.lane_digest) return false;
        const current = new Map<string, CurrentOutput | null>();
        const inputs = consumed.get(candidate.child_task_id as string) ?? [];
        for (const input of inputs) {
          current.set(
            outputLookupKey(input.fromLane, input.outputKey),
            currentOutputForInput(
              outputs,
              input,
              childOf(input.fromLane),
              laneByKey.get(input.fromLane)?.declared_outputs,
            ),
          );
        }
        // A candidate that declares inputs but recorded none cannot show it
        // saw the current upstream outputs.
        if (candidate.declared_input_count > 0 && inputs.length === 0) {
          return false;
        }
        return !inputs.some((input) => isInputStale(input, current));
      });
    if (chosen) decided.set(key, chosen);
    else fresh.add(key);
  }
  return decided;
}
