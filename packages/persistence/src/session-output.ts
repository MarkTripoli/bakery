import { contractSchemas } from "@bakery/contracts/contracts";
import type { ContractOutput } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  OUTPUT_LIMITS,
  type OutputBatch,
  OutputBatchSchema,
  outputDigest,
  type OutputProducer,
  OutputProducerSchema,
} from "@bakery/contracts/output";
import type { PgTransactionClient } from "./postgres.ts";
import { admitRepositoryExecutionJob } from "./repository-admission.ts";
import {
  createOutputFinalization,
  recordStreamArchiveFailure,
} from "./session-output-finalization.ts";

type Binding = ContractOutput<"WorkerOutputBinding">;
type Stream = {
  id: string;
  scope: Omit<
    Binding,
    | "sessionId"
    | "attemptId"
    | "workerHostId"
    | "workerSessionId"
    | "workerSessionGeneration"
    | "fence"
    | "writerGeneration"
    | "highwater"
    | "nextSequence"
    | "closed"
    | "capture"
    | "reason"
    | "archive"
  >;
  highwater: string;
  writer_generation: string;
  display_bytes: string;
  status_bytes: string;
  closed: boolean;
  archive_state: Binding["archive"];
  capture: Binding["capture"];
  reason: Binding["reason"];
};
type Producer = {
  attempt_id: string;
  worker_host_id: string;
  worker_session_id: string;
  worker_session_generation: string;
  fence: string;
};
function denied(): never {
  throw new StandardError({ code: "LEASE_FENCED" });
}
function matches(row: Producer, producer: OutputProducer): boolean {
  return row.attempt_id === producer.attemptId &&
    row.worker_host_id === producer.workerHostId &&
    row.worker_session_id === producer.workerSessionId &&
    row.worker_session_generation === producer.workerSessionGeneration &&
    row.fence === producer.fence;
}
async function loadProducer(
  transaction: PgTransactionClient,
  organizationId: string,
  stream: Stream,
): Promise<Producer | undefined> {
  return (await transaction.query<Producer>(
    `select * from bakery.session_output_producers where organization_id=$1 and session_id=$2 and writer_generation=$3 for update`,
    [organizationId, stream.id, stream.writer_generation],
  )).rows[0];
}
function binding(stream: Stream, producer: OutputProducer): Binding {
  return contractSchemas.WorkerOutputBinding.parse({
    ...stream.scope,
    ...producer,
    sessionId: stream.id,
    writerGeneration: stream.writer_generation,
    highwater: stream.highwater,
    nextSequence: (BigInt(stream.highwater) + 1n).toString(),
    closed: stream.closed,
    capture: stream.capture,
    reason: stream.reason,
    archive: stream.archive_state,
  });
}
async function executionScope(
  transaction: PgTransactionClient,
  producer: OutputProducer,
): Promise<Stream["scope"] & { input: unknown }> {
  // A coordinator turn has no session or output binding: it carries no
  // application, run step or onboarding the stream scope is derived from.
  const coordinator = await transaction.query(
    `select 1 from bakery.jobs
      where organization_id=$1 and id=$2 and action='coordinator.turn'`,
    [producer.organizationId, producer.jobId],
  );
  if (coordinator.rows[0]) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const row = (await transaction.query<{
    application_id: string;
    action: string;
    agent_version_id: string | null;
    input: unknown;
    task_id: string | null;
    run_step_id: string | null;
    conversation_id: string | null;
    inspection_id: string | null;
  }>(
    `select job.application_id, job.action, job.agent_version_id, job.input, job.run_step_id,
      run.task_id, task.conversation_id, onboarding.id as inspection_id
    from bakery.jobs job
    join bakery.applications app on app.organization_id=job.organization_id and app.id=job.application_id
    left join bakery.run_steps step on step.organization_id=job.organization_id and step.id=job.run_step_id
    left join bakery.workflow_runs run on run.organization_id=step.organization_id and run.id=step.run_id
    left join bakery.tasks task on task.organization_id=run.organization_id and task.id=run.task_id and task.application_id=job.application_id
    left join bakery.repository_onboardings onboarding on job.action='repository.inspect' and job.run_step_id is null
      and onboarding.organization_id=job.organization_id and onboarding.application_id=job.application_id
      and onboarding.repository_id=job.repository_id and onboarding.job_id=job.id and onboarding.input=job.input
    where job.organization_id=$1 and job.id=$2`,
    [producer.organizationId, producer.jobId],
  )).rows[0];
  if (
    !row ||
    (row.run_step_id === null
      ? row.inspection_id === null
      : row.task_id === null || row.conversation_id === null)
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (row.run_step_id !== null) {
    await admitRepositoryExecutionJob(
      transaction,
      producer.organizationId,
      producer.jobId,
    );
  }
  return {
    organizationId: producer.organizationId,
    applicationId: row.application_id,
    jobId: producer.jobId,
    taskId: row.task_id,
    runStepId: row.run_step_id,
    conversationId: row.conversation_id,
    logicalActor: `${row.action}:${row.agent_version_id ?? "native"}`,
    input: row.input,
  };
}
export async function replayOutputReceipt(
  transaction: PgTransactionClient,
  producer: OutputProducer,
  operation: "open" | "close",
  key: string,
  digest: string,
): Promise<Binding | undefined> {
  const row = (await transaction.query<
    { request_digest: string; response: unknown; worker_host_id: string }
  >(
    `select request_digest,response,worker_host_id from bakery.session_output_receipts where organization_id=$1 and attempt_id=$2 and operation=$3 and idempotency_key=$4`,
    [producer.organizationId, producer.attemptId, operation, key],
  )).rows[0];
  if (!row) return;
  if (row.worker_host_id !== producer.workerHostId) denied();
  if (row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return contractSchemas.WorkerOutputBinding.parse(row.response);
}
export async function saveOutputReceipt(
  transaction: PgTransactionClient,
  producer: OutputProducer,
  operation: "open" | "close",
  key: string,
  digest: string,
  response: Binding,
): Promise<void> {
  await transaction.query(
    `insert into bakery.session_output_receipts (organization_id,attempt_id,worker_host_id,operation,idempotency_key,request_digest,response) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      producer.organizationId,
      producer.attemptId,
      producer.workerHostId,
      operation,
      key,
      digest,
      JSON.stringify(response),
    ],
  );
}
export async function openOutputBinding(
  transaction: PgTransactionClient,
  input: OutputProducer,
): Promise<Binding> {
  const producer = OutputProducerSchema.parse(input);
  const { input: frozenInput, ...scope } = await executionScope(
    transaction,
    producer,
  );
  const scopeDigest = await outputDigest({ ...scope, input: frozenInput });
  await transaction.query(
    `insert into bakery.session_output_streams (id,organization_id,job_id,scope_digest,scope) values ($1,$2,$3,$4,$5::jsonb) on conflict (organization_id,job_id,scope_digest) do nothing`,
    [
      crypto.randomUUID(),
      producer.organizationId,
      producer.jobId,
      scopeDigest,
      JSON.stringify(scope),
    ],
  );
  const stream = (await transaction.query<Stream>(
    `select * from bakery.session_output_streams where organization_id=$1 and job_id=$2 and scope_digest=$3 for update`,
    [producer.organizationId, producer.jobId, scopeDigest],
  )).rows[0];
  if (!stream || stream.closed) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const old = await loadProducer(transaction, producer.organizationId, stream);
  if (!old || !matches(old, producer)) {
    const next = BigInt(stream.writer_generation) + 1n;
    if (next >= 9223372036854775807n) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    if (old) {
      await transaction.query(
        `update bakery.session_output_producers set ended_reason='producer-replaced' where organization_id=$1 and session_id=$2 and writer_generation=$3`,
        [producer.organizationId, stream.id, stream.writer_generation],
      );
      if (stream.capture === "capturing") {
        stream.capture = "interrupted";
        stream.reason = "producer-replaced";
      }
    }
    stream.writer_generation = next.toString();
    await transaction.query(
      `insert into bakery.session_output_producers (organization_id,session_id,writer_generation,attempt_id,worker_host_id,worker_session_id,worker_session_generation,fence) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        producer.organizationId,
        stream.id,
        stream.writer_generation,
        producer.attemptId,
        producer.workerHostId,
        producer.workerSessionId,
        producer.workerSessionGeneration,
        producer.fence,
      ],
    );
    await transaction.query(
      `update bakery.session_output_streams set writer_generation=$3,capture=$4,reason=$5 where organization_id=$1 and id=$2`,
      [
        producer.organizationId,
        stream.id,
        stream.writer_generation,
        stream.capture,
        stream.reason,
      ],
    );
  }
  return binding(stream, producer);
}
async function currentStream(
  transaction: PgTransactionClient,
  producer: OutputProducer,
  sessionId: string,
  generation: string,
): Promise<Stream> {
  const stream = (await transaction.query<Stream>(
    `select * from bakery.session_output_streams where organization_id=$1 and id=$2 and job_id=$3 for update`,
    [producer.organizationId, sessionId, producer.jobId],
  )).rows[0];
  if (!stream) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (stream.closed) throw new StandardError({ code: "STATE_CONFLICT" });
  const scope = await executionScope(transaction, producer);
  const { input: frozenInput, ...metadata } = scope;
  const digest = await outputDigest({ ...metadata, input: frozenInput });
  const stored = (await transaction.query<{ scope_digest: string }>(
    `select scope_digest from bakery.session_output_streams where organization_id=$1 and id=$2`,
    [producer.organizationId, sessionId],
  )).rows[0];
  if (
    stored?.scope_digest !== digest || generation !== stream.writer_generation
  ) denied();
  const current = await loadProducer(
    transaction,
    producer.organizationId,
    stream,
  );
  if (!current || !matches(current, producer)) denied();
  return stream;
}
export async function appendOutputBatch(
  transaction: PgTransactionClient,
  input: OutputProducer,
  payload: OutputBatch,
  eventId: string,
): Promise<unknown> {
  const producer = OutputProducerSchema.parse(input);
  const batch = OutputBatchSchema.parse(payload);
  const { digest, ...envelope } = batch;
  if (await outputDigest(envelope) !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  const stream = await currentStream(
    transaction,
    producer,
    batch.sessionId,
    batch.writerGeneration,
  );
  const duplicate = await transaction.query(
    `select sequence from bakery.session_output_batches where organization_id=$1 and session_id=$2 and (batch_id=$3 or sequence=$4)`,
    [producer.organizationId, batch.sessionId, batch.batchId, batch.sequence],
  );
  if (duplicate.rows.length) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  if (BigInt(batch.sequence) !== BigInt(stream.highwater) + 1n) {
    throw new StandardError({
      code: "EXPECTED_SEQUENCE",
      params: {
        expectedLocalSeq: (BigInt(stream.highwater) + 1n).toString(),
        ackedLocalSeq: stream.highwater,
      },
    });
  }
  let display = 0, status = 0;
  for (const part of batch.parts) {
    const bytes = new TextEncoder().encode(part.text).byteLength;
    if (part.channel === "status") status += bytes;
    else display += bytes;
  }
  if (
    BigInt(stream.display_bytes) + BigInt(display) >
      BigInt(OUTPUT_LIMITS.displayBytes) ||
    BigInt(stream.status_bytes) + BigInt(status) >
      BigInt(OUTPUT_LIMITS.statusBytes)
  ) throw new StandardError({ code: "STATE_CONFLICT" });
  if (stream.capture === "capturing" && batch.capture !== "capturing") {
    stream.capture = batch.capture;
    stream.reason = batch.reason;
  }
  await transaction.query(
    `insert into bakery.session_output_batches (organization_id,session_id,sequence,batch_id,writer_generation,attempt_id,event_id,payload) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      producer.organizationId,
      batch.sessionId,
      batch.sequence,
      batch.batchId,
      batch.writerGeneration,
      producer.attemptId,
      eventId,
      JSON.stringify(batch),
    ],
  );
  await transaction.query(
    `update bakery.session_output_streams set highwater=$3,display_bytes=display_bytes+$4,status_bytes=status_bytes+$5,capture=$6,reason=$7 where organization_id=$1 and id=$2`,
    [
      producer.organizationId,
      batch.sessionId,
      batch.sequence,
      display,
      status,
      stream.capture,
      stream.reason,
    ],
  );
  return {
    sessionId: batch.sessionId,
    sequence: batch.sequence,
    batchId: batch.batchId,
    writerGeneration: batch.writerGeneration,
    digest,
  };
}
/**
 * Closes a stream without minting transcript authority: its producer is not
 * the live result attempt, or its binding can no longer be verified. Bytes
 * stay readable until the finite history deadline; nothing is published.
 */
export async function closeOutputStreamWithoutAuthority(
  transaction: PgTransactionClient,
  organizationId: string,
  streamId: string,
): Promise<void> {
  const closed = await transaction.query<{ writer_generation: string }>(
    `update bakery.session_output_streams
        set closed=true,
            capture=case when capture='capturing' then 'interrupted' else capture end,
            reason=coalesce(reason,'lease-lost'),
            archive_state='failed',
            archive_failure='finalization_authority_unavailable',
            archive_attempted_at=clock_timestamp(),
            history_expires_at=clock_timestamp()+interval '30 days'
      where organization_id=$1 and id=$2 and closed=false
      returning writer_generation::text`,
    [organizationId, streamId],
  );
  const generation = closed.rows[0]?.writer_generation;
  if (generation === undefined) return;
  await transaction.query(
    `update bakery.session_output_producers set ended_reason=coalesce(ended_reason,'lease-lost')
      where organization_id=$1 and session_id=$2 and writer_generation=$3`,
    [organizationId, streamId, generation],
  );
}

/**
 * Closes every open stream of a job inside its terminal result transaction.
 * It never fails the result: only the result attempt's own live producer
 * mints a finalization grant, everything else closes without authority.
 */
export async function forceCloseOutputBinding(
  transaction: PgTransactionClient,
  producer: OutputProducer,
): Promise<string[]> {
  const streams = await transaction.query<{
    id: string;
    writer_generation: string;
  }>(
    `select id, writer_generation::text from bakery.session_output_streams
      where organization_id=$1 and job_id=$2 and closed=false
      order by id for update`,
    [producer.organizationId, producer.jobId],
  );
  const grants: string[] = [];
  for (const stream of streams.rows) {
    const current = (await transaction.query<Producer>(
      `select * from bakery.session_output_producers
        where organization_id=$1 and session_id=$2 and writer_generation=$3 for update`,
      [producer.organizationId, stream.id, stream.writer_generation],
    )).rows[0];
    // The result route has already verified this attempt's lease and fence; a
    // heartbeat may have rebound its process session, so match the lease.
    if (
      current && current.attempt_id === producer.attemptId &&
      current.worker_host_id === producer.workerHostId &&
      String(current.fence) === producer.fence
    ) {
      await transaction.query("savepoint output_force_close");
      try {
        await closeOutputBinding(transaction, {
          ...producer,
          workerSessionId: current.worker_session_id,
          workerSessionGeneration: String(current.worker_session_generation),
        }, {
          sessionId: stream.id,
          writerGeneration: stream.writer_generation,
          capture: "interrupted",
          reason: "source-lost",
        });
        await transaction.query("release savepoint output_force_close");
        const grant = (await transaction.query<{ id: string }>(
          `select id from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
          [producer.organizationId, stream.id],
        )).rows[0];
        if (grant) grants.push(grant.id);
        continue;
      } catch (error) {
        // An unverifiable binding (fenced producer, changed frozen scope) must
        // not withhold the authoritative terminal result. Unexpected faults
        // still roll the result back for an exact, non-reinferring retry.
        if (!(error instanceof StandardError)) throw error;
        await transaction.query("rollback to savepoint output_force_close");
        await transaction.query("release savepoint output_force_close");
      }
    }
    await closeOutputStreamWithoutAuthority(
      transaction,
      producer.organizationId,
      stream.id,
    );
  }
  return grants;
}

