import type { z } from "zod";
import type { contractSchemas } from "@bakery/contracts/contracts";
import type { PgTransactionClient } from "../../../platform/database.ts";

type RetentionRow = {
  retentionDays: number | null;
  version: number;
  updatedAt: Date | null;
};

type AuditRetention = z.output<typeof contractSchemas.AuditRetention>;

/** Retention window of one organization; null days and version 0 before first set. */
export async function readAuditRetention(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
): Promise<AuditRetention> {
  const result = await transaction.query<RetentionRow>(
    `select retention_days as "retentionDays", version, updated_at as "updatedAt"
     from bakery.audit_retention_settings
     where organization_id = $1::uuid`,
    [organizationId],
  );
  const row = result.rows[0];
  return {
    retentionDays: row?.retentionDays ?? null,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}
