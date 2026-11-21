import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  type EncodedSuccessResponse,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import {
  createNormalizedCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { holdsExternalActionGrant } from "../integrations/invoke.ts";
import { organizationActor } from "../integrations/auth-attempts.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Remote ticket creation (#32, `externalTickets.create`): one new issue in the
 * tracker a ticket source watches, written through that source's connection and
 * the external-effect ledger. This module names no provider: a
 * `RemoteTicketCreator` says which action creates a ticket for a provider and
 * performs the send.
 *
 * The call runs as claim, write, answer, so no transaction is open during the
 * provider call:
 * 1. a short transaction under the live authority check answers a completed
 *    `Idempotency-Key` replay, refuses an unknown or disabled source, and
 *    resolves the connection and repository resource;
 * 2. with no transaction open, the creator sends the effect;
 * 3. a second transaction under the same check audits the request and answers
 *    the receipt.
 * The receipt never claims the issue exists: it says whether the effect was
 * prepared, submitted or is uncertain, and carries the effect id to read it by.
 * A lost response is settled by the provider action's own reconcile (marker and
 * the app's bot identity), never by posting again; the same `Idempotency-Key`
 * resends the same effect, not a second one.
 */

type Receipt = z.output<typeof contractSchemas.IntegrationActionReceipt>;
type Create = z.output<typeof contractSchemas.RemoteTicketCreate>;

/** One ticket to create: who asks, through which connection, in which repository. */
export type RemoteTicketRequest = {
  organizationId: string;
  /** The principal the write runs as; the gate requires their grant for the creating action. */
  actorPrincipalId: string;
  provider: string;
  connectionId: string;
  /** The repository resource of the source (`integration_resources.id`). */
  resourceId: string;
  title: string;
  body: string;
  /** Labels to apply at creation, when the provider fields name any. */
  labels: readonly string[] | undefined;
  /** Names the effect: a resend with the same key is the same effect. */
  idempotencyKey: string;
  signal: AbortSignal;
};

/** What a send produced: the effect and how far it got, or a fixed problem code. */
export type RemoteTicketResult =
  | {
    kind: "sent";
    effectId: string;
    status: "prepared" | "submitted" | "uncertain";
  }
  | { kind: "failed"; problemCode: string };

/** Creates a remote ticket; implemented over the integration gate, in memory in tests. */
export type RemoteTicketCreator = {
  /** The action id that creates a ticket for the provider, or null when it has none. */
  actionFor(provider: string): string | null;
  create(request: RemoteTicketRequest): Promise<RemoteTicketResult>;
};

/** The creator of a process that wired none: no provider can create a ticket. */
export const UNAVAILABLE_TICKET_CREATOR: RemoteTicketCreator = Object.freeze({
  actionFor: () => null,
  create: () =>
    Promise.resolve({
      kind: "failed" as const,
      problemCode: "ticket_creator_unavailable",
    }),
});

type Target = {
  provider: string;
  connectionId: string;
  resourceId: string;
  enabled: boolean;
};

async function readTarget(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<Target> {
  const found = await transaction.query<{
    provider: string;
    integration_connection_id: string;
    integration_resource_id: string;
    enabled: boolean;
  }>(
    `select provider, integration_connection_id, integration_resource_id, enabled
       from bakery.ticket_sources
      where organization_id = $1 and id = $2`,
    [organizationId, sourceId],
  );
  const row = found.rows[0];
  if (row === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return {
    provider: row.provider,
    connectionId: row.integration_connection_id,
    resourceId: row.integration_resource_id,
    enabled: row.enabled,
  };
}

/**
 * The `+exact external action grant` half of the access tier: the caller holds
 * a live grant for the provider's creating action on this source's repository.
 * The role check alone would let any Developer create issues in any connected
 * repository.
 */
export function authorizeRemoteTicketCreate(
  creator: RemoteTicketCreator,
): (context: ActionContext, input: unknown) => Promise<void> {
  return async (context) => {
    const { context: authorized, actor } = organizationActor(context);
    const sourceId = context.params.id;
    if (!sourceId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const target = await readTarget(
      authorized.transaction,
      actor.organizationId as string,
      sourceId,
    );
    const capability = creator.actionFor(target.provider);
    if (capability === null) {
      throw unprocessable(["id"], "provider_capability_missing");
    }
    if (
      !await holdsExternalActionGrant(authorized.transaction, {
        organizationId: actor.organizationId as string,
        connectionId: target.connectionId,
        capability,
        resourceId: target.resourceId,
        principalId: actor.subject.principalId as string,
        role: actor.role ?? null,
      })
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  };
}

/** Longest list of label names a creation carries. */
const MAX_LABELS = 20;

/**
 * The label names in the provider fields, when there are any. Only a list of
 * short strings is read; every other provider field is not passed on, so a
 * caller cannot reach a provider parameter the action does not declare.
 */
export function labelsOfProviderFields(
  fields: Create["providerFields"],
): readonly string[] | undefined {
  if (fields === undefined || fields === null || typeof fields !== "object") {
    return undefined;
  }
  const labels = (fields as Record<string, unknown>).labels;
  if (labels === undefined) return undefined;
  if (
    !Array.isArray(labels) || labels.length > MAX_LABELS ||
    !labels.every((label) =>
      typeof label === "string" && label.length > 0 && label.length <= 50
    )
  ) {
    throw unprocessable(["providerFields", "labels"], "labels_invalid");
  }
  return labels as string[];
}

type Claim = {
  request: Omit<RemoteTicketRequest, "signal">;
};

const outcomeSlot = Symbol("bakery.ticket.create.outcome");

type Outcome = { claim: Claim; result: RemoteTicketResult };

/** The claim of one create call, in the authority transaction. */
async function claimCreate(
  context: ActionContext,
  input: Create,
  idempotencyKey: string,
  creator: RemoteTicketCreator,
): Promise<Claim> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const sourceId = context.params.id;
  if (!sourceId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (input.body.trim() === "") {
    throw unprocessable(["body"], "body_required");
  }
  const target = await readTarget(transaction, organizationId, sourceId);
  if (!target.enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "source_disabled" },
    });
  }
  if (creator.actionFor(target.provider) === null) {
    throw unprocessable(["id"], "provider_capability_missing");
  }
  return {
    request: {
      organizationId,
      actorPrincipalId: principalId,
      provider: target.provider,
      connectionId: target.connectionId,
      resourceId: target.resourceId,
      title: input.title,
      body: input.body,
      labels: labelsOfProviderFields(input.providerFields),
      idempotencyKey,
    },
  };
}

/**
 * The runner of `externalTickets.create`: claim, send with no transaction
 * open, then the handler audits and answers.
 */
export function createRemoteTicketRunner(
  authority: ActionAuthorityRunner,
  creator: RemoteTicketCreator,
): ActionAuthorityRunner["run"] {
  return async (action, context, input, next) => {
    const metadata = createNormalizedCommandMetadata(
      action,
      context.request,
      context.params,
      input,
    );
    const claimed = await authority.run(
      action,
      context,
      input,
      async (authorized) => {
        await action.policy.authorize?.(authorized, input);
        const replay = await readCompletedCommandReplay({
          context: authorized,
          metadata,
          input,
        });
        if (replay) {
          return { replay: validateEncodedSuccessResponse(action, replay) };
        }
        return {
          claim: await claimCreate(
            authorized,
            input as Create,
            metadata.idempotencyKey,
            creator,
          ),
        };
      },
    ) as { replay: EncodedSuccessResponse } | { claim: Claim };
    if ("replay" in claimed) return claimed.replay;
    let result: RemoteTicketResult;
    try {
      result = await creator.create({
        ...claimed.claim.request,
        signal: context.signal,
      });
    } catch (error) {
      result = {
        kind: "failed",
        problemCode: error instanceof StandardError
          ? String(error.code).toLowerCase().replace(/[^a-z0-9_]/g, "_")
          : "ticket_create_failed",
      };
    }
    const outcome: Outcome = { claim: claimed.claim, result };
    return await authority.run(
      action,
      context,
      input,
      (authorized) =>
        next(Object.assign({}, authorized, { [outcomeSlot]: outcome })),
    );
  };
}

/**
 * `externalTickets.create`: Developer with the exact external action grant,
 * `Idempotency-Key`. Answers the 202 receipt of the recorded effect. A send the
 * gate refused is an error the caller can act on (a revoked grant is 403, an
 * unavailable connection is 503); a send that went out and has no answer yet is
 * a receipt that says `uncertain`.
 */
export async function recordRemoteTicketCreate(
  context: ActionContext,
): Promise<Receipt> {
  const outcome = (context as { [outcomeSlot]?: Outcome })[outcomeSlot];
  if (outcome === undefined) throw new StandardError({ code: "INTERNAL" });
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { claim, result } = outcome;
  if (result.kind === "failed") {
    // A 503 names no reason (only a fixed allowlist is echoed); the ledger
    // and the gate's own refusal record why.
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "externalTickets.create",
    resourceType: "external_effect",
    resourceId: result.effectId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      provider: claim.request.provider,
      status: result.status,
      labels: claim.request.labels?.length ?? 0,
    },
  });
  return {
    effectId: result.effectId,
    status: result.status,
    location:
      `/v1/integration-connections/${claim.request.connectionId}/effects/${result.effectId}`,
  };
}
