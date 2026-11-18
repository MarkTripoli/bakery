import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import {
  type CommentAnchor,
  markdownBlocks,
  validateAnchor,
} from "./comments/anchors.ts";
import type {
  DraftAnchorCandidateInput,
  DraftAnchorPosition,
} from "./drafts.ts";

/**
 * Projecting draft threads onto a published version (#28, chapter 20
 * "Comments on a moving document"): a publication may name open draft roots;
 * each becomes a version-pinned artifact comment, with its retained replies,
 * in the same transaction as the version. The anchor is resolved against the
 * frozen cutoff checkpoint, never the live draft, and converted to the
 * published-comment anchor shape. The draft thread is left as it was, and a
 * mapping row records the provenance.
 */

/** Threads one publication may project. */
export const PROJECTED_THREADS_LIMIT = 50;

/** Named roots and the anchors the isolated worker resolves at the cutoff. */
export type PreparedThreadProjection = {
  draftId: string;
  checkpointId: string;
  state: Uint8Array;
  rootIds: string[];
  anchors: DraftAnchorCandidateInput[];
};

/** A prepared projection with every anchor resolved at the cutoff. */
export type ResolvedThreadProjection = PreparedThreadProjection & {
  positions: readonly DraftAnchorPosition[];
};

function refusedProjection(
  code: "PRECONDITION_FAILED" | "STATE_CONFLICT",
  reason: string,
): StandardError {
  return new StandardError({ code, params: { reason } });
}

/**
 * Loads the named roots and the frozen checkpoint they are resolved against.
 * A thread that is unknown, a reply, deleted or resolved is refused by name;
 * a root from another epoch is outdated at the cutoff, since its cursors name
 * another history.
 */
export async function prepareThreadProjection(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
  rootIds: readonly string[],
): Promise<PreparedThreadProjection> {
  if (
    rootIds.length > PROJECTED_THREADS_LIMIT ||
    new Set(rootIds).size !== rootIds.length
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  const checkpoint = (await transaction.query<{
    epoch: number;
    state: Uint8Array;
  }>(
    `select epoch,state from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2 and id=$3`,
    [organizationId, draftId, checkpointId],
  )).rows[0];
  if (!checkpoint) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const rows = (await transaction.query<{
    id: string;
    parent_comment_id: string | null;
    epoch: number;
    status: string | null;
    deleted_at: Date | null;
    start_cursor: string | null;
    end_cursor: string | null;
    quote: string | null;
  }>(
    `select id,parent_comment_id,epoch,status,deleted_at,start_cursor,
            end_cursor,quote
       from bakery.artifact_draft_comments
      where organization_id=$1 and draft_id=$2 and id=any($3::uuid[])`,
    [organizationId, draftId, [...rootIds]],
  )).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const anchors = rootIds.map((id): DraftAnchorCandidateInput => {
    const row = byId.get(id);
    if (!row || row.parent_comment_id !== null) {
      throw refusedProjection("STATE_CONFLICT", "projected_thread_not_found");
    }
    // Open and retained is decided only under the root lock in
    // projectDraftThreads: a check here, without a lock and before the
    // publication locks the draft, could pass for a root resolved or deleted
    // before the copy.
    if (
      row.epoch !== checkpoint.epoch || row.start_cursor === null ||
      row.end_cursor === null || row.quote === null
    ) {
      throw refusedProjection(
        "PRECONDITION_FAILED",
        "projected_thread_outdated",
      );
    }
    return {
      startCursor: row.start_cursor,
      endCursor: row.end_cursor,
      quote: row.quote,
    };
  });
  return {
    draftId,
    checkpointId,
    state: checkpoint.state,
    rootIds: [...rootIds],
    anchors,
  };
}

/**
 * The published-comment anchor for one resolved range of the frozen text: a
 * markdown block selection when the range lies inside one block of a
 * markdown version and fits its bounds, otherwise the text lines it covers.
 */
export function publishedAnchor(
  text: string,
  mediaType: string,
  start: number,
  end: number,
): CommentAnchor {
  if (mediaType.startsWith("text/markdown")) {
    const blocks = markdownBlocks(text);
    let from = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const at = text.indexOf(blocks[index], from);
      if (at < 0) break;
      from = at + blocks[index].length;
      if (start < at || end > from) continue;
      const parsed = contractSchemas.CommentAnchor.safeParse({
        kind: "markdown",
        blockIndex: index,
        blockText: blocks[index],
        start: start - at,
        end: end - at,
        selectedText: text.slice(start, end),
        previousBlock: blocks[index - 1] ?? null,
        nextBlock: blocks[index + 1] ?? null,
      });
      if (parsed.success) return parsed.data;
      break;
    }
  }
  const lines = text.split("\n");
  const startLine = text.slice(0, start).split("\n").length;
  const endLine = text.slice(0, end - 1).split("\n").length;
  const parsed = contractSchemas.CommentAnchor.safeParse({
    kind: "text",
    startLine,
    endLine,
    quote: lines.slice(startLine - 1, endLine).join("\n"),
  });
  if (!parsed.success) {
    throw refusedProjection("STATE_CONFLICT", "projected_thread_too_large");
  }
  return parsed.data;
}

