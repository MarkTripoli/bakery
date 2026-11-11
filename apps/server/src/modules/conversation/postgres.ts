import {
  captureCommentContext,
  sameCommentReferences,
} from "../knowledge/comments/context.ts";
import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";

const MAX_MESSAGE_BODY_BYTES = 32 * 1024;
const MAX_QUEUED_TURNS = 50;

type ConversationScope = {
  id: string;
  applicationId: string | null;
  repositoryId: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  agent_session_id: string | null;
  message_type: string;
  body: string;
  client_message_id: string;
  reply_to_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  sequence: string;
  intent: string;
  comment_context: unknown | null;
};

type MessageCreateInput = z.infer<typeof contractSchemas.MessageCreate>;

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function stateConflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toMessage(row: MessageRow) {
  return contractSchemas.Message.parse({
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    agentSessionId: row.agent_session_id,
    messageType: row.message_type,
    body: row.body,
    clientMessageId: row.client_message_id,
    replyToId: row.reply_to_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
    sequence: row.sequence,
    intent: row.intent,
    commentContext: row.comment_context,
  });
}

/**
 * True while the conversation has room for one more queued coordinator turn.
 * Callers hold the conversation row lock, so the count cannot move under them.
 */
export async function hasQueuedTurnCapacity(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  const queued = await transaction.query<{ count: number }>(
    `select count(*)::int as count
       from bakery.conversation_turns
      where organization_id = $1 and conversation_id = $2
        and status = 'queued'`,
    [organizationId, conversationId],
  );
  return (queued.rows[0]?.count ?? 0) < MAX_QUEUED_TURNS;
}

