import type {
  TicketLabelChange,
  TicketLabelResult,
  TicketLabelWriter,
} from "../work/ticket-labels.ts";
import type { GateActionRef, GateSend, GateSendResult } from "./ticket-gate.ts";

/**
 * The progress-label writer of the ticket module (#32) over the integration
 * gate: the source provider's registered label actions, one effect per label,
 * adds before removes so an issue is never left with none. Which actions change
 * a label is the composition root's to say, per provider: this file names none.
 * An effect that has no confirmed answer yet is not a failure; the next sync
 * writes the labels again from the stored phase.
 */
export function createGateTicketLabelWriter(deps: {
  send: (send: GateSend) => Promise<GateSendResult>;
  labelActions: Readonly<
    Record<string, Readonly<{ add: GateActionRef; remove: GateActionRef }>>
  >;
}): TicketLabelWriter {
  return {
    async apply(change: TicketLabelChange): Promise<TicketLabelResult> {
      const actions = Object.hasOwn(deps.labelActions, change.provider)
        ? deps.labelActions[change.provider]
        : undefined;
      if (actions === undefined) {
        return { kind: "failed", problemCode: "provider_capability_missing" };
      }
      const base = {
        organizationId: change.organizationId,
        actorPrincipalId: change.actorPrincipalId,
        connectionId: change.connectionId,
        resourceId: change.resourceId,
        signal: change.signal,
      };
      const steps: GateSend[] = [
        ...(change.add.length === 0 ? [] : [{
          ...base,
          action: actions.add,
          arguments: {
            issueNumber: change.issueNumber,
            labels: [...change.add],
          },
          idempotencyKey: `${change.idempotencyKey}:add`,
        }]),
        ...change.remove.map((label) => ({
          ...base,
          action: actions.remove,
          arguments: { issueNumber: change.issueNumber, label },
          idempotencyKey: `${change.idempotencyKey}:remove:${label}`,
        })),
      ];
      for (const step of steps) {
        const sent = await deps.send(step);
        if (sent.kind === "failed") return sent;
      }
      return { kind: "applied" };
    },
  };
}
