import type { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type NotificationApprovalOutcome,
  readApprovalOutcomes,
} from "./notification-approval-outcome.ts";

/**
 * Column list selecting a `NotificationRow`. The `to_char` cursor form matches
 * the audit and task list readers: microsecond precision, fixed UTC text, so a
 * keyset cursor compares exactly.
 */
export const NOTIFICATION_COLUMNS =
  `n.id, n.organization_id as "organizationId",
  n.recipient_id as "recipientId", n.kind, n.target_kind as "targetKind",
  n.target_id as "targetId", n.target_anchor as "targetAnchor",
  n.conversation_id as "conversationId", n.run_id as "runId",
  n.task_id as "taskId", n.actor_id as "actorId",
  n.source_event_id as "sourceEventId", n.source_version as "sourceVersion",
  n.arguments, n.read_at as "readAt", n.revision,
  n.created_at as "createdAt",
  a.display_name as "actorName",
  to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as "cursorCreatedAt"`;

export type NotificationRow = {
  id: string;
  organizationId: string;
  recipientId: string;
  kind: string;
  targetKind: string;
  targetId: string;
  targetAnchor: string | null;
  conversationId: string | null;
  runId: string | null;
  taskId: string | null;
  actorId: string | null;
  sourceEventId: string | null;
  sourceVersion: number;
  arguments: unknown;
  readAt: Date | null;
  revision: number;
  createdAt: Date;
  actorName: string | null;
  cursorCreatedAt: string;
};

/**
 * The destination summary a row carries. It is resolved at read time against
 * the recipient's current authority rather than frozen into the row, so a
 * target that has since been deleted, moved or revoked reports unavailable and
 * withholds its title instead of showing a stale one.
 */
export type NotificationDestination = {
  title: string | null;
  available: boolean;
};

export type NotificationScope = {
  organizationId: string;
  recipientId: string;
};

const ORDERING = "createdAt:desc,id:desc";
const MENTION_KINDS = ["mention", "comment_mention"];

function binding(
  action: string,
  scope: NotificationScope,
  filters: unknown,
): CursorBinding {
  return {
    action,
    principalId: scope.recipientId,
    organizationId: scope.organizationId,
    ordering: ORDERING,
    filters: JSON.stringify(filters),
    schemaVersion: 1,
  };
}

/**
 * Renders one stored row into the `Notification` contract. `destination` comes
 * from the caller because resolving it is a separate, authorization-sensitive
 * read; everything else is a straight projection with no hidden fields.
 */
