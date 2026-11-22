import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import type { ActionAttribution } from "../auth/application/action-attribution.ts";
import {
  refusedDraftEdit,
  StaleDraftCandidateError,
} from "./draft-persistence.ts";
import {
  type DraftAnchorCandidateInput,
  type DraftAnchorPosition,
  hasUnpairedSurrogate,
} from "./drafts.ts";
import { validateCommentBody } from "./comments/store.ts";

/**
 * Draft discussion threads (#28, chapter 20 "Comments on a moving document").
 * A root is anchored by two relative Loro cursors and the quoted text; every
 * read resolves them against the current draft. Bodies and resolution live
 * only in Postgres, so an ordinary document edit cannot touch them. The
 * moderation, flat-reply and row_version rules are those of artifact comments.
 */

export type DraftCommentCreateInput = z.output<
  typeof contractSchemas.DraftCommentCreate
>;
export type DraftCommentUpdateInput = z.output<
  typeof contractSchemas.DraftCommentUpdate
>;
export type DraftCommentQueryInput = z.output<
  typeof contractSchemas.DraftCommentQuery
>;
export type DraftCommentRead = z.output<typeof contractSchemas.DraftComment>;

/** Cursor encoding and offset unit every anchor is created with. */
export const DRAFT_COMMENT_COORDINATE_ENCODING = "loro-1.16-cursor-utf16";

const ORDERING = "createdAt:asc,id:asc";
const TIMESTAMP_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

type CommentRow = {
  id: string;
  draft_id: string;
  epoch: number;
  parent_comment_id: string | null;
  author_id: string;
  author_name: string;
  actor_kind: string;
  agent_name: string | null;
  body: string;
  start_cursor: string | null;
  end_cursor: string | null;
  coordinate_encoding: string | null;
  quote: string | null;
  creation_checkpoint_id: string;
  request_digest: string;
  status: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  cursor_created_at: string;
  published_as: {
    artifactVersionId: string;
    artifactCommentId: string;
    sourceCheckpointId: string;
  }[];
};

const COLUMNS = `c.id,c.draft_id,c.epoch,c.parent_comment_id,c.author_id,
  author.display_name as author_name,c.actor_kind,token.name as agent_name,
  c.body,c.start_cursor,c.end_cursor,c.coordinate_encoding,c.quote,
  c.creation_checkpoint_id,c.request_digest,c.status,c.resolved_by,
  c.resolved_at,c.deleted_at,c.deleted_by,c.row_version,c.created_at,
  c.updated_at,
  to_char(c.created_at at time zone 'UTC', '${TIMESTAMP_SQL}')
    as cursor_created_at,
  coalesce((select json_agg(json_build_object(
      'artifactVersionId', m.artifact_version_id,
      'artifactCommentId', m.artifact_comment_id,
      'sourceCheckpointId', m.source_checkpoint_id)
      order by m.created_at, m.id)
    from bakery.artifact_draft_comment_publications m
    where m.organization_id = c.organization_id
      and m.draft_comment_id = c.id), '[]'::json) as published_as`;
const FROM = `from bakery.artifact_draft_comments c
  join bakery.principals author on author.id = c.author_id
  left join bakery.access_tokens token
    on token.organization_id = c.organization_id and token.id = c.access_token_id`;

/** How a read answers for a root's anchor. */
type AnchorAnswer =
  | { state: "current"; start: number; end: number }
  | { state: "outdated" }
  | null;

function anchorAnswer(position: DraftAnchorPosition): AnchorAnswer {
  return position === null
    ? { state: "outdated" }
    : { state: "current", start: position[0], end: position[1] };
}

