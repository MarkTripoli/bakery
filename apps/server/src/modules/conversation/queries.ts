import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeSequenceIdCursor,
  encodeSequenceIdCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  lockConversationScope,
  type MessageRow,
  toMessage,
} from "./postgres.ts";

type PageInput = { cursor?: string; limit?: number };

export type TurnRow = {
  id: string;
  conversation_id: string;
  trigger_message_id: string;
  agent_session_id: string | null;
  status: string;
  context_through_sequence: string | null;
  finished_at: Date | string | null;
  failure: unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  trigger_sequence?: string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toTurn(row: TurnRow) {
  return contractSchemas.ConversationTurn.parse({
    id: row.id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    agentSessionId: row.agent_session_id,
    status: row.status,
    contextThroughSequence: row.context_through_sequence,
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
    failure: row.failure,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  });
}

function binding(
  action: "messages.list" | "conversationTurns.list",
  organizationId: string,
  principalId: string,
  conversationId: string,
): CursorBinding {
  return {
    action,
    organizationId,
    principalId,
    ordering: action === "messages.list"
      ? "sequence:desc,id:desc"
      : "triggerSequence:desc,id:desc",
    filters: `conversation:${conversationId}`,
    schemaVersion: 1,
  };
}

function conversationId(context: ActionContext): string {
  const value = context.params.id;
  if (!value) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return value;
}

export function createConversationQueryHandlers(secret: string) {
  return {
    async messagesList(context: ActionContext, rawInput: unknown) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const id = conversationId(context);
      await lockConversationScope(transaction, organizationId, id, "share");
      const input = rawInput as PageInput;
      const cursorBinding = binding(
        "messages.list",
        organizationId,
        principalId,
        id,
      );
      const position = await decodeSequenceIdCursor(
        secret,
        input.cursor,
        cursorBinding,
      );
      const limit = input.limit ?? 25;
      const result = await transaction.query<MessageRow>(
        `select message.id, message.conversation_id, message.author_id,
                message.agent_session_id, message.message_type, message.body,
                message.client_message_id, message.reply_to_id,
                message.created_at, message.updated_at, message.version,
                message.sequence::text, message.intent, message.comment_context
           from bakery.messages message
          where message.organization_id = $1 and message.conversation_id = $2
            and (
              $3::bigint is null or
              (message.sequence, message.id) < ($3::bigint, $4::uuid)
            )
          order by message.sequence desc, message.id desc
          limit $5`,
        [
          organizationId,
          id,
          position?.sequence ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = result.rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        items: visible.map(toMessage),
        nextCursor: result.rows.length > limit && last
          ? await encodeSequenceIdCursor(secret, cursorBinding, {
            sequence: last.sequence,
            id: last.id,
          })
          : null,
      };
    },

    async turnsList(context: ActionContext, rawInput: unknown) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const id = conversationId(context);
      await lockConversationScope(transaction, organizationId, id, "share");
      const input = rawInput as PageInput;
      const cursorBinding = binding(
        "conversationTurns.list",
        organizationId,
        principalId,
        id,
      );
      const position = await decodeSequenceIdCursor(
        secret,
        input.cursor,
        cursorBinding,
      );
      const limit = input.limit ?? 25;
      const result = await transaction.query<TurnRow>(
        `select turn.id, turn.conversation_id, turn.trigger_message_id,
                turn.agent_session_id, turn.status,
                turn.context_through_sequence::text, turn.finished_at,
                turn.failure, turn.created_at, turn.updated_at, turn.version,
                message.sequence::text as trigger_sequence
           from bakery.conversation_turns turn
           join bakery.messages message
             on message.organization_id = turn.organization_id
            and message.conversation_id = turn.conversation_id
            and message.id = turn.trigger_message_id
          where turn.organization_id = $1 and turn.conversation_id = $2
            and (
              $3::bigint is null or
              (message.sequence, turn.id) < ($3::bigint, $4::uuid)
            )
          order by message.sequence desc, turn.id desc
          limit $5`,
        [
          organizationId,
          id,
          position?.sequence ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = result.rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        items: visible.map(toTurn),
        nextCursor: result.rows.length > limit && last
          ? await encodeSequenceIdCursor(secret, cursorBinding, {
            sequence: last.trigger_sequence ?? "0",
            id: last.id,
          })
          : null,
      };
    },

    /**
     * Distinct principals that took part in the conversation, for attribution.
     * Read-only: names only, no role or capability. Bounded, never paged.
     */
    async participantsList(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const id = conversationId(context);
      await lockConversationScope(transaction, organizationId, id, "share");
      const result = await transaction.query<{
        id: string;
        principal_type: string;
        display_name: string;
      }>(
        `select principal.id, principal.principal_type, principal.display_name
           from bakery.principals principal
          where principal.id in (
            select message.author_id from bakery.messages message
             where message.organization_id = $1 and message.conversation_id = $2
               and message.author_id is not null
            union
            select task.created_by from bakery.tasks task
             where task.organization_id = $1 and task.conversation_id = $2
            union
            select question.answered_by from bakery.questions question
             where question.organization_id = $1
               and question.conversation_id = $2
               and question.answered_by is not null
            union
            select question.decided_by from bakery.questions question
             where question.organization_id = $1
               and question.conversation_id = $2
               and question.decided_by is not null
          )
          order by principal.display_name asc, principal.id asc
          limit 200`,
        [organizationId, id],
      );
      return {
        items: result.rows.map((row) =>
          contractSchemas.ConversationParticipant.parse({
            principalId: row.id,
            principalType: row.principal_type,
            displayName: row.display_name,
          })
        ),
        nextCursor: null,
      };
    },
  };
}
