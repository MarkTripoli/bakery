import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../../platform/database.ts";

export async function appendFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    eventType: string;
    resourceVersion: number;
    requestId: string;
    traceId: string;
    /** `succeeded` unless said otherwise. */
    outcome?: "succeeded" | "failed";
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: options.organizationId,
    principalId: options.principalId,
    operation: options.operation,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    requestId: options.requestId,
    traceId: options.traceId,
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.details === undefined ? {} : { details: options.details }),
  });
  await appendDomainEvent(transaction, {
    organizationId: options.organizationId,
    eventType: options.eventType,
    aggregateId: options.resourceId,
    aggregateVersion: options.resourceVersion,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.resourceVersion,
    },
    traceId: options.traceId,
  });
}
