import { StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import { invokeIntegration } from "../catalog/integration-invoke.ts";
import {
  noteProblemCode,
  type TicketNoteRequest,
  type TicketNoteResult,
  type TicketNoteWriter,
} from "../work/ticket-notes.ts";
import { connectionInvokeDeps } from "./invoke.ts";

/** An exact registered action reference. */
export type NoteActionRef = Readonly<{ id: string; version: number }>;

/**
 * The status-note writer of the ticket module (#69) over the integration
 * gate: the source provider's registered comment action, sent as the asking
 * principal through `invokeIntegration`, so the gate checks that
 * principal's grant and the ledger records the write as an effect. Which
 * action writes a note is the composition root's to say, per provider: this
 * file names none. A provider with no note action, a refusal by the gate, and
 * an effect that is not confirmed are all failures with a fixed code; a
 * confirmed effect answers the provider's comment id.
 */
export function createGateTicketNoteWriter(deps: {
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
  /** The comment action of each provider that can carry a note. */
  noteActions: Readonly<Record<string, NoteActionRef>>;
}): TicketNoteWriter {
  const invoke = connectionInvokeDeps(deps.registry, deps.providerRequests);
  return {
    async post(request: TicketNoteRequest): Promise<TicketNoteResult> {
      const ref = Object.hasOwn(deps.noteActions, request.provider)
        ? deps.noteActions[request.provider]
        : undefined;
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
            load: (key) =>
              withPgTransaction(
                deps.database,
                (transaction) => invoke.snapshotsFor(transaction).load(key),
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
            arguments: { issueNumber: request.issueNumber, body: request.body },
          },
          idempotencyKey: request.idempotencyKey,
        });
        if (result.route !== "ledger") {
          return { kind: "failed", problemCode: "note_action_not_a_write" };
        }
        const remoteId = result.run.outcome === "confirmed"
          ? (result.run.effect.safeResult as { remoteId?: unknown } | null)
            ?.remoteId
          : undefined;
        return typeof remoteId === "string"
          ? { kind: "posted", externalId: remoteId }
          : {
            kind: "failed",
            problemCode: noteProblemCode(`note_${result.run.outcome}`),
          };
      } catch (error) {
        if (!(error instanceof StandardError)) throw error;
        const reason = error.params?.reason;
        return {
          kind: "failed",
          problemCode: noteProblemCode(
            typeof reason === "string" && /^[a-z_]+$/.test(reason)
              ? reason
              : String(error.code).toLowerCase(),
          ),
        };
      }
    },
  };
}
