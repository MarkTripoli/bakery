import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import type { ContractOutput } from "@bakery/contracts/contracts";
import { outputDigest } from "@bakery/contracts/output";
import { StandardError } from "@bakery/contracts/http";
import {
  loadAuthorizedOutputStream,
  loadFinalizationGrant,
  type OutputFinalizationGrant,
  purgeFinalizationIntents,
  recordStreamArchiveFailure,
  TRANSCRIPT_LIMITS,
} from "@bakery/persistence";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { commitArtifactVersion } from "../knowledge/persistence.ts";

// Execution-owned transcript publication. A closed stream's grant, minted under
// live worker authority, is the only way transcript artifacts are published:
// the close hook, the worker retry route and the archive sweep all call
// `finalizeOutputTranscript` with the stored grant. Nothing impersonates a
// principal and no other publisher writes `output_transcript_segments`.

type FinalizeInput = {
  grantId: string;
  sessionId: string;
  frozenHighwater: string;
  payloadDigest: string;
};

type WorkerAuth = {
  organizationId: string;
  workerHostId: string;
  workerPrincipalId: string;
  attemptId?: string;
};

type Parent = {
  id: string;
  revision: number;
  version: number;
  currentVersionId: string | null;
};

type PublicationFaultStage = "segment" | "manifest" | "receipt";
type TranscriptPathEvent =
  | "finalize-stored-intents"
  | "finalize-stored-receipt"
  | "status-stored-ledger";

let publicationFaultForTest: PublicationFaultStage | null = null;
let transcriptPathProbeForTest:
  | ((event: TranscriptPathEvent) => void)
  | null = null;

/** One-shot fixture seam for proving atomic publication rollback. */
export function setOutputTranscriptPublicationFaultForTest(
  stage: PublicationFaultStage | null,
): void {
  publicationFaultForTest = stage;
}

/** Fixture instrumentation for proving transcript paths consume stored data. */
export function setOutputTranscriptPathProbeForTest(
  probe: ((event: TranscriptPathEvent) => void) | null,
): void {
  transcriptPathProbeForTest = probe;
}

function observeTranscriptPath(event: TranscriptPathEvent): void {
  transcriptPathProbeForTest?.(event);
}

function maybeInjectPublicationFaultForTest(
  stage: PublicationFaultStage,
): void {
  if (publicationFaultForTest !== stage) return;
  publicationFaultForTest = null;
  throw new Error(`OUTPUT_TRANSCRIPT_PUBLICATION_${stage.toUpperCase()}_FAULT`);
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}
function precondition(): never {
  throw new StandardError({ code: "PRECONDITION_FAILED" });
}
function mismatch(): never {
  throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new StandardError({ code: "INTERNAL" });
}
async function digestBytes(value: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        value as unknown as BufferSource,
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function parseJson(value: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new StandardError({ code: "INTERNAL", cause: error });
  }
}
async function requestDigest(
  input: FinalizeInput,
  workerHostId: string,
): Promise<string> {
  return await outputDigest({ ...input, workerHostId });
}
async function assertStoredGrantDigest(
  grant: OutputFinalizationGrant,
): Promise<void> {
  const authorityIdentity = await outputDigest({
    organizationId: grant.organization_id,
    applicationId: grant.application_id,
    repositoryId: grant.repository_id,
    taskId: grant.task_id,
    conversationId: grant.conversation_id,
    runStepId: grant.run_step_id,
    jobId: grant.job_id,
    authorId: grant.author_id,
    scopeDigest: grant.scope_digest,
    sessionId: grant.session_id,
    frozenHighwater: grant.frozen_highwater,
    capture: grant.capture,
    captureReason: grant.capture_reason,
  });
  if (authorityIdentity !== grant.authority_identity) precondition();
  if (!grant.payload_digest || !grant.finalization_identity) precondition();
  const finalizationIdentity = await outputDigest({
    schemaVersion: 1,
    operation: "finalize",
    organizationId: grant.organization_id,
    grantId: grant.id,
    sessionId: grant.session_id,
    frozenHighwater: grant.frozen_highwater,
    payloadDigest: grant.payload_digest,
  });
  if (finalizationIdentity !== grant.finalization_identity) precondition();
}

