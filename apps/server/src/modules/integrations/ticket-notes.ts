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
import { ticketFamilyActionsOf } from "../work/ticket-family-actions.ts";
import { connectionInvokeDeps } from "./invoke.ts";

export type NoteActionRef = Readonly<{ id: string; version: number }>;

export function createGateTicketNoteWriter(deps: {
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
}): TicketNoteWriter {
  const invoke = connectionInvokeDeps(deps.registry, deps.providerRequests);
  return {
    async post(request: TicketNoteRequest): Promise<TicketNoteResult> {
      const declared = ticketFamilyActionsOf(request.provider);
      const createRef = declared["comment.create"];
      const updateRef = declared["comment.update"];
      if (createRef === undefined || updateRef === undefined) {
        return { kind: "failed", problemCode: "provider_capability_missing" };
      }
      const send = async (
        ref: NoteActionRef,
        args: Record<string, unknown>,
        key: string,
      ): Promise<
        { remoteId: string } | { missing: true } | { problemCode: string }
      > => {
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
              arguments: args,
            },
            idempotencyKey: key,
          });
          if (result.route !== "ledger") {
            return { problemCode: "note_action_not_a_write" };
          }
          const safe = result.run.outcome === "confirmed"
            ? result.run.effect.safeResult as
              | { remoteId?: unknown; missing?: unknown }
              | null
            : null;
          if (safe?.missing === true) return { missing: true };
          const remoteId = safe?.remoteId;
          return typeof remoteId === "string"
            ? { remoteId }
            : { problemCode: noteProblemCode(`note_${result.run.outcome}`) };
        } catch (error) {
          if (!(error instanceof StandardError)) throw error;
          const reason = error.params?.reason;
          return {
            problemCode: noteProblemCode(
              typeof reason === "string" && /^[a-z_]+$/.test(reason)
                ? reason
                : String(error.code).toLowerCase(),
            ),
          };
        }
      };
      return await writeTicketNote(
        request,
        (which, args, key) =>
          send(which === "create" ? createRef : updateRef, args, key),
      );
    },
  };
}

/** What one send of a note action answers. */
export type NoteSendResult =
  | { remoteId: string }
  | { missing: true }
  | { problemCode: string };

/**
 * The note write decision, apart from the gate so it can be tested: post when
 * no comment is stored; otherwise rewrite it, and post again only when the
 * rewrite confirmed the comment is gone. Any other refusal fails with its code
 * and keeps the stored id, so a resync never leaves a second public comment.
 */
export async function writeTicketNote(
  request: TicketNoteRequest,
  send: (
    which: "create" | "update",
    args: Record<string, unknown>,
    key: string,
  ) => Promise<NoteSendResult>,
): Promise<TicketNoteResult> {
  const create = async (recreated: boolean): Promise<TicketNoteResult> => {
    const posted = await send("create", {
      issueNumber: request.issueNumber,
      body: request.body,
    }, `${request.idempotencyKey}:create`);
    if ("remoteId" in posted) {
      return { kind: "posted", externalId: posted.remoteId, recreated };
    }
    return {
      kind: "failed",
      problemCode: "problemCode" in posted
        ? posted.problemCode
        : "note_post_failed",
    };
  };
  if (request.existingExternalId === null) return await create(false);
  const updated = await send("update", {
    issueNumber: request.issueNumber,
    commentId: request.existingExternalId,
    body: request.body,
  }, `${request.idempotencyKey}:update`);
  if ("remoteId" in updated) {
    return {
      kind: "posted",
      externalId: updated.remoteId,
      recreated: false,
    };
  }
  // Post again only when the provider action confirmed the comment is
  // gone. Any other refusal (a 403 or a 422) keeps the stored id, so a
  // resync never leaves a second public comment.
  if ("missing" in updated) return await create(true);
  return { kind: "failed", problemCode: updated.problemCode };
}
