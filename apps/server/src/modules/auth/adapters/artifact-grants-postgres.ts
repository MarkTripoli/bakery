import {
  type CatalogPermissionKey,
  OrganizationRole,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { OrganizationActor } from "../application/authority.ts";
import {
  type AuthorizationResource,
  authorize,
} from "../application/authorize.ts";

/**
 * Authorizes a draft action for a connection that is not an ordinary action
 * request (the collaboration socket). The organization role decides first; when
 * it refuses, a live `edit` grant on the draft's document may still allow it.
 * `draftId` is the room being used, or null when the person is only connecting
 * and no room is named yet: then any live `edit` grant in the organization
 * lets them connect, and each room is checked as it is joined.
 *
 * The grant row is read `for share`, so a concurrent revoke is ordered before
 * or after this check. A grant never helps a non-human or a member with no
 * system role; only a permission miss is widened, any other error is the answer.
 */
export async function authorizeDraftAccess(
  transaction: PgTransactionClient,
  actor: OrganizationActor,
  permission: CatalogPermissionKey,
  resource: AuthorizationResource,
  draftId: string | null,
): Promise<void> {
  try {
    authorize(actor, permission, resource);
    return;
  } catch (denied) {
    if (
      !(denied instanceof StandardError) ||
      (denied.code !== "AUTH_FORBIDDEN" &&
        denied.code !== "RESOURCE_NOT_FOUND") ||
      actor.subject.principalType !== PrincipalType.Human ||
      actor.role === undefined ||
      (actor.role === OrganizationRole.Guest && actor.customRole === undefined)
    ) throw denied;
    const found = await transaction.query<{ artifactId: string }>(
      draftId === null
        ? `select grant_row.artifact_id as "artifactId"
             from bakery.artifact_access_grants as grant_row
            where grant_row.organization_id = $1 and grant_row.principal_id = $2
              and grant_row.level = 'edit' and grant_row.revoked_at is null
            limit 1
              for share of grant_row`
        : `select grant_row.artifact_id as "artifactId"
             from bakery.artifact_drafts as draft
             join bakery.artifact_access_grants as grant_row
               on grant_row.organization_id = draft.organization_id
              and grant_row.artifact_id = draft.artifact_id
            where draft.organization_id = $1 and draft.id = $3
              and grant_row.principal_id = $2
              and grant_row.level = 'edit' and grant_row.revoked_at is null
              for share of grant_row`,
      draftId === null
        ? [actor.organizationId, actor.subject.principalId]
        : [actor.organizationId, actor.subject.principalId, draftId],
    );
    const grant = found.rows[0];
    if (grant === undefined) throw denied;
    authorize(
      {
        ...actor,
        artifactGrant: { artifactId: grant.artifactId, level: "edit" },
      },
      permission,
      resource,
    );
  }
}
