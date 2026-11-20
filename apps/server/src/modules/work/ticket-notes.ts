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
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { LINK_COLUMNS, type LinkRow, toLinkOutput } from "./ticket-query.ts";
import { claimLinkNote, recordLinkNote } from "./ticket-store.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Bakery's status note on a ticket (#69): one comment on the provider's issue
 * that says which Bakery task was started from it. The note is written by the
 * provider's registered comment action through the integration gate and the
 * effect ledger; this module names no provider. It only decides when a note
 * may be written, claims the link while the write is in flight, and records
 * what came back on the link: `status_comment_external_id`, `sync_health`
 * and `last_problem_code`.
 *
 * `ticketTaskLinks.resyncNote` runs as claim, write, record, so no
 * transaction is open during the provider call:
 * 1. a short transaction under the live authority check answers a completed
 *    `Idempotency-Key` replay, refuses an unknown link (404), a stale
 *    `If-Match` (412), a reference link (422), a note already up to date or
 *    one being written (409), and marks the link `pending`; it commits;
 * 2. with no transaction open, the writer posts the note;
 * 3. a second transaction under the same check records `healthy` with the
 *    provider's comment id, or `failed` with a problem code.
 *
 * A claim whose writer never answered (the process died between 1 and 3)
 * stops counting as in flight after `NOTE_IN_FLIGHT_SECONDS`, so a crash
 * cannot hold a link forever. A link that already has a note gets it
 * rewritten in place by the provider's update action, so the note stays true
 * after the first post; when the provider no longer has that comment (it was
 * deleted there) a new one is posted, its id stored, and `last_problem_code`
 * says `note_recreated`. No digest of the posted text is stored, so every
 * resync writes, even when the text would be unchanged.
 */

type LinkOutput = z.output<typeof contractSchemas.TicketTaskLink>;

/** One note to post: who asks, through which connection, on which issue. */
export type TicketNoteRequest = {
  organizationId: string;
  /** The principal the write runs as; the gate requires their grant for the provider's comment action. */
  actorPrincipalId: string;
  /** `ticket_sources.provider` of the ticket's source. */
  provider: string;
  connectionId: string;
  /** The repository resource of the source (`integration_resources.id`). */
  resourceId: string;
  issueNumber: number;
  /** The note already on the ticket (`status_comment_external_id`): rewritten in place; null posts a new one. */
  existingExternalId: string | null;
  body: string;
  /** Names this write in the effect ledger: one per claim, so a retry of the same claim is one effect. */
  idempotencyKey: string;
  signal: AbortSignal;
};

/**
 * What a write produced: the provider's comment id, or a fixed problem code.
 * `recreated` says the note named by `existingExternalId` was gone on the
 * provider (deleted there), so a new one was posted under a new id.
 */
export type TicketNoteResult =
  | { kind: "posted"; externalId: string; recreated: boolean }
  | { kind: "failed"; problemCode: string };

/** Posts Bakery's status note; implemented over the integration gate, in memory in tests. */
export type TicketNoteWriter = {
  post(request: TicketNoteRequest): Promise<TicketNoteResult>;
};

/** The writer of a process that wired none: every write fails with a stated reason. */
export const UNAVAILABLE_NOTE_WRITER: TicketNoteWriter = Object.freeze({
  post: () =>
    Promise.resolve({
      kind: "failed" as const,
      problemCode: "note_writer_unavailable",
    }),
});

/** How long a claimed write counts as in flight. */
export const NOTE_IN_FLIGHT_SECONDS = 600;

/** Longest problem code stored on a link. */
const PROBLEM_CODE_MAX = 64;

/** A problem code safe to store: lowercase words, bounded; anything else is `note_post_failed`. */
export function noteProblemCode(value: string): string {
  return /^[a-z][a-z0-9_]*$/.test(value) && value.length <= PROBLEM_CODE_MAX
    ? value
    : "note_post_failed";
}

/** The note's text: the task and its state, in plain words. */
export function ticketNoteBody(
  task: { title: string; status: string },
): string {
  // The title is shown as inline code, so an @mention does not notify, a
  // #ref does not link and HTML (an effect marker among it) is not parsed.
  // Backticks would close the span, and the comment action refuses the
  // marker opener anywhere, so both are neutralised first.
  const title = task.title.replace(/\s+/g, " ").trim().slice(0, 200)
    .replaceAll("`", "'").replaceAll("<!--", "<!- -");
  return [
    "Bakery is working on this issue.",
    "",
    `Task: \`${title}\``,
    `Status: ${task.status}`,
  ].join("\n");
}

type NoteTarget = LinkRow & {
  updated_at: Date;
  number: string | null;
  provider: string;
  integration_connection_id: string;
  integration_resource_id: string;
  application_id: string | null;
  repository_id: string | null;
  task_title: string;
  task_status: string;
  conversation_id: string;
  in_flight: boolean;
};

