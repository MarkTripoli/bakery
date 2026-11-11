import { z } from "zod";
import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

const BATCH_SIZE = 1_000;
const REPLAY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;
const LEGACY_FAILURE = Object.freeze({ code: "OUTBOX_LEGACY_FAILURE" });
const LegacyOutboxStatus = Object.freeze(
  {
    Pending: "pending",
    Sending: "sending",
    Delivered: "delivered",
    Failed: "failed",
  } as const,
);
const LegacyOutboxStatusSchema = z.enum([
  LegacyOutboxStatus.Pending,
  LegacyOutboxStatus.Sending,
  LegacyOutboxStatus.Delivered,
  LegacyOutboxStatus.Failed,
]).describe("Outbox delivery status understood by this immutable repair.");
const LegacyDeliveryErrorSchema = z.record(
  z.string().trim().min(1).describe(
    "Nonblank legacy diagnostic property name.",
  ),
  z.json().describe("JSON-compatible legacy diagnostic property value."),
).describe("Legacy delivery diagnostic retained by this immutable repair.");
const NullableJsonSchema = z.json().nullable().describe(
  "JSON delivery diagnostic from the legacy row, or null when absent.",
);

const LegacyOutboxRowSchema = z.object({
  id: z.string().uuid().describe("Outbox row identifier selected for repair."),
  deliveryKey: z.string().trim().min(1).describe(
    "Stable delivery identity used to recover a legacy acknowledgement identifier.",
  ),
  status: LegacyOutboxStatusSchema,
  attemptCount: z.number().int().nonnegative().describe(
    "Number of delivery attempts recorded before repair.",
  ),
  leaseToken: z.string().uuid().nullable().describe(
    "Legacy lease token, null when no dispatcher owns the row.",
  ),
  leaseUntil: z.date().nullable().describe(
    "Legacy lease deadline, null when no dispatcher owns the row.",
  ),
  deliveredAt: z.date().nullable().describe(
    "Legacy engine acknowledgement time, if one was recorded.",
  ),
  engineEventId: z.string().nullable().describe(
    "Legacy engine acknowledgement identifier, if one was recorded.",
  ),
  lastError: NullableJsonSchema,
  replayDeadlineAt: z.date().nullable().describe(
    "Legacy replay-safety deadline, if one was recorded.",
  ),
  updatedAt: z.date().describe(
    "Last persisted row update used as deterministic repair provenance.",
  ),
}).strict().describe(
  "Legacy outbox persistence row requiring application-owned normalization.",
);
type LegacyOutboxRow = z.infer<typeof LegacyOutboxRowSchema>;

type NormalizedOutboxRow = {
  readonly status: typeof LegacyOutboxStatus[keyof typeof LegacyOutboxStatus];
  readonly leaseToken: string | null;
  readonly leaseUntil: Date | null;
  readonly deliveredAt: Date | null;
  readonly engineEventId: string | null;
  readonly lastError: z.infer<typeof NullableJsonSchema>;
  readonly replayDeadlineAt: Date | null;
};

function replayDeadline(row: LegacyOutboxRow): Date | null {
  return row.attemptCount === 0 ? null : row.replayDeadlineAt ??
    new Date(row.updatedAt.getTime() + REPLAY_WINDOW_MILLISECONDS);
}

function deliveryError(value: z.infer<typeof NullableJsonSchema>) {
  const parsed = LegacyDeliveryErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : LEGACY_FAILURE;
}

function isNormalizedOutboxRow(row: NormalizedOutboxRow): boolean {
  const unleased = row.leaseToken === null && row.leaseUntil === null;
  const unacknowledged = row.deliveredAt === null && row.engineEventId === null;
  return row.status === LegacyOutboxStatus.Pending
    ? unleased && unacknowledged
    : row.status === LegacyOutboxStatus.Sending
    ? row.leaseToken !== null && row.leaseUntil !== null && unacknowledged
    : row.status === LegacyOutboxStatus.Delivered
    ? unleased && row.deliveredAt !== null && row.engineEventId !== null &&
      row.lastError === null
    : unleased && unacknowledged && row.lastError !== null;
}