function toComment(row: CommentRow, anchor: AnchorAnswer): DraftCommentRead {
  const deleted = row.deleted_at !== null;
  const root = row.parent_comment_id === null;
  return contractSchemas.DraftComment.parse({
    id: row.id,
    draftId: row.draft_id,
    rootId: row.parent_comment_id,
    epoch: row.epoch,
    authorId: row.author_id,
    authorName: row.author_name,
    actorKind: row.actor_kind === "agent" ? "agent" : "person",
    agentName: row.agent_name,
    body: deleted ? null : row.body,
    startCursor: root ? row.start_cursor : null,
    endCursor: root ? row.end_cursor : null,
    coordinateEncoding: root ? row.coordinate_encoding : null,
    quote: root && !deleted ? row.quote : null,
    creationCheckpointId: row.creation_checkpoint_id,
    anchorState: root && anchor ? anchor.state : null,
    startUtf16: root && anchor?.state === "current" ? anchor.start : null,
    endUtf16: root && anchor?.state === "current" ? anchor.end : null,
    status: root ? (row.status === "resolved" ? "resolved" : "open") : null,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    version: row.row_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAs: row.published_as,
  });
}

function storedAnchor(row: CommentRow): DraftAnchorCandidateInput | null {
  if (
    row.parent_comment_id !== null || row.start_cursor === null ||
    row.end_cursor === null || row.quote === null
  ) return null;
  return {
    startCursor: row.start_cursor,
    endCursor: row.end_cursor,
    quote: row.quote,
  };
}

type DraftScope = {
  epoch: number;
  server_sequence: string | number;
  current_checkpoint_id: string;
  artifact_id: string;
  task_id: string;
  application_id: string | null;
  repository_id: string | null;
  conversation_id: string | null;
};

