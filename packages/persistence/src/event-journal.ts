import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";
import { appendAudit, appendDomainEvent } from "./event-audit.ts";
import type {
  AttemptRow,
  ExistingEventRow,
  RequestMetadata,
  WorkerIdentity,
} from "./types.ts";

export type AttemptExecutionScope = {
  kind: "workflow";
  runId: string;
  runStepId: string;
  taskId: string;
  jobInput: unknown;
} | {
  kind: "repository-inspection";
  jobInput: unknown;
} | {
  kind: "coordinator-turn";
  jobInput: unknown;
};

export type AttemptAuthorityRow = {
  workerHostId: string;
  workerSessionId: string | null;
  workerSessionGeneration: string | number;
  fence: string | number;
  leaseTokenHash: string;
  leaseExpired: boolean;
  status: string;
  jobCurrentFence: string | number;
};

function activeAttempt(status: string): boolean {
  return status === "leased" || status === "running" || status === "canceling";
}

export async function lockAttempt(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
): Promise<AttemptRow> {
  const result = await transaction.query<AttemptRow>(
    `select attempt.id,
        attempt.organization_id as "organizationId",
        attempt.job_id as "jobId",
        attempt.worker_host_id as "workerHostId",
        attempt.worker_session_id as "workerSessionId",
        attempt.worker_session_generation as "workerSessionGeneration",
        attempt.fence,
        attempt.lease_token_hash as "leaseTokenHash",
        attempt.lease_expires_at as "leaseExpiresAt",
        attempt.lease_expires_at <= clock_timestamp() as "leaseExpired",
        attempt.status, attempt.last_event_seq as "lastEventSeq",
        job.current_fence as "jobCurrentFence"
     from bakery.job_attempts attempt
     join bakery.jobs job
       on job.organization_id = attempt.organization_id
      and job.id = attempt.job_id
     where attempt.organization_id = $1 and attempt.id = $2
     for update of attempt, job`,
    [identity.host.organizationId, attemptId],
  );
  const attempt = result.rows[0];
  if (!attempt) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (attempt.workerHostId !== identity.host.id) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
  return attempt;
}

