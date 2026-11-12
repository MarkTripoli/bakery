import {
  formatTraceparent,
  operationTraceContext,
} from "@bakery/config/telemetry-trace";
import { StandardError } from "@bakery/contracts/http";
import { domainEventPayloadSchema } from "@bakery/contracts/contracts";
import type { PgTransactionClient } from "./postgres.ts";

export type EventScope = {
  organizationId: string;
  applicationId?: string | null;
  repositoryId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  workerHostId?: string | null;
  workerEnrollmentId?: string | null;
  eventType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: unknown;
  traceId: string;
  /**
   * The `traceparent` the writing request was sent, if any. The event is stored
   * as a child span of it; without it the event gets a span in `traceId`'s
   * trace, or in a new trace when `traceId` is not a usable trace id.
   */
  traceparent?: string;
  outboxDeliveryKey?: string;
};

export type AuditEntry = {
  /** Null for installation-level and user-level mutations with no organization. */
  organizationId: string | null;
  principalId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  traceId: string;
  outcome?: "succeeded" | "denied" | "allowed" | "failed";
  details?: unknown;
};

export async function nextOrganizationSequence(
  transaction: PgTransactionClient,
  organizationId: string,
): Promise<string> {
  const clock = await transaction.query<{ sequence: string }>(
    `insert into bakery.event_clock (
       organization_id, stream, next_seq
     )
     select $1, 'domain_events', coalesce(max(organization_sequence), 0) + 2
     from bakery.domain_events
     where organization_id = $1
     on conflict (organization_id, stream) do update
       set next_seq = bakery.event_clock.next_seq + 1
     returning (next_seq - 1)::text as sequence`,
    [organizationId],
  );
  const sequence = clock.rows[0]?.sequence;
  if (!sequence) throw new Error("EVENT_CLOCK_UNAVAILABLE");
  return sequence;
}

export async function nextAggregateVersion(
  transaction: PgTransactionClient,
  organizationId: string,
  aggregateId: string,
  eventType: string,
): Promise<number> {
  const row = await transaction.query<{ version: number }>(
    `select coalesce(max(aggregate_version), 0) + 1 as version
       from bakery.domain_events
      where organization_id = $1 and aggregate_id = $2 and event_type = $3`,
    [organizationId, aggregateId, eventType],
  );
  return row.rows[0]?.version ?? 1;
}

export async function appendDomainEvent(
  transaction: PgTransactionClient,
  options: EventScope,
): Promise<string> {
  const schema = domainEventPayloadSchema(options.eventType);
  if (!schema || !schema.safeParse(options.payload).success) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  const sequence = await nextOrganizationSequence(
    transaction,
    options.organizationId,
  );
  const event = await transaction.query<{ id: string }>(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       application_id, repository_id, task_id, conversation_id,
       worker_host_id, worker_enrollment_id, aggregate_id,
       aggregate_version, payload, trace_id, traceparent
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     returning id`,
    [
      options.organizationId,
      sequence,
      options.eventType,
      options.applicationId ?? null,
      options.repositoryId ?? null,
      options.taskId ?? null,
      options.conversationId ?? null,
      options.workerHostId ?? null,
      options.workerEnrollmentId ?? null,
      options.aggregateId,
      options.aggregateVersion,
      JSON.stringify(options.payload),
      options.traceId,
      formatTraceparent(operationTraceContext(options)),
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("DOMAIN_EVENT_INSERT_FAILED");
  if (options.outboxDeliveryKey) {
    await transaction.query(
      `insert into bakery.outbox (
         organization_id, event_id, destination, delivery_key, status
       ) values ($1, $2, 'inngest', $3, 'pending')`,
      [options.organizationId, eventId, options.outboxDeliveryKey],
    );
  }
  return eventId;
}

export async function appendAudit(
  transaction: PgTransactionClient,
  entry: AuditEntry,
): Promise<number> {
  const result = await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type, resource_id,
       outcome, request_id, trace_id, details
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      entry.organizationId,
      entry.principalId,
      entry.operation,
      entry.resourceType,
      entry.resourceId,
      entry.outcome ?? "succeeded",
      entry.requestId,
      entry.traceId,
      JSON.stringify(entry.details ?? {}),
    ],
  );
  return result.rowCount ?? 0;
}
