import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { toTurn, type TurnRow } from "./queries.ts";

type ConversationRow = {
  id: string;
  application_id: string | null;
  repository_id: string | null;
  title: string;
  created_by: string;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

const COLUMNS =
  `id, application_id, repository_id, title, created_by, archived_at,
   created_at, updated_at, version`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toConversation(row: ConversationRow) {
  return contractSchemas.Conversation.parse({
    id: row.id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    title: row.title,
    createdBy: row.created_by,
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function pathId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) notFound();
  return id;
}

async function emit(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: {
    organizationId: string;
    principalId: string;
    operation: "conversations.create" | "conversations.update";
    eventType: "conversations.created" | "conversations.updated";
    row: ConversationRow;
  },
): Promise<void> {
  const { row } = facts;
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: facts.operation,
    resourceType: "conversation",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.id,
    eventType: facts.eventType,
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: context.traceId,
  });
}

export function createConversationsListHandler(secret: string) {
  return async (context: ActionContext, rawInput: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const input = rawInput as { cursor?: string; limit?: number };
    const binding: CursorBinding = {
      action: "conversations.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      ConversationRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.conversations
        where organization_id = $1
          and not (repository_id is not null and application_id is null)
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toConversation),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getConversation(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<ConversationRow>(
    `select ${COLUMNS} from bakery.conversations
      where organization_id = $1 and id = $2
        and not (repository_id is not null and application_id is null)`,
    [organizationId, pathId(context)],
  );
  const row = result.rows[0];
  if (!row) notFound();
  return toConversation(row);
}

export async function createConversation(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as {
    applicationId?: string | null;
    repositoryId?: string | null;
    title: string;
  };
  let applicationId = input.applicationId ?? null;
  const repositoryId = input.repositoryId ?? null;
  if (repositoryId !== null) {
    const repository = await transaction.query<{ application_id: string }>(
      `select application_id from bakery.repositories
        where organization_id = $1 and id = $2 and archived_at is null`,
      [organizationId, repositoryId],
    );
    const owner = repository.rows[0]?.application_id;
    if (!owner) notFound();
    if (applicationId !== null && applicationId !== owner) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
    applicationId = owner;
  }
  if (applicationId !== null) {
    const application = await transaction.query(
      `select 1 from bakery.applications
        where organization_id = $1 and id = $2 and archived_at is null
        for share`,
      [organizationId, applicationId],
    );
    if (application.rows.length !== 1) notFound();
  }
  const inserted = await transaction.query<ConversationRow>(
    `insert into bakery.conversations (
       organization_id, application_id, repository_id, title, created_by
     ) values ($1, $2, $3, $4, $5)
     returning ${COLUMNS}`,
    [
      organizationId,
      applicationId,
      repositoryId,
      input.title.trim(),
      principalId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("CONVERSATION_INSERT_FAILED");
  await emit(transaction, context, {
    organizationId,
    principalId,
    operation: "conversations.create",
    eventType: "conversations.created",
    row,
  });
  return toConversation(row);
}

export async function updateConversation(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as { title?: string; archivedAt?: string | null };
  const id = pathId(context);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const updated = await transaction.query<ConversationRow>(
    `update bakery.conversations
        set title = case when $4::boolean then $5 else title end,
            archived_at = case
              when not $6::boolean then archived_at
              when $7::boolean then coalesce(archived_at, now())
              else null end,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and version = $3
        and not (repository_id is not null and application_id is null)
      returning ${COLUMNS}`,
    [
      organizationId,
      id,
      expectedVersion,
      input.title !== undefined,
      input.title?.trim() ?? null,
      input.archivedAt !== undefined,
      input.archivedAt !== undefined && input.archivedAt !== null,
    ],
  );
  const row = updated.rows[0];
  if (!row) {
    const visible = await transaction.query(
      `select 1 from bakery.conversations where organization_id = $1 and id = $2`,
      [organizationId, id],
    );
    throw new StandardError({
      code: visible.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await emit(transaction, context, {
    organizationId,
    principalId,
    operation: "conversations.update",
    eventType: "conversations.updated",
    row,
  });
  return toConversation(row);
}

const TURN_COLUMNS = `turn.id, turn.conversation_id, turn.trigger_message_id,
  turn.agent_session_id, turn.status, turn.context_through_sequence::text,
  turn.finished_at, turn.failure, turn.created_at, turn.updated_at,
  turn.version`;

export async function getConversationTurn(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<TurnRow>(
    `select ${TURN_COLUMNS} from bakery.conversation_turns turn
      where turn.organization_id = $1 and turn.id = $2`,
    [organizationId, pathId(context)],
  );
  const row = result.rows[0];
  if (!row) notFound();
  return toTurn(row);
}

/** queued -> canceled; active -> cancel_requested; never touches runs. */
export async function cancelConversationTurn(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = pathId(context);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const found = await transaction.query<TurnRow & { conv: string }>(
    `select ${TURN_COLUMNS}, turn.conversation_id as conv
       from bakery.conversation_turns turn
      where turn.organization_id = $1 and turn.id = $2`,
    [organizationId, id],
  );
  const peek = found.rows[0];
  if (!peek) notFound();
  // Same lock order as admission and the runtime: conversation, then turn.
  await transaction.query(
    `select 1 from bakery.conversations
      where organization_id = $1 and id = $2 for update`,
    [organizationId, peek.conversation_id],
  );
  const locked = await transaction.query<TurnRow & { trigger: string }>(
    `select ${TURN_COLUMNS}, turn.trigger_message_id as trigger
       from bakery.conversation_turns turn
      where turn.organization_id = $1 and turn.id = $2 for update`,
    [organizationId, id],
  );
  const turn = locked.rows[0];
  if (!turn) notFound();
  if (
    turn.status === "completed" || turn.status === "failed" ||
    turn.status === "canceled" || turn.status === "cancel_requested"
  ) return toTurn(turn);
  if (turn.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const next = turn.status === "queued" ? "canceled" : "cancel_requested";
  const updated = await transaction.query<TurnRow>(
    `update bakery.conversation_turns turn
        set status = $3,
            finished_at = case when $3 = 'canceled' then now() else null end,
            cancel_requested_at = now(), updated_at = now(),
            version = version + 1
      where turn.organization_id = $1 and turn.id = $2
      returning ${TURN_COLUMNS}`,
    [organizationId, id, next],
  );
  const row = updated.rows[0];
  if (!row) throw new Error("CONVERSATION_TURN_CANCEL_FAILED");
  const scope = await transaction.query<
    { application_id: string | null; repository_id: string | null }
  >(
    `select application_id, repository_id from bakery.conversations
      where organization_id = $1 and id = $2`,
    [organizationId, row.conversation_id],
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.rows[0]?.application_id ?? null,
    repositoryId: scope.rows[0]?.repository_id ?? null,
    conversationId: row.conversation_id,
    eventType: "conversation.turn_changed",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: {
      resourceId: row.id,
      resourceVersion: row.version,
      conversationId: row.conversation_id,
      triggerMessageId: row.trigger_message_id,
      status: next,
    },
    traceId: context.traceId,
    outboxDeliveryKey:
      `conversation:${row.conversation_id}:turn:${row.id}:version:${row.version}`,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "conversationTurns.cancel",
    resourceType: "conversation_turn",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { conversationId: row.conversation_id, status: next },
  });
  return toTurn(row);
}