async function assertLiveStoredGrantIntegrity(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
): Promise<void> {
  const scope = (await transaction.query<{
    application_id: string;
    repository_id: string | null;
    task_id: string;
    conversation_id: string;
    run_step_id: string;
    job_id: string;
    attempt_id: string;
    worker_host_id: string;
    author_id: string;
    scope_digest: string;
  }>(
    `select job.application_id,job.repository_id,run.task_id,task.conversation_id,
            job.run_step_id,job.id as job_id,attempt.id as attempt_id,
            attempt.worker_host_id,host.principal_id as author_id,stream.scope_digest
       from bakery.jobs job
       join bakery.job_attempts attempt
         on attempt.organization_id=job.organization_id and attempt.job_id=job.id
       join bakery.worker_hosts host
         on host.organization_id=attempt.organization_id and host.id=attempt.worker_host_id
       join bakery.run_steps step
         on step.organization_id=job.organization_id and step.id=job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id=step.organization_id and run.id=step.run_id
       join bakery.tasks task
         on task.organization_id=run.organization_id and task.id=run.task_id
       join bakery.session_output_streams stream
         on stream.organization_id=job.organization_id and stream.id=$3
      where job.organization_id=$1 and job.id=$2 and attempt.id=$4`,
    [grant.organization_id, grant.job_id, grant.session_id, grant.attempt_id],
  )).rows[0];
  if (
    !scope || scope.application_id !== grant.application_id ||
    scope.repository_id !== grant.repository_id ||
    scope.task_id !== grant.task_id ||
    scope.conversation_id !== grant.conversation_id ||
    scope.run_step_id !== grant.run_step_id || scope.job_id !== grant.job_id ||
    scope.attempt_id !== grant.attempt_id ||
    scope.worker_host_id !== grant.worker_host_id ||
    scope.author_id !== grant.author_id ||
    scope.scope_digest !== grant.scope_digest
  ) precondition();
}

async function assertGrantAuthority(
  transaction: PgTransactionClient,
  grantId: string,
  organizationId: string,
): Promise<void> {
  const row = (await transaction.query<
    { state: string; grant_expires_at: Date | string }
  >(
    `select state,grant_expires_at from bakery.session_output_finalizations where organization_id=$1 and id=$2 for update`,
    [organizationId, grantId],
  )).rows[0];
  if (!row || !["pending", "retryable"].includes(row.state)) precondition();
  if (new Date(row.grant_expires_at).getTime() <= Date.now()) precondition();
}
async function parent(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
  artifactType: string,
  name: string,
): Promise<Parent> {
  await transaction.query(
    `insert into bakery.artifacts (organization_id,task_id,artifact_type,name)
       values ($1,$2,$3,$4) on conflict (organization_id,task_id,artifact_type,name)
       do update set updated_at=clock_timestamp()`,
    [grant.organization_id, grant.task_id, artifactType, name],
  );
  const row = (await transaction.query<Parent>(
    `select id,revision,version,current_version_id as "currentVersionId"
       from bakery.artifacts where organization_id=$1 and task_id=$2
        and artifact_type=$3 and name=$4 for update`,
    [grant.organization_id, grant.task_id, artifactType, name],
  )).rows[0];
  if (!row || row.revision !== 1 || row.version !== 1) precondition();
  if (row.currentVersionId !== null) precondition();
  return row;
}
async function finalizationReceipt(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
  input: FinalizeInput,
  workerHostId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!grant.finalization_identity) precondition();
  const digest = await requestDigest(input, workerHostId);
  const row = (await transaction.query<
    { request_digest: string; worker_host_id: string; response: unknown }
  >(
    `select request_digest,worker_host_id,response from bakery.session_output_finalization_receipts
      where organization_id=$1 and grant_id=$2 and operation='finalize' and operation_identity=$3`,
    [grant.organization_id, grant.id, grant.finalization_identity],
  )).rows[0];
  if (!row) return;
  if (row.worker_host_id !== workerHostId || row.request_digest !== digest) {
    mismatch();
  }
  const parsed = contractSchemas.OutputFinalizationReceipt.safeParse(
    row.response,
  );
  if (!parsed.success) {
    throw new StandardError({ code: "INTERNAL", cause: parsed.error });
  }
  return parsed.data as Record<string, unknown>;
}