type ThreadComment = {
  id: string;
  parent_comment_id: string | null;
  author_id: string;
  body: string;
};

/**
 * Copies every resolved thread onto the new version and records the mapping.
 * An anchor outdated at the cutoff refuses the whole publication: the caller
 * runs this inside the version transaction, so nothing is written.
 */
export async function projectDraftThreads(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    projection: ResolvedThreadProjection;
    version: {
      id: string;
      artifactId: string;
      content: Uint8Array;
      mediaType: string;
      sha256: string;
    };
    scope: {
      applicationId: string;
      repositoryId: string | null;
      taskId: string;
      conversationId: string | null;
    };
    traceId: string;
  },
): Promise<void> {
  const { organizationId, projection, version } = input;
  if (projection.positions.length !== projection.rootIds.length) {
    throw new Error("DRAFT_PROJECTION_POSITIONS_INVALID");
  }
  // The caller holds the draft lock. Lock each named root in id order (the
  // draft-then-comment order comment updates take) and decide here, so a
  // resolve or delete that committed after preparation refuses the publish.
  for (const rootId of [...projection.rootIds].sort()) {
    const root = (await transaction.query<{
      parent_comment_id: string | null;
      status: string | null;
      deleted_at: Date | null;
    }>(
      `select parent_comment_id,status,deleted_at
         from bakery.artifact_draft_comments
        where organization_id=$1 and draft_id=$2 and id=$3 for update`,
      [organizationId, projection.draftId, rootId],
    )).rows[0];
    if (!root || root.parent_comment_id !== null) {
      throw refusedProjection("STATE_CONFLICT", "projected_thread_not_found");
    }
    if (root.deleted_at !== null || root.status !== "open") {
      throw refusedProjection("STATE_CONFLICT", "projected_thread_not_open");
    }
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    version.content,
  );
  const anchors = projection.positions.map((position) => {
    if (position === null) {
      throw refusedProjection(
        "PRECONDITION_FAILED",
        "projected_thread_outdated",
      );
    }
    const anchor = publishedAnchor(
      text,
      version.mediaType,
      position[0],
      position[1],
    );
    validateAnchor(anchor, {
      id: version.id,
      content: version.content,
      media_type: version.mediaType,
      sha256: version.sha256,
      subject_head_sha: null,
      subject_base_sha: null,
    });
    return anchor;
  });
  for (const [index, rootId] of projection.rootIds.entries()) {
    const thread = (await transaction.query<ThreadComment>(
      `select id,parent_comment_id,author_id,body
         from bakery.artifact_draft_comments
        where organization_id=$1 and draft_id=$2
          and deleted_at is null
          and ((id=$3 and status='open') or parent_comment_id=$3)
        order by parent_comment_id nulls first, created_at, id`,
      [organizationId, projection.draftId, rootId],
    )).rows;
    let publishedRoot: string | undefined;
    for (const comment of thread) {
      const root = comment.parent_comment_id === null;
      const inserted = (await transaction.query<{ id: string }>(
        `insert into bakery.artifact_comments
           (organization_id,artifact_version_id,parent_comment_id,author_id,
            body,anchor,status)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          organizationId,
          version.id,
          root ? null : publishedRoot,
          comment.author_id,
          comment.body,
          root ? anchors[index] : null,
          root ? "open" : null,
        ],
      )).rows[0]?.id;
      if (!inserted) throw new Error("DRAFT_PROJECTION_INSERT_FAILED");
      if (root) publishedRoot = inserted;
      await transaction.query(
        `insert into bakery.artifact_draft_comment_publications (
           organization_id,draft_id,draft_comment_id,artifact_version_id,
           artifact_comment_id,source_checkpoint_id
         ) values ($1,$2,$3,$4,$5,$6)`,
        [
          organizationId,
          projection.draftId,
          comment.id,
          version.id,
          inserted,
          projection.checkpointId,
        ],
      );
      await appendDomainEvent(transaction, {
        organizationId,
        applicationId: input.scope.applicationId,
        repositoryId: input.scope.repositoryId,
        conversationId: input.scope.conversationId,
        taskId: input.scope.taskId,
        eventType: "artifact.comment_created",
        aggregateId: inserted,
        aggregateVersion: 1,
        payload: {
          resourceId: inserted,
          resourceVersion: 1,
          artifactId: version.artifactId,
          artifactVersionId: version.id,
          rootId: publishedRoot ?? inserted,
          rootVersion: 1,
        },
        traceId: input.traceId,
      });
    }
    if (publishedRoot === undefined) {
      throw new Error("DRAFT_PROJECTION_ROOT_MISSING");
    }
  }
}
