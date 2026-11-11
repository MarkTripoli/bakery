import { z } from "zod";
import {
  type OrganizationId,
  organizationId as asOrganizationId,
} from "@bakery/contracts/contracts";
import { OutboxDeliveryStateSchema } from "./outbox-state.ts";
import type { PgDatabase } from "./database.ts";

export const OutboxDestination = Object.freeze(
  {
    GitHub: "github",
    Inngest: "inngest",
    Slack: "slack",
  } as const,
);
export type OutboxDestination =
  (typeof OutboxDestination)[keyof typeof OutboxDestination];
export const OutboxDestinationSchema = z.enum([
  OutboxDestination.GitHub,
  OutboxDestination.Inngest,
  OutboxDestination.Slack,
]).describe("Destination adapter that owns one outbox delivery.");

function uuidSchema(description: string) {
  return z.string().uuid().describe(description);
}

export const OutboxIdSchema = uuidSchema(
  "UUID identifying one durable outbox delivery.",
).brand<"OutboxId">().describe(
  "Database-generated identifier for one durable outbox delivery.",
);
export type OutboxId = z.infer<typeof OutboxIdSchema>;

export const OutboxDeliveryKeySchema = z.string().trim().min(1).brand<
  "OutboxDeliveryKey"
>().describe(
  "Stable nonblank deduplication key for one destination delivery.",
);
export type OutboxDeliveryKey = z.infer<typeof OutboxDeliveryKeySchema>;

const DomainEventIdSchema = uuidSchema(
  "UUID identifying the domain event that owns this delivery.",
).brand<"DomainEventId">().describe(
  "Branded UUID identifying the domain event that owns this delivery.",
);
export type DomainEventId = z.infer<typeof DomainEventIdSchema>;

export const OutboxOrganizationIdSchema = uuidSchema(
  "UUID identifying the organization that owns the domain event and delivery.",
).transform(asOrganizationId).describe(
  "Branded organization identifier shared with application authorization.",
);
export type OutboxOrganizationId = z.infer<
  typeof OutboxOrganizationIdSchema
>;

const ApplicationIdSchema = uuidSchema(
  "UUID identifying the optional application associated with the domain event.",
).brand<"ApplicationId">().describe(
  "Branded UUID for the optional application associated with the event.",
);
type ApplicationId = z.infer<typeof ApplicationIdSchema>;

const RepositoryIdSchema = uuidSchema(
  "UUID identifying the optional repository associated with the domain event.",
).brand<"RepositoryId">().describe(
  "Branded UUID for the optional repository associated with the event.",
);
type RepositoryId = z.infer<typeof RepositoryIdSchema>;

const TaskIdSchema = uuidSchema(
  "UUID identifying the optional task associated with the domain event.",
).brand<"TaskId">().describe(
  "Branded UUID for the optional task associated with the event.",
);
type TaskId = z.infer<typeof TaskIdSchema>;

const ConversationIdSchema = uuidSchema(
  "UUID identifying the optional conversation associated with the domain event.",
).brand<"ConversationId">().describe(
  "Branded UUID for the optional conversation associated with the event.",
);
type ConversationId = z.infer<typeof ConversationIdSchema>;

const AggregateIdSchema = uuidSchema(
  "UUID identifying the aggregate whose state change produced the event.",
).brand<"AggregateId">().describe(
  "Branded UUID for the aggregate whose state change produced the event.",
);
type AggregateId = z.infer<typeof AggregateIdSchema>;

const EventSequenceSchema = z.string().regex(/^\d+$/).brand<
  "EventSequence"
>().describe("Decimal organization-scoped sequence for the domain event.");
type EventSequence = z.infer<typeof EventSequenceSchema>;

const EventTypeSchema = z.string().trim().min(1).describe(
  "Nonblank domain event type used to select an explicit engine trigger.",
);
const SchemaVersionSchema = z.number().int().positive().brand<
  "EventSchemaVersion"
>().describe("Positive schema version for the persisted domain event.");
const AggregateVersionSchema = z.number().int().positive().brand<
  "AggregateVersion"
