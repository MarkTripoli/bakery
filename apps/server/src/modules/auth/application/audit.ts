import { appendAudit } from "@bakery/persistence";
import type { PgTransactionClient } from "../../../platform/database.ts";

/**
 * One authentication or authorization mutation as the audit trail records it.
 * `details` must stay free of secrets: identifiers, enum values and counts only,
 * never tokens, passwords, client secrets or their digests.
 */
export type AuthAuditRecord = {
  /** Null for installation-level and user-level mutations with no organization. */
  organizationId: string | null;
  principalId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  details?: Readonly<Record<string, unknown>>;
};

export type AuthAuditCorrelation = { requestId: string; traceId: string };

/**
 * Appends one succeeded audit row in the mutation's own transaction, so a
 * failed or rolled-back mutation leaves no row and a committed one leaves
 * exactly one.
 */
export async function recordAuthAudit(
  transaction: Pick<PgTransactionClient, "query">,
  correlation: AuthAuditCorrelation,
  record: AuthAuditRecord,
): Promise<void> {
  await appendAudit(transaction as PgTransactionClient, {
    organizationId: record.organizationId,
    principalId: record.principalId,
    operation: record.operation,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    outcome: "succeeded",
    details: record.details ?? {},
  });
}
