import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  draftEditDigest,
  type DraftEditInput,
  type DraftEditRefusalReason,
  type PreparedDraftEdit,
  prepareDraftEditStates,
  refusedDraftEdit,
} from "./draft-persistence.ts";
import type { ActionAttribution } from "../auth/application/action-attribution.ts";

/** Cursor ordering of the suggestion list: oldest first. */
const SUGGESTION_ORDERING = "createdAt:asc,id:asc";
const MAX_PAGE_SIZE = 100;
const TIMESTAMP_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** One proposed replacement, as `draftSuggestions.create` accepts it. */
export type DraftSuggestionCreateInput = {
  epoch: number;
  sourceCheckpointId: string;
  startCursor: string;
  endCursor: string;
  expectedText: string;
  expectedDigest: string;
  replacement: string;
  mutationId: string;
};

export type DraftSuggestionState =
  | "waiting"
  | "accepted"
  | "rejected"
  | "no_longer_fits"
  | "unknown";

/** One suggestion as the read actions serve it. */
export type DraftSuggestionRead = {
  id: string;
  draftId: string;
  epoch: number;
  sourceCheckpointId: string;
  startCursor: string;
  endCursor: string;
  expectedText: string;
  replacement: string;
  state: DraftSuggestionState;
  refusalReason: DraftEditRefusalReason | null;
  requestedById: string;
  requestedByName: string;
  actorKind: "person" | "agent";
  agentName: string | null;
  requestId: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  appliedServerSequence: string | null;
  createdAt: string;
};

type SuggestionRow = {
  id: string;
  draft_id: string;
  epoch: number;
  source_checkpoint_id: string;
  start_cursor: string;
  end_cursor: string;
  expected_text: string;
  expected_digest: string;
  replacement: string;
  request_digest: string;
  requested_by_id: string;
  requested_by_name: string;
  actor_kind: string;
  agent_name: string | null;
  request_id: string;
  state: string;
  refusal_reason: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  applied_server_sequence: string | number | null;
  created_at: Date | string;
  cursor_created_at: string;
};

const SUGGESTION_COLUMNS = `s.id,s.draft_id,s.epoch,s.source_checkpoint_id,
  s.start_cursor,s.end_cursor,s.expected_text,s.expected_digest,s.replacement,
  s.request_digest,s.requested_by_id,requester.display_name as requested_by_name,
  s.actor_kind,token.name as agent_name,s.request_id,s.state,s.refusal_reason,
  s.decided_by_id,decider.display_name as decided_by_name,s.decided_at,
  s.applied_server_sequence::text as applied_server_sequence,s.created_at,
  to_char(s.created_at at time zone 'UTC', '${TIMESTAMP_SQL}')
    as cursor_created_at`;
const SUGGESTION_FROM = `from bakery.artifact_draft_suggestions s
  join bakery.principals requester on requester.id = s.requested_by_id
  left join bakery.access_tokens token
    on token.organization_id = s.organization_id and token.id = s.access_token_id
  left join bakery.principals decider on decider.id = s.decided_by_id`;

const STATES: ReadonlySet<string> = new Set([
  "waiting",
  "accepted",
  "rejected",
  "no_longer_fits",
]);

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function stateOf(value: string): DraftSuggestionState {
  return STATES.has(value) ? value as DraftSuggestionState : "unknown";
}

function refusalOf(
  state: DraftSuggestionState,
  value: string | null,
): DraftEditRefusalReason | null {
  if (state !== "no_longer_fits") return null;
  return value === "text_changed" || value === "draft_moved_on" ? value : null;
}

