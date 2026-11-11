import { StandardError } from "@bakery/contracts/http";
import {
  canonicalOutputJson,
  type OutputBatch,
  OutputBatchSchema,
  outputDigest,
  type OutputProducer,
} from "@bakery/contracts/output";
import type { PgTransactionClient } from "./postgres.ts";

let intentInsertFaultForTest = false;
let intentInsertCountForTest = 0;
let afterSavepointReleaseFaultForTest = false;

/** Narrow fixture-only seam for proving savepoint recovery from an aborted transaction. */
export function setOutputFinalizationIntentInsertFaultForTest(
  enabled: boolean,
): void {
  intentInsertFaultForTest = enabled;
  intentInsertCountForTest = 0;
}

/** Fixture-only seam for proving faults after savepoint release roll back the result. */
export function setOutputFinalizationAfterSavepointReleaseFaultForTest(
  enabled: boolean,
): void {
  afterSavepointReleaseFaultForTest = enabled;
}

async function maybeInjectIntentInsertFaultForTest(
  transaction: PgTransactionClient,
): Promise<void> {
  if (!intentInsertFaultForTest) return;
  intentInsertCountForTest++;
  if (intentInsertCountForTest !== 2) return;
  intentInsertFaultForTest = false;
  await transaction.query("select 1 / $1::integer", [0]);
}

function maybeInjectAfterSavepointReleaseFaultForTest(): void {
  if (!afterSavepointReleaseFaultForTest) return;
  afterSavepointReleaseFaultForTest = false;
  throw new Error("OUTPUT_FINALIZATION_AFTER_SAVEPOINT_RELEASE_FAULT");
}

export const TRANSCRIPT_LIMITS = Object.freeze({
  maxBatches: 4096,
  maxSegmentBytes: 1024 * 1024,
  maxSegments: 16,
  maxTotalBytes: 16 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxAttempts: 8,
  grantHours: 24,
  transientDays: 30,
  cleanupBatches: 256,
});

export type OutputFinalizationGrant = {
  id: string;
  organization_id: string;
  application_id: string;
  repository_id: string | null;
  task_id: string;
  conversation_id: string;
  run_step_id: string;
  job_id: string;
  attempt_id: string;
  worker_host_id: string;
  author_id: string;
  session_id: string;
  scope_digest: string;
  frozen_highwater: string;
  capture: "complete" | "truncated" | "interrupted";
  capture_reason: string;
  authority_identity: string;
  payload_digest: string | null;
  finalization_identity: string | null;
  state:
    | "assembling"
    | "pending"
    | "retryable"
    | "published"
    | "failed"
    | "revoked"
    | "expired";
  assembly_failure: "source-scan-failed" | "intent-persist-failed" | null;
  attempt_count: number;
  grant_expires_at: Date | string;
  transient_expires_at: Date | string;
  revoked_at: Date | string | null;
  history_expired_at: Date | string | null;
};

export type OutputFinalizationSegment = {
  ordinal: number;
  first_sequence: string;
  last_sequence: string;
  content: Uint8Array;
  sha256: string;
  size_bytes: number;
};

type Scope = {
  applicationId: string;
  repositoryId: string | null;
  taskId: string;
  conversationId: string;
  runStepId: string;
  jobId: string;
};

