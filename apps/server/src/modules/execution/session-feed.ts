import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type ContractOutput,
  contractSchemas,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeSequenceIdCursor,
  encodeSequenceIdCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

type PageInput = { cursor?: string; limit?: number };

type SessionFeedRow = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  agent_session_id: string | null;
  message_type: string;
  body: string;
  intent: string;
  sequence: string;
  created_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function sessionPathId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

/**
 * A feed item's kind is derived from the stored message, never sent by a
 * client. An `agent_request` message is what a person or the system delivered
 * into the session, which is what a watcher sees as a delivered input; every
 * other intent is a plain attributed message (the harness speaking, or
 * discussion).
 */
function feedKind(row: SessionFeedRow): "message" | "delivered_input" {
  return row.intent === "agent_request" ? "delivered_input" : "message";
}

function authorKind(row: SessionFeedRow): "person" | "agent" | "system" {
  if (row.agent_session_id !== null) return "agent";
  if (row.author_id === null) return "system";
  return "person";
}

/**
 * One page of a session's live feed.
 *
 * The feed is a typed view over what a session actually produced, keyed by
 * session and ordered forward by (sequence, id). Every item carries exactly the
 * payload its `kind` names; the other payload fields stay null so a reader can
 * switch on `kind` without guessing. Redaction happens in the projection: the
 * feed never carries secret ciphertext, lease tokens, or raw provider payloads,
 * because none of those columns are selected. An item is never dropped in
 * favour of a partial one, so a client resuming from its last sequence sees a
 * gapless continuation.
 */
export function createSessionFeedHandler(secret: string) {
  return async function sessionFeed(
    context: ActionContext,
    rawInput: unknown,
  ): Promise<ContractOutput<"SessionFeed">> {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const id = sessionPathId(context);
    const input = rawInput as PageInput;

    const session = await transaction.query<{ conversation_id: string }>(
      `select conversation_id from bakery.agent_sessions
        where organization_id = $1 and id = $2`,
      [organizationId, id],
    );
    const conversationId = session.rows[0]?.conversation_id;
    if (!conversationId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }

    const cursorBinding: CursorBinding = {
      action: "sessions.feed",
      organizationId,
      principalId,
      ordering: "sequence:asc,id:asc",
      filters: `session:${id}`,
      schemaVersion: 1,
    };
    const position = await decodeSequenceIdCursor(
      secret,
      input.cursor,
      cursorBinding,
    );
    const limit = input.limit ?? 25;
    const result = await transaction.query<SessionFeedRow>(
      `select message.id, message.conversation_id, message.author_id,
              message.agent_session_id, message.message_type, message.body,
              message.intent, message.sequence::text, message.created_at
         from bakery.messages message
        where message.organization_id = $1
          and message.conversation_id = $2
          and (
            $3::bigint is null or
            (message.sequence, message.id) > ($3::bigint, $4::uuid)
          )
        order by message.sequence asc, message.id asc
        limit $5`,
      [
        organizationId,
        conversationId,
        position?.sequence ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );

    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    const items = visible.map((row) => {
      const kind = feedKind(row);
      const body = row.body;
      return {
        id: row.id,
        sessionId: id,
        sequence: row.sequence,
        kind,
        occurredAt: iso(row.created_at),
        redacted: false,
        message: kind === "message"
          ? {
            messageId: row.id,
            authorId: row.author_id,
            authorKind: authorKind(row),
            messageType: row.message_type,
            body,
          }
          : null,
        terminal: null,
        status: null,
        tool: null,
        fileChange: null,
        artifact: null,
        usage: null,
        deliveredInput: kind === "delivered_input"
          ? { messageId: row.id, body }
          : null,
      };
    });

    return contractSchemas.SessionFeed.parse({
      items,
      nextCursor: result.rows.length > limit && last
        ? await encodeSequenceIdCursor(secret, cursorBinding, {
          sequence: last.sequence,
          id: last.id,
        })
        : null,
    }) as ContractOutput<"SessionFeed">;
  };
}
