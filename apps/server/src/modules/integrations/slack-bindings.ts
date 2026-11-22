/**
 * One Slack thread, one conversation (issue #27, design 09-integrations
 * "Bindings"). A mention that starts a conversation and a reply that finds it
 * again both go through here, and two first mentions that arrive together end
 * with exactly one row and one conversation.
 *
 * Every function takes the caller's transaction. An id that is not an id is
 * refused with a reason before the database is touched. Nothing here stores a
 * message, a name or a token: only the ids that name the thread.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import { isSlackAppId, isSlackTeamId } from "./slack-scope.ts";

/** The provider column value for every row this module writes. */
export const SLACK_CHANNEL_PROVIDER = "slack";

// The same channels slack-scope.ts selects: public (C) and private (G), never a
// direct message.
const CHANNEL_ID = /^[CG][A-Z0-9]{2,31}$/;
/** Slack's message timestamp: seconds, a dot and six digits, kept as text. */
const SLACK_TS = /^\d{10}\.\d{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isSlackChannelId = (value: unknown): value is string =>
  typeof value === "string" && CHANNEL_ID.test(value);

export const isSlackTs = (value: unknown): value is string =>
  typeof value === "string" && SLACK_TS.test(value);

/** What names a thread. */
export type SlackThreadKey = {
  readonly appId: string;
  readonly teamId: string;
  readonly channelId: string;
  /** The first message of the thread; a top-level message is its own thread. */
  readonly threadTs: string;
};

export type SlackBinding = SlackThreadKey & {
  readonly id: string;
  readonly organizationId: string;
  readonly conversationId: string;
  readonly createdBy: string;
  readonly createdAt: string;
};

export type BindSlackThreadResult =
  | {
    readonly ok: true;
    readonly binding: SlackBinding;
    /** True only for the call that opened the conversation. */
    readonly created: boolean;
  }
  | { readonly ok: false; readonly reason: "malformed" };

type Query = Pick<PgTransactionClient, "query">;

type Row = {
  id: string;
  organizationId: string;
  appId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  conversationId: string;
  createdBy: string;
  createdAt: Date;
};

const COLUMNS = `id, organization_id as "organizationId", app_id as "appId",
  team_id as "teamId", channel_id as "channelId", thread_ts as "threadTs",
  conversation_id as "conversationId", created_by as "createdBy",
  created_at as "createdAt"`;

function view(row: Row): SlackBinding {
  return {
    id: row.id,
    organizationId: row.organizationId,
    appId: row.appId,
    teamId: row.teamId,
    channelId: row.channelId,
    threadTs: row.threadTs,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether every id of a thread key is the shape Slack gives. */
export function isSlackThreadKey(key: unknown): key is SlackThreadKey {
  if (typeof key !== "object" || key === null) return false;
  const value = key as Record<string, unknown>;
  return isSlackAppId(value.appId) && isSlackTeamId(value.teamId) &&
    isSlackChannelId(value.channelId) && isSlackTs(value.threadTs);
}

/** The binding for a thread of an organization, or undefined. */
export async function findSlackBinding(
  transaction: Query,
  organizationId: string,
  key: SlackThreadKey,
): Promise<SlackBinding | undefined> {
  if (!UUID.test(organizationId) || !isSlackThreadKey(key)) return undefined;
  const result = await transaction.query<Row>(
    `select ${COLUMNS} from bakery.channel_links
      where organization_id = $1 and provider = $2 and app_id = $3
        and team_id = $4 and channel_id = $5 and thread_ts = $6`,
    [
      organizationId,
      SLACK_CHANNEL_PROVIDER,
      key.appId,
      key.teamId,
      key.channelId,
      key.threadTs,
    ],
  );
  return result.rows[0] ? view(result.rows[0]) : undefined;
}

/**
 * Opens a conversation for a Slack thread, owned by the linked person whose
 * mention started it. Application and repository are left empty: a Slack
 * thread is not tied to either until the conversation is.
 */
export async function openSlackConversation(
  transaction: Query,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const result = await transaction.query<{ id: string }>(
    `insert into bakery.conversations (organization_id, title, created_by)
     values ($1, 'Slack thread', $2) returning id`,
    [organizationId, principalId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("SLACK_CONVERSATION_INSERT_FAILED");
  return id;
}

/**
 * Finds the binding for a thread or creates it, once. A lock named after the
 * thread makes simultaneous first mentions take turns: the first opens the
 * conversation and the row, the rest find the row and reuse it. The lock is
 * held to the end of the caller's transaction, so the winner's conversation is
 * committed before anyone else reads.
 *
 * `open` creates the conversation; it runs only when there is no binding yet.
 */
export async function bindSlackThread(
  transaction: Query,
  input: {
    readonly organizationId: string;
    readonly key: SlackThreadKey;
    readonly principalId: string;
    readonly open?: (transaction: Query) => Promise<string>;
  },
): Promise<BindSlackThreadResult> {
  if (
    !UUID.test(input.organizationId) || !UUID.test(input.principalId) ||
    !isSlackThreadKey(input.key)
  ) return { ok: false, reason: "malformed" };
  const { key } = input;
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `slack-thread:${SLACK_CHANNEL_PROVIDER}:${key.appId}:${key.teamId}:${key.channelId}:${key.threadTs}`,
    ],
  );
  const existing = await findSlackBinding(
    transaction,
    input.organizationId,
    key,
  );
  if (existing) return { ok: true, binding: existing, created: false };
  const conversationId = await (input.open ??
    ((tx: Query) =>
      openSlackConversation(tx, input.organizationId, input.principalId)))(
      transaction,
    );
  const inserted = await transaction.query<Row>(
    `insert into bakery.channel_links (
       organization_id, provider, app_id, team_id, channel_id, thread_ts,
       conversation_id, created_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${COLUMNS}`,
    [
      input.organizationId,
      SLACK_CHANNEL_PROVIDER,
      key.appId,
      key.teamId,
      key.channelId,
      key.threadTs,
      conversationId,
      input.principalId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("SLACK_BINDING_INSERT_FAILED");
  return { ok: true, binding: view(row), created: true };
}