export async function loadAttemptAuthority(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
): Promise<AttemptAuthorityRow> {
  const result = await transaction.query<AttemptAuthorityRow>(
    `select attempt.worker_host_id as "workerHostId",
            attempt.worker_session_id as "workerSessionId",
            attempt.worker_session_generation as "workerSessionGeneration",
            attempt.fence, attempt.lease_token_hash as "leaseTokenHash",
            attempt.lease_expires_at <= clock_timestamp() as "leaseExpired",
            attempt.status, job.current_fence as "jobCurrentFence"
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [identity.host.organizationId, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

export async function loadExistingEvent(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
  localSeq: string,
): Promise<ExistingEventRow | undefined> {
  const result = await transaction.query<ExistingEventRow>(
    `select local_seq as "localSeq", event_id as "eventId",
            event_type as "eventType", payload_digest as "payloadDigest",
            saved_ack as "savedAck"
     from bakery.attempt_events
     where organization_id = $1 and attempt_id = $2 and local_seq = $3`,
    [organizationId, attemptId, localSeq],
  );
  return result.rows[0];
}

export async function loadEventsByIds(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
  eventIds: readonly string[],
): Promise<readonly ExistingEventRow[]> {
  const result = await transaction.query<ExistingEventRow>(
    `select local_seq as "localSeq", event_id as "eventId",
            event_type as "eventType", payload_digest as "payloadDigest",
            saved_ack as "savedAck"
     from bakery.attempt_events
     where organization_id = $1 and attempt_id = $2
       and event_id = any($3::uuid[])`,
    [organizationId, attemptId, eventIds],
  );
  return result.rows;
}

export async function appendAttemptEvent(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    attemptId: string;
    localSeq: string;
    eventId: string;
    eventType: string;
    payload: unknown;
    payloadDigest: string;
    savedAck: unknown;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.attempt_events (
       organization_id, attempt_id, local_seq, event_id, event_type,
       payload, payload_digest, saved_ack
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      options.organizationId,
      options.attemptId,
      options.localSeq,
      options.eventId,
      options.eventType,
      JSON.stringify(options.payload),
      options.payloadDigest,
      JSON.stringify(options.savedAck),
    ],
  );
}

export async function advanceAttemptEventSequence(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    attemptId: string;
    localSeq: string;
    workerHostId: string;
    leaseTokenHash: string;
    fence: string;
  },
): Promise<boolean> {
  const result = await transaction.query(
    `update bakery.job_attempts
       set last_event_seq = $2, updated_at = current_timestamp,
           version = version + 1
       where organization_id = $1 and id = $3
         and worker_host_id = $4 and lease_token_hash = $5
         and fence = $6 and status in ('leased', 'running', 'canceling')
         and lease_expires_at > clock_timestamp()
         and exists (
           select 1 from bakery.jobs job
           where job.organization_id = bakery.job_attempts.organization_id
             and job.id = bakery.job_attempts.job_id
             and job.current_fence = bakery.job_attempts.fence
         )
       returning id`,
    [
      options.organizationId,
      options.localSeq,
      options.attemptId,
      options.workerHostId,
      options.leaseTokenHash,
      options.fence,
    ],
  );
  return result.rows.length === 1;
}

export async function applyStartedLifecycle(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  metadata: RequestMetadata,
  principalId: string | null,
): Promise<void> {
  const attemptUpdate = await transaction.query(
    `update bakery.job_attempts
     set status = 'running', started_at = coalesce(started_at, current_timestamp),
         updated_at = current_timestamp, version = version + 1
     where organization_id = $1 and id = $2
       and worker_host_id = $3 and fence = $4
       and status in ('leased', 'running')
       and lease_expires_at > clock_timestamp()
       and exists (
         select 1 from bakery.jobs job
         where job.organization_id = bakery.job_attempts.organization_id
           and job.id = bakery.job_attempts.job_id
           and job.current_fence = bakery.job_attempts.fence
       )
     returning version`,
    [attempt.organizationId, attempt.id, attempt.workerHostId, attempt.fence],
  );
  if (attemptUpdate.rows.length !== 1) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
  const jobUpdate = await transaction.query<{ version: number }>(
    `update bakery.jobs
     set status = 'running', updated_at = current_timestamp,
         version = version + 1
     where organization_id = $1 and id = $2
       and status = 'leased' and current_fence = $3
     returning version`,
    [attempt.organizationId, attempt.jobId, attempt.fence],
  );
  if (!jobUpdate.rows[0]) return;
  await appendDomainEvent(transaction, {
    organizationId: attempt.organizationId,
    eventType: "job.updated",
    aggregateId: attempt.jobId,
    aggregateVersion: jobUpdate.rows[0].version,
    payload: {
      jobId: attempt.jobId,
      attemptId: attempt.id,
      version: jobUpdate.rows[0].version,
    },
    traceId: metadata.traceId,
  });
  await appendAudit(transaction, {
    organizationId: attempt.organizationId,
    principalId,
    operation: "workers.job_started",
    resourceType: "job",
    resourceId: attempt.jobId,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: { attemptId: attempt.id },
  });
}

export async function validateWorkerReferences(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const artifactReferences = collectDeclaredArtifactRefs(eventType, payload);
  if (eventType === "job.artifact" && artifactReferences.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const scope = await loadAttemptExecutionScope(transaction, attempt);
  if (scope.kind === "coordinator-turn") {
    // A coordinator turn owns no artifact, session, check run, snapshot or
    // effect. Its result may carry only harness provenance (`sessionId` as a
    // top-level result string), never a reference to a Bakery resource.
    if (
      artifactReferences.length ||
      eventType === "job.artifact" ||
      eventType === "job.effect_pending" ||
      eventType === "job.effect_committed" ||
      [
        "artifact",
        "artifacts",
        "artifactId",
        "artifactVersionId",
        "checkRunId",
        "checkRunIds",
        "snapshotId",
        "externalEffectId",
        "runId",
        "runStepId",
        "taskId",
      ].some((key) => collectObjectKey(payload, key)) ||
      collectObjectKey(withoutResultSessionId(payload), "sessionId")
    ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return;
  }
  if (scope.kind === "repository-inspection") {
    if (
      artifactReferences.length ||
      eventType === "job.artifact" ||
      eventType === "job.effect_pending" ||
      eventType === "job.effect_committed" ||
      [
        "artifactId",
        "artifactVersionId",
        "checkRunId",
        "checkRunIds",
        "sessionId",
        "snapshotId",
        "externalEffectId",
        "runId",
        "runStepId",
        "taskId",
      ].some(
        (key) => collectReferenceValues(payload, key).length > 0,
      )
    ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return;
  }
  for (const reference of artifactReferences) {
    await assertArtifactReference(
      transaction,
      attempt.organizationId,
      scope.taskId,
      scope.runStepId,
      reference.versionId,
      reference.sha256,
      reference.artifactId,
    );
  }

  for (const referenceId of collectReferenceValues(payload, "checkRunIds")) {
    await assertCheckRunReference(
      transaction,
      attempt.organizationId,
      scope.runId,
      scope.taskId,
      referenceId,
    );
  }
  for (const referenceId of collectReferenceValues(payload, "sessionId")) {
    await assertSessionReference(
      transaction,
      attempt.organizationId,
      scope.runStepId,
      referenceId,
    );
  }
  const snapshotIds = collectReferenceValues(payload, "snapshotId");
  if (snapshotIds.length) {
    const input = jsonValue(scope.jobInput, {});
    const connectionId = input && typeof input === "object" &&
        typeof (input as Record<string, unknown>).connectionId === "string"
      ? (input as Record<string, string>).connectionId
      : undefined;
    if (!connectionId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    for (const referenceId of snapshotIds) {
      await assertSnapshotReference(
        transaction,
        attempt.organizationId,
        connectionId,
        referenceId,
      );
    }
  }
  if (
    eventType === "job.effect_pending" || eventType === "job.effect_committed"
  ) {
    for (
      const referenceId of collectReferenceValues(payload, "externalEffectId")
    ) {
      await assertEffectReference(
        transaction,
        attempt.organizationId,
        scope.runStepId,
        referenceId,
      );
    }
  }
}

async function loadAttemptExecutionScope(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
): Promise<AttemptExecutionScope> {
  const result = await transaction.query<{
    action: string;
    runStepId: string | null;
    runId: string | null;
    taskId: string | null;
    jobInput: unknown;
    inspectionId: string | null;
    conversationTurnId: string | null;
  }>(
    `select job.action, job.run_step_id as "runStepId", job.input as "jobInput",
            job.conversation_turn_id as "conversationTurnId",
            step.run_id as "runId", run.task_id as "taskId",
            onboarding.id as "inspectionId"
     from bakery.jobs job
     left join bakery.run_steps step
       on step.organization_id = job.organization_id
      and step.id = job.run_step_id
     left join bakery.workflow_runs run
       on run.organization_id = step.organization_id
      and run.id = step.run_id
     left join bakery.repository_onboardings onboarding
       on job.action = 'repository.inspect'
      and job.run_step_id is null
      and onboarding.organization_id = job.organization_id
      and onboarding.application_id = job.application_id
      and onboarding.repository_id = job.repository_id
      and onboarding.job_id = job.id
      and onboarding.input = job.input
     where job.organization_id = $1 and job.id = $2`,
    [attempt.organizationId, attempt.jobId],
  );
  const scope = result.rows[0];
  if (!scope) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (scope.action === "coordinator.turn") {
    if (scope.runStepId !== null || scope.conversationTurnId === null) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return { kind: "coordinator-turn", jobInput: scope.jobInput };
  }
  if (scope.action === "repository.inspect") {
    if (scope.runStepId !== null || scope.inspectionId === null) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return { kind: "repository-inspection", jobInput: scope.jobInput };
  }
  if (
    scope.runStepId === null || scope.runId === null || scope.taskId === null
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return {
    kind: "workflow",
    runStepId: scope.runStepId,
    runId: scope.runId,
    taskId: scope.taskId,
    jobInput: scope.jobInput,
  };
}

/** True when `key` appears anywhere in `value` with any (even null) value. */
function collectObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => collectObjectKey(item, key));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key) ||
    Object.values(record).some((item) => collectObjectKey(item, key));
}

/** Drops the top-level provenance `result.sessionId` of a coordinator result. */
function withoutResultSessionId(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return payload;
  }
  const { sessionId: _sessionId, ...rest } = result as Record<string, unknown>;
  return { ...record, result: rest };
}

function collectReferenceValues(value: unknown, key: string): string[] {
  const found: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    const candidate = record[key];
    if (typeof candidate === "string") found.push(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string") found.push(item);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...new Set(found)];
}

type ArtifactReference = {
  artifactId: string;
  versionId: string;
  sha256: string;
};

function collectDeclaredArtifactRefs(
  eventType: string,
  payload: unknown,
): ArtifactReference[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  let candidates: unknown[];
  switch (eventType) {
    case "job.checkpoint":
    case "job.artifact":
      if (!Object.hasOwn(record, "artifact")) return [];
      candidates = [record.artifact];
      break;
    case "job.succeeded": {
      candidates = [];
      const result = record.result;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const resultRecord = result as Record<string, unknown>;
        if (Object.hasOwn(resultRecord, "artifacts")) {
          const artifacts = resultRecord.artifacts;
          if (!Array.isArray(artifacts)) {
            throw new StandardError({ code: "UNPROCESSABLE" });
          }
          candidates.push(...artifacts);
        }
        if (Object.hasOwn(resultRecord, "artifact")) {
          candidates.push(resultRecord.artifact);
        }
      }
      break;
    }
    default:
      return [];
  }

  const found: ArtifactReference[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
    const reference = candidate as Record<string, unknown>;
    if (
      typeof reference.artifactId !== "string" ||
      typeof reference.versionId !== "string" ||
      typeof reference.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(reference.sha256)
    ) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
    const key = JSON.stringify([
      reference.artifactId,
      reference.versionId,
      reference.sha256,
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      found.push({
        artifactId: reference.artifactId,
        versionId: reference.versionId,
        sha256: reference.sha256,
      });
    }
  }
  return found;
}

function assertReferenceUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

async function relationExists(
  transaction: PgTransactionClient,
  relation: string,
): Promise<boolean> {
  const result = await transaction.query<{ exists: boolean }>(
    "select to_regclass($1) is not null as exists",
    [relation],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Proves one artifact version belongs to the reporting step: the version is
 * attached to `runStepId`, its artifact to `taskId`, the stored sha256 equals
 * `digest`, and the content is present and not purged. Locks the version and
 * artifact rows (`for key share`) so the retention collector cannot purge them
 * mid-transaction. Throws RESOURCE_NOT_FOUND on any mismatch. Exported so a
 * finalizer that reads a reference from a nested field reuses this predicate
 * instead of copying the query.
 *
 * One predicate repeats the schema on purpose. `version.organization_id`
 * restates what the composite foreign keys already force for a version bound
 * to `runStepId`: (organization_id, run_step_id) points at run_steps and
 * (organization_id, artifact_id, task_id) at artifacts. No row the schema
 * admits makes it the only line of defense, so no test can show it alone; it
 * stays so a foreign organization is refused by the query itself and not only
 * by the shape of the schema. `artifact.task_id` and `version.run_step_id` are
 * independent of it: no key ties a run step to the task of the artifact that
 * cites it, and the security lane proves each of the two.
 */
export async function assertArtifactReference(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
  runStepId: string,
  referenceId: string,
  digest: string,
  artifactId: string,
): Promise<void> {
  assertReferenceUuid(referenceId);
  assertReferenceUuid(artifactId);
  const versions = await relationExists(
    transaction,
    "bakery.artifact_versions",
  );
  const artifacts = await relationExists(transaction, "bakery.artifacts");
  if (!versions || !artifacts) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const version = await transaction.query(
    `select version.id
     from bakery.artifact_versions version
     join bakery.artifacts artifact
       on artifact.organization_id = version.organization_id
      and artifact.id = version.artifact_id
     where version.organization_id = $1 and version.id = $2
       and version.run_step_id = $3 and artifact.task_id = $4
       and version.artifact_id = $5::uuid
       and version.sha256 = $6::text
       and version.purged_at is null and version.content is not null
     for key share of version, artifact`,
    [
      organizationId,
      referenceId,
      runStepId,
      taskId,
      artifactId,
      digest,
    ],
  );
  if (version.rows.length) return;
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

async function assertEffectReference(
  transaction: PgTransactionClient,
  organizationId: string,
  runStepId: string,
  referenceId: string,
): Promise<void> {
  assertReferenceUuid(referenceId);
  if (!await relationExists(transaction, "bakery.external_effects")) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const effect = await transaction.query(
    `select id from bakery.external_effects
     where organization_id = $1 and id = $2 and run_step_id = $3
     for update`,
    [organizationId, referenceId, runStepId],
  );
  if (!effect.rows.length) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

// Check runs are insert-only evidence: the application role holds no UPDATE
// grant on the table, and every row lock (even FOR KEY SHARE) needs one, so
// the reference is read without a lock. Nothing can change or remove the row
// before this transaction commits.
async function assertCheckRunReference(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  taskId: string,
  referenceId: string,
): Promise<void> {
  assertReferenceUuid(referenceId);
  if (!await relationExists(transaction, "bakery.check_runs")) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // `check_run.run_id = $3` already pins the caller's run, so the run's task
  // check below repeats on purpose: the run row is the authority for the task
  // and the join keeps this reference check correct if the run predicate moves.
  const result = await transaction.query(
    `select check_run.id
     from bakery.check_runs check_run
     join bakery.workflow_runs run
       on run.organization_id = check_run.organization_id
      and run.id = check_run.run_id
     where check_run.organization_id = $1 and check_run.id = $2
       and check_run.run_id = $3 and run.task_id = $4`,
    [organizationId, referenceId, runId, taskId],
  );
  if (!result.rows.length) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

async function assertSessionReference(
  transaction: PgTransactionClient,
  organizationId: string,
  runStepId: string,
  referenceId: string,
): Promise<void> {
  assertReferenceUuid(referenceId);
  if (!await relationExists(transaction, "bakery.agent_sessions")) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query(
    `select id from bakery.agent_sessions
     where organization_id = $1 and id = $2 and run_step_id = $3`,
    [organizationId, referenceId, runStepId],
  );
  if (!result.rows.length) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

async function assertSnapshotReference(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  referenceId: string,
): Promise<void> {
  assertReferenceUuid(referenceId);
  assertReferenceUuid(connectionId);
  if (
    !await relationExists(transaction, "bakery.mcp_capability_snapshots") ||
    !await relationExists(transaction, "bakery.mcp_connections")
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query(
    `select snapshot.id
     from bakery.mcp_capability_snapshots snapshot
     join bakery.mcp_connections connection
       on connection.organization_id = snapshot.organization_id
      and connection.id = snapshot.connection_id
     where snapshot.organization_id = $1 and snapshot.id = $2
       and snapshot.connection_id = $3
     for update of snapshot`,
    [organizationId, referenceId, connectionId],
  );
  if (!result.rows.length) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

function jsonValue(value: unknown, fallback: unknown): unknown {
  return value && typeof value === "object" ? value : fallback;
}

export async function throwAttemptMutationAuthorityError(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
  tokenHash: string,
  fence: string,
): Promise<never> {
  const row = await loadAttemptAuthority(transaction, identity, attemptId);
  if (
    row.workerHostId !== identity.host.id ||
    row.leaseTokenHash !== tokenHash ||
    BigInt(row.fence) !== BigInt(fence) ||
    BigInt(row.jobCurrentFence) !== BigInt(fence) ||
    row.workerSessionId !== identity.host.workerSessionId ||
    BigInt(row.workerSessionGeneration) !==
      BigInt(identity.host.workerSessionGeneration) ||
    !activeAttempt(row.status)
  ) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
  if (row.leaseExpired) throw new StandardError({ code: "LEASE_EXPIRED" });
  throw new StandardError({ code: "LEASE_FENCED" });
}
