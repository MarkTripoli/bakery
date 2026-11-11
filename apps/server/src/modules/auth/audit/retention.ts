import type { z } from "zod";
import { appendAudit, withPgTransaction } from "@bakery/persistence";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { Inngest } from "inngest";
import { readAuditRetention } from "../adapters/audit-retention-postgres.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../../platform/database.ts";

/** Rows one purge call may delete. */
export const PURGE_BATCH_ROWS = 1000;
/** Batches per organization per run, so one tick stays bounded. */
export const PURGE_MAX_BATCHES = 20;

const DAY_MS = 86_400_000;

/** Input of a retention change; `null` days keeps events forever. */
export type AuditRetentionInput = Readonly<{
  organizationId: string;
  principalId: string;
  retentionDays: number | null;
}>;

/** What the scheduled retention purge needs from the host. */
export type AuditRetentionFunctionOptions = Readonly<{
  client: Inngest;
  database: PgDatabase;
}>;

/**
 * Sets or clears one organization's retention window. The window range is the
 * contract's (`AuditRetentionUpdate`), parsed here so the bound has one home.
 * The version is a monotonic change counter, not a concurrency precondition.
 */
export async function updateAuditRetention(
  transaction: Pick<PgTransactionClient, "query">,
  input: AuditRetentionInput,
): Promise<z.output<typeof contractSchemas.AuditRetention>> {
  const parsed = contractSchemas.AuditRetentionUpdate.safeParse({
    retentionDays: input.retentionDays,
  });
  if (!parsed.success) throw new StandardError({ code: "UNPROCESSABLE" });
  await transaction.query(
    `insert into bakery.audit_retention_settings
       (organization_id, retention_days, updated_by_principal_id)
     values ($1::uuid, $2::integer, $3::uuid)
     on conflict (organization_id) do update
       set retention_days = excluded.retention_days,
           updated_by_principal_id = excluded.updated_by_principal_id,
           version = bakery.audit_retention_settings.version + 1,
           updated_at = now()`,
    [input.organizationId, parsed.data.retentionDays, input.principalId],
  );
  return await readAuditRetention(transaction, input.organizationId);
}

export type PurgeResult = { organizations: number; purged: number };

/** Purges one organization's expired events and records the purge, atomically. */
async function purgeOrganization(
  database: PgDatabase,
  setting: { organizationId: string; retentionDays: number },
  now: Date,
): Promise<number> {
  const before = new Date(now.getTime() - setting.retentionDays * DAY_MS);
  return await withPgTransaction(database, async (transaction) => {
    let removed = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
      const result = await transaction.query<{ purged: number }>(
        "select bakery.purge_audit_events($1::uuid, $2::timestamptz, $3::integer) as purged",
        [setting.organizationId, before, PURGE_BATCH_ROWS],
      );
      const count = result.rows[0]?.purged ?? 0;
      removed += count;
      if (count < PURGE_BATCH_ROWS) break;
    }
    if (removed > 0) {
      await appendAudit(transaction, {
        organizationId: setting.organizationId,
        principalId: null,
        operation: "auditRetention.purge",
        resourceType: "audit_retention",
        resourceId: setting.organizationId,
        requestId: "audit-retention-purge",
        traceId: "audit-retention-purge",
        details: {
          purged: removed,
          retentionDays: setting.retentionDays,
          before: before.toISOString(),
        },
      });
    }
    return removed;
  });
}

/**
 * Deletes expired audit events for every organization that has a retention
 * window. Deletion goes only
 * through `bakery.purge_audit_events`, which spares evidence-referenced rows.
 * One organization failing never starves the rest; failures surface together.
 */
export async function purgeExpiredAuditEvents(options: {
  database: PgDatabase;
  now?: Date;
}): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const settings = await options.database.query<
    { organizationId: string; retentionDays: number }
  >(
    `select organization_id as "organizationId", retention_days as "retentionDays"
     from bakery.audit_retention_settings
     where retention_days is not null
     order by organization_id`,
  );
  let organizations = 0;
  let purged = 0;
  const failures: unknown[] = [];
  for (const setting of settings.rows) {
    try {
      purged += await purgeOrganization(options.database, setting, now);
      organizations++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "AUDIT_RETENTION_PURGE_FAILED");
  }
  return { organizations, purged };
}

/** Hourly Inngest cron that runs the retention purge. */
export function createAuditRetentionFunction(
  options: AuditRetentionFunctionOptions,
) {
  return options.client.createFunction(
    {
      id: "bakery-audit-retention",
      retries: 3,
      triggers: [{ cron: "17 * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "purge-expired-audit-events",
        () =>
          purgeExpiredAuditEvents({
            database: options.database,
          }),
      ),
  );
}
