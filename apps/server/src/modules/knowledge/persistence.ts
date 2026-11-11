import {
  assertArtifactWriteCapacity,
  readStorageCapacity,
} from "../../platform/storage-capacity.ts";
import {
  publicationRetention,
  type PublicationSource,
  retentionExpiry,
} from "./retention/policy.ts";
import type { PgTransactionClient } from "@bakery/persistence";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { assertActiveLease, lockAttempt } from "../execution/events.ts";
import {
  assertAttemptMutationSession,
  iso,
  sha256Hex,
  type WorkerIdentity,
} from "../execution/shared.ts";
import {
  type ArtifactUpload,
  sha256Bytes,
  validateArtifactUpload,
} from "./bytes.ts";
import { assertParentVersion } from "./authority.ts";
import { reconcileCoordinationForCommittedOutput } from "../work/coordination-projection.ts";

function assertPublicationAuthority(
  identity: WorkerIdentity,
  attempt: Parameters<typeof assertActiveLease>[0],
  input: ArtifactUpload,
  tokenHash: string,
): void {
  assertAttemptMutationSession(
    identity.host,
    attempt,
    input.workerSessionId ?? undefined,
    input.workerSessionGeneration ?? undefined,
  );
  assertActiveLease(attempt, identity, tokenHash, input.fence);
}

function assertArtifactVersionResponse(
  response: Record<string, unknown>,
): void {
  const parsed = contractSchemas.ArtifactVersion.safeParse(response);
  if (!parsed.success) {
    throw new StandardError({ code: "INTERNAL", cause: parsed.error });
  }
}