export function toNotification(
  row: NotificationRow,
  destination: NotificationDestination,
  approvalOutcome: NotificationApprovalOutcome | null,
) {
  const actor = row.actorId === null ? null : {
    principalId: row.actorId,
    // A removed account leaves actorId null through the FK; a surviving row
    // with a name keeps the name it had, else the client shows "Someone".
    displayName: row.actorName ?? "Someone",
    avatarUrl: null,
  };
  return contractSchemas.Notification.parse({
    id: row.id,
    organizationId: row.organizationId,
    recipientId: row.recipientId,
    kind: row.kind,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetAnchor: row.targetAnchor,
    conversationId: row.conversationId,
    runId: row.runId,
    taskId: row.taskId,
    actor,
    destination,
    approvalOutcome: destination.available ? approvalOutcome : null,
    read: row.readAt !== null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Newest-first page of one recipient's inbox. The recipient predicate is the
 * whole authorization story for this read: a row is visible only to the member
 * in recipient_id, and a cursor from another filter or another recipient fails
 * closed because the binding includes both.
 */
export async function listNotifications(
  transaction: PgTransactionClient,
  input: {
    action: string;
    scope: NotificationScope;
    query: z.output<typeof contractSchemas.NotificationCursorQuery>;
    secret: string;
    destinationOf: (
      row: NotificationRow,
    ) => Promise<NotificationDestination>;
  },
) {
  const { query, scope } = input;
  const filter = query.filter ?? "all";
  const cursor = await decodeCursor(
    input.secret,
    query.cursor,
    binding(input.action, scope, { filter }),
  );
  const limit = query.limit ?? 25;
  const result = await transaction.query<NotificationRow>(
    `select ${NOTIFICATION_COLUMNS}
     from bakery.notifications as n
     left join bakery.principals as a on a.id = n.actor_id
     where n.organization_id = $1::uuid
       and n.recipient_id = $2::uuid
       and ($3::text <> 'unread' or n.read_at is null)
       and ($3::text <> 'mentions' or n.kind = any($4::text[]))
       and ($5::timestamptz is null
         or (n.created_at, n.id) < ($5::timestamptz, $6::uuid))
     order by n.created_at desc, n.id desc
     limit $7`,
    [
      scope.organizationId,
      scope.recipientId,
      filter,
      MENTION_KINDS,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  const outcomes = await readApprovalOutcomes(
    transaction,
    scope.organizationId,
    page,
  );
  const items = await Promise.all(
    page.map(async (row: NotificationRow) =>
      toNotification(
        row,
        await input.destinationOf(row),
        outcomes.get(row.targetId) ?? null,
      )
    ),
  );
  return {
    items,
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(
        input.secret,
        binding(input.action, scope, {
          filter,
        }),
        { createdAt: last.cursorCreatedAt, id: last.id },
      )
      : null,
  };
}

/** The unread total for one recipient, and the newest revision it covers. */
export async function readNotificationCount(
  transaction: PgTransactionClient,
  scope: NotificationScope,
): Promise<{ unread: number; revision: number | null }> {
  const result = await transaction.query<
    { unread: string; revision: number | null }
  >(
    `select count(*)::text as unread, max(revision) as revision
     from bakery.notifications
     where organization_id = $1::uuid and recipient_id = $2::uuid
       and read_at is null`,
    [scope.organizationId, scope.recipientId],
  );
  const row = result.rows[0];
  return {
    unread: Number(row?.unread ?? "0"),
    revision: row?.revision ?? null,
  };
}

/** One notification the recipient owns, or `RESOURCE_NOT_FOUND`. */
export async function readNotification(
  transaction: PgTransactionClient,
  scope: NotificationScope,
  id: string,
): Promise<NotificationRow> {
  const result = await transaction.query<NotificationRow>(
    `select ${NOTIFICATION_COLUMNS}
     from bakery.notifications as n
     left join bakery.principals as a on a.id = n.actor_id
     where n.organization_id = $1::uuid
       and n.recipient_id = $2::uuid
       and n.id = $3::uuid`,
    [scope.organizationId, scope.recipientId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/**
 * Sets read or unread under the revision the client last saw. The row lock
 * serializes two devices racing the same item, so the second write sees the
 * first and its stale revision loses as a version conflict rather than the two
 * silently interleaving. Marking read twice at the same revision is a no-op
 * beyond the write, which keeps a retry safe.
 */
export async function setNotificationRead(
  transaction: PgTransactionClient,
  scope: NotificationScope,
  change: z.output<typeof contractSchemas.NotificationReadUpdate>,
): Promise<NotificationRow> {
  const locked = await transaction.query<
    { revision: number; readAt: Date | null }
  >(
    `select revision, read_at as "readAt"
     from bakery.notifications
     where organization_id = $1::uuid and recipient_id = $2::uuid
       and id = $3::uuid
     for update`,
    [scope.organizationId, scope.recipientId, change.id],
  );
  const current = locked.rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.revision !== change.expectedCasVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const alreadyWanted = change.read
    ? current.readAt !== null
    : current.readAt === null;
  // A repeated Mark read at the same revision is the same state; do not burn a
  // revision on it, or two devices toggling the same value would ping-pong.
  if (alreadyWanted) {
    return await readNotification(transaction, scope, change.id);
  }
  await transaction.query(
    `update bakery.notifications
     set read_at = $4::timestamptz, revision = revision + 1,
       read_batch_id = null
     where organization_id = $1::uuid and recipient_id = $2::uuid
       and id = $3::uuid`,
    [
      scope.organizationId,
      scope.recipientId,
      change.id,
      change.read ? new Date().toISOString() : null,
    ],
  );
  return await readNotification(transaction, scope, change.id);
}

/**
 * Marks everything created at or before the client's cutoff read, leaving
 * arrivals during the action unread. It reports both how many it changed and
 * how many remain unread, so the client can say "Marked 12 read. 2 new
 * notifications arrived." without a second round trip.
 */
export async function markAllNotificationsRead(
  transaction: PgTransactionClient,
  scope: NotificationScope,
  readBefore: string,
): Promise<
  {
    marked: number;
    remainingUnread: number;
    revision: number;
    batchId: string | null;
  }
> {
  // The press is recorded first so every row it marks can point back at it;
  // undo then restores exactly these rows. Rows are locked in a stable order
  // so two devices pressing at once serialize instead of deadlocking.
  const batch = await transaction.query<{ id: string }>(
    `insert into bakery.notification_read_batches (organization_id, recipient_id)
     values ($1, $2) returning id`,
    [scope.organizationId, scope.recipientId],
  );
  const batchId = batch.rows[0]?.id;
  if (!batchId) throw new Error("NOTIFICATION_READ_BATCH_INSERT_FAILED");
  const updated = await transaction.query<{ id: string }>(
    `with target as (
       select id from bakery.notifications
       where organization_id = $1::uuid and recipient_id = $2::uuid
         and read_at is null and created_at <= $3::timestamptz
       order by id
       for update
     )
     update bakery.notifications as n
     set read_at = now(), revision = n.revision + 1, read_batch_id = $4::uuid
     from target where n.id = target.id
     returning n.id`,
    [scope.organizationId, scope.recipientId, readBefore, batchId],
  );
  const remaining = await transaction.query<
    { unread: string; revision: number | null }
  >(
    `select count(*)::text as unread, max(revision) as revision
     from bakery.notifications
     where organization_id = $1::uuid and recipient_id = $2::uuid
       and read_at is null`,
    [scope.organizationId, scope.recipientId],
  );
  return {
    marked: updated.rows.length,
    remainingUnread: Number(remaining.rows[0]?.unread ?? "0"),
    revision: remaining.rows[0]?.revision ?? 0,
    batchId: updated.rows.length > 0 ? batchId : null,
  };
}

/** How long a mark-all-read press can be undone (the UX toast is 10 s). */
export const MARK_ALL_UNDO_WINDOW_SECONDS = 600;

/**
 * Undoes one mark-all-read press of this recipient, once, within the window.
 * Only rows that still carry the press's batch id become unread: a row read or
 * unread again since then had its batch id cleared and keeps the newer state.
 */
export async function undoMarkAllNotificationsRead(
  transaction: PgTransactionClient,
  scope: NotificationScope,
  batchId: string,
): Promise<{ restored: number; unread: number; revision: number }> {
  const locked = await transaction.query<
    { undone: boolean; expired: boolean }
  >(
    `select undone_at is not null as undone,
       created_at < now() - make_interval(secs => $4) as expired
     from bakery.notification_read_batches
     where organization_id = $1::uuid and recipient_id = $2::uuid
       and id = $3::uuid
     for update`,
    [
      scope.organizationId,
      scope.recipientId,
      batchId,
      MARK_ALL_UNDO_WINDOW_SECONDS,
    ],
  );
  const batch = locked.rows[0];
  if (!batch) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (batch.undone || batch.expired) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: batch.undone ? "undo_already_applied" : "undo_window_expired",
      },
    });
  }
  await transaction.query(
    `update bakery.notification_read_batches set undone_at = now()
     where organization_id = $1::uuid and id = $2::uuid`,
    [scope.organizationId, batchId],
  );
  const restored = await transaction.query<{ id: string }>(
    `with target as (
       select id from bakery.notifications
       where organization_id = $1::uuid and recipient_id = $2::uuid
         and read_batch_id = $3::uuid
       order by id
       for update
     )
     update bakery.notifications as n
     set read_at = null, revision = n.revision + 1, read_batch_id = null
     from target where n.id = target.id
     returning n.id`,
    [scope.organizationId, scope.recipientId, batchId],
  );
  const count = await readNotificationCount(transaction, scope);
  const newest = await transaction.query<{ revision: number | null }>(
    `select max(revision) as revision from bakery.notifications
     where organization_id = $1::uuid and recipient_id = $2::uuid`,
    [scope.organizationId, scope.recipientId],
  );
  return {
    restored: restored.rows.length,
    unread: count.unread,
    revision: newest.rows[0]?.revision ?? 1,
  };
}