function fail(
  code:
    | "RESOURCE_NOT_FOUND"
    | "STATE_CONFLICT"
    | "PRECONDITION_FAILED"
    | "INTERNAL",
): never {
  throw new StandardError({ code });
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

type TranscriptSegmentEnvelope = Readonly<{
  organizationId: string;
  streamId: string;
  highwater: string;
  completeness: "complete" | "truncated" | "interrupted";
}>;

function transcriptSegmentEnvelope(
  grant: OutputFinalizationGrant,
): TranscriptSegmentEnvelope {
  return {
    organizationId: grant.organization_id,
    streamId: grant.session_id,
    highwater: String(grant.frozen_highwater),
    completeness: grant.capture,
  };
}

/**
 * Exact byte length of one segment document: the envelope with an empty batch
 * array, plus each serialized batch and the separating commas.
 */
function transcriptSegmentBytes(
  envelope: TranscriptSegmentEnvelope,
  first: OutputBatch,
  last: OutputBatch,
  batchBytes: number,
  count: number,
): number {
  return utf8(JSON.stringify({
    ...envelope,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    batches: [],
  })).byteLength + batchBytes + count - 1;
}

/** Segment bytes are the JSON transcript document current readers download. */
function encodeTranscriptSegment(
  envelope: TranscriptSegmentEnvelope,
  batches: readonly OutputBatch[],
): Uint8Array {
  return utf8(JSON.stringify({
    ...envelope,
    firstSequence: batches[0].sequence,
    lastSequence: batches[batches.length - 1].sequence,
    batches,
  }));
}

function isoAfter(hoursOrDays: number, unit: "hours" | "days"): string {
  const date = new Date();
  date.setTime(
    date.getTime() +
      (unit === "hours" ? hoursOrDays * 3600_000 : hoursOrDays * 86_400_000),
  );
  return date.toISOString();
}

async function loadScope(
  transaction: PgTransactionClient,
  producer: OutputProducer,
): Promise<Scope & { authorId: string }> {
  const result = await transaction.query<Scope & { authorId: string }>(
    `select job.application_id as "applicationId", job.repository_id as "repositoryId",
            run.task_id as "taskId", task.conversation_id as "conversationId",
            job.run_step_id as "runStepId", job.id as "jobId",
            host.principal_id as "authorId"
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id and run.id = step.run_id
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
       join bakery.worker_hosts host
         on host.organization_id = $1 and host.id = $2
      where job.organization_id = $1 and job.id = $3
        and task.application_id = job.application_id
        and task.repository_id is not distinct from job.repository_id`,
    [producer.organizationId, producer.workerHostId, producer.jobId],
  );
  const row = result.rows[0];
  if (!row || !row.taskId || !row.conversationId || !row.runStepId) {
    // Repository inspection has no task/run-step identity and must remain an
    // honest archive-only stream without a transcript authority grant.
    fail("RESOURCE_NOT_FOUND");
  }
  return row;
}

async function assemblePlan(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
): Promise<void> {
  const rows = await transaction.query<
    { sequence: string | number; payload: unknown }
  >(
    `select sequence,payload from bakery.session_output_batches
      where organization_id=$1 and session_id=$2 order by sequence asc limit $3`,
    [grant.organization_id, grant.session_id, TRANSCRIPT_LIMITS.maxBatches + 1],
  );
  // Beyond the batch bound the verified prefix is still published, marked
  // incomplete, rather than nothing.
  const overBatchBound = rows.rows.length > TRANSCRIPT_LIMITS.maxBatches;
  const scanned = overBatchBound
    ? rows.rows.slice(0, TRANSCRIPT_LIMITS.maxBatches)
    : rows.rows;
  let expected = 1n;
  let total = 0;
  let ordinal = 0;
  let current: OutputBatch[] = [];
  let currentBatchBytes = 0;
  const segments: Array<
    {
      ordinal: number;
      firstSequence: string;
      lastSequence: string;
      content: Uint8Array;
      sha256: string;
      sizeBytes: number;
    }
  > = [];
  let incompleteReason: string | null = null;
  const envelope = transcriptSegmentEnvelope(grant);
  const flush = async () => {
    if (!current.length) return;
    ordinal++;
    if (ordinal > TRANSCRIPT_LIMITS.maxSegments) {
      incompleteReason = "resource-limit-segments";
      current = [];
      currentBatchBytes = 0;
      return;
    }
    const content = encodeTranscriptSegment(envelope, current);
    const sha256 = await digestBytes(content);
    segments.push({
      ordinal,
      firstSequence: current[0].sequence,
      lastSequence: current[current.length - 1].sequence,
      content,
      sha256,
      sizeBytes: content.byteLength,
    });
    total += content.byteLength;
    current = [];
    currentBatchBytes = 0;
  };
  for (const row of scanned) {
    const sequence = BigInt(row.sequence);
    const parsed = OutputBatchSchema.safeParse(row.payload);
    if (!parsed.success) {
      incompleteReason = "source-scan-failed";
      break;
    }
    const { digest, ...body } = parsed.data;
    if (
      await outputDigest(body) !== digest ||
      sequence !== BigInt(parsed.data.sequence) ||
      parsed.data.sessionId !== grant.session_id
    ) {
      incompleteReason = "source-digest-mismatch";
      break;
    }
    if (sequence !== expected) {
      incompleteReason = sequence > expected
        ? "source-gap"
        : "source-sequence-invalid";
      break;
    }
    const batchBytes = utf8(JSON.stringify(parsed.data)).byteLength;
    if (
      transcriptSegmentBytes(
        envelope,
        parsed.data,
        parsed.data,
        batchBytes,
        1,
      ) >
        TRANSCRIPT_LIMITS.maxSegmentBytes
    ) {
      incompleteReason = "resource-limit-segment-bytes";
      break;
    }
    if (
      current.length &&
      transcriptSegmentBytes(
          envelope,
          current[0],
          parsed.data,
          currentBatchBytes + batchBytes,
          current.length + 1,
        ) > TRANSCRIPT_LIMITS.maxSegmentBytes
    ) {
      await flush();
      if (incompleteReason) break;
    }
    const pending = current.length
      ? transcriptSegmentBytes(
        envelope,
        current[0],
        parsed.data,
        currentBatchBytes + batchBytes,
        current.length + 1,
      )
      : transcriptSegmentBytes(
        envelope,
        parsed.data,
        parsed.data,
        batchBytes,
        1,
      );
    if (total + pending > TRANSCRIPT_LIMITS.maxTotalBytes) {
      incompleteReason = "resource-limit-total-bytes";
      break;
    }
    current.push(parsed.data);
    currentBatchBytes += batchBytes;
    expected++;
  }
  await flush();
  if (!incompleteReason && overBatchBound) {
    incompleteReason = "resource-limit-batches";
  }
  // Coverage is what the published segments prove, never what was buffered.
  const lastSegment = segments.at(-1);
  const covered = lastSegment ? BigInt(lastSegment.lastSequence) : 0n;
  const frozen = BigInt(grant.frozen_highwater);
  if (!incompleteReason && covered !== frozen) {
    incompleteReason = covered < frozen
      ? "source-missing"
      : "source-highwater-mismatch";
  }
  if (!incompleteReason && segments.length > TRANSCRIPT_LIMITS.maxSegments) {
    incompleteReason = "resource-limit-segments";
  }
  if (incompleteReason) {
    // Preserve verified prefix segments, but mark the manifest incomplete.
    for (const segment of segments) {
      await maybeInjectIntentInsertFaultForTest(transaction);
      await transaction.query(
        `insert into bakery.session_output_finalization_segments
          (organization_id,grant_id,ordinal,first_sequence,last_sequence,content,sha256,size_bytes)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          grant.organization_id,
          grant.id,
          segment.ordinal,
          segment.firstSequence,
          segment.lastSequence,
          segment.content,
          segment.sha256,
          segment.sizeBytes,
        ],
      );
    }
    const plan = {
      schemaVersion: 1,
      grantId: grant.id,
      sessionId: grant.session_id,
      scopeDigest: grant.scope_digest,
      authorId: grant.author_id,
      frozenHighwater: grant.frozen_highwater,
      coveredHighwater: covered.toString(),
      capture: grant.capture,
      captureReason: grant.capture_reason,
      completeness: "incomplete",
      reason: incompleteReason,
      segments: segments.map(({ content: _content, ...item }) => item),
    };
    const content = utf8(canonicalOutputJson(plan));
    if (content.byteLength > TRANSCRIPT_LIMITS.maxManifestBytes) {
      fail("INTERNAL");
    }
    await maybeInjectIntentInsertFaultForTest(transaction);
    await transaction.query(
      `insert into bakery.session_output_finalization_manifests (organization_id,grant_id,content,sha256,size_bytes) values ($1,$2,$3,$4,$5)`,
      [
        grant.organization_id,
        grant.id,
        content,
        await digestBytes(content),
        content.byteLength,
      ],
    );
  } else {
    for (const segment of segments) {
      await maybeInjectIntentInsertFaultForTest(transaction);
      await transaction.query(
        `insert into bakery.session_output_finalization_segments (organization_id,grant_id,ordinal,first_sequence,last_sequence,content,sha256,size_bytes) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          grant.organization_id,
          grant.id,
          segment.ordinal,
          segment.firstSequence,
          segment.lastSequence,
          segment.content,
          segment.sha256,
          segment.sizeBytes,
        ],
      );
    }
    const plan = {
      schemaVersion: 1,
      grantId: grant.id,
      sessionId: grant.session_id,
      scopeDigest: grant.scope_digest,
      authorId: grant.author_id,
      frozenHighwater: grant.frozen_highwater,
      coveredHighwater: covered.toString(),
      capture: grant.capture,
      captureReason: grant.capture_reason,
      completeness: grant.capture === "complete" ? "complete" : "incomplete",
      reason: grant.capture === "complete" ? "clean-end" : grant.capture_reason,
      segments: segments.map(({ content: _content, ...item }) => item),
    };
    const content = utf8(canonicalOutputJson(plan));
    if (content.byteLength > TRANSCRIPT_LIMITS.maxManifestBytes) {
      fail("INTERNAL");
    }
    await maybeInjectIntentInsertFaultForTest(transaction);
    await transaction.query(
      `insert into bakery.session_output_finalization_manifests (organization_id,grant_id,content,sha256,size_bytes) values ($1,$2,$3,$4,$5)`,
      [
        grant.organization_id,
        grant.id,
        content,
        await digestBytes(content),
        content.byteLength,
      ],
    );
  }
  const payloadPlan = segments.map(({ content: _content, ...item }) => item);
  const payloadDigest = await outputDigest({
    schemaVersion: 1,
    grantId: grant.id,
    sessionId: grant.session_id,
    frozenHighwater: grant.frozen_highwater,
    segments: payloadPlan,
  });
  const finalizationIdentity = await outputDigest({
    schemaVersion: 1,
    operation: "finalize",
    organizationId: grant.organization_id,
    grantId: grant.id,
    sessionId: grant.session_id,
    frozenHighwater: grant.frozen_highwater,
    payloadDigest,
  });
  await transaction.query(
    `update bakery.session_output_finalizations set payload_digest=$3,finalization_identity=$4,state='pending',updated_at=clock_timestamp() where organization_id=$1 and id=$2`,
    [grant.organization_id, grant.id, payloadDigest, finalizationIdentity],
  );
}