export async function commitArtifactVersion(
  transaction: PgTransactionClient,
  args: {
    scope: {
      organizationId: string;
      taskId: string;
      applicationId: string;
      repositoryId: string | null;
      conversationId: string | null;
    };
    parent: {
      id: string;
      revision: number;
      version: number;
      currentVersionId: string | null;
    };
    version: {
      parentVersionId: string | null;
      runStepId: string | null;
      authorId: string;
      subjectHeadSha: string | null;
      subjectBaseSha: string | null;
      stepKey: string | null;
      metadata: Record<string, unknown>;
      content: Uint8Array;
      sha256: string;
      mediaType: string;
    };
    promotion:
      | {
        kind: "worker";
        attemptId: string;
        assertAuthority: () => Promise<void>;
      }
      | {
        kind: "execution-output";
        grantId: string;
        assertAuthority: () => Promise<void>;
      }
      | { kind: "human" };
    publicationSource?: PublicationSource;
    traceId?: string;
  },
): Promise<Record<string, unknown>> {
  const { scope, parent, version, promotion, traceId } = args;
  assertParentVersion(parent.currentVersionId, version.parentVersionId);
  assertArtifactWriteCapacity(await readStorageCapacity());
  const typeRow = await transaction.query<
    { artifact_type: string; name: string }
  >(
    "select artifact_type, name from bakery.artifacts where organization_id=$1 and id=$2 for update",
    [scope.organizationId, parent.id],
  );
  const retentionClass = publicationRetention(
    args.publicationSource ??
      (promotion.kind === "human" ? "import" : "worker"),
    typeRow.rows[0]?.artifact_type ?? "other",
  );
  const expiresAt = retentionExpiry(retentionClass, new Date());
  const runStepId = promotion.kind === "human" ? null : version.runStepId;
  if (promotion.kind === "execution-output") await promotion.assertAuthority();
  const versionResult = await transaction.query<{
    id: string;
    created_at: Date | string;
  }>(
    `insert into bakery.artifact_versions (organization_id, artifact_id, task_id, run_step_id, revision, author_id, subject_head_sha, subject_base_sha, step_key, metadata, content, sha256, size_bytes, media_type, retention_class, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id, created_at`,
    [
      scope.organizationId,
      parent.id,
      scope.taskId,
      runStepId,
      parent.revision,
      version.authorId,
      version.subjectHeadSha,
      version.subjectBaseSha,
      version.stepKey,
      version.metadata,
      version.content,
      version.sha256,
      version.content.byteLength,
      version.mediaType,
      retentionClass,
      expiresAt,
    ],
  );
  const versionRow = versionResult.rows[0];
  const createdAt = iso(versionRow.created_at);
  const response = {
    id: versionRow.id,
    retentionClass,
    expiresAt: expiresAt.toISOString(),
    purgedAt: null,
    artifactId: parent.id,
    revision: parent.revision,
    runStepId,
    authorId: version.authorId,
    mediaType: version.mediaType,
    sizeBytes: version.content.byteLength,
    sha256: version.sha256,
    subjectHeadSha: version.subjectHeadSha ?? null,
    subjectBaseSha: version.subjectBaseSha ?? null,
    metadata: version.metadata,
    createdAt,
    updatedAt: createdAt,
    version: 1,
  };
  assertArtifactVersionResponse(response);
  const resourceVersion = parent.version + 1;
  await appendDomainEvent(transaction, {
    organizationId: scope.organizationId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    taskId: scope.taskId,
    conversationId: scope.conversationId,
    eventType: "artifact.version_created",
    aggregateId: parent.id,
    aggregateVersion: resourceVersion,
    payload: {
      resourceId: parent.id,
      resourceVersion,
    },
    traceId: traceId ?? crypto.randomUUID(),
    outboxDeliveryKey: `artifact:${versionRow.id}`,
  });
  if (promotion.kind === "worker") {
    await promotion.assertAuthority();
  }
  const promoted = promotion.kind === "worker"
    ? await transaction.query(
      `update bakery.artifacts set current_version_id=$1, revision=revision+1, updated_at=now(), version=version+1 where organization_id=$2 and id=$3 and current_version_id is not distinct from $4 and exists (select 1 from bakery.job_attempts where organization_id=$2 and id=$5 and lease_expires_at > clock_timestamp())`,
      [
        versionRow.id,
        scope.organizationId,
        parent.id,
        parent.currentVersionId,
        promotion.attemptId,
      ],
    )
    : promotion.kind === "execution-output"
    ? await transaction.query(
      `update bakery.artifacts set current_version_id=$1, revision=revision+1, updated_at=now(), version=version+1 where organization_id=$2 and id=$3 and current_version_id is not distinct from $4 and exists (select 1 from bakery.session_output_finalizations where organization_id=$2 and id=$5 and state in ('pending','retryable'))`,
      [
        versionRow.id,
        scope.organizationId,
        parent.id,
        parent.currentVersionId,
        promotion.grantId,
      ],
    )
    : await transaction.query(
      `update bakery.artifacts set current_version_id=$1, revision=revision+1, updated_at=now(), version=version+1 where organization_id=$2 and id=$3 and current_version_id is not distinct from $4`,
      [versionRow.id, scope.organizationId, parent.id, parent.currentVersionId],
    );
  if (promoted.rowCount !== 1) {
    if (promotion.kind !== "human") await promotion.assertAuthority();
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  // A new committed version can make a dependant lane's consumed input stale;
  // keep the coordination plan projection current in the same transaction.
  await reconcileCoordinationForCommittedOutput(transaction, {
    organizationId: scope.organizationId,
    taskId: scope.taskId,
    artifactName: typeRow.rows[0]?.name ?? "",
    artifactType: typeRow.rows[0]?.artifact_type ?? "other",
    traceId: traceId ?? crypto.randomUUID(),
  });
  return response;
}

export async function publishArtifact(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
  input: ArtifactUpload,
  requestDigest: string,
  traceId?: string,
): Promise<{ response: Record<string, unknown>; replayed: boolean }> {
  const attempt = await lockAttempt(transaction, identity, attemptId);
  const tokenHash = await sha256Hex(input.leaseToken);
  // Check the durable replay before lease status so an exact retry returns
  // its committed receipt after an otherwise stale lease. Exact retries are
  // intentionally replayable across worker sessions because the durable key
  // and request digest bind the original publication, not session identity.
  const existing = await transaction.query<
    { response: Record<string, unknown>; request_digest: string }
  >(
    `select response, request_digest from bakery.artifact_publication_replays where organization_id=$1 and attempt_id=$2 and worker_host_id=$3 and idempotency_key=$4 for update`,
    [
      attempt.organization_id,
      attemptId,
      identity.host.id,
      input.idempotencyKey,
    ],
  );
  if (existing.rows.length) {
    if (existing.rows[0].request_digest !== requestDigest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    const response = existing.rows[0].response;
    assertArtifactVersionResponse(response);
    return { response, replayed: true };
  }
  if (
    input.metadata !== null &&
    typeof input.metadata === "object" &&
    !Array.isArray(input.metadata) &&
    (
      Object.hasOwn(input.metadata, "sourceRepositoryId") ||
      Object.hasOwn(input.metadata, "path") ||
      Object.hasOwn(input.metadata, "commitSha")
    )
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  validateArtifactUpload(input);
  assertPublicationAuthority(identity, attempt, input, tokenHash);
  const job = await transaction.query<
    {
      organization_id: string;
      run_step_id: string;
      task_id: string;
      application_id: string;
      repository_id: string | null;
      conversation_id: string | null;
    }
  >(
    `select j.organization_id, j.run_step_id, wr.task_id,
            t.application_id, t.repository_id, t.conversation_id
       from bakery.jobs j
       join bakery.run_steps rs
         on rs.organization_id=j.organization_id and rs.id=j.run_step_id
       join bakery.workflow_runs wr
         on wr.organization_id=rs.organization_id and wr.id=rs.run_id
       join bakery.tasks t
         on t.organization_id=wr.organization_id and t.id=wr.task_id
      where j.organization_id=$1 and j.id=$2`,
    [attempt.organization_id, attempt.job_id],
  );
  if (job.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const scope = job.rows[0];
  if (input.runStepId && input.runStepId !== scope.run_step_id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const digest = input.contentSha256 ?? await sha256Bytes(input.content);
  const artifact = await transaction.query<
    {
      id: string;
      revision: number;
      version: number;
      current_version_id: string | null;
    }
  >(
    `insert into bakery.artifacts (organization_id, task_id, artifact_type, name) values ($1,$2,$3,$4) on conflict (organization_id, task_id, artifact_type, name) do update set updated_at=now() returning id, revision, version, current_version_id`,
    [scope.organization_id, scope.task_id, input.artifactType, input.name],
  );
  const parent = artifact.rows[0];
  if (
    !Number.isSafeInteger(parent.revision) || parent.revision < 1 ||
    !Number.isSafeInteger(parent.version) || parent.version < 1
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  assertParentVersion(parent.current_version_id, input.parentVersionId);
  const response = await commitArtifactVersion(transaction, {
    scope: {
      organizationId: scope.organization_id,
      taskId: scope.task_id,
      applicationId: scope.application_id,
      repositoryId: scope.repository_id,
      conversationId: scope.conversation_id,
    },
    parent: {
      id: parent.id,
      revision: parent.revision,
      version: parent.version,
      currentVersionId: parent.current_version_id,
    },
    version: {
      parentVersionId: input.parentVersionId ?? null,
      runStepId: input.runStepId ?? scope.run_step_id,
      authorId: identity.host.principal_id,
      subjectHeadSha: input.subjectHeadSha ?? null,
      subjectBaseSha: input.subjectBaseSha ?? null,
      stepKey: input.stepKey ?? null,
      metadata: input.metadata as Record<string, unknown>,
      content: input.content,
      sha256: digest,
      mediaType: input.contentType,
    },
    promotion: {
      kind: "worker",
      attemptId,
      assertAuthority: async () => {
        const refreshedAttempt = await lockAttempt(
          transaction,
          identity,
          attemptId,
        );
        assertPublicationAuthority(
          identity,
          refreshedAttempt,
          input,
          tokenHash,
        );
      },
    },
    traceId,
  });
  await transaction.query(
    `insert into bakery.artifact_publication_replays (organization_id,attempt_id,worker_host_id,idempotency_key,request_digest,response) values ($1,$2,$3,$4,$5,$6)`,
    [
      scope.organization_id,
      attemptId,
      identity.host.id,
      input.idempotencyKey,
      requestDigest,
      response,
    ],
  );
  return { response, replayed: false };
}