export async function finalizeOutputTranscript(
  transaction: PgTransactionClient,
  auth: WorkerAuth,
  input: FinalizeInput,
): Promise<{ response: Record<string, unknown>; replayed: boolean }> {
  const grant = await loadFinalizationGrant(
    transaction,
    auth.organizationId,
    input.grantId,
  );
  if (
    grant.worker_host_id !== auth.workerHostId ||
    (auth.attemptId !== undefined && grant.attempt_id !== auth.attemptId) ||
    grant.author_id !== auth.workerPrincipalId
  ) notFound();
  await assertStoredGrantDigest(grant);
  if (
    grant.session_id !== input.sessionId ||
    grant.frozen_highwater !== input.frozenHighwater ||
    grant.payload_digest !== input.payloadDigest
  ) mismatch();
  const replay = await finalizationReceipt(
    transaction,
    grant,
    input,
    auth.workerHostId,
  );
  if (replay) {
    observeTranscriptPath("finalize-stored-receipt");
    return { response: replay, replayed: true };
  }
  await assertLiveStoredGrantIntegrity(transaction, grant);
  if (
    grant.state === "revoked" || grant.state === "expired" ||
    grant.state === "failed"
  ) precondition();
  if (!grant.finalization_identity || !grant.payload_digest) precondition();
  const claimed = (await transaction.query<{ attempt_count: number }>(
    `update bakery.session_output_finalizations
        set attempt_count=attempt_count+1,updated_at=clock_timestamp()
      where organization_id=$1 and id=$2 and state in ('pending','retryable')
        and attempt_count < $3 and grant_expires_at > clock_timestamp()
      returning attempt_count`,
    [grant.organization_id, grant.id, TRANSCRIPT_LIMITS.maxAttempts],
  )).rows[0];
  if (!claimed) precondition();

  observeTranscriptPath("finalize-stored-intents");
  const segmentRows = await transaction.query<{
    ordinal: number;
    first_sequence: string | number;
    last_sequence: string | number;
    content: unknown;
    sha256: string;
    size_bytes: number;
  }>(
    `select ordinal,first_sequence,last_sequence,content,sha256,size_bytes from bakery.session_output_finalization_segments where organization_id=$1 and grant_id=$2 order by ordinal`,
    [grant.organization_id, grant.id],
  );
  const manifestRow = (await transaction.query<
    { content: unknown; sha256: string; size_bytes: number }
  >(
    `select content,sha256,size_bytes from bakery.session_output_finalization_manifests where organization_id=$1 and grant_id=$2`,
    [grant.organization_id, grant.id],
  )).rows[0];
  if (!manifestRow) precondition();
  const manifestBytes = bytes(manifestRow.content);
  if (await digestBytes(manifestBytes) !== manifestRow.sha256) precondition();
  const manifestPlan = parseJson(manifestBytes);
  const preparedSegments = [];
  for (const row of segmentRows.rows) {
    const content = bytes(row.content);
    if (
      content.byteLength !== row.size_bytes ||
      row.size_bytes > TRANSCRIPT_LIMITS.maxSegmentBytes ||
      await digestBytes(content) !== row.sha256
    ) precondition();
    preparedSegments.push({ ...row, content });
  }
  const segmentParents = [];
  for (const row of preparedSegments) {
    segmentParents.push(
      await parent(
        transaction,
        grant,
        "log",
        `output-transcript/${grant.session_id}/segment/${
          String(row.ordinal).padStart(6, "0")
        }`,
      ),
    );
  }
  const manifestParent = await parent(
    transaction,
    grant,
    "log",
    `output-transcript/${grant.session_id}/manifest`,
  );
  const segmentRefs: Array<Record<string, unknown>> = [];
  for (let index = 0; index < preparedSegments.length; index++) {
    const row = preparedSegments[index];
    const version = await commitArtifactVersion(transaction, {
      scope: {
        organizationId: grant.organization_id,
        taskId: grant.task_id,
        applicationId: grant.application_id,
        repositoryId: grant.repository_id,
        conversationId: grant.conversation_id,
      },
      parent: segmentParents[index],
      version: {
        parentVersionId: null,
        runStepId: grant.run_step_id,
        authorId: grant.author_id,
        subjectHeadSha: null,
        subjectBaseSha: null,
        stepKey: "output-transcript",
        metadata: {
          grantId: grant.id,
          sessionId: grant.session_id,
          ordinal: row.ordinal,
          firstSequence: String(row.first_sequence),
          lastSequence: String(row.last_sequence),
          promotion: "execution-output",
        },
        content: row.content,
        sha256: row.sha256,
        mediaType: "application/json",
      },
      promotion: {
        kind: "execution-output",
        grantId: grant.id,
        assertAuthority: () =>
          assertGrantAuthority(transaction, grant.id, grant.organization_id),
      },
    });
    await transaction.query(
      `insert into bakery.output_transcript_segments
         (organization_id, stream_id, segment_index, first_sequence, last_sequence,
          size_bytes, sha256, completeness, artifact_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        grant.organization_id,
        grant.session_id,
        row.ordinal - 1,
        row.first_sequence,
        row.last_sequence,
        row.size_bytes,
        row.sha256,
        grant.capture,
        version.id,
      ],
    );
    segmentRefs.push({
      artifactId: version.artifactId,
      versionId: version.id,
      ordinal: row.ordinal,
      firstSequence: String(row.first_sequence),
      lastSequence: String(row.last_sequence),
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
    });
    if (index === 0) maybeInjectPublicationFaultForTest("segment");
  }
  const manifestObject = { ...manifestPlan, segments: segmentRefs };
  const manifestContent = new TextEncoder().encode(
    canonicalJson(manifestObject),
  );
  if (manifestContent.byteLength > TRANSCRIPT_LIMITS.maxManifestBytes) {
    precondition();
  }
  const manifestVersion = await commitArtifactVersion(transaction, {
    scope: {
      organizationId: grant.organization_id,
      taskId: grant.task_id,
      applicationId: grant.application_id,
      repositoryId: grant.repository_id,
      conversationId: grant.conversation_id,
    },
    parent: manifestParent,
    version: {
      parentVersionId: null,
      runStepId: grant.run_step_id,
      authorId: grant.author_id,
      subjectHeadSha: null,
      subjectBaseSha: null,
      stepKey: "output-transcript",
      metadata: {
        grantId: grant.id,
        sessionId: grant.session_id,
        promotion: "execution-output",
      },
      content: manifestContent,
      sha256: await outputDigest(manifestObject),
      mediaType: "application/json",
    },
    promotion: {
      kind: "execution-output",
      grantId: grant.id,
      assertAuthority: () =>
        assertGrantAuthority(transaction, grant.id, grant.organization_id),
    },
  });
  maybeInjectPublicationFaultForTest("manifest");
  const receiptId = crypto.randomUUID();
  const response = contractSchemas.OutputFinalizationReceipt.parse({
    receiptId,
    finalizationIdentity: grant.finalization_identity,
    grantId: grant.id,
    sessionId: grant.session_id,
    frozenHighwater: grant.frozen_highwater,
    payloadDigest: grant.payload_digest,
    exportDisposition: manifestPlan.completeness === "complete"
      ? "published"
      : "incomplete",
    segments: segmentRefs,
    manifest: {
      artifactId: manifestVersion.artifactId,
      versionId: manifestVersion.id,
      sizeBytes: manifestContent.byteLength,
      sha256: await outputDigest(manifestObject),
    },
  });
  const digest = await requestDigest(input, auth.workerHostId);
  await transaction.query(
    `insert into bakery.session_output_finalization_receipts (id,organization_id,grant_id,operation,operation_identity,request_digest,worker_host_id,response) values ($1,$2,$3,'finalize',$4,$5,$6,$7::jsonb)`,
    [
      receiptId,
      grant.organization_id,
      grant.id,
      grant.finalization_identity,
      digest,
      auth.workerHostId,
      JSON.stringify(response),
    ],
  );
  maybeInjectPublicationFaultForTest("receipt");
  await transaction.query(
    `update bakery.session_output_finalizations set state='published',updated_at=clock_timestamp() where organization_id=$1 and id=$2`,
    [grant.organization_id, grant.id],
  );
  // Published bytes live in the immutable artifacts; the intent copy goes.
  await purgeFinalizationIntents(
    transaction,
    grant.organization_id,
    grant.id,
  );
  // Capture truncation is already explicit per segment; source integrity or
  // resource limits are surfaced as the archive reason so readers never infer
  // complete coverage from an archived stream.
  const coverageFailure = manifestPlan.completeness !== "complete" &&
      typeof manifestPlan.reason === "string" &&
      manifestPlan.reason !== grant.capture_reason
    ? manifestPlan.reason
    : null;
  await transaction.query(
    `update bakery.session_output_streams
        set archive_state='archived',archive_failure=$3,
            archived_at=clock_timestamp(),archive_attempted_at=clock_timestamp()
      where organization_id=$1 and id=$2`,
    [grant.organization_id, grant.session_id, coverageFailure],
  );
  return { response: response as Record<string, unknown>, replayed: false };
}

export function transcriptManifestMaximumBytes(): number {
  const uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const sha256 = "f".repeat(64);
  const sequence = "9".repeat(19);
  const segments = Array.from(
    { length: TRANSCRIPT_LIMITS.maxSegments },
    (_, index) => ({
      artifactId: uuid,
      versionId: uuid,
      ordinal: index + 1,
      firstSequence: sequence,
      lastSequence: sequence,
      sizeBytes: TRANSCRIPT_LIMITS.maxSegmentBytes,
      sha256,
    }),
  );
  return new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    grantId: uuid,
    sessionId: uuid,
    scopeDigest: sha256,
    authorId: uuid,
    frozenHighwater: sequence,
    coveredHighwater: sequence,
    capture: "interrupted",
    captureReason: "producer-replaced",
    completeness: "incomplete",
    reason: "resource-limit-segment-bytes",
    segments,
  })).byteLength;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
      ).join(",")
    }}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("OUTPUT_JSON_INVALID");
  return result;
}

export async function revokeOutputTranscript(
  transaction: PgTransactionClient,
  auth: {
    organizationId: string;
    workerHostId: string;
    workerPrincipalId: string;
    attemptId: string;
    tokenHash: string;
    fence: string;
    workerSessionId: string;
    workerSessionGeneration: string;
  },
  input: { grantId: string; idempotencyKey: string },
  assertLive: () => void,
): Promise<{ response: Record<string, unknown>; replayed: boolean }> {
  const grant = await loadFinalizationGrant(
    transaction,
    auth.organizationId,
    input.grantId,
  );
  const revokeIdentity = await outputDigest({
    schemaVersion: 1,
    operation: "revoke",
    organizationId: auth.organizationId,
    grantId: grant.id,
    idempotencyKey: input.idempotencyKey,
  });
  const requestDigest = await outputDigest({
    ...input,
    attemptId: auth.attemptId,
    workerHostId: auth.workerHostId,
    workerSessionId: auth.workerSessionId,
    workerSessionGeneration: auth.workerSessionGeneration,
    fence: auth.fence,
    tokenHash: auth.tokenHash,
    finalizationIdentity: grant.finalization_identity,
  });
  const replay = (await transaction.query<
    { request_digest: string; worker_host_id: string; response: unknown }
  >(
    `select request_digest,worker_host_id,response from bakery.session_output_finalization_receipts where organization_id=$1 and grant_id=$2 and operation='revoke' and operation_identity=$3`,
    [auth.organizationId, grant.id, revokeIdentity],
  )).rows[0];
  if (replay) {
    if (
      replay.worker_host_id !== auth.workerHostId ||
      replay.request_digest !== requestDigest
    ) mismatch();
    const parsed = contractSchemas.OutputRevokeReceipt.safeParse(
      replay.response,
    );
    if (!parsed.success) {
      throw new StandardError({ code: "INTERNAL", cause: parsed.error });
    }
    return { response: parsed.data as Record<string, unknown>, replayed: true };
  }
  assertLive();
  if (
    grant.worker_host_id !== auth.workerHostId ||
    grant.author_id !== auth.workerPrincipalId ||
    grant.attempt_id !== auth.attemptId || grant.state === "published" ||
    grant.state === "revoked" || grant.state === "expired"
  ) precondition();
  const response = contractSchemas.OutputRevokeReceipt.parse({
    receiptId: crypto.randomUUID(),
    revokeIdentity,
    grantId: grant.id,
    finalizationIdentity: grant.finalization_identity,
    revokedAt: new Date().toISOString(),
    state: "revoked",
  });
  await transaction.query(
    `update bakery.session_output_finalizations set state='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() where organization_id=$1 and id=$2 and state in ('assembling','pending','retryable','failed')`,
    [auth.organizationId, grant.id],
  );
  await recordStreamArchiveFailure(transaction, auth.organizationId, grant.id);
  await purgeFinalizationIntents(transaction, auth.organizationId, grant.id);
  await transaction.query(
    `insert into bakery.session_output_finalization_receipts (id,organization_id,grant_id,operation,operation_identity,request_digest,worker_host_id,response) values ($1,$2,$3,'revoke',$4,$5,$6,$7::jsonb)`,
    [
      response.receiptId,
      auth.organizationId,
      grant.id,
      revokeIdentity,
      requestDigest,
      auth.workerHostId,
      JSON.stringify(response),
    ],
  );
  return { response: response as Record<string, unknown>, replayed: false };
}

type PublishedVersion = {
  artifact_id: string;
  version_id: string | null;
  content: unknown;
  size_bytes: number;
  sha256: string;
};

/**
 * Loads a published version by its immutable id from the stored receipt, never
 * through the artifact's mutable current pointer.
 */
async function publishedVersion(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
  versionId: string,
): Promise<PublishedVersion | undefined> {
  return (await transaction.query<PublishedVersion>(
    `select a.id as artifact_id,v.id as version_id,
            v.content,v.size_bytes,v.sha256
       from bakery.artifact_versions v
       join bakery.artifacts a
         on a.organization_id=v.organization_id and a.id=v.artifact_id
      where v.organization_id=$1 and v.id=$2 and a.task_id=$3
        and a.artifact_type='log'`,
    [grant.organization_id, versionId, grant.task_id],
  )).rows[0];
}

async function publishedReceipt(
  transaction: PgTransactionClient,
  grant: OutputFinalizationGrant,
): Promise<ContractOutput<"OutputFinalizationReceipt"> | null> {
  if (grant.state !== "published") return null;
  const row = (await transaction.query<{ response: unknown }>(
    `select response from bakery.session_output_finalization_receipts
      where organization_id=$1 and grant_id=$2 and operation='finalize'
        and operation_identity=$3`,
    [grant.organization_id, grant.id, grant.finalization_identity],
  )).rows[0];
  if (!row) precondition();
  const parsed = contractSchemas.OutputFinalizationReceipt.safeParse(
    row.response,
  );
  if (!parsed.success) {
    throw new StandardError({ code: "INTERNAL", cause: parsed.error });
  }
  return parsed.data as ContractOutput<"OutputFinalizationReceipt">;
}

/** Verifies retained bytes; collected content keeps only its stored digest. */
async function assertPublishedBytes(
  version: PublishedVersion,
  expected: { size_bytes: number; sha256: string },
  exact?: Uint8Array,
): Promise<void> {
  if (
    version.size_bytes !== expected.size_bytes ||
    version.sha256 !== expected.sha256
  ) precondition();
  if (version.content === null) return;
  const content = bytes(version.content);
  if (
    content.byteLength !== expected.size_bytes ||
    await digestBytes(content) !== expected.sha256 ||
    (exact !== undefined &&
      (content.byteLength !== exact.byteLength ||
        content.some((byte, index) => byte !== exact[index])))
  ) precondition();
}

export async function transcriptStatusAction(
  context: ActionContext,
  input: { sessionId: string },
): Promise<ContractOutput<"TranscriptStatus">> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  observeTranscriptPath("status-stored-ledger");
  const sessionId = context.params.id ?? input.sessionId;
  if (sessionId !== input.sessionId) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  // The same scope predicate as the output stream reader authorizes status.
  const stream = await loadAuthorizedOutputStream(
    transaction,
    organizationId,
    sessionId,
  );
  const grant = (await transaction.query<OutputFinalizationGrant>(
    `select * from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
    [organizationId, sessionId],
  )).rows[0];
  if (!grant) notFound();
  const manifest = (await transaction.query<{
    content: unknown;
    sha256: string;
    size_bytes: number;
  }>(
    `select content,sha256,size_bytes from bakery.session_output_finalization_manifests where organization_id=$1 and grant_id=$2`,
    [organizationId, grant.id],
  )).rows[0];
  const manifestBytes = manifest ? bytes(manifest.content) : null;
  if (
    manifestBytes &&
    (manifestBytes.byteLength !== manifest.size_bytes ||
      await digestBytes(manifestBytes) !== manifest.sha256)
  ) precondition();
  const plan = manifestBytes ? parseJson(manifestBytes) : null;
  const segments = (await transaction.query<{
    ordinal: number;
    first_sequence: string | number;
    last_sequence: string | number;
    size_bytes: number;
    sha256: string;
  }>(
    `select ordinal,first_sequence,last_sequence,size_bytes,sha256
       from bakery.session_output_finalization_segments
      where organization_id=$1 and grant_id=$2 order by ordinal`,
    [organizationId, grant.id],
  )).rows;
  const receipt = await publishedReceipt(transaction, grant);
  const refs: Array<Record<string, unknown>> = [];
  for (const published of receipt?.segments ?? []) {
    const row = segments.find((item) => item.ordinal === published.ordinal);
    if (!row) precondition();
    const version = await publishedVersion(
      transaction,
      grant,
      published.versionId,
    );
    if (!version?.version_id) precondition();
    await assertPublishedBytes(version, row);
    refs.push({
      artifactId: version.artifact_id,
      versionId: version.version_id,
      ordinal: row.ordinal,
      firstSequence: String(row.first_sequence),
      lastSequence: String(row.last_sequence),
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
    });
  }
  if (
    grant.state === "published" &&
    (!Array.isArray(plan?.segments) || plan.segments.length !== refs.length)
  ) precondition();
  // Expiry is derived, never performed, on read; the archive sweep deletes.
  const historyExpired = grant.history_expired_at !== null ||
    (stream.historyExpiresAt !== null &&
      Date.parse(stream.historyExpiresAt) <= Date.now());
  // An unpublished grant past its deadline can never be retried.
  const retryable = grant.state === "assembling" ||
    grant.state === "pending" || grant.state === "retryable";
  const grantLapsed = retryable &&
    new Date(grant.grant_expires_at).getTime() <= Date.now();
  const disposition:
    | "published"
    | "incomplete"
    | "failed"
    | "retryable"
    | "revoked"
    | "expired" = grant.state === "published"
      ? (plan?.completeness === "complete" ? "published" : "incomplete")
      : historyExpired || grant.state === "expired"
      ? "expired"
      : grantLapsed || grant.state === "failed"
      ? "failed"
      : grant.state === "revoked"
      ? "revoked"
      : "retryable";
  const result: {
    sessionId: string;
    capture: "complete" | "truncated" | "interrupted";
    captureReason: string;
    frozenHighwater: string;
    coveredHighwater: string;
    exportDisposition:
      | "published"
      | "incomplete"
      | "failed"
      | "retryable"
      | "revoked"
      | "expired";
    history: "available" | "expired";
    transientExpiresAt: string;
    segments: Array<Record<string, unknown>>;
    manifest: Record<string, unknown> | null;
  } = {
    sessionId: grant.session_id,
    capture: grant.capture,
    captureReason: grant.capture_reason,
    frozenHighwater: grant.frozen_highwater,
    coveredHighwater: String(
      plan?.coveredHighwater ?? (segments.at(-1)?.last_sequence ?? "0"),
    ),
    exportDisposition: disposition,
    history: historyExpired ? "expired" : "available",
    transientExpiresAt: stream.historyExpiresAt ??
      new Date(grant.transient_expires_at).toISOString(),
    segments: refs,
    manifest: null,
  };
  if (manifest && receipt) {
    const version = await publishedVersion(
      transaction,
      grant,
      receipt.manifest.versionId,
    );
    if (!version?.version_id) precondition();
    const expectedManifestBytes = new TextEncoder().encode(canonicalJson({
      ...plan,
      segments: refs,
    }));
    await assertPublishedBytes(version, {
      size_bytes: expectedManifestBytes.byteLength,
      sha256: version.sha256,
    }, expectedManifestBytes);
    result.manifest = {
      artifactId: version.artifact_id,
      versionId: version.version_id,
      sizeBytes: version.size_bytes,
      sha256: version.sha256,
    };
  }
  return contractSchemas.TranscriptStatus.parse(result) as ContractOutput<
    "TranscriptStatus"
  >;
}
