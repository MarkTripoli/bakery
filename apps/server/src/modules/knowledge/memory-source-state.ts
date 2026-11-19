import type { ActionContext } from "@bakery/contracts/action-registry";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { effectivePermissions } from "../auth/application/authorize.ts";

/**
 * Reader-relative state of the artifact version a memory revision cites (#72).
 *
 * The state is judged for whoever is reading, at read time. The write path
 * already checked that the source exists, but that says nothing about the next
 * reader: a reader may hold memory:read without artifactVersion:read (a custom
 * role or an exact grant), and a version's content can be purged after the
 * revision was written. Storing a state at write time would answer both wrong.
 *
 * - available: the reader may read artifact versions, the version is reachable
 *   by the same rules the artifact version reads apply, and its bytes are held.
 * - deleted: readable, but its content was purged (the content read answers
 *   ARTIFACT_CONTENT_EXPIRED).
 * - no_access: the reader holds no live artifactVersion:read (role, custom
 *   role, exact grant, narrowed by a token's scopes), or the version is not
 *   reachable through the artifact version reads.
 * - unknown: no such version row, or a row that is neither purged nor holding
 *   bytes, so nothing truthful can be said about it.
 *
 * no_access is decided before anything about the row is looked at, so a reader
 * who may not read artifact versions cannot tell deleted from available.
 */
export type MemorySourceState =
  | "available"
  | "deleted"
  | "no_access"
  | "unknown";

/** True when the current reader may read artifact versions organization-wide. */
export function readerMayReadArtifactVersions(context: ActionContext): boolean {
  const authority = (context as Partial<AuthorizedActionContext>).authority;
  if (!authority || !("organizationId" in authority)) return false;
  // Effective permissions are the live role, custom role and exact grants,
  // narrowed by the token's scopes: the same inputs the artifact version read
  // routes are authorized against. Artifact versions have no resource binding,
  // so a binding cannot open them and is not consulted.
  return effectivePermissions(authority as OrganizationActor).includes(
    "artifactVersion:read",
  );
}

/**
 * Resolve the state of every cited version in one query, so a page of
 * revisions or entries costs one lookup rather than one per row.
 */
export async function resolveMemorySourceStates(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    readerMayRead: boolean;
    versionIds: readonly (string | null)[];
  },
): Promise<Map<string, MemorySourceState>> {
  const ids = [
    ...new Set(input.versionIds.filter((id): id is string => id !== null)),
  ];
  const states = new Map<string, MemorySourceState>();
  if (!input.readerMayRead) {
    for (const id of ids) states.set(id, "no_access");
    return states;
  }
  if (ids.length === 0) return states;
  const rows = await transaction.query<{
    id: string;
    purged: boolean;
    present: boolean;
    reachable: boolean;
  }>(
    // Reachability mirrors artifactVersions.list: the version's artifact and
    // task are this organization's, and a version written by a run step belongs
    // to a run of that same task.
    `select v.id,
            v.purged_at is not null as purged,
            (v.content is not null or v.blob_id is not null) as present,
            (exists (
               select 1
                 from bakery.artifacts a
                 join bakery.tasks t
                   on t.organization_id = a.organization_id and t.id = a.task_id
                where a.organization_id = v.organization_id
                  and a.id = v.artifact_id
                  and a.task_id = v.task_id
             )
             and (
               v.run_step_id is null or exists (
                 select 1
                   from bakery.run_steps rs
                   join bakery.workflow_runs wr
                     on wr.organization_id = rs.organization_id
                    and wr.id = rs.run_id
                  where rs.organization_id = v.organization_id
                    and rs.id = v.run_step_id
                    and wr.task_id = v.task_id
               )
             )) as reachable
       from bakery.artifact_versions v
      where v.organization_id = $1 and v.id = any($2::uuid[])`,
    [input.organizationId, ids],
  );
  for (const id of ids) states.set(id, "unknown");
  for (const row of rows.rows) {
    states.set(
      row.id,
      !row.reachable
        ? "no_access"
        : row.purged
        ? "deleted"
        : row.present
        ? "available"
        : "unknown",
    );
  }
  return states;
}

/**
 * Tell every memory that cites a version that the version's content is gone.
 *
 * Called in the transaction that purges the version, so the invalidation
 * commits with the change it describes. One content-free event per affected
 * memory entry, scoped to its repository like the other memory events.
 */
export async function appendMemorySourceChanged(
  transaction: PgTransactionClient,
  input: { organizationId: string; versionId: string; traceId: string },
): Promise<number> {
  const affected = await transaction.query<{
    id: string;
    repository_id: string;
    version: number;
  }>(
    `select distinct m.id, m.repository_id, m.version
       from bakery.memory_revisions r
       join bakery.memory_entries m
         on m.organization_id = r.organization_id and m.id = r.memory_id
      where r.organization_id = $1 and r.source_artifact_version_id = $2
      order by m.id`,
    [input.organizationId, input.versionId],
  );
  for (const memory of affected.rows) {
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      repositoryId: memory.repository_id,
      eventType: "memory.source_changed",
      aggregateId: memory.id,
      aggregateVersion: Number(memory.version),
      payload: {
        resourceId: memory.id,
        resourceVersion: Number(memory.version),
      },
      traceId: input.traceId,
    });
  }
  return affected.rows.length;
}
