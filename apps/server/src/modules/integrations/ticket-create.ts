import { StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import { invokeIntegration } from "../catalog/integration-invoke.ts";
import type {
  RemoteTicketCreator,
  RemoteTicketRequest,
  RemoteTicketResult,
} from "../work/ticket-create.ts";
import { connectionInvokeDeps } from "./invoke.ts";

/** An exact registered action reference. */
export type CreateActionRef = Readonly<{ id: string; version: number }>;

/**
 * The remote-ticket creator of the ticket module (#32) over the integration
 * gate: the source provider's registered issue-creating action, sent as the
 * asking principal through `invokeIntegration`, so the gate checks that
 * principal's grant and the ledger records the write as an effect keyed by the
 * caller's `Idempotency-Key`. Which action creates a ticket is the
 * composition root's to say, per provider: this file names none. A refusal by
 * the gate and an effect that failed are failures with a fixed code; an effect
 * that went out and has no confirmed answer is `uncertain`, never retried here.
 */
export function createGateRemoteTicketCreator(deps: {
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
  /** The issue-creating action of each provider that can create one. */
  createActions: Readonly<Record<string, CreateActionRef>>;
}): RemoteTicketCreator {
  const invoke = connectionInvokeDeps(deps.registry, deps.providerRequests);
  const refOf = (provider: string): CreateActionRef | undefined =>
    Object.hasOwn(deps.createActions, provider)
      ? deps.createActions[provider]
      : undefined;
  return {
    actionFor: (provider) => refOf(provider)?.id ?? null,
    async create(request: RemoteTicketRequest): Promise<RemoteTicketResult> {
      const ref = refOf(request.provider);
      if (ref === undefined) {
        return { kind: "failed", problemCode: "provider_capability_missing" };
      }
      try {
        const result = await invokeIntegration({
          database: deps.database,
          registry: deps.registry,
          snapshotsFor: invoke.snapshotsFor,
          providerRequests: deps.providerRequests,
          snapshots: {
            load: (snapshotKey) =>
              withPgTransaction(
                deps.database,
                (transaction) =>
                  invoke.snapshotsFor(transaction).load(snapshotKey),
              ),
          },
          signal: request.signal,
        }, {
          organizationId: request.organizationId,
          actorRef: request.actorPrincipalId,
          connectionId: request.connectionId,
          input: {
            actionId: ref.id,
            actionVersion: ref.version,
            resourceId: request.resourceId,
            arguments: {
              title: request.title,
              body: request.body,
              ...(request.labels === undefined
                ? {}
                : { labels: [...request.labels] }),
            },
          },
          idempotencyKey: request.idempotencyKey,
        });
        if (result.route !== "ledger") {
          return { kind: "failed", problemCode: "create_action_not_a_write" };
        }
        const effectId = result.prepare.effectId;
        switch (result.run.outcome) {
          case "confirmed":
          case "in_flight":
            return { kind: "sent", effectId, status: "submitted" };
          case "uncertain":
            return { kind: "sent", effectId, status: "uncertain" };
          case "retry_scheduled":
            return { kind: "sent", effectId, status: "prepared" };
          default:
            return { kind: "failed", problemCode: "effect_failed" };
        }
      } catch (error) {
        if (!(error instanceof StandardError)) throw error;
        const reason = error.params?.reason;
        return {
          kind: "failed",
          problemCode: typeof reason === "string" && /^[a-z_]+$/.test(reason)
            ? reason
            : String(error.code).toLowerCase(),
        };
      }
    },
  };
}
