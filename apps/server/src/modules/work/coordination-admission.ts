import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  CoordinationPlanSpecSchema,
  projectLaneStatuses,
} from "./coordination-plan.ts";
import { hasStaleUpstream } from "./coordination-stale.ts";
import { laneProjectionStatus, loadPlanLanes } from "./coordination-query.ts";

/** Typed artifact reference a dependant lane receives from an upstream lane. */
export type LaneHandoffInput = Readonly<{
  fromLane: string;
  outputKey: string;
  childTaskId: string;
  artifactId: string;
  artifactVersionId: string;
  sha256: string;
}>;

export type LaneCoordinationSnapshot = Readonly<{
  planId: string;
  planRevision: number;
  laneKey: string;
  inputs: readonly LaneHandoffInput[];
}>;

export type LaneAdmission = Readonly<{
  reason: string | null;
  snapshot: LaneCoordinationSnapshot;
}>;

type CommittedArtifact = {
  artifact_id: string;
  version_id: string;
  sha256: string;
};

async function committedArtifact(
  transaction: PgTransactionClient,
  organizationId: string,
  childTaskId: string,
  name: string,
  artifactType: string,
): Promise<CommittedArtifact | null> {
  const result = await transaction.query<CommittedArtifact>(
    `select a.id as artifact_id, v.id as version_id, v.sha256
       from bakery.artifacts a
       join bakery.artifact_versions v
         on v.organization_id = a.organization_id
        and v.artifact_id = a.id
        and v.id = a.current_version_id
      where a.organization_id = $1 and a.task_id = $2 and a.name = $3
        and a.artifact_type = $4
      order by a.created_at desc, a.id desc
      limit 1`,
    [organizationId, childTaskId, name, artifactType],
  );
  return result.rows[0] ?? null;
}

/**
 * Admission gate for a coordination lane child. A dependant waits until every
 * prerequisite lane child is completed with each declared output committed as
 * an artifact; the committed references are frozen into the run as typed
 * inputs. A failed or stopped upstream lane rejects the run (stop-dependent).
 * A stale upstream lane, direct or transitive, refuses it with
 * `lane_prerequisite_stale`.
 * Returns null for a task that is not a lane child.
 */
export async function evaluateLaneAdmission(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<LaneAdmission | null> {
  const found = await transaction.query<
    {
      lane_key: string;
      plan_id: string;
      revision: number;
      plan_status: string;
      spec: unknown;
    }
  >(
    `select l.lane_key, l.plan_id, p.revision, p.status as plan_status, p.spec
       from bakery.coordination_lanes l
       join bakery.coordination_plans p
         on p.organization_id = l.organization_id and p.id = l.plan_id
      where l.organization_id = $1 and l.child_task_id = $2
      order by p.revision desc
      limit 1
      for share of p`,
    [organizationId, taskId],
  );
  const own = found.rows[0];
  if (!own) return null;
  if (own.plan_status === "canceled" || own.plan_status === "superseded") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "coordination_plan_inactive" },
    });
  }
  const lanes = (await loadPlanLanes(transaction, organizationId, [
    own.plan_id,
  ])).get(own.plan_id) ?? [];
  const projection = projectLaneStatuses(lanes.map((lane) => ({
    key: lane.lane_key,
    prerequisites: lane.prerequisites,
    status: laneProjectionStatus(lane),
  })));
  if (projection.lanes.get(own.lane_key) === "stopped") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "lane_prerequisite_failed" },
    });
  }
  const spec = CoordinationPlanSpecSchema.parse(own.spec);
  const laneSpec = spec.lanes.find((lane) => lane.key === own.lane_key);
  const byKey = new Map(lanes.map((lane) => [lane.lane_key, lane]));
  let reason: string | null = null;
  // A stale lane anywhere upstream (direct or transitive) blocks the run: its
  // committed output no longer matches what its own inputs were built from.
  const staleLanes = new Set(
    lanes.filter((lane) => lane.stale).map((lane) => lane.lane_key),
  );
  if (
    hasStaleUpstream(
      own.lane_key,
      new Map(lanes.map((lane) => [lane.lane_key, lane.prerequisites])),
      staleLanes,
    )
  ) reason = "lane_prerequisite_stale";
  for (const prerequisite of laneSpec?.prerequisites ?? []) {
    if (reason === "lane_prerequisite_stale") break;
    const upstream = byKey.get(prerequisite);
    if (
      !upstream?.child_task_id || upstream.child_status !== "completed"
    ) {
      reason = "lane_prerequisite_incomplete";
      continue;
    }
    for (
      const output of upstream.declared_outputs as {
        key: string;
        artifactType?: string;
      }[]
    ) {
      const artifact = await committedArtifact(
        transaction,
        organizationId,
        upstream.child_task_id,
        output.key,
        output.artifactType ?? "patch",
      );
      if (!artifact) reason ??= "lane_outputs_missing";
    }
  }
  const inputs: LaneHandoffInput[] = [];
  if (reason === null) {
    for (const input of laneSpec?.inputs ?? []) {
      const upstream = byKey.get(input.fromLane);
      const declared = (upstream?.declared_outputs as
        | { key: string; artifactType?: string }[]
        | undefined)?.find((output) => output.key === input.outputKey);
      const artifact = upstream?.child_task_id
        ? await committedArtifact(
          transaction,
          organizationId,
          upstream.child_task_id,
          input.outputKey,
          declared?.artifactType ?? "patch",
        )
        : null;
      if (!upstream?.child_task_id || !artifact) {
        reason = "lane_outputs_missing";
        break;
      }
      inputs.push({
        fromLane: input.fromLane,
        outputKey: input.outputKey,
        childTaskId: upstream.child_task_id,
        artifactId: artifact.artifact_id,
        artifactVersionId: artifact.version_id,
        sha256: artifact.sha256,
      });
    }
  }
  return {
    reason,
    snapshot: {
      planId: own.plan_id,
      planRevision: own.revision,
      laneKey: own.lane_key,
      inputs: reason === null ? inputs : [],
    },
  };
}
