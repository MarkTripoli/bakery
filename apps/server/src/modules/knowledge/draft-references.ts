import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { ActionAttribution } from "../auth/application/action-attribution.ts";
import { sha256Bytes } from "./bytes.ts";
import { freezeTextDraftCheckpoint } from "./draft-publication.ts";
import { refusedDraftEdit } from "./draft-persistence.ts";

/**
 * Frozen references a draft is sent to an agent with (#28, chapter 20 "Send
 * draft to agent freezes a bounded artifact revision"). A reference names one
 * exact committed checkpoint (epoch, server sequence, content digest) and the
 * exact roots and retained replies chosen with it, captured under CAS against
 * each root's version and inside the comment-context bounds conversation
 * sends already use. It is insert only: editing the draft or a comment, or
 * resolving it, never changes what was captured. Turn and workflow admission
 * may consume a reference later; nothing here admits or runs anything.
 */

export type DraftReferenceCreateInput = z.output<
  typeof contractSchemas.DraftReferenceCreate
>;
export type DraftReferenceRead = z.output<
  typeof contractSchemas.DraftReference
>;

/**
 * The comment-context bounds of a send to an agent (comments/context.ts): at
 * most 100 roots, at most 200 retained replies per root, and 32 KiB of
 * captured comment JSON. Over a bound is refused, never truncated.
 */
export const DRAFT_REFERENCE_LIMITS = Object.freeze({
  threads: 100,
  repliesPerThread: 200,
  contextBytes: 32_768,
});

type ReferenceRow = {
  id: string;
  draft_id: string;
  epoch: number;
  checkpoint_id: string;
  server_sequence: string;
  content_digest: string;
  created_by: string;
  actor_kind: string;
  request_digest: string;
  created_at: Date;
};

type CapturedRow = {
  draft_comment_id: string;
  parent_comment_id: string | null;
  row_version: number;
  author_id: string;
  actor_kind: string;
  body: string;
  body_digest: string;
  start_cursor: string | null;
  end_cursor: string | null;
  coordinate_encoding: string | null;
  quote: string | null;
  status: string | null;
  comment_created_at: Date;
};

type LiveComment = {
  id: string;
  parent_comment_id: string | null;
  row_version: number;
  author_id: string;
  actor_kind: string;
  body: string;
  start_cursor: string | null;
  end_cursor: string | null;
  coordinate_encoding: string | null;
  quote: string | null;
  status: string | null;
  deleted_at: Date | null;
  created_at: Date;
};

const LIVE_COLUMNS = `id,parent_comment_id,row_version,author_id,actor_kind,
  body,start_cursor,end_cursor,coordinate_encoding,quote,status,deleted_at,
  created_at`;

function refused(
  code: "PRECONDITION_FAILED" | "STATE_CONFLICT",
  reason: string,
): StandardError {
  return new StandardError({ code, params: { reason } });
}

function toCaptured(row: CapturedRow) {
  const root = row.parent_comment_id === null;
  return {
    commentId: row.draft_comment_id,
    ...(root ? {} : { parentId: row.parent_comment_id! }),
    version: row.row_version,
    authorId: row.author_id,
    actorKind: row.actor_kind === "agent" ? "agent" : "person",
    body: row.body,
    bodyDigest: row.body_digest,
    ...(root && row.start_cursor !== null
      ? { startCursor: row.start_cursor }
      : {}),
    ...(root && row.end_cursor !== null ? { endCursor: row.end_cursor } : {}),
    ...(root && row.coordinate_encoding !== null
      ? { coordinateEncoding: row.coordinate_encoding }
      : {}),
    ...(root && row.quote !== null ? { quote: row.quote } : {}),
    ...(root
      ? { status: row.status === "resolved" ? "resolved" : "open" }
      : {}),
    createdAt: row.comment_created_at.toISOString(),
  };
}

async function readReferenceRow(
  transaction: PgTransactionClient,
  organizationId: string,
  where: { id: string } | { draftId: string; mutationId: string },
): Promise<ReferenceRow | undefined> {
  const byId = "id" in where;
  return (await transaction.query<ReferenceRow>(
    `select id,draft_id,epoch,checkpoint_id,server_sequence::text as
            server_sequence,content_digest,created_by,actor_kind,
            request_digest,created_at
       from bakery.artifact_draft_references
      where organization_id=$1 and ${
      byId ? "id=$2" : "draft_id=$2 and client_mutation_id=$3"
    }`,
    byId
      ? [organizationId, where.id]
      : [organizationId, where.draftId, where.mutationId],
  )).rows[0];
}