async function lockNoteTarget(
  transaction: PgTransactionClient,
  organizationId: string,
  linkId: string,
): Promise<NoteTarget> {
  const result = await transaction.query<NoteTarget>(
    `select ${
      LINK_COLUMNS.split(",").map((column) => `link.${column.trim()}`).join(
        ", ",
      )
    },
            ticket.number, source.provider,
            source.integration_connection_id, source.integration_resource_id,
            source.application_id, source.repository_id,
            task.title as task_title, task.status as task_status,
            task.conversation_id,
            link.updated_at > now() - make_interval(secs => $3) as in_flight
       from bakery.ticket_task_links as link
       join bakery.external_tickets as ticket
         on ticket.organization_id = link.organization_id
        and ticket.id = link.external_ticket_id
       join bakery.ticket_sources as source
         on source.organization_id = ticket.organization_id
        and source.id = ticket.ticket_source_id
       join bakery.tasks as task
         on task.organization_id = link.organization_id
        and task.id = link.task_id
      where link.organization_id = $1 and link.id = $2
      for update of link`,
    [organizationId, linkId, NOTE_IN_FLIGHT_SECONDS],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

function stateConflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/** What the claim hands the write and the record step. */
type NoteClaim = {
  linkId: string;
  /** The link version the claim wrote; the record step requires it unchanged. */
  claimedVersion: number;
  request: Omit<TicketNoteRequest, "signal">;
};

const outcomeSlot = Symbol("bakery.ticket.note.outcome");

type NoteOutcome = { claim: NoteClaim; result: TicketNoteResult };

/** The claim of one `resyncNote` call, in the authority transaction. */
async function claimNote(
  context: ActionContext,
  expectedVersion: number | undefined,
): Promise<NoteClaim> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const linkId = context.params.id;
  if (!linkId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const target = await lockNoteTarget(transaction, organizationId, linkId);
  if (target.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (target.role !== "primary") {
    throw unprocessable(["id"], "note_requires_primary_link");
  }
  if (target.sync_health === "pending" && target.in_flight) {
    throw stateConflict("note_sync_in_flight");
  }
  if (target.number === null) {
    throw unprocessable(["id"], "ticket_number_missing");
  }
  const claimedVersion = await claimLinkNote(
    transaction,
    organizationId,
    linkId,
  );
  return {
    linkId,
    claimedVersion,
    request: {
      organizationId,
      actorPrincipalId: principalId,
      provider: target.provider,
      connectionId: target.integration_connection_id,
      resourceId: target.integration_resource_id,
      issueNumber: Number(target.number),
      existingExternalId: target.status_comment_external_id,
      body: ticketNoteBody({
        title: target.task_title,
        status: target.task_status,
      }),
      idempotencyKey: `ticket-note:${linkId}:${claimedVersion}`,
    },
  };
}

/**
 * The runner of `ticketTaskLinks.resyncNote`: claim, write with no
 * transaction open, then the handler records the outcome.
 */
export function createTicketNoteRunner(
  authority: ActionAuthorityRunner,
  writer: TicketNoteWriter,
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
        return { claim: await claimNote(authorized, metadata.expectedVersion) };
      },
    ) as { replay: EncodedSuccessResponse } | { claim: NoteClaim };
    if ("replay" in claimed) return claimed.replay;
    let result: TicketNoteResult;
    try {
      result = await writer.post({
        ...claimed.claim.request,
        signal: context.signal,
      });
    } catch (error) {
      // A write that threw is recorded as failed, never left pending.
      result = {
        kind: "failed",
        problemCode: error instanceof StandardError
          ? noteProblemCode(String(error.code).toLowerCase())
          : "note_post_failed",
      };
    }
    const outcome: NoteOutcome = { claim: claimed.claim, result };
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
 * `ticketTaskLinks.resyncNote`: Developer, `Idempotency-Key` and `If-Match`
 * on the link version. Posts Bakery's status note on the ticket of a primary
 * link, or rewrites the one already posted, and answers the link
 * as recorded: `healthy` with the comment id, or `failed` with the problem
 * code. A failure is an answer, not an error: the caller may try again.
 */
export async function recordTicketNoteSync(
  context: ActionContext,
): Promise<LinkOutput> {
  const outcome = (context as { [outcomeSlot]?: NoteOutcome })[outcomeSlot];
  if (outcome === undefined) throw new StandardError({ code: "INTERNAL" });
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { claim, result } = outcome;
  const posted = result.kind === "posted";
  const row = await recordLinkNote<LinkRow>(
    transaction,
    organizationId,
    claim.linkId,
    claim.claimedVersion,
    posted
      ? {
        syncHealth: "healthy",
        externalId: result.externalId,
        problemCode: result.recreated ? "note_recreated" : null,
      }
      : {
        syncHealth: "failed",
        externalId: null,
        problemCode: noteProblemCode(result.problemCode),
      },
    LINK_COLUMNS,
  );
  if (!row) throw stateConflict("note_sync_superseded");
  const scope = await transaction.query<
    {
      application_id: string | null;
      repository_id: string | null;
      conversation_id: string;
    }
  >(
    `select source.application_id, source.repository_id, task.conversation_id
       from bakery.external_tickets as ticket
       join bakery.ticket_sources as source
         on source.organization_id = ticket.organization_id
        and source.id = ticket.ticket_source_id
       join bakery.tasks as task
         on task.organization_id = ticket.organization_id and task.id = $3
      where ticket.organization_id = $1 and ticket.id = $2`,
    [organizationId, row.external_ticket_id, row.task_id],
  );
  const facts = scope.rows[0];
  const eventType = "ticket.link_changed";
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "ticketTaskLinks.resyncNote",
    resourceType: "ticket_task_link",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      syncHealth: row.sync_health,
      problemCode: row.last_problem_code,
      recreated: posted && result.recreated,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: facts?.application_id ?? null,
    repositoryId: facts?.repository_id ?? null,
    taskId: row.task_id,
    conversationId: facts?.conversation_id ?? null,
    eventType,
    aggregateId: row.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      organizationId,
      row.id,
      eventType,
    ),
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: context.traceId,
  });
  return toLinkOutput(organizationId, row);
}
