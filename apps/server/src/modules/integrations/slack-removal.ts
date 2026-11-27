import {
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { followConnectionStatus } from "./slack-receipts.ts";
import type { SlackRemovalCause } from "./slack-request.ts";
import { CONNECTION_UPDATED } from "./updates.ts";
import { PROVIDER_REMOVED_PROBLEM } from "./connection-problems.ts";

export const SLACK_REMOVED_OPERATION = "integrationConnections.providerRemoved";

export async function markSlackConnectionsRemoved(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly teamId: string;
    readonly eventId: string;
    readonly cause: SlackRemovalCause;
  },
): Promise<number> {
  const live = await transaction.query<
    { id: string; status: string; version: number }
  >(
    `select connection.id, connection.status, connection.version
       from bakery.integration_connections connection
       join bakery.integration_installations installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1
        and connection.provider = 'slack'
        and installation.external_authorization_id = $2
        and connection.archived_at is null
        and connection.status <> 'revoked'
      order by connection.id
      for update of connection`,
    [input.organizationId, input.teamId],
  );
  const correlation = {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID().replaceAll("-", ""),
  };
  for (const connection of live.rows) {
    const released = await transaction.query(
      `update bakery.integration_resources
          set selected = false, version = version + 1, updated_at = now()
        where organization_id = $1 and connection_id = $2 and selected`,
      [input.organizationId, connection.id],
    );
    const updated = await transaction.query<{ version: number }>(
      `update bakery.integration_connections
          set status = 'revoked', secret_id = null, last_problem_code = $3,
              version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2
        returning version`,
      [input.organizationId, connection.id, PROVIDER_REMOVED_PROBLEM],
    );
    const version = updated.rows[0]!.version;
    await followConnectionStatus(transaction, {
      organizationId: input.organizationId,
      connectionId: connection.id,
      status: "disabled",
    });
    await recordAuthAudit(transaction, correlation, {
      organizationId: input.organizationId,
      principalId: null,
      operation: SLACK_REMOVED_OPERATION,
      resourceType: "integration_connection",
      resourceId: connection.id,
      details: {
        provider: "slack",
        from: connection.status,
        to: "revoked",
        cause: input.cause,
        slackEventId: input.eventId,
        releasedResources: released.rowCount ?? 0,
      },
    });
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      eventType: CONNECTION_UPDATED,
      aggregateId: connection.id,
      aggregateVersion: version,
      payload: { resourceId: connection.id, resourceVersion: version },
      traceId: correlation.traceId,
    });
  }
  return live.rows.length;
}
