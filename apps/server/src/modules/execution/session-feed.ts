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
import { hasStandingRunAccess } from "../work/run-requests.ts";

type PageInput = { cursor?: string; limit?: number; sequenceAfter?: string };

type SessionFeedRow = {
  id: string;
  source_kind: "message" | "tool";
  conversation_id: string;
  author_id: string | null;
  agent_session_id: string | null;
  message_type: string | null;
  body: string | null;
  intent: string | null;
  sequence: string;
  created_at: Date | string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_phase: "started" | "completed" | "failed" | null;
  tool_ok: boolean | null;
};

const PROJECTION_WITHHOLDS_NOTHING = false;

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

function feedKind(row: SessionFeedRow): "message" | "delivered_input" {
  return row.intent === "agent_request" ? "delivered_input" : "message";
}

function authorKind(row: SessionFeedRow): "person" | "agent" | "system" {
  if (row.agent_session_id !== null) return "agent";
  if (row.author_id === null) return "system";
  return "person";
}

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

    const ownMessagesOnly = !(await hasStandingRunAccess(
      transaction,
      organizationId,
      principalId,
    ));
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
      filters: `session:${id}:${ownMessagesOnly ? "own" : "all"}`,
      schemaVersion: 1,
    };
    const position = await decodeSequenceIdCursor(
      secret,
      input.cursor,
      cursorBinding,
    );
    const limit = input.limit ?? 25;
    // The stream asks forward from a sequence it already sent; a JSON reader
    // never sets this, it passes the opaque cursor instead.
    const afterSequence = input.sequenceAfter ?? position?.sequence ?? null;
    const afterId = input.sequenceAfter === undefined
      ? position?.id ?? null
      : null;
    const result = await transaction.query<SessionFeedRow>(
      `select feed.id, feed.source_kind, feed.conversation_id,
              feed.author_id, feed.agent_session_id, feed.message_type,
              feed.body, feed.intent, feed.sequence::text, feed.created_at,
              feed.tool_call_id, feed.tool_name, feed.tool_phase, feed.tool_ok
         from (
           select message.id, 'message'::text as source_kind,
                  message.conversation_id, message.author_id,
                  message.agent_session_id, message.message_type, message.body,
                  message.intent, message.sequence, message.created_at,
                  null::uuid as tool_call_id, null::text as tool_name,
                  null::text as tool_phase, null::boolean as tool_ok
             from bakery.messages message
            where message.organization_id = $1
              and message.conversation_id = $2
              and (
                not $6::boolean or message.agent_session_id = $7::uuid or exists (
                  select 1 from bakery.decisions_ledger steer
                   where steer.organization_id = message.organization_id
                     and steer.kind = 'steer'
                     and steer.subject_kind = 'session'
                     and steer.subject_id = $7::uuid
                     and steer.detail ->> 'messageId' = message.id::text
                )
              )
           union all
           select event.id, 'tool'::text as source_kind,
                  event.conversation_id, null::uuid as author_id,
                  event.agent_session_id, null::text as message_type,
                  null::text as body, null::text as intent, event.sequence,
                  event.occurred_at as created_at,
                  event.tool_gateway_call_id as tool_call_id,
                  call.effective_name as tool_name, event.phase as tool_phase,
                  event.ok as tool_ok
             from bakery.session_tool_feed_events event
             join bakery.tool_gateway_calls call
               on call.organization_id = event.organization_id
              and call.id = event.tool_gateway_call_id
            where event.organization_id = $1
              and event.conversation_id = $2
              and event.agent_session_id = $7::uuid
         ) feed
        where (
          $3::bigint is null or
          (feed.sequence, feed.id) > ($3::bigint, $4::uuid)
        )
        order by feed.sequence asc, feed.id asc
        limit $5`,
      [
        organizationId,
        conversationId,
        afterSequence,
        afterId,
        limit + 1,
        ownMessagesOnly,
        id,
      ],
    );

    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    const items = visible.map((row) => {
      if (row.source_kind === "tool") {
        if (
          row.tool_call_id === null ||
          row.tool_name === null ||
          row.tool_phase === null
        ) throw new Error("TOOL_FEED_EVENT_INVALID");
        return {
          id: row.id,
          sessionId: id,
          sequence: row.sequence,
          kind: "tool" as const,
          occurredAt: iso(row.created_at),
          redacted: PROJECTION_WITHHOLDS_NOTHING,
          message: null,
          terminal: null,
          status: null,
          tool: {
            callId: row.tool_call_id,
            name: row.tool_name,
            phase: row.tool_phase,
            ok: row.tool_ok,
          },
          fileChange: null,
          artifact: null,
          usage: null,
          deliveredInput: null,
        };
      }
      if (
        row.body === null ||
        row.message_type === null ||
        row.intent === null
      ) throw new Error("MESSAGE_FEED_EVENT_INVALID");
      const kind = feedKind(row);
      return {
        id: row.id,
        sessionId: id,
        sequence: row.sequence,
        kind,
        occurredAt: iso(row.created_at),
        redacted: PROJECTION_WITHHOLDS_NOTHING,
        message: kind === "message"
          ? {
            messageId: row.id,
            authorId: row.author_id,
            authorKind: authorKind(row),
            messageType: row.message_type,
            body: row.body,
          }
          : null,
        terminal: null,
        status: null,
        tool: null,
        fileChange: null,
        artifact: null,
        usage: null,
        deliveredInput: kind === "delivered_input"
          ? { messageId: row.id, body: row.body }
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
