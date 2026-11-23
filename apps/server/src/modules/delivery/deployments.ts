import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  canMove,
  type DeploymentEnvironment,
  type DeploymentStatus,
  IN_FLIGHT_STATUSES,
  isDeploymentStatus,
  ROLLBACK_SOURCE_STATUSES,
  SERVING_STATUSES,
} from "./deployment-states.ts";

/**
 * Deployment records (#43, B10.06): one release attempt of a merged revision to
 * one environment, and the rollback that restores the release it replaced.
 *
 * The serialization is the database's: a partial unique index refuses a second
 * deployment in flight for one repository and environment, an `unknown` outcome
 * counts as in flight, and so uncertainty blocks further writes. The store only
 * decides what the index cannot: that the revision was merged, which release is
 * current, and which moves are allowed.
 */

const DEPLOYMENT_ORDERING = "createdAt:desc,id:desc";
const MAX_PAGE_SIZE = 100;
const TIMESTAMP_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * What `deployments.create` accepts: exactly what the contract validated, so a
 * change to the contract is a compile error here and not a cast that hides it.
 */
export type DeploymentCreateInput = z.output<
  typeof contractSchemas.DeploymentCreate
>;

export type DeploymentRead = {
  id: string;
  repositoryId: string;
  runId: string;
  environment: DeploymentEnvironment;
  commitSha: string;
  artifactDigest: string;
  previousDeploymentId: string | null;
  /** The commit of the release this one replaced: what a rollback restores. */
  previousCommitSha: string | null;
  status: DeploymentStatus;
  externalEffectId: string | null;
  healthEvidenceId: string | null;
  /** A rollback of this release ended in `failed`: the environment may not run the release before it. */
  rollbackFailed: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type DeploymentRow = {
  id: string;
  repository_id: string;
  run_id: string;
  environment: string;
  commit_sha: string;
  artifact_digest: string;
  previous_deployment_id: string | null;
  previous_commit_sha: string | null;
  status: string;
  external_effect_id: string | null;
  health_evidence_id: string | null;
  rollback_failed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  cursor_created_at: string;
};

const COLUMNS = `d.id,d.repository_id,d.run_id,d.environment,d.commit_sha,
  d.artifact_digest,d.previous_deployment_id,
  (select p.commit_sha from bakery.deployments p
    where p.id = d.previous_deployment_id
      and p.organization_id = d.organization_id) as previous_commit_sha,
  d.status,d.external_effect_id,
  d.health_evidence_id,d.rollback_failed,d.created_at,d.updated_at,d.version,
  to_char(d.created_at at time zone 'UTC', '${TIMESTAMP_SQL}')
    as cursor_created_at`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function deployment(row: DeploymentRow): DeploymentRead {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    environment: row.environment as DeploymentEnvironment,
    commitSha: row.commit_sha,
    artifactDigest: row.artifact_digest,
    previousDeploymentId: row.previous_deployment_id,
    previousCommitSha: row.previous_commit_sha,
    // A status this code does not know is `unknown`, never a success.
    status: isDeploymentStatus(row.status) ? row.status : "unknown",
    externalEffectId: row.external_effect_id,
    healthEvidenceId: row.health_evidence_id,
    rollbackFailed: row.rollback_failed,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

function conflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function unprocessable(reason: string): StandardError {
  return new StandardError({ code: "UNPROCESSABLE", params: { reason } });
}

function sameRequest(row: DeploymentRead, create: DeploymentCreateInput) {
  return row.runId === create.runId && row.commitSha === create.commitSha &&
    row.artifactDigest === create.artifactDigest;
}

async function inFlight(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
  environment: string,
): Promise<DeploymentRead | null> {
  const row = (await transaction.query<DeploymentRow>(
    `select ${COLUMNS} from bakery.deployments d
      where d.organization_id = $1 and d.repository_id = $2
        and d.environment = $3 and d.status = any($4::text[])
      order by d.created_at, d.id
      limit 1`,
    [organizationId, repositoryId, environment, [...IN_FLIGHT_STATUSES]],
  )).rows[0];
  return row ? deployment(row) : null;
}

/**
 * Only a revision a pull request of this repository, opened by this run, was
 * merged into is deployed: the commit is the one the provider reported for the
 * merge, not one the caller chose.
 */
async function assertMergedRevision(
  transaction: PgTransactionClient,
  organizationId: string,
  create: DeploymentCreateInput,
): Promise<void> {
  const merged = await transaction.query(
    `select 1 from bakery.pull_requests
      where organization_id = $1 and repository_id = $2 and run_id = $3
        and status = 'merged' and merged_sha = $4
      limit 1`,
    [organizationId, create.repositoryId, create.runId, create.commitSha],
  );
  if (merged.rows.length === 0) throw unprocessable("revision_not_merged");
}

/** The release serving the environment now: its newest healthy or degraded one. */
async function currentRelease(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
  environment: string,
): Promise<string | null> {
  const row = (await transaction.query<{ id: string }>(
    `select d.id from bakery.deployments d
      where d.organization_id = $1 and d.repository_id = $2
        and d.environment = $3 and d.status = any($4::text[])
      order by d.created_at desc, d.id desc
      limit 1`,
    [organizationId, repositoryId, environment, [...SERVING_STATUSES]],
  )).rows[0];
  return row?.id ?? null;
}

/**
 * Queues one deployment of a merged revision. The same request while one is
 * in flight answers with that deployment; any other request for the
 * environment is a state conflict, including while an outcome is unknown.
 */
export async function createDeployment(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: {
    requestId: string;
    traceId: string;
    create: DeploymentCreateInput;
  },
): Promise<DeploymentRead> {
  const create = input.create;
  const repository = await transaction.query(
    `select 1 from bakery.repositories
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, create.repositoryId],
  );
  if (repository.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  await assertMergedRevision(transaction, organizationId, create);

  const active = await inFlight(
    transaction,
    organizationId,
    create.repositoryId,
    create.environment,
  );
  if (active) {
    if (sameRequest(active, create)) return active;
    throw conflict(
      active.status === "unknown"
        ? "outcome_unknown"
        : "deployment_in_progress",
    );
  }

  const previous = await currentRelease(
    transaction,
    organizationId,
    create.repositoryId,
    create.environment,
  );
  const inserted = await transaction.query<DeploymentRow>(
    `insert into bakery.deployments as d (
       organization_id,repository_id,run_id,environment,commit_sha,
       artifact_digest,previous_deployment_id,status,requested_by_id,
       request_id,trace_id
     ) values ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10)
     on conflict do nothing
     returning ${COLUMNS}`,
    [
      organizationId,
      create.repositoryId,
      create.runId,
      create.environment,
      create.commitSha,
      create.artifactDigest,
      previous,
      principalId,
      input.requestId,
      input.traceId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    // A concurrent request won the unique index: answer with it, or conflict.
    const winner = await inFlight(
      transaction,
      organizationId,
      create.repositoryId,
      create.environment,
    );
    if (winner && sameRequest(winner, create)) return winner;
    throw conflict("deployment_in_progress");
  }
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "deployment.queued",
    aggregateId: row.id,
    aggregateVersion: 1,
    payload: { deploymentId: row.id },
    traceId: input.traceId,
    outboxDeliveryKey: `deployment:${row.id}`,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "deployments.create",
    resourceType: "deployment",
    resourceId: row.id,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      repositoryId: create.repositoryId,
      runId: create.runId,
      environment: create.environment,
      commitSha: create.commitSha,
      artifactDigest: create.artifactDigest,
      previousDeploymentId: previous,
    },
  });
  return deployment(row);
}

/**
 * Asks for the release a deployment replaced to be restored. Only the current
 * release of an environment, with nothing in flight and a known previous
 * release, can be rolled back; the same request while it rolls back answers
 * with it. The reason is kept in the audit record.
 */
export async function rollbackDeployment(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  deploymentId: string,
  input: { requestId: string; traceId: string; reason: string },
): Promise<DeploymentRead> {
  const row = (await transaction.query<DeploymentRow>(
    `select ${COLUMNS} from bakery.deployments d
      where d.organization_id = $1 and d.id = $2
      for update`,
    [organizationId, deploymentId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const current = deployment(row);
  if (current.status === "rolling_back") return current;
  if (current.status === "unknown") throw conflict("outcome_unknown");
  if (!ROLLBACK_SOURCE_STATUSES.includes(current.status)) {
    throw conflict(
      current.status === "rolled_back"
        ? "already_rolled_back"
        : "deployment_in_progress",
    );
  }
  // Only the newest release of the environment is rolled back: an older one
  // under a newer release is history, not something to restore over it.
  const newer = await transaction.query(
    `select 1 from bakery.deployments d
      where d.organization_id = $1 and d.repository_id = $2
        and d.environment = $3 and d.id <> $4
        and (d.created_at, d.id) > ($5::timestamptz, $4::uuid)
        and d.status not in ('rolled_back', 'failed')
      limit 1`,
    [
      organizationId,
      current.repositoryId,
      current.environment,
      current.id,
      row.created_at,
    ],
  );
  if (newer.rows.length > 0) throw conflict("not_current_release");
  if (current.previousDeploymentId === null) {
    throw conflict("no_previous_release");
  }
  const busy = await inFlight(
    transaction,
    organizationId,
    current.repositoryId,
    current.environment,
  );
  if (busy) throw conflict("deployment_in_progress");

  const moved = await transaction.query<DeploymentRow>(
    `update bakery.deployments d
        set status = 'rolling_back', updated_at = now(), version = version + 1
      where d.organization_id = $1 and d.id = $2 and d.status = $3
      returning ${COLUMNS}`,
    [organizationId, deploymentId, current.status],
  );
  const after = moved.rows[0];
  if (!after) throw conflict("deployment_in_progress");
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "deployment.rollback_requested",
    aggregateId: after.id,
    aggregateVersion: after.version,
    payload: { deploymentId: after.id },
    traceId: input.traceId,
    outboxDeliveryKey: `deployment-rollback:${after.id}:${after.version}`,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "deployments.rollback",
    resourceType: "deployment",
    resourceId: after.id,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      reason: input.reason,
      from: current.status,
      restores: current.previousDeploymentId,
    },
  });
  return deployment(after);
}

/** One deployment of the organization, as the lifecycle driver reads it. */
export async function readDeployment(
  transaction: PgTransactionClient,
  organizationId: string,
  deploymentId: string,
): Promise<DeploymentRead> {
  const row = (await transaction.query<DeploymentRow>(
    `select ${COLUMNS} from bakery.deployments d
      where d.organization_id = $1 and d.id = $2`,
    [organizationId, deploymentId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return deployment(row);
}

/**
 * Moves a deployment along its lifecycle, for the adapter that drives it. The
 * move must be allowed and the version still current; otherwise it is a state
 * conflict and nothing changes. Effect and evidence references are set once.
 */
export async function advanceDeployment(
  transaction: PgTransactionClient,
  organizationId: string,
  deploymentId: string,
  move: {
    from: DeploymentStatus;
    to: DeploymentStatus;
    expectedVersion: number;
    externalEffectId?: string;
    healthEvidenceId?: string;
  },
): Promise<DeploymentRead> {
  if (!canMove(move.from, move.to)) throw conflict("move_not_allowed");
  const moved = await transaction.query<DeploymentRow>(
    `update bakery.deployments d
        set status = $4,
            external_effect_id = coalesce(d.external_effect_id, $6::uuid),
            health_evidence_id = coalesce(d.health_evidence_id, $7::uuid),
            rollback_failed = d.rollback_failed
              or (d.status = 'rolling_back' and $4 = 'failed'),
            updated_at = now(), version = version + 1
      where d.organization_id = $1 and d.id = $2 and d.status = $3
        and d.version = $5
      returning ${COLUMNS}`,
    [
      organizationId,
      deploymentId,
      move.from,
      move.to,
      move.expectedVersion,
      move.externalEffectId ?? null,
      move.healthEvidenceId ?? null,
    ],
  );
  const row = moved.rows[0];
  if (!row) throw conflict("deployment_changed");
  return deployment(row);
}

function pageSize(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return limit;
}

function listBinding(
  organizationId: string,
  principalId: string,
  filters: {
    repositoryId: string | null;
    runId: string | null;
    environment: string | null;
  },
): CursorBinding {
  return {
    action: "deployments.list",
    principalId,
    organizationId,
    ordering: DEPLOYMENT_ORDERING,
    filters: JSON.stringify(filters),
    schemaVersion: 1,
  };
}

/**
 * Lists the organization's deployments, newest first, keyset paginated on
 * (created_at, id). The repository, run and environment filters narrow the page; the
 * cursor is bound to all three and to the caller.
 */
export async function listDeployments(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  query: {
    repositoryId?: string;
    runId?: string;
    environment?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: DeploymentRead[]; nextCursor: string | null }> {
  const limit = pageSize(query.limit);
  const filters = {
    repositoryId: query.repositoryId ?? null,
    runId: query.runId ?? null,
    environment: query.environment ?? null,
  };
  const binding = listBinding(organizationId, principalId, filters);
  const position = await decodeCursor(secret, query.cursor, binding);
  const rows = (await transaction.query<DeploymentRow>(
    `select ${COLUMNS} from bakery.deployments d
      where d.organization_id = $1
        and ($2::uuid is null or d.repository_id = $2)
        and ($6::text is null or d.environment = $6)
        and ($7::uuid is null or d.run_id = $7)
        and ($3::timestamptz is null or (d.created_at,d.id) < ($3,$4::uuid))
      order by d.created_at desc,d.id desc
      limit $5`,
    [
      organizationId,
      filters.repositoryId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
      filters.environment,
      filters.runId,
    ],
  )).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(deployment),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}
