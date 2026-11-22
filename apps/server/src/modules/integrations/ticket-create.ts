import type {
  RemoteTicketCreator,
  RemoteTicketRequest,
  RemoteTicketResult,
} from "../work/ticket-create.ts";
import type { GateActionRef, GateSend, GateSendResult } from "./ticket-gate.ts";

/**
 * The remote-ticket creator of the ticket module (#32) over the integration
 * gate: the source provider's registered issue-creating action, sent through
 * the shared gate sender. Which action creates a ticket is the composition
 * root's to say, per provider: this file names none. An effect that went out
 * and has no confirmed answer is `uncertain`, never retried here.
 */
export function createGateRemoteTicketCreator(deps: {
  send: (send: GateSend) => Promise<GateSendResult>;
  /** The issue-creating action of each provider that can create one. */
  createActions: Readonly<Record<string, GateActionRef>>;
}): RemoteTicketCreator {
  const refOf = (provider: string): GateActionRef | undefined =>
    Object.hasOwn(deps.createActions, provider)
      ? deps.createActions[provider]
      : undefined;
  return {
    actionFor: (provider) => refOf(provider)?.id ?? null,
    async create(request: RemoteTicketRequest): Promise<RemoteTicketResult> {
      const action = refOf(request.provider);
      if (action === undefined) {
        return { kind: "failed", problemCode: "provider_capability_missing" };
      }
      const sent = await deps.send({
        organizationId: request.organizationId,
        actorPrincipalId: request.actorPrincipalId,
        connectionId: request.connectionId,
        resourceId: request.resourceId,
        action,
        arguments: {
          title: request.title,
          body: request.body,
          ...(request.labels === undefined
            ? {}
            : { labels: [...request.labels] }),
        },
        idempotencyKey: request.idempotencyKey,
        signal: request.signal,
      });
      if (sent.kind === "failed") return sent;
      return {
        kind: "sent",
        effectId: sent.effectId,
        status: sent.outcome === "uncertain"
          ? "uncertain"
          : sent.outcome === "retry_scheduled"
          ? "prepared"
          : "submitted",
      };
    },
  };
}
