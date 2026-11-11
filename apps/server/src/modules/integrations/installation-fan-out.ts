import { StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { GITHUB_PROVIDER } from "./postgres.ts";

/** Lifecycle of a host-owned installation row. */
export const InstallationStatus = Object.freeze(
  {
    Pending: "pending",
    Enabled: "enabled",
    Suspended: "suspended",
    Revoked: "revoked",
  } as const,
);
export type InstallationStatus =
  (typeof InstallationStatus)[keyof typeof InstallationStatus];

export const RECONCILE_OPERATION = "integrationInstallations.reconcile";
export const HEALTH_CHANGED = "integration.health_changed";
const CONNECTION_UPDATED = "integrationConnections.updated";

/** Safe problem codes reconciliation stores on the affected connections. */
const ReconcileProblem = Object.freeze(
  {
    Suspended: "installation_suspended",
    Revoked: "installation_revoked",
  } as const,
);

/**
 * How one live connection follows its installation into `next`. Lifecycle
 * status changes only on revoke; an unsuspend clears the suspension problem
 * and asks for revalidation (health unknown) but never enables a connection
 * an Admin disabled.
 */
export function connectionFanOut(
  connection: { status: string; health: string },
  next: InstallationStatus,
): { status: string; health: string; problem: string | null } {
  if (next === InstallationStatus.Revoked) {
    return {
      status: "revoked",
      health: "unknown",
      problem: ReconcileProblem.Revoked,
    };
  }
  if (next === InstallationStatus.Suspended) {
    return {
      status: connection.status,
      health: "degraded",
      problem: ReconcileProblem.Suspended,
    };
  }
  return { status: connection.status, health: "unknown", problem: null };
}

type LiveConnection = {
  id: string;
  organizationId: string;
  status: string;
  health: string;
};

/** Live connections of every organization on the installation, by id. */
export async function liveConnections(
  transaction: PgTransactionClient,
  installationId: string,
  lock: boolean,
): Promise<LiveConnection[]> {
  const result = await transaction.query<LiveConnection>(
    `select id, organization_id as "organizationId", status, health
       from bakery.integration_connections
      where installation_id = $1 and archived_at is null
      order by id
      ${lock ? "for update" : ""}`,
    [installationId],
  );
  return result.rows;
}

/**
 * Moves every live connection on the installation after its row went from
 * `from` to `to`, with audit and events per connection. The caller holds the
 * installation row lock, so connection locks follow it. `cover` runs for each
 * locked connection before its row changes. The audit names the operation
 * that caused the move, a reconcile by default. `actor` is the principal who
 * caused it; only rows of the actor's own organization name them, so no
 * organization's audit names another organization's principal.
 */
export async function fanOutConnections(
  transaction: PgTransactionClient,
  installationId: string,
  from: InstallationStatus,
  to: InstallationStatus,
  traceId: string,
  options: {
    cover?: (connectionId: string) => void;
    operation?: string;
    actor?: { organizationId: string; principalId: string };
  } = {},
): Promise<number> {
  const {
    cover = () => {},
    operation = RECONCILE_OPERATION,
    actor,
  } = options;
  const connections = await liveConnections(transaction, installationId, true);
  for (const connection of connections) cover(connection.id);
  for (const connection of connections) {
    const change = connectionFanOut(connection, to);
    const updated = await transaction.query<{ version: number }>(
      `update bakery.integration_connections
          set status = $3, health = $4, last_problem_code = $5,
              version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2
        returning version`,
      [
        connection.organizationId,
        connection.id,
        change.status,
        change.health,
        change.problem,
      ],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) throw new StandardError({ code: "INTERNAL" });
    await appendAudit(transaction, {
      organizationId: connection.organizationId,
      principalId: actor?.organizationId === connection.organizationId
        ? actor.principalId
        : null,
      operation,
      resourceType: "integration_connection",
      resourceId: connection.id,
      requestId: traceId,
      traceId,
      details: {
        provider: GITHUB_PROVIDER,
        installation: { from, to },
        status: { from: connection.status, to: change.status },
        health: { from: connection.health, to: change.health },
      },
    });
    if (change.status !== connection.status) {
      await appendDomainEvent(transaction, {
        organizationId: connection.organizationId,
        eventType: CONNECTION_UPDATED,
        aggregateId: connection.id,
        aggregateVersion: version,
        payload: { resourceId: connection.id, resourceVersion: version },
        traceId,
      });
    }
    if (change.health !== connection.health) {
      await appendDomainEvent(transaction, {
        organizationId: connection.organizationId,
        eventType: HEALTH_CHANGED,
        aggregateId: connection.id,
        aggregateVersion: version,
        payload: { resourceId: connection.id, resourceVersion: version },
        traceId,
      });
    }
  }
  return connections.length;
}
