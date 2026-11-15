import { appendDomainEvent } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";

/** Scope of a queued run whose start is requested. */
export type RunStartScope = {
  organizationId: string;
  applicationId: string | null;
  repositoryId: string | null;
  taskId: string;
  conversationId: string | null;
  runId: string;
  runVersion: number;
  traceId: string;
};

/**
 * Starts a queued run: the `run.requested` domain event plus its pending
 * Inngest outbox row, keyed by run id and version. Admission calls it for a run
 * admitted queued; dependency release calls it for a blocked run it resumes, so
 * both start exactly the same way.
 */
export async function requestRunStart(
  transaction: PgTransactionClient,
  scope: RunStartScope,
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId: scope.organizationId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    taskId: scope.taskId,
    conversationId: scope.conversationId,
    eventType: "run.requested",
    aggregateId: scope.runId,
    aggregateVersion: scope.runVersion,
    payload: { runId: scope.runId },
    traceId: scope.traceId,
    outboxDeliveryKey: `run:${scope.runId}:version:${scope.runVersion}`,
  });
}
