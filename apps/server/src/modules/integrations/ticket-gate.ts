import { StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import { invokeIntegration } from "../catalog/integration-invoke.ts";
import { connectionInvokeDeps } from "./invoke.ts";

/** An exact registered action reference. */
export type GateActionRef = Readonly<{ id: string; version: number }>;

/** One write to send through the integration gate as a principal. */
export type GateSend = Readonly<{
  organizationId: string;
  actorPrincipalId: string;
  connectionId: string;
  resourceId: string;
  action: GateActionRef;
  arguments: Readonly<Record<string, unknown>>;
  /** Names the effect: a resend with the same key and arguments is the same effect. */
  idempotencyKey: string;
  signal: AbortSignal;
}>;

/** How far the effect got, or the fixed code of a refusal. */
export type GateSendResult =
  | {
    kind: "sent";
    effectId: string;
    outcome: "confirmed" | "in_flight" | "uncertain" | "retry_scheduled";
  }
  | { kind: "failed"; problemCode: string };

/**
 * The shared door of the ticket module's provider writes (a created issue, a
 * progress label): one registered write action, sent as the asking principal
 * through `invokeIntegration`, so the gate checks that principal's grant and
 * the ledger records the write as an effect. A refusal by the gate and an
 * effect that failed are failures with a fixed code; nothing here retries.
 */
export function createGateSender(deps: {
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
}): (send: GateSend) => Promise<GateSendResult> {
  const invoke = connectionInvokeDeps(deps.registry, deps.providerRequests);
  return async (send) => {
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
        signal: send.signal,
      }, {
        organizationId: send.organizationId,
        actorRef: send.actorPrincipalId,
        connectionId: send.connectionId,
        input: {
          actionId: send.action.id,
          actionVersion: send.action.version,
          resourceId: send.resourceId,
          arguments: send.arguments,
        },
        idempotencyKey: send.idempotencyKey,
      });
      if (result.route !== "ledger") {
        return { kind: "failed", problemCode: "action_not_a_write" };
      }
      const outcome = result.run.outcome;
      return outcome === "failed"
        ? { kind: "failed", problemCode: "effect_failed" }
        : { kind: "sent", effectId: result.prepare.effectId, outcome };
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
  };
}