async function loadDraftScope(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  lock = false,
): Promise<DraftScope> {
  const row = (await transaction.query<DraftScope>(
    `select draft.epoch,draft.server_sequence,draft.current_checkpoint_id,
       draft.artifact_id,draft.task_id,task.application_id,task.repository_id,
       task.conversation_id
     from bakery.artifact_drafts draft
     join bakery.tasks task
       on task.organization_id = draft.organization_id
       and task.id = draft.task_id
     where draft.organization_id = $1 and draft.id = $2
       and draft.status = 'active' and task.archived_at is null${
      lock ? " for update of draft" : ""
    }`,
    [organizationId, draftId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function currentState(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  checkpointId: string,
): Promise<Uint8Array> {
  const row = (await transaction.query<{ state: Uint8Array }>(
    `select state from bakery.artifact_draft_checkpoints
      where organization_id = $1 and draft_id = $2 and id = $3`,
    [organizationId, draftId, checkpointId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  return row.state;
}

async function findRow(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  where: "mutation" | "id",
  value: string,
  lock = false,
): Promise<CommentRow | undefined> {
  const column = where === "mutation" ? "c.client_mutation_id" : "c.id";
  return (await transaction.query<CommentRow>(
    `select ${COLUMNS} ${FROM}
      where c.organization_id = $1 and c.draft_id = $2 and ${column} = $3${
      lock ? " for update of c" : ""
    }`,
    [organizationId, draftId, value],
  )).rows[0];
}

async function requireRow(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  id: string,
  lock = false,
): Promise<CommentRow> {
  const row = await findRow(
    transaction,
    organizationId,
    draftId,
    "id",
    id,
    lock,
  );
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function createDigest(
  draftId: string,
  principalId: string,
  input: DraftCommentCreateInput,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    operation: "draftComments.create",
    draftId,
    principalId,
    body: input.body,
    rootId: input.rootId ?? null,
    epoch: input.epoch ?? null,
    startCursor: input.startCursor ?? null,
    endCursor: input.endCursor ?? null,
    quote: input.quote ?? null,
    mutationId: input.mutationId,
  }));
}

function replay(row: CommentRow, digest: string): DraftCommentRead {
  if (row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return toComment(row, null);
}

/** A root anchor the isolated worker must verify before it is recorded. */
export type PreparedDraftCommentRoot = {
  draftId: string;
  epoch: number;
  highwater: string;
  checkpointId: string;
  state: Uint8Array;
  anchor: DraftAnchorCandidateInput;
  requestDigest: string;
};

type CommandInput = {
  draftId: string;
  attribution: ActionAttribution;
  requestId: string;
  traceId: string;
  /** The session that made the call when an agent did (O50), else null. */
  agentSessionId?: string | null;
  create: DraftCommentCreateInput;
};

async function recordChange(
  transaction: PgTransactionClient,
  organizationId: string,
  scope: DraftScope,
  change: {
    row: CommentRow;
    rootVersion: number;
    created: boolean;
    principalId: string;
    requestId: string;
    traceId: string;
    agentSessionId?: string | null;
  },
): Promise<void> {
  const { row } = change;
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: scope.task_id,
    conversationId: scope.conversation_id,
    eventType: change.created
      ? "draft.comment_created"
      : "draft.comment_updated",
    aggregateId: row.id,
    aggregateVersion: row.row_version,
    payload: { resourceId: row.id, resourceVersion: row.row_version },
    traceId: change.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: change.principalId,
    operation: change.created ? "draftComments.create" : "draftComments.update",
    resourceType: "artifact_draft_comment",
    resourceId: row.id,
    requestId: change.requestId,
    traceId: change.traceId,
    agentSessionId: change.agentSessionId ?? null,
    details: {
      draftId: row.draft_id,
      rootId: row.parent_comment_id ?? row.id,
      rootVersion: change.rootVersion,
    },
  });
}

async function insertComment(
  transaction: PgTransactionClient,
  organizationId: string,
  input: CommandInput,
  values: {
    epoch: number;
    rootId: string | null;
    checkpointId: string;
    anchor: DraftAnchorCandidateInput | null;
    requestDigest: string;
  },
): Promise<string | undefined> {
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.artifact_draft_comments (
       organization_id,draft_id,epoch,parent_comment_id,author_id,actor_kind,
       access_token_id,body,start_cursor,end_cursor,coordinate_encoding,quote,
       creation_checkpoint_id,client_mutation_id,request_digest,request_id,
       trace_id,status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (organization_id, draft_id, client_mutation_id) do nothing
     returning id`,
    [
      organizationId,
      input.draftId,
      values.epoch,
      values.rootId,
      input.attribution.principalId,
      input.attribution.actorKind,
      input.attribution.accessTokenId,
      input.create.body,
      values.anchor?.startCursor ?? null,
      values.anchor?.endCursor ?? null,
      values.anchor ? DRAFT_COMMENT_COORDINATE_ENCODING : null,
      values.anchor?.quote ?? null,
      values.checkpointId,
      input.create.mutationId,
      values.requestDigest,
      input.requestId,
      input.traceId,
      values.rootId === null ? "open" : null,
    ],
  );
  return inserted.rows[0]?.id;
}

/**
 * First pass of `draftComments.create`. An exact retry answers with the
 * recorded comment. A reply is recorded at once: it carries no anchor. A root
 * returns what the isolated worker must verify against the current
 * checkpoint before anything is recorded.
 */
export async function prepareDraftComment(
  transaction: PgTransactionClient,
  organizationId: string,
  input: CommandInput,
): Promise<DraftCommentRead | PreparedDraftCommentRoot> {
  validateCommentBody(input.create.body);
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
  );
  const digest = await createDigest(
    input.draftId,
    input.attribution.principalId,
    input.create,
  );
  const recorded = await findRow(
    transaction,
    organizationId,
    input.draftId,
    "mutation",
    input.create.mutationId,
  );
  if (recorded) return replay(recorded, digest);
  const { rootId, epoch, startCursor, endCursor, quote } = input.create;
  if (rootId !== undefined) {
    if (
      epoch !== undefined || startCursor !== undefined ||
      endCursor !== undefined || quote !== undefined
    ) throw new StandardError({ code: "UNPROCESSABLE" });
    return await createReply(transaction, organizationId, input, digest);
  }
  if (
    epoch === undefined || startCursor === undefined ||
    endCursor === undefined || quote === undefined
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  if (scope.epoch !== epoch) throw refusedDraftEdit("draft_moved_on");
  // Checked here, not only in the worker: the worker frame is UTF-8, which
  // cannot carry half a surrogate pair and would turn it into U+FFFD.
  if (hasUnpairedSurrogate(quote)) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "comment_anchor_splits_character" },
    });
  }
  return {
    draftId: input.draftId,
    epoch,
    highwater: String(scope.server_sequence),
    checkpointId: scope.current_checkpoint_id,
    state: await currentState(
      transaction,
      organizationId,
      input.draftId,
      scope.current_checkpoint_id,
    ),
    anchor: { startCursor, endCursor, quote },
    requestDigest: digest,
  };
}

async function createReply(
  transaction: PgTransactionClient,
  organizationId: string,
  input: CommandInput,
  digest: string,
): Promise<DraftCommentRead> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
    true,
  );
  const root = await requireRow(
    transaction,
    organizationId,
    input.draftId,
    input.create.rootId!,
    true,
  );
  // Replies are flat (as on artifact comments): a reply names a root.
  if (root.parent_comment_id !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "comment_replies_are_flat" },
    });
  }
  if (root.deleted_at !== null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const id = await insertComment(transaction, organizationId, input, {
    epoch: scope.epoch,
    rootId: root.id,
    checkpointId: scope.current_checkpoint_id,
    anchor: null,
    requestDigest: digest,
  });
  if (!id) {
    return await replayAfterConflict(
      transaction,
      organizationId,
      input,
      digest,
    );
  }
  await transaction.query(
    `update bakery.artifact_draft_comments
        set row_version = row_version + 1, updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, root.id],
  );
  const row = await requireRow(transaction, organizationId, input.draftId, id);
  await recordChange(transaction, organizationId, scope, {
    row,
    rootVersion: root.row_version + 1,
    created: true,
    principalId: input.attribution.principalId,
    requestId: input.requestId,
    traceId: input.traceId,
    agentSessionId: input.agentSessionId ?? null,
  });
  return toComment(row, null);
}

async function replayAfterConflict(
  transaction: PgTransactionClient,
  organizationId: string,
  input: CommandInput,
  digest: string,
): Promise<DraftCommentRead> {
  const existing = await findRow(
    transaction,
    organizationId,
    input.draftId,
    "mutation",
    input.create.mutationId,
  );
  if (!existing) throw new StandardError({ code: "STATE_CONFLICT" });
  return replay(existing, digest);
}

/**
 * Records a verified root. The draft row is locked and its epoch, sequence
 * and checkpoint re-checked: if the draft moved while the worker resolved the
 * anchor, the anchor is resolved again rather than recorded against stale
 * text.
 */
export async function commitDraftCommentRoot(
  transaction: PgTransactionClient,
  organizationId: string,
  input: CommandInput,
  prepared: PreparedDraftCommentRoot,
  position: readonly [number, number],
): Promise<DraftCommentRead> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
    true,
  );
  const recorded = await findRow(
    transaction,
    organizationId,
    input.draftId,
    "mutation",
    input.create.mutationId,
  );
  if (recorded) return replay(recorded, prepared.requestDigest);
  if (scope.epoch !== prepared.epoch) throw refusedDraftEdit("draft_moved_on");
  if (
    String(scope.server_sequence) !== prepared.highwater ||
    scope.current_checkpoint_id !== prepared.checkpointId
  ) throw new StaleDraftCandidateError();
  const id = await insertComment(transaction, organizationId, input, {
    epoch: prepared.epoch,
    rootId: null,
    checkpointId: prepared.checkpointId,
    anchor: prepared.anchor,
    requestDigest: prepared.requestDigest,
  });
  if (!id) {
    return await replayAfterConflict(
      transaction,
      organizationId,
      input,
      prepared.requestDigest,
    );
  }
  const row = await requireRow(transaction, organizationId, input.draftId, id);
  await recordChange(transaction, organizationId, scope, {
    row,
    rootVersion: row.row_version,
    created: true,
    principalId: input.attribution.principalId,
    requestId: input.requestId,
    traceId: input.traceId,
    agentSessionId: input.agentSessionId ?? null,
  });
  return toComment(row, anchorAnswer(position));
}

/** One page read in the first pass, with the anchors still to resolve. */
export type PreparedDraftCommentPage = {
  rows: CommentRow[];
  nextCursor: string | null;
  state: Uint8Array;
  anchors: DraftAnchorCandidateInput[];
  /** Index into `anchors` per row, or -1 for a row with no anchor. */
  anchorOf: number[];
};

/**
 * First pass of `draftComments.list`: one keyset page of roots (or one root's
 * flat replies), bound to the draft, filters and caller. Roots come back with
 * the current checkpoint state so their anchors can be resolved outside the
 * transaction; a page with nothing to resolve is answered at once.
 */
export async function prepareDraftCommentPage(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  draftId: string,
  query: DraftCommentQueryInput,
): Promise<
  | { items: DraftCommentRead[]; nextCursor: string | null }
  | PreparedDraftCommentPage
> {
  if (query.rootId !== undefined && query.status !== undefined) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  if (query.rootId !== undefined) {
    const root = await requireRow(
      transaction,
      organizationId,
      draftId,
      query.rootId,
    );
    if (root.parent_comment_id !== null) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
  const binding = {
    action: "draftComments.list",
    principalId,
    organizationId,
    ordering: ORDERING,
    schemaVersion: 1,
    filters: JSON.stringify({
      draftId,
      rootId: query.rootId ?? null,
      status: query.status ?? null,
    }),
  };
  const position = await decodeCursor(secret, query.cursor, binding);
  const limit = query.limit ?? 25;
  const result = await transaction.query<CommentRow>(
    `select ${COLUMNS} ${FROM}
      where c.organization_id = $1 and c.draft_id = $2
        and c.parent_comment_id is not distinct from $3::uuid
        and ($4::text is null or c.status = $4)
        and ($5::timestamptz is null or (c.created_at,c.id) > ($5,$6::uuid))
      order by c.created_at,c.id
      limit $7`,
    [
      organizationId,
      draftId,
      query.rootId ?? null,
      query.status ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = result.rows.length > limit && last
    ? await encodeCursor(secret, binding, {
      createdAt: last.cursor_created_at,
      id: last.id,
    })
    : null;
  const anchors: DraftAnchorCandidateInput[] = [];
  const anchorOf = rows.map((row) => {
    const anchor = storedAnchor(row);
    if (!anchor) return -1;
    anchors.push(anchor);
    return anchors.length - 1;
  });
  if (anchors.length === 0) {
    return { items: rows.map((row) => toComment(row, null)), nextCursor };
  }
  return {
    rows,
    nextCursor,
    state: await currentState(
      transaction,
      organizationId,
      draftId,
      scope.current_checkpoint_id,
    ),
    anchors,
    anchorOf,
  };
}

/**
 * Second pass of `draftComments.list`: the page with every root's anchor
 * resolved. A root whose cursor is missing, whose range collapsed or whose
 * text no longer equals the quote is outdated and still listed. A root of a
 * draft in an epoch other than the one it was made in is outdated too: its
 * cursors name the old history.
 */
export function resolvedDraftCommentPage(
  page: PreparedDraftCommentPage,
  positions: readonly DraftAnchorPosition[],
  currentEpoch: number,
): { items: DraftCommentRead[]; nextCursor: string | null } {
  return {
    items: page.rows.map((row, index) => {
      const at = page.anchorOf[index];
      if (at < 0) return toComment(row, null);
      const position = row.epoch === currentEpoch
        ? positions[at] ?? null
        : null;
      return toComment(row, anchorAnswer(position));
    }),
    nextCursor: page.nextCursor,
  };
}

/** Current epoch of a draft the caller may read. */
export async function draftEpoch(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
): Promise<number> {
  return (await loadDraftScope(transaction, organizationId, draftId)).epoch;
}

/**
 * `draftComments.update`: edits, resolves, reopens, deletes or restores one
 * comment under its If-Match, with the moderation rules of artifact comments.
 * Changing a reply also increments its root's version. The answer carries no
 * resolved anchor: only the list resolves stored anchors.
 */
export async function updateDraftComment(
  transaction: PgTransactionClient,
  organizationId: string,
  input: {
    draftId: string;
    commentId: string;
    principalId: string;
    expectedVersion: string | number | undefined;
    requestId: string;
    traceId: string;
    agentSessionId?: string | null;
    update: DraftCommentUpdateInput;
  },
): Promise<DraftCommentRead> {
  const { update } = input;
  if (
    update.body === undefined && update.resolved === undefined &&
    update.deleted === undefined
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  if (update.body !== undefined) validateCommentBody(update.body);
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
    true,
  );
  const observed = await requireRow(
    transaction,
    organizationId,
    input.draftId,
    input.commentId,
  );
  const root = await requireRow(
    transaction,
    organizationId,
    input.draftId,
    observed.parent_comment_id ?? observed.id,
    true,
  );
  const row = observed.parent_comment_id
    ? await requireRow(
      transaction,
      organizationId,
      input.draftId,
      observed.id,
      true,
    )
    : root;
  if (
    input.expectedVersion === undefined ||
    String(row.row_version) !== String(input.expectedVersion)
  ) throw new StandardError({ code: "PRECONDITION_FAILED" });
  if (update.resolved !== undefined && row.parent_comment_id !== null) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (
    row.deleted_at !== null &&
    (update.body !== undefined || update.resolved !== undefined)
  ) throw new StandardError({ code: "STATE_CONFLICT" });
  if (update.body !== undefined && row.author_id !== input.principalId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const deletionOwner = update.deleted === false && row.deleted_at !== null
    ? row.deleted_by
    : row.author_id;
  if (update.deleted !== undefined && deletionOwner !== input.principalId) {
    const admin = await transaction.query(
      `select 1 from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2 and role = 'admin'
          and status = 'active'`,
      [organizationId, input.principalId],
    );
    if (admin.rows.length !== 1) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  }
  await transaction.query(
    `update bakery.artifact_draft_comments set
       body = coalesce($3, body),
       status = case when $4::boolean is null then status
         when $4 then 'resolved' else 'open' end,
       resolved_by = case when $4::boolean is null then resolved_by
         when $4 then $6::uuid else null end,
       resolved_at = case when $4::boolean is null then resolved_at
         when $4 then now() else null end,
       deleted_at = case when $5::boolean is null then deleted_at
         when $5 then coalesce(deleted_at, now()) else null end,
       deleted_by = case when $5::boolean is null then deleted_by
         when $5 then coalesce(deleted_by, $6::uuid) else null end,
       row_version = row_version + 1, updated_at = now()
     where organization_id = $1 and id = $2`,
    [
      organizationId,
      row.id,
      update.body ?? null,
      update.resolved ?? null,
      update.deleted ?? null,
      input.principalId,
    ],
  );
  if (row.parent_comment_id) {
    await transaction.query(
      `update bakery.artifact_draft_comments
          set row_version = row_version + 1, updated_at = now()
        where organization_id = $1 and id = $2`,
      [organizationId, root.id],
    );
  }
  const updated = await requireRow(
    transaction,
    organizationId,
    input.draftId,
    row.id,
  );
  await recordChange(transaction, organizationId, scope, {
    row: updated,
    rootVersion: root.row_version + 1,
    created: false,
    principalId: input.principalId,
    requestId: input.requestId,
    traceId: input.traceId,
    agentSessionId: input.agentSessionId ?? null,
  });
  return toComment(updated, null);
}
