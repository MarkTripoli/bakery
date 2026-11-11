import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { OrganizationActor } from "../../auth/application/authority.ts";
import { authorize } from "../../auth/application/authorize.ts";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import {
  appRevisionPath,
  isPreviewableMediaType,
  PREVIEW_EXCHANGE_PATH,
  PREVIEW_ORIGIN_NOT_CONFIGURED,
} from "./shared.ts";
import {
  insertPreviewGrant,
  readPreviewGrantOwner,
  revokePreviewGrant,
} from "./store.ts";

export type ArtifactPreviewDependencies = {
  /** Validated `BAKERY_ARTIFACT_PREVIEW_ORIGIN`, absent when unconfigured. */
  readonly previewOrigin?: string;
};

export function previewAvailability(
  dependencies: ArtifactPreviewDependencies,
): { available: boolean } {
  return { available: dependencies.previewOrigin !== undefined };
}

/**
 * Issues a one-use grant. The response carries the secret, so this action is
 * a query-kind POST: the command runner never stores it as a replayable body.
 */
export async function createPreviewGrant(
  context: ActionContext,
  dependencies: ArtifactPreviewDependencies,
) {
  const origin = dependencies.previewOrigin;
  if (origin === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: PREVIEW_ORIGIN_NOT_CONFIGURED },
    });
  }
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const versionId = context.params.id;
  const found = await transaction.query<{
    artifact_id: string;
    task_id: string;
    media_type: string;
    purged_at: Date | null;
  }>(
    `select v.artifact_id, v.task_id, v.media_type, v.purged_at
       from bakery.artifact_versions v
       join bakery.artifacts a
         on a.organization_id = v.organization_id
        and a.id = v.artifact_id and a.task_id = v.task_id
       join bakery.tasks t
         on t.organization_id = v.organization_id and t.id = v.task_id
      where v.organization_id = $1 and v.id = $2
        and (
          v.run_step_id is null or exists (
            select 1
              from bakery.run_steps rs
              join bakery.workflow_runs wr
                on wr.organization_id = rs.organization_id
               and wr.id = rs.run_id
             where rs.organization_id = v.organization_id
               and rs.id = v.run_step_id and wr.task_id = v.task_id
          )
        )`,
    [organizationId, versionId],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.purged_at !== null) {
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  if (!isPreviewableMediaType(row.media_type)) {
    throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const grant = await insertPreviewGrant(transaction, {
    organizationId,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    versionId,
    principalId,
  });
  // The audit record names the grant id only: never the secret.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifactPreviews.create",
    resourceType: "artifact_version",
    resourceId: versionId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { grantId: grant.grantId },
  });
  return {
    grantId: grant.grantId,
    grant: grant.secret,
    exchangeUrl: `${origin}${PREVIEW_EXCHANGE_PATH}`,
    expiresAt: grant.expiresAt,
    revisionPath: appRevisionPath(row.task_id, row.artifact_id, versionId),
  };
}

/** The grant's principal or an organization administrator closes a preview. */
export async function revokePreview(context: ActionContext): Promise<null> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const grantId = context.params.id;
  const owner = await readPreviewGrantOwner(
    transaction,
    organizationId,
    grantId,
  );
  if (!owner) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (owner.principalId !== principalId) {
    // Closing someone else's preview is an administrator's moderation power.
    const authority = (context as { authority?: OrganizationActor }).authority;
    if (!authority) throw new StandardError({ code: "AUTH_FORBIDDEN" });
    authorize(authority, "artifact:manage", {
      action: "artifactPreviews.revoke",
    });
  }
  if (owner.revoked) return null;
  await revokePreviewGrant(transaction, organizationId, grantId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifactPreviews.revoke",
    resourceType: "artifact_preview_grant",
    resourceId: grantId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {},
  });
  return null;
}