async function present(
  transaction: PgTransactionClient,
  organizationId: string,
  row: ReferenceRow,
): Promise<DraftReferenceRead> {
  const comments = (await transaction.query<CapturedRow>(
    `select draft_comment_id,parent_comment_id,row_version,author_id,
            actor_kind,body,body_digest,start_cursor,end_cursor,
            coordinate_encoding,quote,status,comment_created_at
       from bakery.artifact_draft_reference_comments
      where organization_id=$1 and reference_id=$2
      order by position`,
    [organizationId, row.id],
  )).rows;
  return contractSchemas.DraftReference.parse({
    id: row.id,
    draftId: row.draft_id,
    epoch: row.epoch,
    checkpointId: row.checkpoint_id,
    serverSequence: String(row.server_sequence),
    textDigest: row.content_digest,
    createdById: row.created_by,
    actorKind: row.actor_kind === "agent" ? "agent" : "person",
    createdAt: row.created_at.toISOString(),
    comments: comments.map(toCaptured),
  });
}

async function replay(
  transaction: PgTransactionClient,
  organizationId: string,
  row: ReferenceRow,
  digest: string,
): Promise<DraftReferenceRead> {
  if (row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return await present(transaction, organizationId, row);
}

/** Reads one reference of the caller's organization; others are not found. */
export async function readDraftReference(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
): Promise<DraftReferenceRead> {
  const row = await readReferenceRow(transaction, organizationId, { id });
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return await present(transaction, organizationId, row);
}

/**
 * Records one frozen reference. The draft row is locked first and then each
 * named root in identifier order (the order every reply write takes them),
 * so a reply racing the capture either lands before it, moving the root's
 * version and failing the CAS, or waits until it commits.
 */
export async function createDraftReference(
  transaction: PgTransactionClient,
  organizationId: string,
  command: {
    draftId: string;
    attribution: ActionAttribution;
    requestId: string;
    traceId: string;
    create: DraftReferenceCreateInput;
  },
): Promise<DraftReferenceRead> {
  const { draftId, attribution, create } = command;
  const ids = create.threads.map((thread) => thread.commentId.toLowerCase());
  if (
    ids.length > DRAFT_REFERENCE_LIMITS.threads ||
    new Set(ids).size !== ids.length
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  const digest = await sha256Hex(canonicalJson({
    operation: "draftReferences.create",
    draftId,
    principalId: attribution.principalId,
    expectedEpoch: create.expectedEpoch,
    checkpointId: create.checkpointId,
    textDigest: create.textDigest,
    threads: create.threads.map((thread, index) => ({
      commentId: ids[index],
      expectedVersion: thread.expectedVersion,
    })),
    mutationId: create.mutationId,
  }));
  const draft = (await transaction.query<{ epoch: number }>(
    `select d.epoch from bakery.artifact_drafts d
       join bakery.tasks t
         on t.organization_id=d.organization_id and t.id=d.task_id
      where d.organization_id=$1 and d.id=$2
        and d.status='active' and t.archived_at is null
      for update of d`,
    [organizationId, draftId],
  )).rows[0];
  if (!draft) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const recorded = await readReferenceRow(transaction, organizationId, {
    draftId,
    mutationId: create.mutationId,
  });
  if (recorded) {
    return await replay(transaction, organizationId, recorded, digest);
  }
  if (draft.epoch !== create.expectedEpoch) {
    throw refusedDraftEdit("draft_moved_on");
  }
  // The same freeze a publication runs: the exact committed checkpoint whose
  // stored text has the previewed digest.
  const frozen = await freezeTextDraftCheckpoint(
    transaction,
    organizationId,
    draftId,
    create.checkpointId,
    create.textDigest,
  );
  if (frozen.epoch !== create.expectedEpoch) {
    throw refusedDraftEdit("draft_moved_on");
  }
  const roots = new Map<string, LiveComment>();
  for (const id of [...ids].sort()) {
    const row = (await transaction.query<LiveComment>(
      `select ${LIVE_COLUMNS} from bakery.artifact_draft_comments
        where organization_id=$1 and draft_id=$2 and id=$3 for update`,
      [organizationId, draftId, id],
    )).rows[0];
    if (!row || row.parent_comment_id !== null) {
      throw refused("STATE_CONFLICT", "reference_thread_not_found");
    }
    if (row.deleted_at !== null) {
      throw refused("STATE_CONFLICT", "reference_thread_deleted");
    }
    roots.set(id, row);
  }
  const captured: LiveComment[] = [];
  let contextBytes = 0;
  const encoder = new TextEncoder();
  for (const [index, thread] of create.threads.entries()) {
    const root = roots.get(ids[index])!;
    if (root.row_version !== thread.expectedVersion) {
      throw refused("PRECONDITION_FAILED", "thread_version_changed");
    }
    const replies = (await transaction.query<LiveComment>(
      `select ${LIVE_COLUMNS} from bakery.artifact_draft_comments
        where organization_id=$1 and draft_id=$2 and parent_comment_id=$3
          and deleted_at is null
        order by created_at,id limit $4`,
      [
        organizationId,
        draftId,
        root.id,
        DRAFT_REFERENCE_LIMITS.repliesPerThread + 1,
      ],
    )).rows;
    if (replies.length > DRAFT_REFERENCE_LIMITS.repliesPerThread) {
      throw new StandardError({
        code: "BODY_TOO_LARGE",
        params: { limit: DRAFT_REFERENCE_LIMITS.contextBytes },
      });
    }
    for (const comment of [root, ...replies]) {
      contextBytes += encoder.encode(JSON.stringify({
        commentId: comment.id,
        body: comment.body,
        quote: comment.quote,
        startCursor: comment.start_cursor,
        endCursor: comment.end_cursor,
      })).byteLength;
      if (contextBytes > DRAFT_REFERENCE_LIMITS.contextBytes) {
        throw new StandardError({
          code: "BODY_TOO_LARGE",
          params: { limit: DRAFT_REFERENCE_LIMITS.contextBytes },
        });
      }
      captured.push(comment);
    }
  }
  const id = (await transaction.query<{ id: string }>(
    `insert into bakery.artifact_draft_references (
       organization_id,draft_id,epoch,checkpoint_id,server_sequence,
       content_digest,created_by,actor_kind,access_token_id,
       client_mutation_id,request_digest,request_id,trace_id
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (organization_id, draft_id, client_mutation_id) do nothing
     returning id`,
    [
      organizationId,
      draftId,
      frozen.epoch,
      frozen.checkpointId,
      frozen.serverSequence,
      frozen.contentDigest,
      attribution.principalId,
      attribution.actorKind,
      attribution.accessTokenId,
      create.mutationId,
      digest,
      command.requestId,
      command.traceId,
    ],
  )).rows[0]?.id;
  if (!id) {
    const raced = await readReferenceRow(transaction, organizationId, {
      draftId,
      mutationId: create.mutationId,
    });
    if (!raced) throw new StandardError({ code: "STATE_CONFLICT" });
    return await replay(transaction, organizationId, raced, digest);
  }
  for (const [position, comment] of captured.entries()) {
    const root = comment.parent_comment_id === null;
    await transaction.query(
      `insert into bakery.artifact_draft_reference_comments (
         organization_id,reference_id,position,draft_comment_id,
         parent_comment_id,row_version,author_id,actor_kind,body,body_digest,
         start_cursor,end_cursor,coordinate_encoding,quote,status,
         comment_created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        organizationId,
        id,
        position,
        comment.id,
        comment.parent_comment_id,
        comment.row_version,
        comment.author_id,
        comment.actor_kind,
        comment.body,
        await sha256Bytes(encoder.encode(comment.body)),
        root ? comment.start_cursor : null,
        root ? comment.end_cursor : null,
        root ? comment.coordinate_encoding : null,
        root ? comment.quote : null,
        root ? comment.status : null,
        comment.created_at,
      ],
    );
  }
  await appendAudit(transaction, {
    organizationId,
    principalId: attribution.principalId,
    operation: "draftReferences.create",
    resourceType: "artifact_draft_reference",
    resourceId: id,
    requestId: command.requestId,
    traceId: command.traceId,
    details: {
      draftId,
      checkpointId: frozen.checkpointId,
      threads: ids.length,
      comments: captured.length,
    },
  });
  return await readDraftReference(transaction, organizationId, id);
}