function suggestion(row: SuggestionRow): DraftSuggestionRead {
  const state = stateOf(row.state);
  return {
    id: row.id,
    draftId: row.draft_id,
    epoch: row.epoch,
    sourceCheckpointId: row.source_checkpoint_id,
    startCursor: row.start_cursor,
    endCursor: row.end_cursor,
    expectedText: row.expected_text,
    replacement: row.replacement,
    state,
    refusalReason: refusalOf(state, row.refusal_reason),
    requestedById: row.requested_by_id,
    requestedByName: row.requested_by_name,
    actorKind: row.actor_kind === "agent" ? "agent" : "person",
    agentName: row.agent_name,
    requestId: row.request_id,
    decidedById: row.decided_by_id,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
    appliedServerSequence: row.applied_server_sequence === null
      ? null
      : String(row.applied_server_sequence),
    createdAt: iso(row.created_at),
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

const DRAFT_SCOPE_SELECT = `select draft.epoch,draft.server_sequence,
  draft.current_checkpoint_id,draft.artifact_id,draft.task_id,
  task.application_id,task.repository_id,task.conversation_id
  from bakery.artifact_drafts draft
  join bakery.tasks task
    on task.organization_id = draft.organization_id and task.id = draft.task_id
  where draft.organization_id = $1 and draft.id = $2`;

async function loadDraftScope(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  lock = false,
): Promise<DraftScope> {
  const row = (await transaction.query<DraftScope>(
    `${DRAFT_SCOPE_SELECT}${lock ? " for update of draft" : ""}`,
    [organizationId, draftId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/**
 * Digest binding one proposal to its principal and payload. A retry carrying
 * the same mutation id and payload replays the recorded suggestion; a changed
 * payload is a mismatch, never a second suggestion.
 */
async function suggestionDigest(
  draftId: string,
  principalId: string,
  input: DraftSuggestionCreateInput,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    operation: "draftSuggestions.create",
    draftId,
    principalId,
    ...input,
  }));
}

async function findSuggestionRow(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  where: "mutation" | "id",
  value: string,
  lock = false,
): Promise<SuggestionRow | undefined> {
  const column = where === "mutation" ? "s.client_mutation_id" : "s.id";
  return (await transaction.query<SuggestionRow>(
    `select ${SUGGESTION_COLUMNS} ${SUGGESTION_FROM}
      where s.organization_id = $1 and s.draft_id = $2 and ${column} = $3${
      lock ? " for update of s" : ""
    }`,
    [organizationId, draftId, value],
  )).rows[0];
}

async function findSuggestion(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  where: "mutation" | "id",
  value: string,
  lock = false,
): Promise<DraftSuggestionRead | undefined> {
  const row = await findSuggestionRow(
    transaction,
    organizationId,
    draftId,
    where,
    value,
    lock,
  );
  return row ? suggestion(row) : undefined;
}

function assertSuggestionDigest(
  row: SuggestionRow,
  digest: string,
): DraftSuggestionRead {
  if (row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return suggestion(row);
}

/**
 * Prepares one proposal (#71): checks the draft epoch and loads the source
 * and current checkpoints a guarded edit is computed from, exactly as
 * `drafts.edit` does, so the suggestion is anchored on the same terms. The
 * anchor itself is verified by the caller through the draft isolation before
 * anything is recorded. An exact retry answers with the recorded suggestion.
 */
export async function prepareDraftSuggestion(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  draftId: string,
  input: DraftSuggestionCreateInput,
  record: Omit<SuggestionRecordContext, "create" | "draftId">,
): Promise<DraftSuggestionRead | PreparedDraftEdit> {
  const scope = await loadDraftScope(transaction, organizationId, draftId);
  const digest = await suggestionDigest(draftId, principalId, input);
  const recorded = await findSuggestionRow(
    transaction,
    organizationId,
    draftId,
    "mutation",
    input.mutationId,
  );
  if (recorded) return assertSuggestionDigest(recorded, digest);
  // A proposal from an epoch that has closed (a client that was offline across
  // a rollover) is kept, not lost: it is recorded as one the draft no longer
  // fits, so a person can read it and apply it by hand. It is never anchored,
  // because its checkpoint may have been compacted away.
  if (input.epoch < scope.epoch) {
    return await insertSuggestion(
      transaction,
      organizationId,
      { ...record, draftId, create: input },
      digest,
      scope,
      true,
    );
  }
  if (scope.epoch !== input.epoch) throw refusedDraftEdit("draft_moved_on");
  return await prepareDraftEditStates(
    transaction,
    organizationId,
    draftId,
    input,
    digest,
  );
}

/** What recording a suggestion needs besides the proposal itself. */
export type SuggestionRecordContext = {
  draftId: string;
  attribution: ActionAttribution;
  requestId: string;
  traceId: string;
  create: DraftSuggestionCreateInput;
};

type DraftScopeRow = Awaited<ReturnType<typeof loadDraftScope>>;

/**
 * Inserts one proposal and announces it: the row, the `draft.suggestion_created`
 * event and the audit entry. `moved` records it as one the draft no longer fits
 * (a closed epoch) instead of waiting. A lost insert race answers with the
 * recorded proposal after the digest check, so a retry never records twice.
 */
async function insertSuggestion(
  transaction: PgTransactionClient,
  organizationId: string,
  input: SuggestionRecordContext,
  requestDigest: string,
  scope: DraftScopeRow,
  moved: boolean,
): Promise<DraftSuggestionRead> {
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.artifact_draft_suggestions (
       organization_id,draft_id,epoch,source_checkpoint_id,start_cursor,
       end_cursor,expected_text,expected_digest,replacement,
       client_mutation_id,request_digest,requested_by_id,actor_kind,
       access_token_id,request_id,trace_id,state,refusal_reason
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (organization_id, draft_id, client_mutation_id) do nothing
     returning id`,
    [
      organizationId,
      input.draftId,
      input.create.epoch,
      input.create.sourceCheckpointId,
      input.create.startCursor,
      input.create.endCursor,
      input.create.expectedText,
      input.create.expectedDigest,
      input.create.replacement,
      input.create.mutationId,
      requestDigest,
      input.attribution.principalId,
      input.attribution.actorKind,
      input.attribution.accessTokenId,
      input.requestId,
      input.traceId,
      moved ? "no_longer_fits" : "waiting",
      moved ? "draft_moved_on" : null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const existing = await findSuggestionRow(
      transaction,
      organizationId,
      input.draftId,
      "mutation",
      input.create.mutationId,
    );
    if (!existing) throw new StandardError({ code: "STATE_CONFLICT" });
    return assertSuggestionDigest(existing, requestDigest);
  }
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: scope.task_id,
    conversationId: scope.conversation_id,
    eventType: "draft.suggestion_created",
    aggregateId: id,
    aggregateVersion: 1,
    payload: { resourceId: id, resourceVersion: 1 },
    traceId: input.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: input.attribution.principalId,
    operation: "draftSuggestions.create",
    resourceType: "artifact_draft_suggestion",
    resourceId: id,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      draftId: input.draftId,
      epoch: input.create.epoch,
      sourceCheckpointId: input.create.sourceCheckpointId,
      actorKind: input.attribution.actorKind,
      ...(moved ? { movedOn: true } : {}),
    },
  });
  const recorded = await findSuggestion(
    transaction,
    organizationId,
    input.draftId,
    "id",
    id,
  );
  if (!recorded) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return recorded;
}

/**
 * Records a verified proposal. The draft row is locked and its epoch and
 * server sequence re-checked, so a proposal made against a draft that moved on
 * in the meantime is refused rather than recorded against a stale anchor.
 */
export async function commitDraftSuggestion(
  transaction: PgTransactionClient,
  organizationId: string,
  input: SuggestionRecordContext,
  preparation: PreparedDraftEdit,
): Promise<{ suggestion: DraftSuggestionRead; traceId: string }> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
    true,
  );
  const replay = await findSuggestionRow(
    transaction,
    organizationId,
    input.draftId,
    "mutation",
    input.create.mutationId,
  );
  if (replay) {
    return {
      suggestion: assertSuggestionDigest(replay, preparation.requestDigest),
      traceId: input.traceId,
    };
  }
  if (
    scope.epoch !== preparation.epoch ||
    String(scope.server_sequence) !== preparation.highwater
  ) throw refusedDraftEdit("draft_moved_on");
  return {
    suggestion: await insertSuggestion(
      transaction,
      organizationId,
      input,
      preparation.requestDigest,
      scope,
      false,
    ),
    traceId: input.traceId,
  };
}

/** How a suggestion is being decided. */
export type SuggestionDecision = "accept" | "reject";

/** A decision that applies no edit: a rejection, or an already-decided replay. */
export type SuggestionDecisionPlan =
  | { kind: "settled"; suggestion: DraftSuggestionRead }
  | { kind: "refused"; reason: DraftEditRefusalReason }
  | { kind: "reject"; suggestion: DraftSuggestionRead }
  | {
    kind: "accept";
    suggestion: DraftSuggestionRead;
    edit: PreparedDraftEdit;
    input: DraftEditInput;
  };

/**
 * Prepares a decision. A suggestion already in a final state answers with
 * itself (accepting an accepted suggestion, rejecting a rejected one) and a
 * suggestion decided the other way is a state conflict. Accepting prepares the
 * guarded edit the deciding person's own `drafts.edit` would apply, so the
 * recorded receipt is an ordinary edit receipt.
 */
export async function prepareSuggestionDecision(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  suggestionId: string,
  decision: SuggestionDecision,
): Promise<SuggestionDecisionPlan> {
  const row = await findSuggestionRow(
    transaction,
    organizationId,
    draftId,
    "id",
    suggestionId,
  );
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const current = suggestion(row);
  if (current.state !== "waiting") {
    if (
      (decision === "accept" && current.state === "accepted") ||
      (decision === "reject" && current.state === "rejected") ||
      current.state === "unknown"
    ) return { kind: "settled", suggestion: current };
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  if (decision === "reject") return { kind: "reject", suggestion: current };
  const edit: DraftEditInput = {
    epoch: current.epoch,
    sourceCheckpointId: current.sourceCheckpointId,
    startCursor: current.startCursor,
    endCursor: current.endCursor,
    expectedText: current.expectedText,
    expectedDigest: row.expected_digest,
    replacement: current.replacement,
    mutationId: crypto.randomUUID(),
  };
  const digest = await draftEditDigest(draftId, current.requestedById, edit);
  try {
    return {
      kind: "accept",
      suggestion: current,
      edit: await prepareDraftEditStates(
        transaction,
        organizationId,
        draftId,
        edit,
        digest,
      ),
      input: edit,
    };
  } catch (error) {
    const reason = refusalReason(error);
    if (reason) return { kind: "refused", reason };
    throw error;
  }
}

function refusalReason(error: unknown): DraftEditRefusalReason | null {
  if (!(error instanceof StandardError)) return null;
  if (error.code !== "PRECONDITION_FAILED") return null;
  const reason = error.params?.reason;
  return reason === "text_changed" || reason === "draft_moved_on"
    ? reason
    : null;
}

/**
 * Locks the suggestion a decision is about to change and proves it is still
 * waiting. Taking this lock before any edit is what keeps an accept and a
 * reject from both passing the waiting check: the second decision waits here,
 * then sees the settled state and changes nothing (#71 review).
 */
async function lockWaitingSuggestion(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  suggestionId: string,
): Promise<SuggestionRow> {
  const row = (await transaction.query<SuggestionRow>(
    `select ${SUGGESTION_COLUMNS} ${SUGGESTION_FROM}
      where s.organization_id = $1 and s.draft_id = $2 and s.id = $3
      for update of s`,
    [organizationId, draftId, suggestionId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // Another decision committed first: this one applies nothing at all.
  if (row.state !== "waiting") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return row;
}

async function recordDecision(
  transaction: PgTransactionClient,
  organizationId: string,
  input: {
    draftId: string;
    suggestionId: string;
    operation: string;
    principalId: string;
    requestId: string;
    traceId: string;
    state: "accepted" | "rejected" | "no_longer_fits";
    refusalReason?: DraftEditRefusalReason;
    appliedServerSequence?: string;
  },
): Promise<{ suggestion: DraftSuggestionRead; draftId: string }> {
  const scope = await loadDraftScope(
    transaction,
    organizationId,
    input.draftId,
  );
  const updated = await transaction.query<{ id: string }>(
    `update bakery.artifact_draft_suggestions
        set state = $4, refusal_reason = $5, decided_by_id = $6,
            decided_at = current_timestamp, applied_server_sequence = $7::bigint
      where organization_id = $1 and draft_id = $2 and id = $3
        and state = 'waiting'
      returning id`,
    [
      organizationId,
      input.draftId,
      input.suggestionId,
      input.state,
      input.refusalReason ?? null,
      input.principalId,
      input.appliedServerSequence ?? null,
    ],
  );
  // The row was locked and proved waiting before any edit, so this always
  // changes it; a decision that changed nothing must not claim it did.
  if (updated.rows.length !== 1) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: scope.task_id,
    conversationId: scope.conversation_id,
    eventType: "draft.suggestion_decided",
    aggregateId: input.suggestionId,
    aggregateVersion: 1,
    payload: { resourceId: input.suggestionId, resourceVersion: 1 },
    traceId: input.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: input.principalId,
    operation: input.operation,
    resourceType: "artifact_draft_suggestion",
    resourceId: input.suggestionId,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      draftId: input.draftId,
      state: input.state,
      ...(input.refusalReason ? { refusalReason: input.refusalReason } : {}),
      ...(input.appliedServerSequence
        ? { appliedServerSequence: input.appliedServerSequence }
        : {}),
    },
  });
  const decided = await findSuggestion(
    transaction,
    organizationId,
    input.draftId,
    "id",
    input.suggestionId,
  );
  if (!decided) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return { suggestion: decided, draftId: input.draftId };
}

/**
 * Takes the decision lock on a suggestion before the acceptance applies its
 * edit. The edit then commits while the row is held, so a concurrent reject
 * cannot settle the suggestion in between — it waits, then finds a decided
 * row and changes nothing (#71 review).
 */
export async function lockSuggestionAcceptance(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  suggestionId: string,
): Promise<void> {
  await lockWaitingSuggestion(
    transaction,
    organizationId,
    draftId,
    suggestionId,
  );
}

/**
 * Records an acceptance together with the edit it applied. The suggestion is
 * locked first and the edit is already committed, so a concurrent decision
 * cannot apply it twice: only a still-waiting row is updated.
 */
export async function commitSuggestionAcceptance(
  transaction: PgTransactionClient,
  organizationId: string,
  input: {
    draftId: string;
    suggestionId: string;
    principalId: string;
    requestId: string;
    traceId: string;
    appliedServerSequence: string;
  },
): Promise<{ suggestion: DraftSuggestionRead; draftId: string }> {
  await lockWaitingSuggestion(
    transaction,
    organizationId,
    input.draftId,
    input.suggestionId,
  );
  return await recordDecision(transaction, organizationId, {
    ...input,
    operation: "draftSuggestions.accept",
    state: "accepted",
    appliedServerSequence: input.appliedServerSequence,
  });
}

/** Records a rejection of a still-waiting suggestion. */
export async function commitSuggestionRejection(
  transaction: PgTransactionClient,
  organizationId: string,
  input: {
    draftId: string;
    suggestionId: string;
    principalId: string;
    requestId: string;
    traceId: string;
  },
): Promise<{ suggestion: DraftSuggestionRead; draftId: string }> {
  await lockWaitingSuggestion(
    transaction,
    organizationId,
    input.draftId,
    input.suggestionId,
  );
  return await recordDecision(transaction, organizationId, {
    ...input,
    operation: "draftSuggestions.reject",
    state: "rejected",
  });
}

/**
 * Records that an accepted suggestion no longer fits: at accept time its
 * anchored text had changed or the draft had moved on, and nothing was
 * applied. The reason is kept so editors can say which of the two happened.
 */
export async function commitSuggestionRefusal(
  transaction: PgTransactionClient,
  organizationId: string,
  input: {
    draftId: string;
    suggestionId: string;
    principalId: string;
    requestId: string;
    traceId: string;
    reason: DraftEditRefusalReason;
  },
): Promise<{ suggestion: DraftSuggestionRead; draftId: string }> {
  await lockWaitingSuggestion(
    transaction,
    organizationId,
    input.draftId,
    input.suggestionId,
  );
  return await recordDecision(transaction, organizationId, {
    ...input,
    operation: "draftSuggestions.accept",
    state: "no_longer_fits",
    refusalReason: input.reason,
  });
}

function pageSize(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return limit;
}

function suggestionBinding(
  organizationId: string,
  principalId: string,
  draftId: string,
  state: string | null,
): CursorBinding {
  return {
    action: "draftSuggestions.list",
    principalId,
    organizationId,
    ordering: SUGGESTION_ORDERING,
    filters: JSON.stringify({ draftId, state }),
    schemaVersion: 1,
  };
}

/**
 * Lists one draft's suggestions, oldest first, keyset paginated on
 * (created_at, id). The cursor is bound to the draft, the state filter and the
 * caller, so a cursor from another listing is refused.
 */
export async function listDraftSuggestions(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  draftId: string,
  query: { cursor?: string; limit?: number; state?: string },
): Promise<{
  items: DraftSuggestionRead[];
  nextCursor: string | null;
}> {
  await loadDraftScope(transaction, organizationId, draftId);
  const limit = pageSize(query.limit);
  const state = query.state ?? null;
  const binding = suggestionBinding(
    organizationId,
    principalId,
    draftId,
    state,
  );
  const position = await decodeCursor(secret, query.cursor, binding);
  const result = await transaction.query<SuggestionRow>(
    `select ${SUGGESTION_COLUMNS} ${SUGGESTION_FROM}
      where s.organization_id = $1 and s.draft_id = $2
        and ($3::text is null or s.state = $3)
        and ($4::timestamptz is null or (s.created_at,s.id) > ($4,$5::uuid))
      order by s.created_at,s.id
      limit $6`,
    [
      organizationId,
      draftId,
      state,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const items = result.rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(suggestion),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}