export async function lockConversationScope(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
  lock: "share" | "update",
): Promise<ConversationScope> {
  const observed = await transaction.query<{
    id: string;
    application_id: string | null;
    repository_id: string | null;
    archived_at: Date | string | null;
  }>(
    `select id, application_id, repository_id, archived_at
       from bakery.conversations
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId],
  );
  const candidate = observed.rows[0];
  if (!candidate) notFound();
  if (candidate.archived_at !== null) stateConflict("conversation_archived");
  if (candidate.repository_id !== null && candidate.application_id === null) {
    notFound();
  }

  if (candidate.application_id !== null) {
    const application = await transaction.query(
      `select id
         from bakery.applications
        where organization_id = $1 and id = $2 and archived_at is null
        for share`,
      [organizationId, candidate.application_id],
    );
    if (application.rows.length !== 1) notFound();
  }
  if (candidate.repository_id !== null) {
    const repository = await transaction.query(
      `select id
         from bakery.repositories
        where organization_id = $1 and application_id = $2 and id = $3
          and archived_at is null
        for share`,
      [organizationId, candidate.application_id, candidate.repository_id],
    );
    if (repository.rows.length !== 1) notFound();
  }

  const locked = await transaction.query<{
    id: string;
    application_id: string | null;
    repository_id: string | null;
    archived_at: Date | string | null;
  }>(
    `select id, application_id, repository_id, archived_at
       from bakery.conversations
      where organization_id = $1 and id = $2
      ${lock === "update" ? "for update" : "for share"}`,
    [organizationId, conversationId],
  );
  const current = locked.rows[0];
  if (
    !current || current.application_id !== candidate.application_id ||
    current.repository_id !== candidate.repository_id
  ) notFound();
  if (current.archived_at !== null) stateConflict("conversation_archived");
  return {
    id: current.id,
    applicationId: current.application_id,
    repositoryId: current.repository_id,
  };
}

/** Slug of the organization agent definition that runs coordinator turns. */
export const COORDINATOR_AGENT_SLUG = "coordinator";

/**
 * Pins the active version of the organization's coordinator agent definition
 * at admission. None configured pins null: the turn still queues and fails at
 * execution with `coordinator_unconfigured` instead of blocking the transcript.
 */
export async function resolveCoordinatorAgentVersion(
  transaction: PgTransactionClient,
  organizationId: string,
): Promise<string | null> {
  const result = await transaction.query<{ active_version_id: string }>(
    `select active_version_id
       from bakery.agent_definitions
      where organization_id = $1 and slug = $2 and enabled
        and active_version_id is not null`,
    [organizationId, COORDINATOR_AGENT_SLUG],
  );
  return result.rows[0]?.active_version_id ?? null;
}

function sameCanonicalInput(
  row: MessageRow,
  input: MessageCreateInput,
): boolean {
  return row.body === input.body && row.intent === input.intent &&
    row.reply_to_id === (input.replyToId ?? null) &&
    row.message_type === "user" && row.agent_session_id === null &&
    sameCommentReferences(row.comment_context, input.commentRefs ?? []);
}

export async function createMessage(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const conversationId = context.params.id;
  if (!conversationId) notFound();
  const input = rawInput as MessageCreateInput;
  const scope = await lockConversationScope(
    transaction,
    organizationId,
    conversationId,
    "update",
  );

  if (
    new TextEncoder().encode(input.body).byteLength > MAX_MESSAGE_BODY_BYTES
  ) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: MAX_MESSAGE_BODY_BYTES },
    });
  }

  const replay = await transaction.query<MessageRow>(
    `select id, conversation_id, author_id, agent_session_id, message_type,
            body, client_message_id, reply_to_id, created_at, updated_at,
            version, sequence::text, intent, comment_context
       from bakery.messages
      where organization_id = $1 and conversation_id = $2
        and author_id = $3 and client_message_id = $4`,
    [organizationId, conversationId, principalId, input.clientMessageId],
  );
  const existing = replay.rows[0];
  if (existing) {
    if (!sameCanonicalInput(existing, input)) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return toMessage(existing);
  }

  if (
    (input.commentRefs?.length ?? 0) > 0 && input.intent !== "agent_request"
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const commentContext = await captureCommentContext(
    context,
    input.commentRefs ?? [],
  );

  if (input.replyToId !== undefined) {
    const reply = await transaction.query(
      `select 1 from bakery.messages
        where organization_id = $1 and conversation_id = $2 and id = $3`,
      [organizationId, conversationId, input.replyToId],
    );
    if (reply.rows.length !== 1) notFound();
  }

  if (
    input.intent === "agent_request" &&
    !await hasQueuedTurnCapacity(transaction, organizationId, conversationId)
  ) stateConflict("conversation_queue_full");

  const next = await transaction.query<{ sequence: string }>(
    `select (coalesce(max(sequence), 0) + 1)::text as sequence
       from bakery.messages
      where organization_id = $1 and conversation_id = $2`,
    [organizationId, conversationId],
  );
  const sequence = next.rows[0]?.sequence;
  if (!sequence) throw new Error("MESSAGE_SEQUENCE_UNAVAILABLE");

  const inserted = await transaction.query<MessageRow>(
    `insert into bakery.messages (
       organization_id, conversation_id, author_id, message_type, body,
       client_message_id, reply_to_id, sequence, intent, comment_context
     ) values ($1, $2, $3, 'user', $4, $5, $6, $7, $8, $9)
     returning id, conversation_id, author_id, agent_session_id, message_type,
       body, client_message_id, reply_to_id, created_at, updated_at, version,
       sequence::text, intent, comment_context`,
    [
      organizationId,
      conversationId,
      principalId,
      input.body,
      input.clientMessageId,
      input.replyToId ?? null,
      sequence,
      input.intent,
      commentContext,
    ],
  );
  const message = inserted.rows[0];
  if (!message) throw new Error("MESSAGE_INSERT_FAILED");

  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    conversationId,
    eventType: "conversation.message_created",
    aggregateId: message.id,
    aggregateVersion: 1,
    payload: {
      resourceId: message.id,
      resourceVersion: 1,
      conversationId,
      messageSequence: sequence,
      intent: input.intent,
    },
    traceId: context.traceId,
  });

  if (input.intent === "agent_request") {
    const agentVersionId = await resolveCoordinatorAgentVersion(
      transaction,
      organizationId,
    );
    const turn = await transaction.query<{ id: string }>(
      `insert into bakery.conversation_turns (
         organization_id, conversation_id, trigger_message_id, status,
         context_through_sequence, agent_version_id
       ) values ($1, $2, $3, 'queued', $4, $5)
       returning id`,
      [
        organizationId,
        conversationId,
        message.id,
        sequence,
        agentVersionId,
      ],
    );
    const turnId = turn.rows[0]?.id;
    if (!turnId) throw new Error("CONVERSATION_TURN_INSERT_FAILED");
    await appendDomainEvent(transaction, {
      organizationId,
      applicationId: scope.applicationId,
      repositoryId: scope.repositoryId,
      conversationId,
      eventType: "conversation.turn_changed",
      aggregateId: turnId,
      aggregateVersion: 1,
      payload: {
        resourceId: turnId,
        resourceVersion: 1,
        conversationId,
        triggerMessageId: message.id,
        status: "queued",
      },
      traceId: context.traceId,
      outboxDeliveryKey:
        `conversation:${conversationId}:turn:${turnId}:version:1`,
    });
  }

  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "messages.create",
    resourceType: "message",
    resourceId: message.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { conversationId, intent: input.intent, sequence },
  });
  return toMessage(message);
}
