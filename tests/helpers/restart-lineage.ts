const MAX_LINEAGE_ROWS = 8;
export const MAX_RESTART_LINEAGE_DIAGNOSTIC_BYTES = 12_288;

const HEX_ID = /^[0-9a-f]{32}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINE_EVENT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FUNCTION_SLUG = /^[A-Za-z0-9./_-]{1,128}$/;
const FINISH_STATUS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const DELIVERY_STATUS = /^(pending|sending|delivered|failed)$/;
const GENERATION = /^[0-9]{1,20}$/;
// The engine database stores run start times without a zone, bakery's with one.
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:[0-9]{2})?)?$/;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function safeString(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : "[invalid]";
}

function safeNullableHex(value: unknown): string | null {
  return value === null ? null : safeString(value, HEX_ID);
}

function safeNullableTimestamp(value: unknown): string | null {
  return value === null ? null : safeString(value, TIMESTAMP);
}

function safeMilliseconds(value: unknown): number | null | "[invalid]" {
  if (value === null) return null;
  return Number.isSafeInteger(value) && Math.abs(Number(value)) <= 86_400_000
    ? Number(value)
    : "[invalid]";
}

function safeCount(value: unknown): number | "[invalid]" {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
      Number(value) <= 100
    ? Number(value)
    : "[invalid]";
}

function safeTotal(value: unknown): number | "[invalid]" {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
      Number(value) <= 10_000
    ? Number(value)
    : "[invalid]";
}

/**
 * Converts database observations into an allow-listed, row- and byte-bounded
 * diagnostic. Unknown fields and unsafe values never reach test logs.
 *
 * An invocation is labelled `outbox` when its event id is one of the run's
 * Bakery delivery keys and `recovery-or-other` otherwise, such as the event the
 * recovery cron sends without an id of its own. The lease is read against the
 * database clock, so a lapse shows as a negative `remainingMs`.
 */
export function formatRestartLineageDiagnostic(input: unknown): string {
  const source = record(input);
  const deliveryKeys = new Set(
    Array.isArray(source.requests)
      ? source.requests.slice(0, MAX_LINEAGE_ROWS).map((value) =>
        safeString(record(value).deliveryKey, ENGINE_EVENT_ID)
      )
      : [],
  );
  deliveryKeys.delete("[invalid]");
  const invocations = Array.isArray(source.invocations)
    ? source.invocations.slice(0, MAX_LINEAGE_ROWS).map((value) => {
      const row = record(value);
      const eventId = safeString(row.eventId, ENGINE_EVENT_ID);
      return {
        functionSlug: safeString(row.functionSlug, FUNCTION_SLUG),
        functionRunId: safeString(row.functionRunId, HEX_ID),
        eventId,
        eventInternalId: safeString(row.eventInternalId, HEX_ID),
        originalRunId: safeNullableHex(row.originalRunId),
        startedAt: safeString(row.startedAt, TIMESTAMP),
        finishStatus: safeString(row.finishStatus, FINISH_STATUS),
        source: deliveryKeys.has(eventId) ? "outbox" : "recovery-or-other",
      };
    })
    : [];
  const requests = Array.isArray(source.requests)
    ? source.requests.slice(0, MAX_LINEAGE_ROWS).map((value) => {
      const row = record(value);
      return {
        requestEventId: safeString(row.requestEventId, UUID),
        deliveryKey: safeString(row.deliveryKey, ENGINE_EVENT_ID),
        deliveryStatus: safeString(row.deliveryStatus, DELIVERY_STATUS),
        attempts: safeCount(row.attempts),
      };
    })
    : [];
  const lease = record(source.lease);
  const diagnostic = JSON.stringify({
    ownerGeneration: safeString(source.ownerGeneration, GENERATION),
    invocationCount: safeTotal(source.invocationCount),
    requestCount: safeTotal(source.requestCount),
    lease: {
      expiresAt: safeNullableTimestamp(lease.expiresAt),
      updatedAt: safeString(lease.updatedAt, TIMESTAMP),
      databaseNow: safeString(lease.databaseNow, TIMESTAMP),
      remainingMs: safeMilliseconds(lease.remainingMs),
    },
    invocations,
    requests,
  });
  if (
    new TextEncoder().encode(diagnostic).byteLength <=
      MAX_RESTART_LINEAGE_DIAGNOSTIC_BYTES
  ) {
    return diagnostic;
  }
  return JSON.stringify({
    error: "restart-lineage-diagnostic-too-large",
    invocationCount: safeTotal(source.invocationCount),
    requestCount: safeTotal(source.requestCount),
  });
}