function assertNormalizedOutboxRow(row: NormalizedOutboxRow): void {
  if (!isNormalizedOutboxRow(row)) {
    throw new Error("OUTBOX_REPAIR_STATE_INVALID");
  }
}

export function normalizeLegacyOutboxRow(
  row: LegacyOutboxRow,
): NormalizedOutboxRow {
  const deadline = replayDeadline(row);
  if (row.status === LegacyOutboxStatus.Delivered) {
    return {
      status: row.status,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: row.deliveredAt ?? row.updatedAt,
      engineEventId: row.engineEventId?.trim() || row.deliveryKey,
      lastError: null,
      replayDeadlineAt: deadline,
    };
  }
  if (row.status === LegacyOutboxStatus.Failed) {
    return {
      status: row.status,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: null,
      engineEventId: null,
      lastError: deliveryError(row.lastError),
      replayDeadlineAt: deadline,
    };
  }
  if (row.status === LegacyOutboxStatus.Sending && deadline !== null) {
    const normalized: NormalizedOutboxRow = {
      status: row.status,
      leaseToken: row.leaseToken,
      leaseUntil: row.leaseUntil,
      deliveredAt: row.deliveredAt,
      engineEventId: row.engineEventId,
      lastError: row.lastError === null ? null : deliveryError(row.lastError),
      replayDeadlineAt: deadline,
    };
    if (isNormalizedOutboxRow(normalized)) return normalized;
  }
  return {
    status: LegacyOutboxStatus.Pending,
    leaseToken: null,
    leaseUntil: null,
    deliveredAt: null,
    engineEventId: null,
    lastError: row.lastError === null ? null : deliveryError(row.lastError),
    replayDeadlineAt: deadline,
  };
}

async function repairBatch(
  connection: Parameters<DataMigration["run"]>[0],
): Promise<number> {
  return await runDataMigrationBatch(connection, async (transaction) => {
    const rawRows = await transaction`
      select id, delivery_key as "deliveryKey", status,
        attempt_count as "attemptCount", lease_token as "leaseToken",
        lease_until as "leaseUntil", delivered_at as "deliveredAt",
        engine_event_id as "engineEventId", last_error as "lastError",
        replay_deadline_at as "replayDeadlineAt", updated_at as "updatedAt"
      from bakery.outbox
      where (status = 'pending' and (
          lease_token is not null or lease_until is not null
          or delivered_at is not null or engine_event_id is not null
        )) or (status = 'sending' and (
          lease_token is null or lease_until is null
          or delivered_at is not null or engine_event_id is not null
        )) or (status = 'delivered' and (
          lease_token is not null or lease_until is not null
          or delivered_at is null or engine_event_id is null
          or btrim(engine_event_id) = '' or last_error is not null
        )) or (status = 'failed' and (
          lease_token is not null or lease_until is not null
          or delivered_at is not null or engine_event_id is not null
          or last_error is null
        )) or (last_error is not null and jsonb_typeof(last_error) <> 'object')
          or exists (
            select 1 from jsonb_object_keys(last_error) as diagnostic(key)
            where btrim(diagnostic.key) = ''
          )
          or (attempt_count = 0 and replay_deadline_at is not null)
          or (attempt_count > 0 and replay_deadline_at is null)
      order by id
      for update
      limit ${BATCH_SIZE}
    `;
    for (const rawRow of rawRows) {
      const row = LegacyOutboxRowSchema.parse(rawRow);
      const normalized = normalizeLegacyOutboxRow(row);
      assertNormalizedOutboxRow(normalized);
      await transaction`
        update bakery.outbox
        set status = ${normalized.status},
          lease_token = ${normalized.leaseToken},
          lease_until = ${normalized.leaseUntil},
          delivered_at = ${normalized.deliveredAt},
          engine_event_id = ${normalized.engineEventId},
          last_error = ${
        normalized.lastError === null
          ? null
          : transaction.json(normalized.lastError)
      },
          replay_deadline_at = ${normalized.replayDeadlineAt}
        where id = ${row.id}
      `;
    }
    return rawRows.length;
  });
}

export const outboxDispatchBackfill: DataMigration = {
  version: "0015_outbox_dispatch_backfill",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      if (await repairBatch(connection) === 0) return true;
    }
    return false;
  },
};
