import {
  inngestEventDefinition,
  type InngestEventName,
  inngestEventName,
} from "@bakery/contracts/events";
import { z } from "zod";
import type { EngineEvent } from "./inngest-event-client.ts";
import { OutboxDeliveryError } from "./inngest-event-client.ts";
import { OutboxDestination, type OutboxEventRecord } from "./outbox-types.ts";

const LegacyTaskInvalidationPayloadSchema = z.object({
  status: z.string().trim().min(1).describe(
    "Persisted task status emitted before task invalidations became re-read signals.",
  ),
  taskType: z.string().trim().min(1).describe(
    "Persisted task type emitted by the legacy task event producer.",
  ),
  priority: z.number().int().describe(
    "Persisted task priority emitted by the legacy task event producer.",
  ),
}).strict().describe(
  "Legacy version 1 task payload accepted only for upgrade-compatible delivery.",
);

function deliveryPayload(
  row: OutboxEventRecord,
  definition: NonNullable<ReturnType<typeof inngestEventDefinition>>,
): unknown {
  const current = definition.payload.safeParse(row.payload);
  if (current.success) return current.data;
  const isTaskInvalidation = row.eventType === "tasks.created" ||
    row.eventType === "tasks.updated";
  const legacy = LegacyTaskInvalidationPayloadSchema.safeParse(row.payload);
  if (
    isTaskInvalidation && row.schemaVersion === 1 && legacy.success &&
    row.taskId !== null && String(row.taskId) === String(row.aggregateId)
  ) {
    const upgraded = definition.payload.safeParse({
      resourceId: row.taskId,
      resourceVersion: row.aggregateVersion,
    });
    if (upgraded.success) return upgraded.data;
  }
  throw new OutboxDeliveryError("EVENT_PAYLOAD_INVALID", false);
}

export function toEngineEvent(row: OutboxEventRecord): EngineEvent {
  if (row.destination !== OutboxDestination.Inngest) {
    throw new OutboxDeliveryError("DESTINATION_UNSUPPORTED", false);
  }
  const definition = inngestEventDefinition(row.eventType, row.schemaVersion);
  if (!definition) {
    throw new OutboxDeliveryError("EVENT_TRIGGER_UNMAPPED", false);
  }
  const payload = deliveryPayload(row, definition);
  return {
    id: row.deliveryKey,
    name: definition.name,
    ts: row.createdAt.getTime(),
    data: {
      eventId: row.eventId,
      organizationId: row.organizationId,
      sequence: row.sequence,
      applicationId: row.applicationId,
      repositoryId: row.repositoryId,
      taskId: row.taskId,
      conversationId: row.conversationId,
      aggregateId: row.aggregateId,
      aggregateVersion: row.aggregateVersion,
      schemaVersion: row.schemaVersion,
      traceId: row.traceId,
      payload,
    },
  };
}

export { type InngestEventName, inngestEventName };

export function outboxRetryDelaySeconds(attemptCount: number): number {
  return Math.min(5 * 2 ** Math.max(0, attemptCount - 1), 60);
}
