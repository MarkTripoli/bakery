import { StandardError } from "@bakery/contracts/http";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import type { PgTransactionClient } from "@bakery/persistence";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { ActionAttribution } from "../auth/application/action-attribution.ts";
import { sha256Bytes } from "./bytes.ts";
import { commitArtifactVersion } from "./persistence.ts";
export { DRAFT_SOURCE_METADATA_KEYS } from "./draft-source-metadata.ts";

/**
 * Publishing a draft as its artifact's next immutable version (chapter 20,
 * "Publish a cutoff while editing continues"; #71).
 *
 * The split is deliberate so every draft kind reuses one publish path:
 * a kind-specific `freeze…` function turns one committed checkpoint into
 * {@link FrozenDraftContent} (bytes, digest, media type and the exact cutoff),
 * and {@link publishFrozenDraft} does the rest: replay, ordering, the
 * artifact compare-and-set, the version write through the shared
 * {@link commitArtifactVersion} service, the publication record, the domain
 * event and the audit row. Nothing in it knows about Loro or Markdown.
 */

/** One committed draft checkpoint, frozen as the exact bytes to publish. */
export type FrozenDraftContent = Readonly<{
  draftId: string;
  epoch: number;
  checkpointId: string;
  /** Committed draft sequence of the cutoff, as a decimal string. */
  serverSequence: string;
  /** Kind-specific digest the publisher previewed (text drafts: UTF-8 body). */
  contentDigest: string;
  content: Uint8Array;
  /** SHA-256 of `content`. */
  sha256: string;
  mediaType: string;
}>;

/** The durable answer to "which version did this publication make?". */
export type DraftPublicationRecord = {
  draftId: string;
  epoch: number;
  checkpointId: string;
  serverSequence: string;
  textDigest: string;
  artifactId: string;
  artifactVersionId: string;
  versionNumber: number;
  sha256: string;
  publishedById: string;
  publishedByName: string;
  actorKind: "person" | "agent";
  publishedAt: string;
};

export type PublishFrozenDraftInput = Readonly<{
  organizationId: string;
  frozen: FrozenDraftContent;
  attribution: ActionAttribution;
  /** Client Idempotency-Key, bound to this checkpoint; null when not sent. */
  idempotencyKey: string | null;
  requestId: string;
  traceId: string;
  /** Audit operation name of the calling action. */
  operation: string;
  /**
   * Where the published version's bytes go. Present, the version names a blob;
   * absent, it stores its bytes inline. The draft publication path is the one
   * that has a store today, so it is the one that writes blob-backed versions.
   */
  blobStore?: OrganizationBlobStore;
}>;

type PublicationRow = {
  draft_id: string;
  epoch: number;
  checkpoint_id: string;
  server_sequence: string;
  text_digest: string;
  artifact_id: string;
  artifact_version_id: string;
  version_number: number;
  sha256: string;
  publisher_id: string;
  publisher_name: string;
  actor_kind: "person" | "agent";
  published_at: Date | string;
};

const PUBLICATION_COLUMNS = `p.draft_id,p.epoch,p.checkpoint_id,
  p.server_sequence::text as server_sequence,p.text_digest,p.artifact_id,
  p.artifact_version_id,p.version_number,v.sha256,p.publisher_id,
  pr.display_name as publisher_name,p.actor_kind,p.published_at`;
const PUBLICATION_FROM = `from bakery.artifact_draft_publications p
  join bakery.artifact_versions v
    on v.organization_id=p.organization_id and v.id=p.artifact_version_id
  join bakery.principals pr on pr.id=p.publisher_id`;

function record(row: PublicationRow): DraftPublicationRecord {
  return {
    draftId: row.draft_id,
    epoch: row.epoch,
    checkpointId: row.checkpoint_id,
    serverSequence: String(row.server_sequence),
    textDigest: row.text_digest,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    versionNumber: row.version_number,
    sha256: row.sha256,
    publishedById: row.publisher_id,
    publishedByName: row.publisher_name,
    actorKind: row.actor_kind,
    publishedAt:
      (row.published_at instanceof Date
        ? row.published_at
        : new Date(row.published_at)).toISOString(),
  };
}

async function findPublication(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  where: "checkpoint" | "key",
  value: string,
): Promise<DraftPublicationRecord | undefined> {
  const column = where === "checkpoint"
    ? "p.checkpoint_id"
    : "p.idempotency_key";
  const row = (await transaction.query<PublicationRow>(
    `select ${PUBLICATION_COLUMNS} ${PUBLICATION_FROM}
      where p.organization_id=$1 and p.draft_id=$2 and ${column}=$3`,
    [organizationId, draftId, value],
  )).rows[0];
  return row ? record(row) : undefined;
}

