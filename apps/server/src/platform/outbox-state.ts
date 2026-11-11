import { z } from "zod";
import { EngineEventIdSchema } from "./inngest-event-client.ts";

function uuidSchema(description: string) {
  return z.string().uuid().describe(description);
}

export const OutboxDeliveryStatus = Object.freeze(
  {
    Pending: "pending",
    Sending: "sending",
    Delivered: "delivered",
    Failed: "failed",
  } as const,
);
export type OutboxDeliveryStatus =
  (typeof OutboxDeliveryStatus)[keyof typeof OutboxDeliveryStatus];
export const OutboxDeliveryStatusSchema = z.enum([
  OutboxDeliveryStatus.Pending,
  OutboxDeliveryStatus.Sending,
  OutboxDeliveryStatus.Delivered,
  OutboxDeliveryStatus.Failed,
]).describe("Persisted lifecycle status for one outbox delivery.");

export const OutboxLeaseTokenSchema = uuidSchema(
  "UUID fencing token held only while a delivery is being sent.",
).brand<"OutboxLeaseToken">().describe(
  "UUID fencing token held only while a delivery is being sent.",
);
export type OutboxLeaseToken = z.infer<typeof OutboxLeaseTokenSchema>;

export const OutboxDeliveryErrorSchema = z.record(
  z.string().trim().min(1).describe("Nonblank diagnostic property name."),
  z.json().describe("JSON-compatible diagnostic property value."),
).describe(
  "Persisted diagnostic for a retryable or terminal delivery failure.",
);
const NullableDeliveryErrorSchema = z.union([
  OutboxDeliveryErrorSchema,
  z.null().describe("No delivery failure has been recorded."),
]).describe("Optional persisted delivery failure diagnostic.");

const PendingOutboxDeliveryStateSchema = z.object({
  status: z.literal(OutboxDeliveryStatus.Pending).describe(
    "Delivery is eligible now or after its retry delay.",
  ),
  leaseToken: z.null().describe("Pending deliveries hold no fencing token."),
  leaseUntil: z.null().describe("Pending deliveries hold no lease deadline."),
  deliveredAt: z.null().describe("Pending deliveries are not acknowledged."),
  engineEventId: z.null().describe(
    "Pending deliveries have no engine acknowledgement.",
  ),
  lastError: NullableDeliveryErrorSchema,
}).describe("Coherent persisted state for a pending outbox delivery.");

const SendingOutboxDeliveryStateSchema = z.object({
  status: z.literal(OutboxDeliveryStatus.Sending).describe(
    "Delivery is held by one dispatcher lease.",
  ),
  leaseToken: OutboxLeaseTokenSchema,
  leaseUntil: z.date().describe(
    "Exclusive UTC deadline after which another dispatcher may reclaim delivery.",
  ),
  deliveredAt: z.null().describe("Sending deliveries are not acknowledged."),
  engineEventId: z.null().describe(
    "Sending deliveries have no engine acknowledgement.",
  ),
  lastError: NullableDeliveryErrorSchema,
}).describe("Coherent persisted state for a leased outbox delivery.");

const DeliveredOutboxDeliveryStateSchema = z.object({
  status: z.literal(OutboxDeliveryStatus.Delivered).describe(
    "Engine acknowledged the delivery.",
  ),
  leaseToken: z.null().describe("Delivered rows release their fencing token."),
  leaseUntil: z.null().describe("Delivered rows release their lease deadline."),
  deliveredAt: z.date().describe(
    "UTC timestamp when the engine acknowledgement was persisted.",
  ),
  engineEventId: EngineEventIdSchema,
  lastError: z.null().describe(
    "Successful deliveries retain no failure diagnostic.",
  ),
}).describe("Coherent persisted state for an acknowledged outbox delivery.");

const FailedOutboxDeliveryStateSchema = z.object({
  status: z.literal(OutboxDeliveryStatus.Failed).describe(
    "Delivery stopped after a terminal error or exhausted retry budget.",
  ),
  leaseToken: z.null().describe("Failed rows release their fencing token."),
  leaseUntil: z.null().describe("Failed rows release their lease deadline."),
  deliveredAt: z.null().describe("Failed deliveries were not acknowledged."),
  engineEventId: z.null().describe(
    "Failed deliveries have no engine acknowledgement.",
  ),
  lastError: OutboxDeliveryErrorSchema,
}).describe(
  "Coherent persisted state for a terminally failed outbox delivery.",
);

export const OutboxDeliveryStateSchema = z.discriminatedUnion("status", [
  PendingOutboxDeliveryStateSchema,
  SendingOutboxDeliveryStateSchema,
  DeliveredOutboxDeliveryStateSchema,
  FailedOutboxDeliveryStateSchema,
]).describe(
  "Application-owned delivery-state invariant parsed whenever outbox state enters code.",
);
export type OutboxDeliveryState = z.infer<
  typeof OutboxDeliveryStateSchema
>;
