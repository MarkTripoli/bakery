import { lockRetainedArtifactVersion } from "./retention/references.ts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { sha256Bytes } from "./bytes.ts";
import { DRAFT_LIMITS, type DraftCandidate } from "./drafts.ts";
import {
  compactDraftEpoch,
  measureDraftEpochBytes,
} from "./draft-compaction.ts";

export type DraftEditInput = {
  epoch: number;
  sourceCheckpointId: string;
  startCursor: string;
  endCursor: string;
  expectedText: string;
  expectedDigest: string;
  replacement: string;
  mutationId: string;
};

export type DraftReceipt = {
  mutationId: string;
  draftId: string;
  epoch: number;
  serverSequence: string;
  checkpointId: string;
  actorId: string;
  mutationDigest: string;
  updateDigest: string;
  textDigest: string;
  committedAt: string;
};

export type DraftRead = {
  id: string;
  artifactId: string;
  taskId: string;
  epoch: number;
  serverSequence: string;
  checkpointId: string;
  textDigest: string;
  text: string;
  receipts: DraftReceipt[];
};

export type PreparedDraftOpen = {
  kind: "candidate";
  artifactId: string;
  taskId: string;
  baseVersionId: string | null;
  text: string;
};

export type PreparedDraftRollover = {
  kind: "candidate";
  draftId: string;
  epoch: number;
  checkpointId: string;
  artifactId: string;
  publishedVersionId: string;
  text: string;
  textDigest: string;
};

export type PreparedDraftEdit = {
  kind: "candidate";
  draftId: string;
  epoch: number;
  highwater: string;
  requestDigest: string;
  currentState: Uint8Array;
  sourceState: Uint8Array;
};

export type PreparedDraftSlice = {
  draftId: string;
  epoch: number;
  checkpointId: string;
  serverSequence: string;
  state: Uint8Array;
};

export class DraftPreparationComplete extends Error {
  override readonly name = "DraftPreparationComplete";
}

export class StaleDraftCandidateError extends Error {
  override readonly name = "StaleDraftCandidateError";
}

type DraftScopeRow = {
  id: string;
  artifact_id: string;
  task_id: string;
  epoch: number;
  server_sequence: string | number;
  current_checkpoint_id: string;
};

type ReceiptRow = {
  mutation_id: string;
  draft_id: string;
  epoch: number;
  server_sequence: string | number;
  checkpoint_id: string;
  actor_id: string;
  request_digest: string;
  update_digest: string;
  text_digest: string;
  committed_at: Date | string;
};

function sequence(value: string | number): string {
  return String(value);
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function receipt(row: ReceiptRow): DraftReceipt {
  return {
    mutationId: row.mutation_id,
    draftId: row.draft_id,
    epoch: row.epoch,
    serverSequence: sequence(row.server_sequence),
    checkpointId: row.checkpoint_id,
    actorId: row.actor_id,
    mutationDigest: row.request_digest,
    updateDigest: row.update_digest,
    textDigest: row.text_digest,
    committedAt: iso(row.committed_at),
  };
}

function stateBytes(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value);
  if (result.length === 0 || result.length > DRAFT_LIMITS.stateBytes) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return result;
}

async function loadDraftScope(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  lock = false,
): Promise<DraftScopeRow> {
  const result = await transaction.query<DraftScopeRow>(
    `select d.id,d.artifact_id,d.task_id,d.epoch,
            d.server_sequence::text as server_sequence,
            d.current_checkpoint_id
       from bakery.artifact_drafts d
       join bakery.artifacts a
         on a.organization_id=d.organization_id
        and a.id=d.artifact_id and a.task_id=d.task_id
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
      where d.organization_id=$1 and d.id=$2
        and d.status='active' and t.archived_at is null
      ${lock ? "for update of d" : ""}`,
    [organizationId, draftId],
  );
  const row = result.rows[0];
  if (!row || !row.current_checkpoint_id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return row;
}

async function loadReceipt(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  mutationId: string,
): Promise<ReceiptRow | undefined> {
  return (await transaction.query<ReceiptRow>(
    `select mutation_id,draft_id,epoch,server_sequence::text as server_sequence,
            checkpoint_id,actor_id,request_digest,update_digest,text_digest,
            committed_at
       from bakery.artifact_draft_receipts
      where organization_id=$1 and draft_id=$2 and mutation_id=$3`,
    [organizationId, draftId, mutationId],
  )).rows[0];
}

async function requestDigest(
  draftId: string,
  principalId: string,
  input: DraftEditInput,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    operation: "drafts.edit",
    draftId,
    principalId,
    ...input,
  }));
}

