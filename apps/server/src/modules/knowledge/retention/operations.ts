import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import { readStorageCapacity } from "../../../platform/storage-capacity.ts";
import { hasProtectedArtifactReference } from "./references.ts";
import { isTerminalTask } from "./policy.ts";

export async function updateArtifactPin(
  context: ActionContext,
  input: { readonly pinned: boolean },
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const artifactId = context.params.id;
  const parents = await transaction.query<{ version: number; task_id: string }>(
    "select version,task_id from bakery.artifacts where organization_id=$1 and id=$2 for update",
    [organizationId, artifactId],
  );
  const parent = parents.rows[0];
  if (!parent) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (Number(parent.version) !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const versions = await transaction.query<{ id: string; expired: boolean }>(
    "select id, (expires_at <= now() and purged_at is null) as expired from bakery.artifact_versions where organization_id=$1 and artifact_id=$2 order by id for update",
    [organizationId, artifactId],
  );
  const task = await transaction.query<{ status: string }>(
    "select status from bakery.tasks where organization_id=$1 and id=$2",
    [organizationId, parent.task_id],
  );
  let unpinEligible = false;
  if (!input.pinned && task.rows[0] && isTerminalTask(task.rows[0].status)) {
    for (const version of versions.rows) {
      if (
        version.expired &&
        !await hasProtectedArtifactReference(
          transaction,
          organizationId,
          version.id,
        )
      ) {
        unpinEligible = true;
        break;
      }
    }
  }
  const updated = await transaction.query<
    {
      id: string;
      pinned_at: Date | null;
      pinned_by: string | null;
      version: number;
    }
  >(
    `update bakery.artifacts set pinned_at=case when $3 then now() else null end,pinned_by=case when $3 then $4::uuid else null end,
    updated_at=now(),version=version+1,row_version=row_version+1 where organization_id=$1 and id=$2 returning id,pinned_at,pinned_by,version`,
    [organizationId, artifactId, input.pinned, principalId],
  );
  const row = updated.rows[0];
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifacts.update",
    resourceType: "artifact",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { pinned: input.pinned, version: row.version, unpinEligible },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    taskId: parent.task_id,
    eventType: "artifact.updated",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: context.traceId,
  });
  return {
    id: row.id,
    pinned: input.pinned,
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    pinnedBy: row.pinned_by,
    version: row.version,
    unpinEligible,
  };
}

export async function getArtifactStorage(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const capacity = await readStorageCapacity();
  const usage = await transaction.query<
    { retained_bytes: string; pinned_bytes: string }
  >(
    `select coalesce(sum(v.size_bytes),0)::text as retained_bytes,
    coalesce(sum(v.size_bytes) filter (where a.pinned_at is not null),0)::text as pinned_bytes
    from bakery.artifact_versions v join bakery.artifacts a on a.organization_id=v.organization_id and a.id=v.artifact_id
    where v.organization_id=$1 and v.purged_at is null`,
    [organizationId],
  );
  return {
    ...capacity,
    retainedBytes: Number(usage.rows[0].retained_bytes),
    pinnedBytes: Number(usage.rows[0].pinned_bytes),
  };
}
