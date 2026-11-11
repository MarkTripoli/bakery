import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Write-time authority lock.
 *
 * A fact is stored from a provider read that can take seconds, and the
 * authority the caller checked before that read (an enabled installation and
 * connection, a selected and available repository) can change while it runs.
 * The route processor and the reconciliation sweep therefore read the same
 * three rows again inside the transaction that is about to write, and take a
 * `for share` lock on each, so none of them can change before that transaction
 * commits. The rows are locked in the order the reconcile and the discovery
 * take theirs (installation, connection, resource), so the lock cannot
 * deadlock against either. The verdict over what this returns is
 * `authorityVerdict` in `fact-reads.ts`; this module only reads.
 */

/** The ids of the rows to lock, as a route or a checkpoint carries them. */
export type AuthorityScope = {
  organizationId: string;
  connectionId: string;
  installationId: string;
  /** The repository resource the write is about; null when it is about none. */
  resourceId: string | null;
};

/** What the three locked rows say; a row that is gone or archived reads as null. */
export type LockedAuthority = {
  installation: { status: string } | null;
  connection: { status: string; installationId: string } | null;
  resource: { selected: boolean; available: boolean } | null;
};

/**
 * Locks the installation, connection and resource rows `for share`, in that
 * order, and returns what they hold. Call it first in the writing transaction.
 */
export async function lockAuthority(
  transaction: PgTransactionClient,
  scope: AuthorityScope,
): Promise<LockedAuthority> {
  const installation = (await transaction.query<{ status: string }>(
    `select status from bakery.integration_installations
      where id = $1 for share`,
    [scope.installationId],
  )).rows[0] ?? null;
  const connection = (await transaction.query<{
    status: string;
    installationId: string;
  }>(
    `select status, installation_id as "installationId"
       from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null
      for share`,
    [scope.organizationId, scope.connectionId],
  )).rows[0] ?? null;
  const resource = scope.resourceId === null
    ? null
    : (await transaction.query<{ selected: boolean; available: boolean }>(
      `select selected, available from bakery.integration_resources
        where organization_id = $1 and connection_id = $2 and id = $3
          and kind = 'repository' and archived_at is null
        for share`,
      [scope.organizationId, scope.connectionId, scope.resourceId],
    )).rows[0] ?? null;
  return { installation, connection, resource };
}
