import type { QueryResultRow } from "pg";
import { z } from "zod";
import type { PgTransactionClient } from "./database.ts";
import { withPgTransaction } from "./database.ts";
import {
  type ClaimedOutboxRow,
  ClaimedOutboxRowSchema,
  OutboxIdSchema,
  type OutboxRepositoryOptions,
} from "./outbox-types.ts";
import {
  OutboxDeliveryStateSchema,
  OutboxDeliveryStatus,
} from "./outbox-state.ts";

const MAX_CLAIM_SCAN = 100;
const OutboxClaimPersistenceRowSchema = z.intersection(
  ClaimedOutboxRowSchema,
  z.object({
    action: z.union([
      z.literal("claimed").describe(
        "Row atomically fenced for delivery by this claim transaction.",
      ),
      z.literal("settled").describe(
        "Pending row atomically classified as terminal without provider delivery.",
      ),
    ]).describe(
      "Database decision made while the candidate row lock was held.",
    ),
  }).strict().describe(
    "Claim action returned by the atomic outbox classification statement.",
  ),
).describe(
  "Validated persistence row containing joined event data and the atomic claim decision.",
);

export async function claimOutboxRows(
  options: OutboxRepositoryOptions,
  limit: number,
): Promise<readonly ClaimedOutboxRow[]> {
  return await withPgTransaction(options.database, async (transaction) => {
    const requested = Math.min(Math.max(limit, 1), MAX_CLAIM_SCAN);
    const result = await transaction.query<QueryResultRow>(
      `
      with expired_candidates as materialized (
        select id, false as terminal, 0 as priority,
          lease_until as available_at
      from bakery.outbox
        where status = $2 and lease_until <= now()
          and lease_token is not null
          and delivered_at is null and engine_event_id is null
          and attempt_count < $3
          and (
            (attempt_count = 0 and replay_deadline_at is null)
            or (attempt_count > 0
              and replay_deadline_at > now() + ($8 * interval '1 second'))
          )
        order by lease_until, created_at, id
        for update skip locked
        limit least($4::int, $5::int)
      ), terminal_candidates as materialized (
        select id, true as terminal, 1 as priority,
          case when status = $2 then lease_until else next_attempt_at end
            as available_at
        from bakery.outbox
        where (
          status = $1 and (
            lease_token is not null or lease_until is not null
            or delivered_at is not null or engine_event_id is not null
            or attempt_count >= $3
            or (attempt_count = 0 and replay_deadline_at is not null)
            or (attempt_count > 0 and replay_deadline_at is null)
            or (
              attempt_count > 0
              and replay_deadline_at <= now() + ($8 * interval '1 second')
            )
          )
        ) or (
          status = $2 and (
            lease_until is null
            or lease_token is null
            or delivered_at is not null
            or engine_event_id is not null
            or (lease_until <= now() and (
              attempt_count >= $3
              or (attempt_count = 0 and replay_deadline_at is not null)
              or (attempt_count > 0 and replay_deadline_at is null)
              or (
                attempt_count > 0
                and replay_deadline_at <= now() + ($8 * interval '1 second')
              )
            ))
          )
        )
        order by available_at nulls last, created_at, id
        for update skip locked
        limit greatest(
          $4::int - (select count(*)::int from expired_candidates),
          0
        )
      ), pending_candidates as materialized (
        select id, false as terminal, 2 as priority,
          next_attempt_at as available_at
        from bakery.outbox
        where status = $1 and next_attempt_at <= now()
          and lease_token is null and lease_until is null
          and delivered_at is null and engine_event_id is null
          and attempt_count < $3
          and (
            (attempt_count = 0 and replay_deadline_at is null)
            or (attempt_count > 0
              and replay_deadline_at > now() + ($8 * interval '1 second'))
          )
        order by next_attempt_at, created_at, id
        for update skip locked
        limit greatest(least(
          $5::int - (select count(*)::int from expired_candidates),
          $4::int - (select count(*)::int from expired_candidates)
            - (select count(*)::int from terminal_candidates)
        ), 0)
      ), candidates as (
        select * from expired_candidates
        union all
        select * from terminal_candidates
        union all
        select * from pending_candidates
      ), mutated as (
        update bakery.outbox as outbox
        set status = case when candidates.terminal then $6 else $2 end,
          attempt_count = case when candidates.terminal then outbox.attempt_count
            else outbox.attempt_count + 1 end,
          replay_deadline_at = case when candidates.terminal
            then outbox.replay_deadline_at
            else coalesce(
              outbox.replay_deadline_at,
              now() + interval '24 hours'
            ) end,
          lease_token = case when candidates.terminal then null
            else gen_random_uuid() end,
          lease_until = case when candidates.terminal then null
            else now() + ($7 * interval '1 second') end,
          delivered_at = null,
          engine_event_id = null,
          last_error = case when candidates.terminal then
            case when (outbox.status = $1 and (
                outbox.lease_token is not null or outbox.lease_until is not null
                or outbox.delivered_at is not null
                or outbox.engine_event_id is not null
              )) or (outbox.status = $2 and (
                outbox.lease_until is null or outbox.lease_token is null
                or outbox.delivered_at is not null
                or outbox.engine_event_id is not null
              ))
              or (outbox.attempt_count = 0) <>
                (outbox.replay_deadline_at is null)
              then '{"code":"OUTBOX_STATE_INVALID"}'::jsonb
              when outbox.status = $2 or outbox.replay_deadline_at <=
              now() + ($8 * interval '1 second')
              then '{"code":"OUTBOX_RECONCILIATION_REQUIRED"}'::jsonb
              else '{"code":"OUTBOX_ATTEMPTS_EXHAUSTED"}'::jsonb end
            else outbox.last_error end,
          updated_at = now()
        from candidates
        where outbox.id = candidates.id
        returning outbox.*, candidates.terminal, candidates.priority,
          candidates.available_at
      )
      select outbox.id, outbox.destination,
        outbox.delivery_key as "deliveryKey",
        outbox.attempt_count as "attemptCount",
        outbox.next_attempt_at as "nextAttemptAt",
        outbox.replay_deadline_at as "replayDeadlineAt",
        outbox.status, outbox.lease_token as "leaseToken",
        outbox.lease_until as "leaseUntil",
        outbox.delivered_at as "deliveredAt",
        outbox.engine_event_id as "engineEventId",
        outbox.last_error as "lastError", event.id as "eventId",
        event.organization_id as "organizationId",
        event.organization_sequence::text as sequence,
        event.event_type as "eventType", event.schema_version as "schemaVersion",
        event.application_id as "applicationId", event.repository_id as "repositoryId",
        event.task_id as "taskId", event.conversation_id as "conversationId",
        event.aggregate_id as "aggregateId", event.aggregate_version as "aggregateVersion",
        event.payload, event.trace_id as "traceId", event.created_at as "createdAt",
        case when outbox.terminal then 'settled' else 'claimed' end as action
      from mutated as outbox
      join bakery.domain_events as event on event.id = outbox.event_id
      order by outbox.priority, outbox.available_at nulls last,
        outbox.created_at, outbox.id
    `,
      [
        OutboxDeliveryStatus.Pending,
        OutboxDeliveryStatus.Sending,
        options.maxAttempts,
        MAX_CLAIM_SCAN,
        requested,
        OutboxDeliveryStatus.Failed,
        options.leaseSeconds,
        options.replaySafetySeconds,
      ],
    );
    const rows: ClaimedOutboxRow[] = [];
    for (const raw of result.rows) {
      const parsed = OutboxClaimPersistenceRowSchema.safeParse(raw);
      if (!parsed.success) {
        await quarantine(transaction, raw);
        continue;
      }
      const row = parsed.data;
      if (row.action === "claimed") rows.push(row);
    }
    return rows;
  });
}

async function quarantine(
  transaction: PgTransactionClient,
  row: QueryResultRow,
): Promise<void> {
  const id = OutboxIdSchema.parse(row.id);
  const result = await transaction.query<QueryResultRow>(
    `
    update bakery.outbox
    set status = $2, lease_token = null, lease_until = null,
      delivered_at = null, engine_event_id = null,
      last_error = '{"code":"OUTBOX_STATE_INVALID"}'::jsonb,
      updated_at = now()
    where id = $1
    returning status, lease_token as "leaseToken", lease_until as "leaseUntil",
      delivered_at as "deliveredAt", engine_event_id as "engineEventId",
      last_error as "lastError"
  `,
    [id, OutboxDeliveryStatus.Failed],
  );
  if (result.rowCount !== 1) throw new Error("OUTBOX_QUARANTINE_FAILED");
  OutboxDeliveryStateSchema.parse(result.rows[0]);
}