export async function closeOutputBinding(
  transaction: PgTransactionClient,
  producer: OutputProducer,
  input: {
    sessionId: string;
    writerGeneration: string;
    capture: "complete" | "truncated" | "interrupted";
    reason: NonNullable<Binding["reason"]>;
  },
): Promise<Binding> {
  if (
    input.capture === "complete"
      ? input.reason !== "clean-end"
      : input.capture === "truncated"
      ? input.reason !== "text-limit"
      : !["source-lost", "lease-lost", "producer-replaced"].includes(
        input.reason,
      )
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const stream = await currentStream(
    transaction,
    producer,
    input.sessionId,
    input.writerGeneration,
  );
  if (stream.capture === "capturing") {
    stream.capture = input.capture;
    stream.reason = input.reason;
  }
  stream.closed = true;
  await transaction.query(
    `update bakery.session_output_streams set closed=true,capture=$3,reason=$4 where organization_id=$1 and id=$2`,
    [producer.organizationId, stream.id, stream.capture, stream.reason],
  );
  await transaction.query(
    `update bakery.session_output_producers set ended_reason=$4 where organization_id=$1 and session_id=$2 and writer_generation=$3`,
    [
      producer.organizationId,
      stream.id,
      stream.writer_generation,
      input.reason,
    ],
  );
  const grantId = await createOutputFinalization(
    transaction,
    producer,
    stream.id,
    stream.highwater,
    stream.capture,
    stream.reason ?? input.reason,
  );
  if (grantId) {
    // The grant's transient deadline is the stream's only history clock.
    await transaction.query(
      `update bakery.session_output_streams stream
          set history_expires_at=grant_row.transient_expires_at
         from bakery.session_output_finalizations grant_row
        where stream.organization_id=$1 and stream.id=$2
          and grant_row.organization_id=stream.organization_id and grant_row.id=$3`,
      [producer.organizationId, stream.id, grantId],
    );
    await recordStreamArchiveFailure(
      transaction,
      producer.organizationId,
      grantId,
    );
  } else {
    // Taskless inspection output has no task-owned destination; an empty
    // stream has nothing to publish. Neither mints transcript authority.
    stream.archive_state = "not_required";
    await transaction.query(
      `update bakery.session_output_streams
          set archive_state='not_required',
              archive_failure=$3,
              history_expires_at=clock_timestamp()+interval '30 days'
        where organization_id=$1 and id=$2`,
      [
        producer.organizationId,
        stream.id,
        stream.scope.taskId !== null && BigInt(stream.highwater) === 0n
          ? null
          : "no_task_owned_destination",
      ],
    );
  }
  return binding(stream, producer);
}

export type OutputStreamReaderFilters = Readonly<{
  applicationId?: string;
  repositoryId?: string;
  taskId?: string;
  runStepId?: string;
  conversationId?: string;
  logicalActor?: string;
}>;

export type OutputStreamDiscoveryPosition = Readonly<{
  createdAt: string;
  streamId: string;
}>;

export type OutputStreamReaderRecord = Readonly<{
  streamId: string;
  organizationId: string;
  applicationId: string;
  repositoryId: string | null;
  jobId: string;
  taskId: string | null;
  runStepId: string | null;
  conversationId: string | null;
  logicalActor: string;
  highwater: string;
  closed: boolean;
  capture: "capturing" | "complete" | "truncated" | "interrupted";
  reason:
    | "clean-end"
    | "text-limit"
    | "source-lost"
    | "lease-lost"
    | "producer-replaced"
    | null;
  archive: Binding["archive"];
  archiveFailure: string | null;
  archivedAt: string | null;
  historyExpiresAt: string | null;
  segments: ContractOutput<"OutputTranscriptSegment">[];
  producers: ContractOutput<"OutputStreamProducer">[];
  createdAt: string;
}>;

type OutputStreamReaderRow = {
  id: string;
  organization_id: string;
  application_id: string;
  repository_id: string | null;
  job_id: string;
  task_id: string | null;
  run_step_id: string | null;
  conversation_id: string | null;
  logical_actor: string;
  highwater: string | number;
  closed: boolean;
  capture: OutputStreamReaderRecord["capture"];
  reason: OutputStreamReaderRecord["reason"];
  archive_state: Binding["archive"];
  archive_failure: string | null;
  archived_at: Date | string | null;
  history_expires_at: Date | string | null;
  segments: unknown;
  producers: unknown;
  created_at: Date | string;
};

const OUTPUT_STREAM_READER_SELECT = `
  select stream.id, stream.organization_id,
         stream.scope->>'applicationId' as application_id,
         job.repository_id,
         stream.job_id,
         stream.scope->>'taskId' as task_id,
         stream.scope->>'runStepId' as run_step_id,
         stream.scope->>'conversationId' as conversation_id,
         stream.scope->>'logicalActor' as logical_actor,
         stream.highwater, stream.closed, stream.capture, stream.reason,
         stream.archive_state, stream.archive_failure, stream.archived_at,
         stream.history_expires_at,
         (select coalesce(jsonb_agg(jsonb_build_object(
           'segmentIndex', segment.segment_index,
           'firstSequence', segment.first_sequence::text,
           'lastSequence', segment.last_sequence::text,
           'sizeBytes', segment.size_bytes, 'sha256', segment.sha256,
           'completeness', segment.completeness,
           'artifactVersionId', segment.artifact_version_id
         ) order by segment.segment_index), '[]'::jsonb)
          from bakery.output_transcript_segments segment
          where segment.organization_id = stream.organization_id
            and segment.stream_id = stream.id) as segments,
         (select coalesce(jsonb_agg(jsonb_build_object(
           'writerGeneration', latest.writer_generation::text,
           'attemptId', latest.attempt_id,
           'attemptNo', latest.attempt_no
         ) order by latest.writer_generation), '[]'::jsonb)
          from (
            select producer.writer_generation, producer.attempt_id,
                   attempt.attempt_no
              from bakery.session_output_producers producer
              join bakery.job_attempts attempt
                on attempt.organization_id = producer.organization_id
               and attempt.id = producer.attempt_id
             where producer.organization_id = stream.organization_id
               and producer.session_id = stream.id
             order by producer.writer_generation desc
             limit 64
          ) latest) as producers,
         to_char(
           stream.created_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) as created_at
    from bakery.session_output_streams stream
    join bakery.jobs job
      on job.organization_id = stream.organization_id
     and job.id = stream.job_id
    join bakery.applications application
      on application.organization_id = stream.organization_id
     and application.id = nullif(stream.scope->>'applicationId', '')::uuid
     and application.archived_at is null
    left join bakery.repositories repository
      on repository.organization_id = stream.organization_id
     and repository.application_id = application.id
     and repository.id = job.repository_id
     and repository.archived_at is null
    left join bakery.tasks task
      on task.organization_id = stream.organization_id
     and task.id = nullif(stream.scope->>'taskId', '')::uuid
     and task.application_id = application.id
     and task.repository_id is not distinct from job.repository_id
     and task.conversation_id = nullif(stream.scope->>'conversationId', '')::uuid
     and task.archived_at is null
    left join bakery.run_steps step
      on step.organization_id = stream.organization_id
     and step.id = nullif(stream.scope->>'runStepId', '')::uuid
     and step.id = job.run_step_id`;

const OUTPUT_STREAM_AUTHORIZED = `
   (job.repository_id is null or repository.id is not null)
   and (
     ((stream.scope->>'taskId') is null
       and (stream.scope->>'runStepId') is null
       and (stream.scope->>'conversationId') is null
       and job.run_step_id is null)
     or
     ((stream.scope->>'taskId') is not null
       and task.id is not null
       and step.id is not null)
   )`;

function outputStreamIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    return value;
  }
  return new Date(value).toISOString();
}

