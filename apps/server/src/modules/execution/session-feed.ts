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
  conversation_id: string;
  author_id: string | null;
  agent_session_id: string | null;
  message_type: string;
  body: string;
  intent: string;
  sequence: string;
  created_at: Date | string;
};

/**
 * Whether an item had secret material withheld from it.
 *
 * No current source can carry such material: the projection reads attributed
 * message columns only. A source that can must compute this per item instead of
 * reusing this constant.
 */
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
 * switch on `kind` without guessing. An item is never dropped in favour of a
 * partial one, so a client resuming from its last sequence sees a gapless
 * continuation.
 *
 * Redaction has two gates, and the mapper is the one that holds. The mapper
 * builds each item from named fields, so a column the SELECT happens to return
 * still cannot reach the wire: widening the SELECT alone leaves every test
 * green, while spreading the raw row into the item leaks at once. The SELECT is
 * the second gate, not the first, and no column it reads today holds secret
 * ciphertext, a lease token or a raw provider payload. A message body is
 * authored by a person, and text a person typed is their message, not a server
 * secret, so the feed republishes it verbatim rather than guessing at what
 * inside it looks secret. A future source that can carry real secret material
 * (harness terminal or tool output) must redact per item and set `redacted`
 * from that, never reuse the constant below.
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
          and (not $6::boolean or message.agent_session_id = $7::uuid)
        order by message.sequence asc, message.id asc
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
      const kind = feedKind(row);
      const body = row.body;
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
