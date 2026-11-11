import { assertEquals, assertThrows } from "@std/assert";
import { INNGEST_EVENT_DEFINITIONS } from "../../packages/contracts/src/events.ts";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import {
  inngestEventName,
  outboxRetryDelaySeconds,
  toEngineEvent,
} from "../../apps/server/src/platform/outbox-events.ts";
import {
  OutboxDeliveryStateSchema,
  OutboxDeliveryStatus,
} from "../../apps/server/src/platform/outbox-state.ts";
import {
  newOutboxDeliveryKey,
  OutboxEventRecordSchema,
  outboxId,
} from "../../apps/server/src/platform/outbox-types.ts";

Deno.test("canonical domain events map only to explicit Inngest names", () => {
  // Given canonical trigger, unknown, and version-mismatch events
  const cases = [
    ["run.requested", 1, "bakery/run.requested.v1"],
    ["run.blocked", 1, null],
    ["job.completed", 1, "bakery/job.completed.v1"],
    ["conversation.turn_changed", 1, "bakery/conversation.turn_changed.v1"],
    ["tasks.created", 1, "bakery/tasks.created.v1"],
    ["tasks.updated", 1, "bakery/tasks.updated.v1"],
    ["run.requested", 2, null],
    ["unknown.event", 1, null],
  ] as const;

  // When each mapping is resolved
  const names = cases.map(([type, version]) => inngestEventName(type, version));

  // Then only exact catalog trigger mappings produce engine event names
  assertEquals(names, cases.map(([, , expected]) => expected));

  const runtimeTypes = new Set(Object.keys(INNGEST_EVENT_DEFINITIONS));
  const inventory = Object.entries(transport.events)
    .filter(([, event]) => event.inngestTrigger !== null)
    .map(([eventType, event]) => ({
      eventType,
      schemaVersion: event.schemaVersion,
      inngestTrigger: event.inngestTrigger,
      fields: Object.keys(event.payloadFields).sort(),
    })).sort((left, right) => left.eventType.localeCompare(right.eventType));
  assertEquals(
    inventory
      .map(({ eventType }) => eventType)
      .filter((eventType) => !runtimeTypes.has(eventType)),
    [],
    "inventory trigger definitions must exist at runtime",
  );
  const registry = Object.entries(INNGEST_EVENT_DEFINITIONS)
    .map(([eventType, definition]) => ({
      eventType,
      schemaVersion: definition.schemaVersion,
      inngestTrigger: definition.name,
      fields: Object.keys(definition.payload.shape).sort(),
    })).sort((left, right) => left.eventType.localeCompare(right.eventType));

  // Then every inventory trigger has a matching runtime schema, so deleting
  // one runtime definition fails here.
  assertEquals(registry, inventory);
});

Deno.test("outbox retry backoff remains bounded inside Inngest dedupe window", () => {
  // Given successive persisted attempt counts
  const attempts = [1, 2, 3, 4, 5];

  // When retry delays are calculated
  const delays = attempts.map(outboxRetryDelaySeconds);

  // Then backoff grows deterministically but stays far below 24 hours
  assertEquals(delays, [5, 10, 20, 40, 60]);
});

Deno.test("outbox delivery states accept only coherent field combinations", () => {
  // Given complete pending, sending, delivered, and failed state records
  const cases = [
    {
      status: OutboxDeliveryStatus.Pending,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: null,
      engineEventId: null,
      lastError: { code: "DELIVERY_RETRYABLE" },
    },
    {
      status: OutboxDeliveryStatus.Sending,
      leaseToken: "00000000-0000-4000-8000-000000000001",
      leaseUntil: new Date("2026-09-12T00:00:30.000Z"),
      deliveredAt: null,
      engineEventId: null,
      lastError: null,
    },
    {
      status: OutboxDeliveryStatus.Delivered,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: new Date("2026-09-12T00:00:01.000Z"),
      engineEventId: "engine-1",
      lastError: null,
    },
    {
      status: OutboxDeliveryStatus.Failed,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: null,
      engineEventId: null,
      lastError: { code: "DELIVERY_FAILED" },
    },
  ] as const;

  // When each record is parsed at the persistence boundary
  const results = cases.map((state) =>
    OutboxDeliveryStateSchema.safeParse(state).success
  );

  // Then every declared delivery state is accepted
  assertEquals(results, [true, true, true, true]);
});

