import { StandardError } from "@bakery/contracts/http";
import { appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";

/** Scans of one installation start at least this far apart. */
export const DISCOVERY_PACE_MS = 30_000;

const DISCOVERY_REQUESTED = "integration.discovery_requested";

/**
 * Queues one bounded rescan of a connection, or answers with the scan
 * already queued or running for it. A new row starts no earlier than
 * DISCOVERY_PACE_MS after the latest scan of the installation, and
 * integration.discovery_requested reaches the discovery function through
 * the outbox. The caller holds the installation row lock and then the
 * connection row lock, the order reconciliation takes them in, so pacing
 * for one installation is computed one request at a time.
 */
export async function queueDiscovery(
  transaction: PgTransactionClient,
  request: {
    organizationId: string;
    connectionId: string;
    installationId: string;
    principalId: string;
    traceId: string;
  },
): Promise<{ discoveryId: string; queued: boolean }> {
  const active = (await transaction.query<{ id: string }>(
    `select id from bakery.integration_discoveries
      where connection_id = $1 and status in ('queued', 'running')`,
    [request.connectionId],
  )).rows[0];
  // One scan per connection at a time.
  if (active !== undefined) return { discoveryId: active.id, queued: false };
  const discoveryId = crypto.randomUUID();
  const inserted = await transaction.query<{ version: number }>(
    `insert into bakery.integration_discoveries (
       id, organization_id, connection_id, installation_id, requested_by,
       status, not_before
     )
     select $1, $2, $3, $4, $5, 'queued',
       greatest(now(), coalesce(
         max(not_before) + ($6::bigint * interval '1 millisecond'), now()))
       from bakery.integration_discoveries where installation_id = $4
     returning version`,
    [
      discoveryId,
      request.organizationId,
      request.connectionId,
      request.installationId,
      request.principalId,
      DISCOVERY_PACE_MS,
    ],
  );
  const version = inserted.rows[0]?.version;
  if (version === undefined) throw new StandardError({ code: "INTERNAL" });
  await appendDomainEvent(transaction, {
    organizationId: request.organizationId,
    eventType: DISCOVERY_REQUESTED,
    aggregateId: discoveryId,
    aggregateVersion: version,
    payload: { resourceId: discoveryId, resourceVersion: version },
    traceId: request.traceId,
    outboxDeliveryKey: `integration-discovery:${discoveryId}`,
  });
  return { discoveryId, queued: true };
}
