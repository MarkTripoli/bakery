/**
 * The receipt-time gate of an event trigger (issue #36): whether an enabled
 * automation of one organization is bound to hear this kind of event for one
 * Bakery repository (the provider has already said the kind is one it routes). It is the coarse half of matching, and it is read-only:
 * the receipt creates an `automation` route only when it says yes, so a
 * delivery nobody listens for costs no route and wakes nothing. The exact half
 * (action and filter) is `eventMatches`, applied by the consumer against the
 * stored receipt.
 */
import type { PgTransactionClient } from "../../../platform/database.ts";

/**
 * True when the organization has an enabled automation whose active version is
 * an event trigger of this kind, bound to this repository.
 */
export async function automationListens(
  transaction: PgTransactionClient,
  scope: Readonly<{
    organizationId: string;
    repositoryId: string;
    eventKind: string;
  }>,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1
       from bakery.automation_definitions definition
       join bakery.automation_versions version
         on version.organization_id = definition.organization_id
        and version.id = definition.active_version_id
      where definition.organization_id = $1
        and definition.enabled
        and version.repository_id = $2
        and version.trigger ->> 'type' = 'event'
        and version.trigger ->> 'kind' = $3
      limit 1`,
    [scope.organizationId, scope.repositoryId, scope.eventKind],
  );
  return found.rows.length > 0;
}
