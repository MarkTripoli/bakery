import { StandardError } from "@bakery/contracts/http";
import type { TicketSourcePolicy } from "@bakery/contracts/ticket-admission";
import type { TicketTrigger } from "@bakery/integration-sdk/provider";
import { linearServerProvider } from "@bakery/integration-linear/server";
import type { PgTransactionClient } from "../../platform/database.ts";

const GITHUB_TICKET_TRIGGERS: readonly TicketTrigger[] = ["label", "status"];

const DECLARED: Readonly<Record<string, readonly TicketTrigger[]>> = {
  github: GITHUB_TICKET_TRIGGERS,
  [linearServerProvider.manifest.slug]: linearServerProvider.manifest
    .ticketTriggers ?? ["label"],
};

export function ticketTriggersOf(provider: string): readonly TicketTrigger[] {
  return DECLARED[provider] ?? ["label"];
}

export function assertPolicyTriggersDeclared(
  provider: string,
  policy: TicketSourcePolicy,
): void {
  if (
    policy.readiness.statuses !== undefined &&
    !ticketTriggersOf(provider).includes("status")
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "status_trigger_unsupported",
      params: {
        issues: [{
          path: ["policy", "readiness", "statuses"],
          code: "status_trigger_unsupported",
        }],
      },
    });
  }
}

export async function sourceProvider(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<string> {
  const result = await transaction.query<{ provider: string }>(
    `select connection.provider
       from bakery.ticket_sources as source
       join bakery.integration_connections as connection
         on connection.organization_id = source.organization_id
        and connection.id = source.integration_connection_id
      where source.organization_id = $1 and source.id = $2`,
    [organizationId, sourceId],
  );
  const provider = result.rows[0]?.provider;
  if (provider === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return provider;
}