Deno.test("outbox delivery states reject contradictory persisted fields", () => {
  // Given a delivered row without an engine acknowledgement
  const state = {
    status: OutboxDeliveryStatus.Delivered,
    leaseToken: null,
    leaseUntil: null,
    deliveredAt: new Date("2026-09-12T00:00:01.000Z"),
    engineEventId: null,
    lastError: null,
  };

  // When the record is parsed at the persistence boundary
  const result = OutboxDeliveryStateSchema.safeParse(state);

  // Then the contradictory state fails closed in application code
  assertEquals(result.success, false);
});

Deno.test("outbox identifiers cross boundaries through typed constructors", () => {
  // Given persisted and newly generated outbox identifiers
  const persistedId = "00000000-0000-4000-8000-000000000001";

  // When identifiers are constructed
  const parsedId = outboxId(persistedId);
  const deliveryKey = newOutboxDeliveryKey();

  // Then valid identifiers are usable and malformed persisted IDs fail closed
  assertEquals(parsedId, persistedId);
  assertEquals(typeof deliveryKey, "string");
  assertThrows(() => outboxId("not-an-outbox-id"));
});

Deno.test("outbox mapping rejects malformed input before engine delivery", () => {
  const row = OutboxEventRecordSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    deliveryKey: "task:00000000-0000-4000-8000-000000000004:version:1",
    destination: "inngest" as const,
    eventId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003",
    sequence: "1",
    eventType: "run.requested",
    schemaVersion: 1,
    applicationId: null,
    repositoryId: null,
    taskId: null,
    conversationId: null,
    aggregateId: "00000000-0000-4000-8000-000000000004",
    aggregateVersion: 1,
    payload: { runId: "00000000-0000-4000-8000-000000000004" },
    traceId: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
  });

  assertThrows(
    () => toEngineEvent({ ...row, payload: [] }),
    Error,
    "EVENT_PAYLOAD_INVALID",
  );
  assertThrows(
    () => toEngineEvent({ ...row, payload: {} }),
    Error,
    "EVENT_PAYLOAD_INVALID",
  );
  assertThrows(
    () => toEngineEvent({ ...row, payload: { runId: "not-a-uuid" } }),
    Error,
    "EVENT_PAYLOAD_INVALID",
  );
  assertThrows(
    () => toEngineEvent({ ...row, payload: {}, eventType: "unknown.event" }),
    Error,
    "EVENT_TRIGGER_UNMAPPED",
  );
});

Deno.test("outbox mapping preserves the persisted delivery identity", () => {
  // Given a delivery whose persisted key differs from its outbox row identifier
  const deliveryKey = "task:00000000-0000-4000-8000-000000000004:version:1";
  const row = OutboxEventRecordSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    deliveryKey,
    destination: "inngest" as const,
    eventId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003",
    sequence: "1",
    eventType: "tasks.created",
    schemaVersion: 1,
    applicationId: null,
    repositoryId: null,
    taskId: "00000000-0000-4000-8000-000000000004",
    conversationId: null,
    aggregateId: "00000000-0000-4000-8000-000000000004",
    aggregateVersion: 1,
    payload: {
      resourceId: "00000000-0000-4000-8000-000000000004",
      resourceVersion: 1,
    },
    traceId: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
  });

  // When the persisted delivery is mapped for Inngest
  const event = toEngineEvent(row);

  // Then retries use the producer-owned stable identity and canonical task trigger
  assertEquals(event.id, deliveryKey);
  assertEquals(event.name, "bakery/tasks.created.v1");
});

Deno.test("outbox mapping upgrades persisted legacy task invalidations", () => {
  const taskId = "00000000-0000-4000-8000-000000000004";
  const row = OutboxEventRecordSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    deliveryKey: `task:${taskId}:version:7`,
    destination: "inngest" as const,
    eventId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003",
    sequence: "1",
    eventType: "tasks.updated",
    schemaVersion: 1,
    applicationId: null,
    repositoryId: null,
    taskId,
    conversationId: null,
    aggregateId: taskId,
    aggregateVersion: 7,
    payload: { status: "draft", taskType: "implementation", priority: 50 },
    traceId: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
  });

  const event = toEngineEvent(row);

  assertEquals(event.data.payload, { resourceId: taskId, resourceVersion: 7 });
});