function outputStreamReaderRecord(
  row: OutputStreamReaderRow,
): OutputStreamReaderRecord {
  return {
    streamId: row.id,
    organizationId: row.organization_id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    jobId: row.job_id,
    taskId: row.task_id,
    runStepId: row.run_step_id,
    conversationId: row.conversation_id,
    logicalActor: row.logical_actor,
    highwater: String(row.highwater),
    closed: row.closed,
    capture: row.capture,
    reason: row.reason,
    archive: row.archive_state,
    archiveFailure: row.archive_failure,
    archivedAt: row.archived_at === null
      ? null
      : outputStreamIso(row.archived_at),
    historyExpiresAt: row.history_expires_at === null
      ? null
      : outputStreamIso(row.history_expires_at),
    segments: contractSchemas.OutputTranscriptSegment.array().describe(
      "Ordered immutable transcript references for an authorized output stream.",
    ).parse(
      row.segments,
    ),
    producers: contractSchemas.OutputStreamProducer.array().max(64).describe(
      "Ascending producer bindings that attribute each committed batch's writer generation to a job attempt; the latest 64.",
    ).parse(row.producers),
    createdAt: outputStreamIso(row.created_at),
  };
}

export async function listAuthorizedOutputStreams(
  transaction: PgTransactionClient,
  organizationId: string,
  filters: OutputStreamReaderFilters,
  after: OutputStreamDiscoveryPosition | null,
  limit: number,
): Promise<readonly OutputStreamReaderRecord[]> {
  const values: unknown[] = [organizationId];
  const where = ["stream.organization_id = $1", OUTPUT_STREAM_AUTHORIZED];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (filters.applicationId) {
    add("stream.scope->>'applicationId' = ?", filters.applicationId);
  }
  if (filters.repositoryId) {
    add("job.repository_id = ?::uuid", filters.repositoryId);
  }
  if (filters.taskId) add("stream.scope->>'taskId' = ?", filters.taskId);
  if (filters.runStepId) {
    add("stream.scope->>'runStepId' = ?", filters.runStepId);
  }
  if (filters.conversationId) {
    add("stream.scope->>'conversationId' = ?", filters.conversationId);
  }
  if (filters.logicalActor !== undefined) {
    add("stream.scope->>'logicalActor' = ?", filters.logicalActor);
  }
  if (after) {
    values.push(after.createdAt, after.streamId);
    where.push(
      `(stream.created_at, stream.id) > ($${
        values.length - 1
      }::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(limit);
  const result = await transaction.query<OutputStreamReaderRow>(
    `${OUTPUT_STREAM_READER_SELECT}
      where ${where.join("\n and ")}
      order by stream.created_at asc, stream.id asc
      limit $${values.length}`,
    values,
  );
  return result.rows.map(outputStreamReaderRecord);
}

export async function loadAuthorizedOutputStream(
  transaction: PgTransactionClient,
  organizationId: string,
  streamId: string,
): Promise<OutputStreamReaderRecord> {
  const result = await transaction.query<OutputStreamReaderRow>(
    `${OUTPUT_STREAM_READER_SELECT}
      where stream.organization_id = $1 and stream.id = $2
      and ${OUTPUT_STREAM_AUTHORIZED}`,
    [organizationId, streamId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return outputStreamReaderRecord(row);
}

export type OutputBatchRead = Readonly<{
  stream: OutputStreamReaderRecord;
  batches: readonly OutputBatch[];
  highwater: string;
  retainedFrom: string | null;
  resetFrom: string | null;
}>;

export async function readAuthorizedOutputBatches(
  transaction: PgTransactionClient,
  organizationId: string,
  streamId: string,
  after: string | null,
  limit: number,
  authorizedStream?: OutputStreamReaderRecord,
): Promise<OutputBatchRead> {
  const stream = authorizedStream ?? await loadAuthorizedOutputStream(
    transaction,
    organizationId,
    streamId,
  );
  if (
    stream.organizationId !== organizationId || stream.streamId !== streamId
  ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const retained = await transaction.query<
    { retained_from: string | number | null }
  >(
    `select min(sequence) as retained_from
       from bakery.session_output_batches
      where organization_id = $1 and session_id = $2`,
    [organizationId, streamId],
  );
  const retainedValue = retained.rows[0]?.retained_from;
  const retainedFrom = retainedValue === null || retainedValue === undefined
    ? null
    : String(retainedValue);
  if (retainedFrom === null) {
    return {
      stream,
      batches: [],
      highwater: stream.highwater,
      retainedFrom,
      resetFrom: BigInt(after ?? "0") < BigInt(stream.highwater)
        ? (BigInt(stream.highwater) + 1n).toString()
        : null,
    };
  }
  const exclusive = after === null ? null : BigInt(after);
  if (exclusive !== null && exclusive + 1n < BigInt(retainedFrom)) {
    return {
      stream,
      batches: [],
      highwater: stream.highwater,
      retainedFrom,
      resetFrom: retainedFrom,
    };
  }
  const rows = await transaction.query<
    { sequence: string | number; payload: unknown }
  >(
    `select sequence, payload
       from bakery.session_output_batches
      where organization_id = $1 and session_id = $2 and sequence > $3
      order by sequence asc
      limit $4`,
    [organizationId, streamId, after ?? "0", limit],
  );
  const first = rows.rows[0];
  if (
    exclusive !== null && first &&
    BigInt(first.sequence) > exclusive + 1n &&
    exclusive < BigInt(stream.highwater)
  ) {
    return {
      stream,
      batches: [],
      highwater: stream.highwater,
      retainedFrom,
      resetFrom: String(first.sequence),
    };
  }
  const batches: OutputBatch[] = [];
  let expected = exclusive === null
    ? first === undefined ? null : BigInt(first.sequence)
    : exclusive + 1n;
  for (const row of rows.rows) {
    const sequence = BigInt(row.sequence);
    if (expected !== null && sequence !== expected) break;
    batches.push(OutputBatchSchema.parse(row.payload));
    expected = sequence + 1n;
  }
  return {
    stream,
    batches,
    highwater: stream.highwater,
    retainedFrom,
    resetFrom: null,
  };
}