>().describe("Positive version of the changed aggregate.");
const PayloadSchema = z.unknown().describe(
  "JSON payload persisted with the domain event; the destination adapter validates its shape.",
);
const CreatedAtSchema = z.date().describe(
  "UTC creation time assigned to the persisted domain event.",
);
const NullableApplicationIdSchema = ApplicationIdSchema.nullable().describe(
  "Optional application identifier, null when the event is not application-scoped.",
);
const NullableRepositoryIdSchema = RepositoryIdSchema.nullable().describe(
  "Optional repository identifier, null when the event is not repository-scoped.",
);
const NullableTaskIdSchema = TaskIdSchema.nullable().describe(
  "Optional task identifier, null when the event is not task-scoped.",
);
const NullableConversationIdSchema = ConversationIdSchema.nullable().describe(
  "Optional conversation identifier, null when the event is not conversation-scoped.",
);
const NullableTraceIdSchema = z.string().trim().min(1).describe(
  "Nonblank tracing identifier propagated to the engine event.",
).nullable().describe(
  "Optional tracing identifier, null when no trace was recorded.",
);

export const OutboxEventRecordSchema = z.object({
  id: OutboxIdSchema,
  deliveryKey: OutboxDeliveryKeySchema,
  destination: OutboxDestinationSchema,
  eventId: DomainEventIdSchema,
  organizationId: OutboxOrganizationIdSchema,
  sequence: EventSequenceSchema,
  eventType: EventTypeSchema,
  schemaVersion: SchemaVersionSchema,
  applicationId: NullableApplicationIdSchema,
  repositoryId: NullableRepositoryIdSchema,
  taskId: NullableTaskIdSchema,
  conversationId: NullableConversationIdSchema,
  aggregateId: AggregateIdSchema,
  aggregateVersion: AggregateVersionSchema,
  payload: PayloadSchema,
  traceId: NullableTraceIdSchema,
  createdAt: CreatedAtSchema,
}).describe(
  "Parsed domain-event fields joined to one durable outbox delivery.",
);
export type OutboxEventRecord = z.infer<typeof OutboxEventRecordSchema>;

const AttemptCountSchema = z.number().int().nonnegative().describe(
  "Nonnegative number of engine attempts already claimed for this delivery.",
);
const NextAttemptAtSchema = z.date().describe(
  "UTC time at or after which a pending retry may be claimed.",
);
const ReplayDeadlineAtSchema = z.date().nullable().describe(
  "Immutable UTC deadline for safely replaying an attempted delivery, or null before its first claim.",
);

export const ClaimedOutboxRowSchema = z.intersection(
  OutboxEventRecordSchema,
  z.intersection(
    z.object({
      attemptCount: AttemptCountSchema,
      nextAttemptAt: NextAttemptAtSchema,
      replayDeadlineAt: ReplayDeadlineAtSchema,
    }).describe("Parsed scheduling fields for one outbox delivery."),
    OutboxDeliveryStateSchema,
  ).describe("Parsed delivery state and lease fields for one outbox row."),
).describe("Fully parsed outbox row handed from persistence to dispatch.");
export type ClaimedOutboxRow = z.infer<typeof ClaimedOutboxRowSchema>;

export type OutboxRepositoryOptions = {
  readonly database: PgDatabase;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly replaySafetySeconds: number;
};

export function outboxId(value: unknown): OutboxId {
  return OutboxIdSchema.parse(value);
}

export function domainEventId(value: unknown): DomainEventId {
  return DomainEventIdSchema.parse(value);
}

export function applicationId(value: unknown): ApplicationId {
  return ApplicationIdSchema.parse(value);
}

export function repositoryId(value: unknown): RepositoryId {
  return RepositoryIdSchema.parse(value);
}

export function taskId(value: unknown): TaskId {
  return TaskIdSchema.parse(value);
}

export function conversationId(value: unknown): ConversationId {
  return ConversationIdSchema.parse(value);
}

export function aggregateId(value: unknown): AggregateId {
  return AggregateIdSchema.parse(value);
}

export function eventSequence(value: unknown): EventSequence {
  return EventSequenceSchema.parse(value);
}

export function outboxOrganizationId(value: unknown): OrganizationId {
  return OutboxOrganizationIdSchema.parse(value);
}

export function newOutboxDeliveryKey(): OutboxDeliveryKey {
  return OutboxDeliveryKeySchema.parse(crypto.randomUUID());
}