type LockedDraft = {
  artifact_id: string;
  task_id: string;
  base_version_id: string | null;
  application_id: string;
  repository_id: string | null;
  conversation_id: string | null;
};

/** Locks the active draft: concurrent publishes of one draft serialize here. */
async function lockDraft(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
): Promise<LockedDraft> {
  const row = (await transaction.query<LockedDraft>(
    `select d.artifact_id,d.task_id,d.base_version_id,
            t.application_id,t.repository_id,t.conversation_id
       from bakery.artifact_drafts d
       join bakery.artifacts a
         on a.organization_id=d.organization_id
        and a.id=d.artifact_id and a.task_id=d.task_id
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
      where d.organization_id=$1 and d.id=$2
        and d.status='active' and t.archived_at is null
      for update of d`,
    [organizationId, draftId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/**
 * Publishes one frozen draft checkpoint as the artifact's next version, once.
 *
 * - The same checkpoint, or the same Idempotency-Key, answers with the
 *   committed publication (one version); a key reused for another checkpoint
 *   is IDEMPOTENCY_PAYLOAD_MISMATCH.
 * - A cutoff at or before an already published one is PRECONDITION_FAILED.
 * - The artifact must still point at the version this draft last published
 *   (or its base); a version written elsewhere meanwhile is STATE_CONFLICT,
 *   the diverged base chapter 20 asks the client to reconcile.
 */
export async function publishFrozenDraft(
  transaction: PgTransactionClient,
  input: PublishFrozenDraftInput,
): Promise<{ publication: DraftPublicationRecord; replayed: boolean }> {
  const { organizationId, frozen, attribution } = input;
  const draft = await lockDraft(transaction, organizationId, frozen.draftId);
  const byCheckpoint = await findPublication(
    transaction,
    organizationId,
    frozen.draftId,
    "checkpoint",
    frozen.checkpointId,
  );
  const byKey = input.idempotencyKey === null
    ? undefined
    : await findPublication(
      transaction,
      organizationId,
      frozen.draftId,
      "key",
      input.idempotencyKey,
    );
  if (byKey && byKey.checkpointId !== frozen.checkpointId) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  if (byCheckpoint) {
    if (byCheckpoint.textDigest !== frozen.contentDigest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return { publication: byCheckpoint, replayed: true };
  }

  const latest = (await transaction.query<{
    epoch: number;
    server_sequence: string;
    artifact_version_id: string;
  }>(
    `select epoch,server_sequence::text as server_sequence,artifact_version_id
       from bakery.artifact_draft_publications
      where organization_id=$1 and draft_id=$2
      order by epoch desc, server_sequence desc limit 1`,
    [organizationId, frozen.draftId],
  )).rows[0];
  if (
    latest && (frozen.epoch < latest.epoch ||
      (frozen.epoch === latest.epoch &&
        BigInt(frozen.serverSequence) <= BigInt(latest.server_sequence)))
  ) throw new StandardError({ code: "PRECONDITION_FAILED" });

  const artifact = (await transaction.query<{
    revision: number;
    version: number;
    current_version_id: string | null;
  }>(
    `select revision,version,current_version_id from bakery.artifacts
      where organization_id=$1 and id=$2 for update`,
    [organizationId, draft.artifact_id],
  )).rows[0];
  if (!artifact) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedParent = latest?.artifact_version_id ?? draft.base_version_id;
  if (artifact.current_version_id !== expectedParent) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }

  const version = await commitArtifactVersion(transaction, {
    blobStore: input.blobStore,
    scope: {
      organizationId,
      taskId: draft.task_id,
      applicationId: draft.application_id,
      repositoryId: draft.repository_id,
      conversationId: draft.conversation_id,
    },
    parent: {
      id: draft.artifact_id,
      revision: artifact.revision,
      version: artifact.version,
      currentVersionId: artifact.current_version_id,
    },
    version: {
      parentVersionId: artifact.current_version_id === null
        ? null
        : `"${artifact.current_version_id}"`,
      runStepId: null,
      authorId: attribution.principalId,
      subjectHeadSha: null,
      subjectBaseSha: null,
      stepKey: null,
      metadata: {
        sourceDraftId: frozen.draftId,
        sourceDraftEpoch: frozen.epoch,
        sourceDraftCheckpointId: frozen.checkpointId,
        sourceDraftServerSequence: frozen.serverSequence,
        publishedActorKind: attribution.actorKind,
      },
      content: frozen.content,
      sha256: frozen.sha256,
      mediaType: frozen.mediaType,
    },
    promotion: { kind: "human" },
    traceId: input.traceId,
  });
  const versionId = version.id as string;
  const versionNumber = version.revision as number;
  await transaction.query(
    `insert into bakery.artifact_draft_publications (
       organization_id,draft_id,epoch,checkpoint_id,server_sequence,
       text_digest,artifact_id,artifact_version_id,version_number,
       idempotency_key,publisher_id,actor_kind,access_token_id
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      organizationId,
      frozen.draftId,
      frozen.epoch,
      frozen.checkpointId,
      frozen.serverSequence,
      frozen.contentDigest,
      draft.artifact_id,
      versionId,
      versionNumber,
      input.idempotencyKey,
      attribution.principalId,
      attribution.actorKind,
      attribution.accessTokenId,
    ],
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: draft.application_id,
    repositoryId: draft.repository_id,
    taskId: draft.task_id,
    conversationId: draft.conversation_id,
    eventType: "draft.published",
    aggregateId: frozen.draftId,
    aggregateVersion: versionNumber,
    payload: { resourceId: frozen.draftId, resourceVersion: versionNumber },
    traceId: input.traceId,
    outboxDeliveryKey: `draft-publication:${versionId}`,
  });
  const audited = await appendAudit(transaction, {
    organizationId,
    principalId: attribution.principalId,
    operation: input.operation,
    resourceType: "artifact_version",
    resourceId: versionId,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      draftId: frozen.draftId,
      epoch: frozen.epoch,
      checkpointId: frozen.checkpointId,
      serverSequence: frozen.serverSequence,
      versionNumber,
      actorKind: attribution.actorKind,
      accessTokenId: attribution.accessTokenId,
    },
  });
  if (audited !== 1) throw new Error("DRAFT_PUBLICATION_AUDIT_INSERT_FAILED");
  const publication = await findPublication(
    transaction,
    organizationId,
    frozen.draftId,
    "checkpoint",
    frozen.checkpointId,
  );
  if (!publication) throw new Error("DRAFT_PUBLICATION_READBACK_MISSING");
  return { publication, replayed: false };
}

/** "Was this checkpoint published?": the publication, or RESOURCE_NOT_FOUND. */
export async function readDraftPublication(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
): Promise<DraftPublicationRecord> {
  await assertDraftReadable(transaction, organizationId, draftId);
  const publication = await findPublication(
    transaction,
    organizationId,
    draftId,
    "checkpoint",
    checkpointId,
  );
  if (!publication) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return publication;
}

async function assertDraftReadable(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
): Promise<void> {
  const found = await transaction.query(
    `select 1 from bakery.artifact_drafts d
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
      where d.organization_id=$1 and d.id=$2
        and d.status='active' and t.archived_at is null`,
    [organizationId, draftId],
  );
  if (found.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

const TEXT_MEDIA_TYPES = new Set(["text/markdown", "text/plain"]);

/**
 * Freezes one committed checkpoint of a collaborative text draft. The
 * checkpoint is the server barrier: it holds every edit acknowledged up to
 * its sequence and nothing after it, and its stored text is already the
 * canonical body, so no Loro decoding is needed. `textDigest` must be the
 * digest the publisher previewed.
 */
export async function freezeTextDraftCheckpoint(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
  textDigest: string,
): Promise<FrozenDraftContent> {
  const row = (await transaction.query<{
    epoch: number;
    server_sequence: string;
    text_content: string;
    text_digest: string;
    media_type: string | null;
  }>(
    `select c.epoch,c.server_sequence::text as server_sequence,
            c.text_content,c.text_digest,v.media_type
       from bakery.artifact_draft_checkpoints c
       join bakery.artifact_drafts d
         on d.organization_id=c.organization_id and d.id=c.draft_id
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
       left join bakery.artifact_versions v
         on v.organization_id=d.organization_id and v.id=d.base_version_id
      where c.organization_id=$1 and c.draft_id=$2 and c.id=$3
        and d.status='active' and t.archived_at is null`,
    [organizationId, draftId, checkpointId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.text_digest !== textDigest) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const content = new TextEncoder().encode(row.text_content);
  const sha256 = await sha256Bytes(content);
  if (sha256 !== row.text_digest) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return {
    draftId,
    epoch: row.epoch,
    checkpointId,
    serverSequence: String(row.server_sequence),
    contentDigest: row.text_digest,
    content,
    sha256,
    mediaType: TEXT_MEDIA_TYPES.has(row.media_type ?? "")
      ? row.media_type!
      : "text/markdown",
  };
}