export async function createOutputFinalization(
  transaction: PgTransactionClient,
  producer: OutputProducer,
  sessionId: string,
  frozenHighwater: string,
  capture: "complete" | "truncated" | "interrupted",
  captureReason: string,
): Promise<string | null> {
  // An empty closed stream has nothing to export and needs no authority.
  if (BigInt(frozenHighwater) === 0n) return null;
  let scope: Scope & { authorId: string };
  try {
    scope = await loadScope(transaction, producer);
  } catch (error) {
    if (error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
  const grantId = crypto.randomUUID();
  const streamRow = (await transaction.query<{ scope_digest: string }>(
    `select scope_digest from bakery.session_output_streams where organization_id=$1 and id=$2 for update`,
    [producer.organizationId, sessionId],
  )).rows[0];
  if (!streamRow?.scope_digest) fail("RESOURCE_NOT_FOUND");
  const authorityIdentity = await outputDigest({
    organizationId: producer.organizationId,
    ...scope,
    scopeDigest: streamRow.scope_digest,
    sessionId,
    frozenHighwater,
    capture,
    captureReason,
    authorId: scope.authorId,
  });
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.session_output_finalizations
      (id,organization_id,application_id,repository_id,task_id,conversation_id,run_step_id,job_id,attempt_id,worker_host_id,author_id,session_id,scope_digest,frozen_highwater,capture,capture_reason,authority_identity,state,grant_expires_at,transient_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       (select scope_digest from bakery.session_output_streams where organization_id=$2 and id=$12),$13,$14,$15,$16,'assembling',$17,$18)
     on conflict (organization_id,session_id) do nothing returning id`,
    [
      grantId,
      producer.organizationId,
      scope.applicationId,
      scope.repositoryId,
      scope.taskId,
      scope.conversationId,
      scope.runStepId,
      scope.jobId,
      producer.attemptId,
      producer.workerHostId,
      scope.authorId,
      sessionId,
      frozenHighwater,
      capture,
      captureReason,
      authorityIdentity,
      isoAfter(TRANSCRIPT_LIMITS.grantHours, "hours"),
      isoAfter(TRANSCRIPT_LIMITS.transientDays, "days"),
    ],
  );
  const actualId = inserted.rows[0]?.id;
  if (!actualId) {
    const existing = await transaction.query<{ id: string }>(
      `select id from bakery.session_output_finalizations where organization_id=$1 and session_id=$2 for update`,
      [producer.organizationId, sessionId],
    );
    return existing.rows[0]?.id ?? null;
  }
  const grant = (await transaction.query<OutputFinalizationGrant>(
    `select * from bakery.session_output_finalizations where organization_id=$1 and id=$2 for update`,
    [producer.organizationId, actualId],
  )).rows[0];
  if (!grant) fail("INTERNAL");
  await transaction.query("savepoint transcript_intent_assembly");
  try {
    await assemblePlan(transaction, grant);
  } catch (_error) {
    await transaction.query("rollback to savepoint transcript_intent_assembly");
    await transaction.query("release savepoint transcript_intent_assembly");
    await transaction.query(
      `update bakery.session_output_finalizations set state='failed',assembly_failure='intent-persist-failed',updated_at=clock_timestamp() where organization_id=$1 and id=$2`,
      [producer.organizationId, actualId],
    );
    return actualId;
  }
  await transaction.query("release savepoint transcript_intent_assembly");
  maybeInjectAfterSavepointReleaseFaultForTest();
  return actualId;
}

export async function loadFinalizationGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<OutputFinalizationGrant> {
  const row = (await transaction.query<OutputFinalizationGrant>(
    `select * from bakery.session_output_finalizations where organization_id=$1 and id=$2 for update`,
    [organizationId, grantId],
  )).rows[0];
  if (!row) fail("RESOURCE_NOT_FOUND");
  return row;
}

export async function recordFinalizationFailure(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
  retryable: boolean,
): Promise<void> {
  await transaction.query(
    `update bakery.session_output_finalizations
        set attempt_count=least(attempt_count+1,$4),
            state=case when attempt_count+1 >= $4 then 'failed'
                       when $3 then 'retryable' else 'failed' end,
            updated_at=clock_timestamp()
      where organization_id=$1 and id=$2 and state in ('pending','retryable')`,
    [organizationId, grantId, retryable, TRANSCRIPT_LIMITS.maxAttempts],
  );
  await recordStreamArchiveFailure(transaction, organizationId, grantId);
  await purgeFinalizationIntents(transaction, organizationId, grantId);
}

/**
 * Drops intent bytes once no publication can use them. Ranges and digests
 * stay for status; only published, failed, revoked or expired grants qualify.
 */
export async function purgeFinalizationIntents(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.session_output_finalization_segments segment
        set content=null
       from bakery.session_output_finalizations grant_row
      where segment.organization_id=$1 and segment.grant_id=$2
        and segment.content is not null
        and grant_row.organization_id=segment.organization_id
        and grant_row.id=segment.grant_id
        and grant_row.state in ('published','failed','revoked','expired')`,
    [organizationId, grantId],
  );
}

/** Mirrors an unpublished grant's durable failure onto its stream for readers. */
export async function recordStreamArchiveFailure(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.session_output_streams stream
        set archive_state='failed',
            archive_failure=case grant_row.state
              when 'retryable' then 'archive_publication_failed'
              when 'revoked' then 'archive_revoked'
              else 'archive_publication_abandoned' end,
            archive_attempted_at=clock_timestamp()
       from bakery.session_output_finalizations grant_row
      where grant_row.organization_id=$1 and grant_row.id=$2
        and grant_row.state in ('retryable','failed','revoked')
        and stream.organization_id=grant_row.organization_id
        and stream.id=grant_row.session_id
        and stream.archive_state in ('pending','failed')`,
    [organizationId, grantId],
  );
}

/**
 * One bounded pass of transient output-history expiry across closed streams.
 * Immutable transcript references survive; unpublished streams become an
 * explicit expired failure rather than silently pending.
 */
export async function expireOutputHistory(
  transaction: PgTransactionClient,
  now = new Date(),
): Promise<number> {
  const deleted = await transaction.query(
    `with expired as (
       select batch.organization_id, batch.session_id, batch.sequence
         from bakery.session_output_batches batch
         join bakery.session_output_streams stream
           on stream.organization_id=batch.organization_id and stream.id=batch.session_id
        where stream.closed and stream.history_expires_at <= $1
        order by batch.organization_id, batch.session_id, batch.sequence
        limit $2)
     delete from bakery.session_output_batches batch using expired
      where batch.organization_id=expired.organization_id
        and batch.session_id=expired.session_id
        and batch.sequence=expired.sequence`,
    [now, TRANSCRIPT_LIMITS.cleanupBatches],
  );
  await transaction.query(
    `update bakery.session_output_finalizations grant_row
        set state=case when grant_row.state in ('assembling','pending','retryable','failed')
                       then 'expired' else grant_row.state end,
            history_expired_at=clock_timestamp(),updated_at=clock_timestamp()
      where (grant_row.organization_id, grant_row.id) in (
        select candidate.organization_id, candidate.id
          from bakery.session_output_finalizations candidate
          join bakery.session_output_streams stream
            on stream.organization_id=candidate.organization_id and stream.id=candidate.session_id
         where stream.closed and stream.history_expires_at <= $1
           and candidate.history_expired_at is null
         limit $2)`,
    [now, TRANSCRIPT_LIMITS.cleanupBatches],
  );
  await transaction.query(
    `update bakery.session_output_finalization_segments
        set content=null
      where (organization_id, grant_id, ordinal) in (
        select segment.organization_id, segment.grant_id, segment.ordinal
          from bakery.session_output_finalization_segments segment
          join bakery.session_output_finalizations grant_row
            on grant_row.organization_id=segment.organization_id
           and grant_row.id=segment.grant_id
          join bakery.session_output_streams stream
            on stream.organization_id=grant_row.organization_id
           and stream.id=grant_row.session_id
         where stream.closed and stream.history_expires_at <= $1
           and segment.content is not null
         limit $2)`,
    [now, TRANSCRIPT_LIMITS.cleanupBatches],
  );
  await transaction.query(
    `update bakery.session_output_streams
        set archive_state='failed',archive_failure='history_expired',
            archive_attempted_at=clock_timestamp()
      where (organization_id, id) in (
        select organization_id, id from bakery.session_output_streams
         where closed and history_expires_at <= $1
           and archive_state in ('pending','failed')
           and archive_failure is distinct from 'history_expired'
         limit $2)`,
    [now, TRANSCRIPT_LIMITS.cleanupBatches],
  );
  return deleted.rowCount ?? 0;
}