function assertReceiptDigest(row: ReceiptRow, digest: string): DraftReceipt {
  if (row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return receipt(row);
}

export async function prepareDraftOpen(
  transaction: PgTransactionClient,
  organizationId: string,
  artifactId: string,
): Promise<DraftRead | PreparedDraftOpen> {
  const existing = await transaction.query<{ id: string }>(
    `select d.id
       from bakery.artifact_drafts d
       join bakery.artifacts a
         on a.organization_id=d.organization_id and a.id=d.artifact_id
       join bakery.tasks t
         on t.organization_id=a.organization_id and t.id=a.task_id
      where d.organization_id=$1 and d.artifact_id=$2
        and d.status='active' and t.archived_at is null`,
    [organizationId, artifactId],
  );
  if (existing.rows[0]) {
    return await readDraft(transaction, organizationId, existing.rows[0].id);
  }
  const result = await transaction.query<{
    task_id: string;
    current_version_id: string | null;
    content: Uint8Array | null;
    media_type: string | null;
    size_bytes: number | null;
  }>(
    `select a.task_id,a.current_version_id,v.content,v.media_type,v.size_bytes
       from bakery.artifacts a
       join bakery.tasks t
         on t.organization_id=a.organization_id and t.id=a.task_id
       left join bakery.artifact_versions v
         on v.organization_id=a.organization_id
        and v.artifact_id=a.id and v.id=a.current_version_id
      where a.organization_id=$1 and a.id=$2 and t.archived_at is null`,
    [organizationId, artifactId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    row.content &&
    (row.size_bytes === null || row.size_bytes > DRAFT_LIMITS.bodyBytes ||
      !["text/plain", "text/markdown"].includes(row.media_type ?? ""))
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  let text = "";
  if (row.content) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(row.content);
    } catch {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
  }
  return {
    kind: "candidate",
    artifactId,
    taskId: row.task_id,
    baseVersionId: row.current_version_id,
    text,
  };
}

export async function commitDraftOpen(
  transaction: PgTransactionClient,
  organizationId: string,
  preparation: PreparedDraftOpen,
  candidate: DraftCandidate,
): Promise<DraftRead> {
  const artifact = await transaction.query<{
    task_id: string;
    current_version_id: string | null;
  }>(
    `select a.task_id,a.current_version_id
       from bakery.artifacts a
       join bakery.tasks t
         on t.organization_id=a.organization_id and t.id=a.task_id
      where a.organization_id=$1 and a.id=$2 and t.archived_at is null
      for update of a`,
    [organizationId, preparation.artifactId],
  );
  const row = artifact.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const existing = await transaction.query<{ id: string }>(
    `select id from bakery.artifact_drafts
      where organization_id=$1 and artifact_id=$2 and status='active'`,
    [organizationId, preparation.artifactId],
  );
  if (existing.rows[0]) {
    return await readDraft(transaction, organizationId, existing.rows[0].id);
  }
  if (
    row.task_id !== preparation.taskId ||
    row.current_version_id !== preparation.baseVersionId
  ) throw new StaleDraftCandidateError();
  if (preparation.baseVersionId) {
    await lockRetainedArtifactVersion(
      transaction,
      organizationId,
      preparation.artifactId,
      preparation.baseVersionId,
    );
  }
  const draftId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.artifact_drafts (
       id,organization_id,artifact_id,task_id,epoch,base_version_id,
       server_sequence,status
     ) values ($1,$2,$3,$4,1,$5,0,'active')`,
    [
      draftId,
      organizationId,
      preparation.artifactId,
      preparation.taskId,
      preparation.baseVersionId,
    ],
  );
  await transaction.query(
    `insert into bakery.artifact_draft_checkpoints (
       id,organization_id,draft_id,epoch,server_sequence,state,frontiers,
       text_content,text_digest
     ) values ($1,$2,$3,1,0,$4,$5,$6,$7)`,
    [
      checkpointId,
      organizationId,
      draftId,
      candidate.state,
      candidate.frontiers,
      candidate.text,
      candidate.textDigest,
    ],
  );
  await transaction.query(
    `update bakery.artifact_drafts
        set current_checkpoint_id=$3,updated_at=current_timestamp
      where organization_id=$1 and id=$2`,
    [organizationId, draftId, checkpointId],
  );
  return await readDraft(transaction, organizationId, draftId);
}

/**
 * First pass of an epoch rollover (#38): the epoch and checkpoint the caller
 * names must still be the draft's current ones, and that checkpoint must
 * already be published, so the closed epoch ends in a frozen, bounded version.
 * An exact retry of a roll that happened returns the draft instead.
 */
export async function prepareDraftRollover(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  input: { epoch: number; checkpointId: string },
): Promise<PreparedDraftRollover | DraftRead> {
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  // An exact retry of a roll that already happened (a lost response): the draft
  // is one epoch on, and its opening checkpoint carries the text of the
  // published checkpoint this call names. Answer with the draft as it is now.
  if (scope.epoch === input.epoch + 1) {
    const rolled = await transaction.query(
      `select 1
         from bakery.artifact_draft_publications p
         join bakery.artifact_draft_checkpoints closed
           on closed.organization_id=p.organization_id
          and closed.id=p.checkpoint_id and closed.epoch=$4
         join bakery.artifact_draft_checkpoints opened
           on opened.organization_id=p.organization_id
          and opened.draft_id=p.draft_id and opened.epoch=$5
          and opened.server_sequence=0
          and opened.text_digest=closed.text_digest
        where p.organization_id=$1 and p.draft_id=$2 and p.checkpoint_id=$3`,
      [organizationId, draftId, input.checkpointId, input.epoch, scope.epoch],
    );
    if (rolled.rows.length > 0) {
      return await readDraft(transaction, organizationId, draftId);
    }
  }
  if (
    scope.epoch !== input.epoch ||
    scope.current_checkpoint_id !== input.checkpointId
  ) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const published = (await transaction.query<{
    artifact_version_id: string;
    text_content: string;
    text_digest: string;
  }>(
    `select p.artifact_version_id,c.text_content,c.text_digest
       from bakery.artifact_draft_publications p
       join bakery.artifact_draft_checkpoints c
         on c.organization_id=p.organization_id and c.id=p.checkpoint_id
      where p.organization_id=$1 and p.draft_id=$2 and p.checkpoint_id=$3`,
    [organizationId, draftId, input.checkpointId],
  )).rows[0];
  if (!published) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      detail: "Publish the current checkpoint before rolling the epoch over.",
    });
  }
  return {
    kind: "candidate",
    draftId,
    epoch: scope.epoch,
    checkpointId: input.checkpointId,
    artifactId: scope.artifact_id,
    publishedVersionId: published.artifact_version_id,
    text: published.text_content,
    textDigest: published.text_digest,
  };
}

/**
 * Second pass: the new epoch begins at sequence 0 with a fresh document built
 * from the published text, so no old-epoch update can merge into it. The draft
 * lock is held, so the epoch and current checkpoint are checked again.
 */
export async function commitDraftRollover(
  transaction: PgTransactionClient,
  organizationId: string,
  preparation: PreparedDraftRollover,
  candidate: DraftCandidate,
): Promise<DraftRead> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    preparation.draftId,
    true,
  );
  if (
    scope.epoch !== preparation.epoch ||
    scope.current_checkpoint_id !== preparation.checkpointId
  ) throw new StaleDraftCandidateError();
  if (
    candidate.text !== preparation.text ||
    candidate.textDigest !== preparation.textDigest ||
    candidate.state.length === 0 ||
    candidate.state.length > DRAFT_LIMITS.stateBytes
  ) throw new StandardError({ code: "INTERNAL" });
  await lockRetainedArtifactVersion(
    transaction,
    organizationId,
    preparation.artifactId,
    preparation.publishedVersionId,
  );
  const nextEpoch = preparation.epoch + 1;
  const checkpointId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.artifact_draft_checkpoints (
       id,organization_id,draft_id,epoch,server_sequence,state,frontiers,
       text_content,text_digest
     ) values ($1,$2,$3,$4,0,$5,$6,$7,$8)`,
    [
      checkpointId,
      organizationId,
      preparation.draftId,
      nextEpoch,
      candidate.state,
      candidate.frontiers,
      candidate.text,
      candidate.textDigest,
    ],
  );
  await transaction.query(
    `update bakery.artifact_drafts
        set epoch=$3,current_checkpoint_id=$4,server_sequence=0,
            updated_at=current_timestamp
      where organization_id=$1 and id=$2`,
    [organizationId, preparation.draftId, nextEpoch, checkpointId],
  );
  return await readDraft(transaction, organizationId, preparation.draftId);
}

/** Why a guarded draft edit was refused (#71): carried as the problem reason. */
export type DraftEditRefusalReason = "text_changed" | "draft_moved_on";

/** A 412 naming why the edit cannot apply to the current draft. */
export function refusedDraftEdit(
  reason: DraftEditRefusalReason,
  cause?: unknown,
): StandardError {
  return new StandardError({
    code: "PRECONDITION_FAILED",
    params: { reason },
    cause,
  });
}

/**
 * Loads the current and source checkpoints a guarded edit is computed from.
 * A different epoch or a source checkpoint that is gone means the draft moved
 * on. Shared by drafts.edit and the suggestion actions, so a suggestion is
 * checked and applied exactly as a direct edit is.
 */
export async function prepareDraftEditStates(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  input: Pick<DraftEditInput, "epoch" | "sourceCheckpointId">,
  digest: string,
): Promise<PreparedDraftEdit> {
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  if (scope.epoch !== input.epoch) throw refusedDraftEdit("draft_moved_on");
  const checkpoints = await transaction.query<{
    id: string;
    state: Uint8Array;
  }>(
    `select id,state from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and epoch=$3
        and id=any($4::uuid[])`,
    [
      organizationId,
      draftId,
      input.epoch,
      [scope.current_checkpoint_id, input.sourceCheckpointId],
    ],
  );
  const states = new Map(checkpoints.rows.map((row) => [row.id, row.state]));
  const current = states.get(scope.current_checkpoint_id);
  const source = states.get(input.sourceCheckpointId);
  if (!current || !source) throw refusedDraftEdit("draft_moved_on");
  return {
    kind: "candidate",
    draftId,
    epoch: scope.epoch,
    highwater: sequence(scope.server_sequence),
    requestDigest: digest,
    currentState: stateBytes(current),
    sourceState: stateBytes(source),
  };
}

/** Digest binding one guarded edit to its principal, for exact retries. */
export async function draftEditDigest(
  draftId: string,
  principalId: string,
  input: DraftEditInput,
): Promise<string> {
  return await requestDigest(draftId, principalId, input);
}

export async function prepareDraftEdit(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  draftId: string,
  input: DraftEditInput,
): Promise<DraftReceipt | PreparedDraftEdit> {
  await loadDraftScope(transaction, organizationId, draftId);
  const digest = await requestDigest(draftId, principalId, input);
  const existing = await loadReceipt(
    transaction,
    organizationId,
    draftId,
    input.mutationId,
  );
  if (existing) return assertReceiptDigest(existing, digest);
  return await prepareDraftEditStates(
    transaction,
    organizationId,
    draftId,
    input,
    digest,
  );
}

/**
 * Keeps one epoch inside its retained-state cap (chapter 20: 16 MiB). Above the
 * compaction threshold the commit compacts once first; if the candidate still
 * does not fit, it is refused. One pass and one refusal, never a retry loop.
 */
async function makeRoomForCandidate(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  epoch: number,
  incomingBytes: number,
): Promise<void> {
  let retained = await measureDraftEpochBytes(
    transaction,
    organizationId,
    draftId,
    epoch,
  );
  if (retained + incomingBytes <= DRAFT_LIMITS.compactionThresholdBytes) return;
  await compactDraftEpoch(transaction, organizationId, draftId, epoch);
  retained = await measureDraftEpochBytes(
    transaction,
    organizationId,
    draftId,
    epoch,
  );
  if (retained + incomingBytes > DRAFT_LIMITS.stateBytes) {
    throw new StandardError({
      code: "STORAGE_QUOTA_EXCEEDED",
      detail: "This draft has reached its size limit for the current epoch.",
    });
  }
}

async function commitDraftCandidate(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: { mutationId: string },
  preparation: PreparedDraftEdit,
  candidate: DraftCandidate,
): Promise<DraftReceipt> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    preparation.draftId,
    true,
  );
  const existing = await loadReceipt(
    transaction,
    organizationId,
    preparation.draftId,
    input.mutationId,
  );
  if (existing) return assertReceiptDigest(existing, preparation.requestDigest);
  if (
    scope.epoch !== preparation.epoch ||
    sequence(scope.server_sequence) !== preparation.highwater
  ) throw new StaleDraftCandidateError();
  if (
    candidate.state.length === 0 ||
    candidate.state.length > DRAFT_LIMITS.stateBytes ||
    candidate.update.length === 0 ||
    candidate.update.length > DRAFT_LIMITS.updateBytes ||
    candidate.frontiers.length > DRAFT_LIMITS.updateBytes ||
    new TextEncoder().encode(candidate.text).length > DRAFT_LIMITS.bodyBytes ||
    await sha256Bytes(candidate.update) !== candidate.updateDigest ||
    await sha256Bytes(new TextEncoder().encode(candidate.text)) !==
      candidate.textDigest
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  await makeRoomForCandidate(
    transaction,
    organizationId,
    preparation.draftId,
    preparation.epoch,
    candidate.state.length + candidate.frontiers.length +
      candidate.update.length,
  );
  const nextSequence = (BigInt(preparation.highwater) + 1n).toString();
  const checkpointId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.artifact_draft_checkpoints (
       id,organization_id,draft_id,epoch,server_sequence,state,frontiers,
       text_content,text_digest
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9)`,
    [
      checkpointId,
      organizationId,
      preparation.draftId,
      preparation.epoch,
      nextSequence,
      candidate.state,
      candidate.frontiers,
      candidate.text,
      candidate.textDigest,
    ],
  );
  await transaction.query(
    `insert into bakery.artifact_draft_updates (
       id,organization_id,draft_id,epoch,server_sequence,mutation_id,actor_id,
       update_bytes,update_digest
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9)`,
    [
      updateId,
      organizationId,
      preparation.draftId,
      preparation.epoch,
      nextSequence,
      input.mutationId,
      principalId,
      candidate.update,
      candidate.updateDigest,
    ],
  );
  const saved = await transaction.query<ReceiptRow>(
    `insert into bakery.artifact_draft_receipts (
       organization_id,draft_id,mutation_id,request_digest,actor_id,epoch,
       server_sequence,checkpoint_id,update_id,update_digest,text_digest
     ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11)
     returning mutation_id,draft_id,epoch,server_sequence::text as server_sequence,
       checkpoint_id,actor_id,request_digest,update_digest,text_digest,
       committed_at`,
    [
      organizationId,
      preparation.draftId,
      input.mutationId,
      preparation.requestDigest,
      principalId,
      preparation.epoch,
      nextSequence,
      checkpointId,
      updateId,
      candidate.updateDigest,
      candidate.textDigest,
    ],
  );
  await transaction.query(
    `update bakery.artifact_drafts
        set current_checkpoint_id=$3,server_sequence=$4::bigint,
            updated_at=current_timestamp
      where organization_id=$1 and id=$2`,
    [organizationId, preparation.draftId, checkpointId, nextSequence],
  );
  return receipt(saved.rows[0]);
}

export async function commitDraftEdit(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: DraftEditInput,
  preparation: PreparedDraftEdit,
  candidate: DraftCandidate,
): Promise<DraftReceipt> {
  return await commitDraftCandidate(
    transaction,
    organizationId,
    principalId,
    input,
    preparation,
    candidate,
  );
}

/** One collaboration-socket update: the client's Loro bytes under a mutation id. */
export type DraftUpdateInput = {
  epoch: number;
  mutationId: string;
  /** SHA-256 of the client's update bytes, binding replays to identical bytes. */
  clientUpdateDigest: string;
};

/**
 * Loads the committed state for a socket update, or replays its exact receipt.
 * The same mutation id with different bytes is IDEMPOTENCY_PAYLOAD_MISMATCH;
 * a different epoch is PRECONDITION_FAILED (the client must resynchronize).
 */
export async function prepareDraftUpdate(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  draftId: string,
  input: DraftUpdateInput,
): Promise<DraftReceipt | PreparedDraftEdit> {
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  const digest = await sha256Hex(canonicalJson({
    operation: "drafts.update",
    draftId,
    principalId,
    ...input,
  }));
  const existing = await loadReceipt(
    transaction,
    organizationId,
    draftId,
    input.mutationId,
  );
  if (existing) return assertReceiptDigest(existing, digest);
  if (scope.epoch !== input.epoch) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const current = (await transaction.query<{ state: Uint8Array }>(
    `select state from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and id=$3`,
    [organizationId, draftId, scope.current_checkpoint_id],
  )).rows[0];
  if (!current) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const state = stateBytes(current.state);
  return {
    kind: "candidate",
    draftId,
    epoch: scope.epoch,
    highwater: sequence(scope.server_sequence),
    requestDigest: digest,
    currentState: state,
    sourceState: state,
  };
}

/** Commits a socket update; same locking, highwater check and receipt as an edit. */
export async function commitDraftUpdate(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: DraftUpdateInput,
  preparation: PreparedDraftEdit,
  candidate: DraftCandidate,
): Promise<DraftReceipt> {
  return await commitDraftCandidate(
    transaction,
    organizationId,
    principalId,
    input,
    preparation,
    candidate,
  );
}

/** Committed state of a draft for a collaboration sync. */
export async function readDraftState(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
): Promise<{
  epoch: number;
  serverSequence: string;
  checkpointId: string;
  state: Uint8Array;
}> {
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  const row = (await transaction.query<{ state: Uint8Array }>(
    `select state from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and id=$3`,
    [organizationId, draftId, scope.current_checkpoint_id],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    epoch: scope.epoch,
    serverSequence: sequence(scope.server_sequence),
    checkpointId: scope.current_checkpoint_id,
    state: stateBytes(row.state),
  };
}

export async function readDraft(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
): Promise<DraftRead> {
  const result = await transaction.query<{
    id: string;
    artifact_id: string;
    task_id: string;
    epoch: number;
    server_sequence: string | number;
    checkpoint_id: string;
    text_digest: string;
    text_content: string;
  }>(
    `select d.id,d.artifact_id,d.task_id,d.epoch,
            d.server_sequence::text as server_sequence,
            c.id as checkpoint_id,c.text_digest,c.text_content
       from bakery.artifact_drafts d
       join bakery.artifacts a
         on a.organization_id=d.organization_id
        and a.id=d.artifact_id and a.task_id=d.task_id
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
       join bakery.artifact_draft_checkpoints c
         on c.organization_id=d.organization_id
        and c.id=d.current_checkpoint_id and c.draft_id=d.id
      where d.organization_id=$1 and d.id=$2
        and d.status='active' and t.archived_at is null`,
    [organizationId, draftId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const receipts = await transaction.query<ReceiptRow>(
    `select mutation_id,draft_id,epoch,server_sequence::text as server_sequence,
            checkpoint_id,actor_id,request_digest,update_digest,text_digest,
            committed_at
       from bakery.artifact_draft_receipts
      where organization_id=$1 and draft_id=$2 and epoch=$3
      order by server_sequence asc limit 100`,
    [organizationId, draftId, row.epoch],
  );
  return {
    id: row.id,
    artifactId: row.artifact_id,
    taskId: row.task_id,
    epoch: row.epoch,
    serverSequence: sequence(row.server_sequence),
    checkpointId: row.checkpoint_id,
    textDigest: row.text_digest,
    text: row.text_content,
    receipts: receipts.rows.map(receipt),
  };
}

export async function readDraftCheckpoint(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
): Promise<{
  draftId: string;
  epoch: number;
  checkpointId: string;
  serverSequence: string;
  textDigest: string;
  text: string;
}> {
  await loadDraftScope(transaction, organizationId, draftId);
  const result = await transaction.query<{
    epoch: number;
    server_sequence: string | number;
    text_digest: string;
    text_content: string;
  }>(
    `select epoch,server_sequence::text as server_sequence,text_digest,text_content
       from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and id=$3`,
    [organizationId, draftId, checkpointId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    draftId,
    epoch: row.epoch,
    checkpointId,
    serverSequence: sequence(row.server_sequence),
    textDigest: row.text_digest,
    text: row.text_content,
  };
}

export async function prepareDraftSlice(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
): Promise<PreparedDraftSlice> {
  await loadDraftScope(transaction, organizationId, draftId);
  const result = await transaction.query<{
    epoch: number;
    server_sequence: string | number;
    state: Uint8Array;
  }>(
    `select epoch,server_sequence::text as server_sequence,state
       from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and id=$3`,
    [organizationId, draftId, checkpointId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    draftId,
    epoch: row.epoch,
    checkpointId,
    serverSequence: sequence(row.server_sequence),
    state: stateBytes(row.state),
  };
}
