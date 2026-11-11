import { type PgDatabase, withPgTransaction } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { StandardError } from "@bakery/contracts/http";
import { hasProtectedArtifactReference } from "./references.ts";
import { isTerminalTask } from "./policy.ts";
import { postgresErrorCode } from "../../../platform/postgres-errors.ts";

export async function collectArtifactVersion(
  ownerDatabase: PgDatabase,
  versionId: string,
  policy = "retention-v1",
): Promise<boolean> {
  if (!policy.trim() || policy.length > 100) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  return await withPgTransaction(ownerDatabase, async (transaction) => {
    const role = await transaction.query<{ allowed: boolean }>(
      `select session_user='bakery' and current_user='bakery'
      and (select datdba::regrole::text from pg_database where datname=current_database())='bakery' as allowed`,
    );
    if (role.rows[0]?.allowed !== true) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    await transaction.query("set local lock_timeout='2s'");
    await transaction.query("set local statement_timeout='10s'");
    const identity = await transaction.query<
      { artifact_id: string; organization_id: string }
    >(
      "select artifact_id,organization_id from bakery.artifact_versions where id=$1",
      [versionId],
    );
    const version = identity.rows[0];
    if (!version) return false;
    const parents = await transaction.query<
      { pinned_at: Date | null; task_id: string }
    >(
      "select pinned_at,task_id from bakery.artifacts where organization_id=$1 and id=$2 for update",
      [version.organization_id, version.artifact_id],
    );
    const parent = parents.rows[0];
    if (!parent || parent.pinned_at !== null) return false;
    const versions = await transaction.query<
      {
        eligible: boolean;
        sha256: string;
        size_bytes: number;
        retention_class: string;
      }
    >(
      `select (purged_at is null and content is not null and expires_at <= now()) as eligible,sha256,size_bytes,retention_class
      from bakery.artifact_versions where id=$1 for update`,
      [versionId],
    );
    const row = versions.rows[0];
    if (
      !row?.eligible || !["transient", "evidence"].includes(row.retention_class)
    ) return false;
    const tasks = await transaction.query<{ status: string }>(
      "select status from bakery.tasks where organization_id=$1 and id=$2 for update",
      [version.organization_id, parent.task_id],
    );
    if (!tasks.rows[0] || !isTerminalTask(tasks.rows[0].status)) return false;
    // Match live writers: acquire parent rows before locking reference tables.
    await transaction.query(
      "lock table bakery.workflow_runs, bakery.run_steps, bakery.jobs, bakery.artifact_drafts in share mode",
    );
    if (
      await hasProtectedArtifactReference(
        transaction,
        version.organization_id,
        versionId,
      )
    ) return false;
    await transaction.query(
      "update bakery.artifact_versions set content=null,purged_at=now(),purge_policy=$2 where id=$1",
      [versionId, policy],
    );
    await appendAudit(transaction, {
      organizationId: version.organization_id,
      principalId: null,
      operation: "artifactVersions.collect",
      resourceType: "artifact_version",
      resourceId: versionId,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      details: {
        policy,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        retentionClass: row.retention_class,
      },
    });
    return true;
  }).catch((error: unknown) => {
    switch (postgresErrorCode(error)) {
      case "40P01":
      case "55P03":
        throw new StandardError({
          code: "DEPENDENCY_UNAVAILABLE",
          params: { retryAfterSeconds: 60 },
        });
      default:
        throw error;
    }
  });
}
