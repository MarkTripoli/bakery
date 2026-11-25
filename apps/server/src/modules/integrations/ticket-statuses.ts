import { ticketFamilyActionsOf } from "../integrations/registry.ts";
import type {
  TicketStatusChange,
  TicketStatusResult,
  TicketStatusWriter,
} from "../work/ticket-statuses.ts";
import type { GateSend, GateSendResult } from "./ticket-gate.ts";

export function createGateTicketStatusWriter(deps: {
  send: (send: GateSend) => Promise<GateSendResult>;
}): TicketStatusWriter {
  return {
    async set(change: TicketStatusChange): Promise<TicketStatusResult> {
      const action = ticketFamilyActionsOf(change.provider)["status.set"];
      if (action === undefined) {
        return { kind: "failed", problemCode: "provider_capability_missing" };
      }
      const sent = await deps.send({
        organizationId: change.organizationId,
        actorPrincipalId: change.actorPrincipalId,
        connectionId: change.connectionId,
        resourceId: change.resourceId,
        action,
        arguments: {
          issueNumber: change.issueNumber,
          statusId: change.statusId,
        },
        idempotencyKey: change.idempotencyKey,
        signal: change.signal,
      });
      return sent.kind === "failed" ? sent : { kind: "set" };
    },
  };
}
