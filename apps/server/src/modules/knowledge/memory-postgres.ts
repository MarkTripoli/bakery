import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  MEMORY_MINIMUM_ACCEPTING_CONFIDENCE,
  type MemoryConflictVerdict,
  MemoryProvenanceSchema,
} from "@bakery/contracts/memory-promotion";
import type { PgTransactionClient } from "../../platform/database.ts";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type MemorySource,
  readerMayReadArtifactVersions,
  resolveMemorySources,
} from "./memory-source-state.ts";

/**
 * Memory persistence (#22, chapter 17 "Memory promotes evidence, never policy").
 *
 * Two rules shape every query here:
 *
 * 1. Content never changes in place. A correction is a new revision, and the
 *    entry's current_revision_id moves by compare-and-swap. The history is the
 *    table, so "what did this say when a run read it" stays answerable.
 * 2. A promotion either has the evidence to be accepted or it does not. A
 *    refused promotion writes nothing at all, so the entry keeps the status it
 *    had rather than recording an acceptance decision it never received.
 *
 * Nothing in this file returns a memory body as anything but text. There is no
 * path from a stored body to a grant, a policy or a configuration value.
 */

const MEMORY_COLUMNS = `
  m.id, m.repository_id, m.topic, m.tags, m.current_revision_id, m.status,
  m.created_at, m.updated_at, m.version
`;

const REVISION_COLUMNS = `
  r.id, r.memory_id, r.revision, r.body, r.reason,
  r.source_artifact_version_id, r.supersedes_id, r.confidence,
  r.expires_at, r.created_by, r.created_at, r.updated_at, r.version
`;

type MemoryRow = {
  id: string;
  repository_id: string;
  topic: string;
  tags: unknown;
  current_revision_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type RevisionRow = {
  id: string;
  memory_id: string;
  revision: number;
  body: string;
  reason: string | null;
  source_artifact_version_id: string;
  supersedes_id: string | null;
  confidence: string | number;
  expires_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type MemoryEntry = z.output<typeof contractSchemas.MemoryEntry>;
type MemoryRevision = z.output<typeof contractSchemas.MemoryRevision>;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function toEntry(
  row: MemoryRow,
  currentRevision: MemoryRevision | null,
): MemoryEntry {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    topic: row.topic,
    tags: (row.tags ?? []) as MemoryEntry["tags"],
    currentRevisionId: row.current_revision_id,
    currentRevision,
    // The entry's source state is its current revision's.
    sourceState: currentRevision?.sourceState ?? "unknown",
    status: row.status as MemoryEntry["status"],
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

/** A numeric column as the contract's bounded decimal string (six places). */
function decimalString(value: string | number): string {
  const text = typeof value === "number" ? value.toString() : value;
  // Scale to at most six places by truncation, matching the column's meaning:
  // confidence is a judgment, and a seventh place is not information.
  const [whole, fraction = ""] = text.split(".");
  return fraction.length === 0
    ? whole
    : `${whole}.${fraction.slice(0, 6).padEnd(1, "0")}`;
}

function toRevision(
  row: RevisionRow,
  source: MemorySource,
  createdByName: string | null,
): MemoryRevision {
  const sourceState = source.state;
  return {
    id: row.id,
    memoryId: row.memory_id,
    revision: row.revision,
    body: row.body,
    reason: row.reason,
    // Withheld when the reader cannot read artifact versions: those reads answer
    // a denied read as not found, so naming the id here would confirm a record
    // the reader's own artifact reads refuse to.
    sourceArtifactVersionId: sourceState === "no_access"
      ? null
      : row.source_artifact_version_id,
    sourceState,
    sourceName: source.name,
    sourceRevision: source.revision,
    supersedesId: row.supersedes_id,
    // `decimal` is an exact decimal string on the wire, never a float: the
    // driver already returns numeric as text, so it is passed through rather
    // than round-tripped through a number that could lose the last place.
    confidence: decimalString(row.confidence),
    expiresAt: iso(row.expires_at),
    createdBy: row.created_by,
    createdByName,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

/** Display names of the principals who made these revisions: one query, never one per row. */
async function creatorNames(
  transaction: PgTransactionClient,
  rows: readonly RevisionRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.created_by))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const found = await transaction.query<{ id: string; display_name: string }>(
    `select id, display_name from bakery.principals where id = any($1::uuid[])`,
    [ids],
  );
  for (const principal of found.rows) {
    if (principal.display_name.trim() !== "") {
      names.set(principal.id, principal.display_name);
    }
  }
  return names;
}

/**
 * Revisions as this reader sees them: one batched source lookup per call, never
 * one per row.
 */
async function revisionsForReader(
  context: ActionContext,
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly RevisionRow[],
): Promise<MemoryRevision[]> {
  const sources = await resolveMemorySources(transaction, {
    organizationId,
    readerMayRead: readerMayReadArtifactVersions(context),
    versionIds: rows.map((row) => row.source_artifact_version_id),
  });
  const names = await creatorNames(transaction, rows);
  return rows.map((row) =>
    toRevision(
      row,
      sources.get(row.source_artifact_version_id) ??
        { state: "unknown", name: null, revision: null },
      names.get(row.created_by) ?? null,
    )
  );
}

/**
 * Entries as this reader sees them, each with its current revision (wording,
 * source, confidence, expiry) so a list needs no read per row. One query loads
 * every current revision and one resolves their sources, whatever the page size.
 */
async function entriesForReader(
  context: ActionContext,
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly MemoryRow[],
): Promise<MemoryEntry[]> {
  const revisionIds = rows.flatMap((row) =>
    row.current_revision_id === null ? [] : [row.current_revision_id]
  );
  const current = new Map<string, MemoryRevision>();
  if (revisionIds.length > 0) {
    const revisionRows = await transaction.query<RevisionRow>(
      `select ${REVISION_COLUMNS} from bakery.memory_revisions r
        where r.organization_id = $1 and r.id = any($2::uuid[])`,
      [organizationId, revisionIds],
    );
    for (
      const revision of await revisionsForReader(
        context,
        transaction,
        organizationId,
        revisionRows.rows,
      )
    ) {
      current.set(revision.id, revision);
    }
  }
  return rows.map((row) =>
    toEntry(
      row,
      row.current_revision_id === null
        ? null
        : current.get(row.current_revision_id) ?? null,
    )
  );
}

/** One content-free invalidation, written in the transaction of the change. */
async function appendMemoryEvent(
  context: ActionContext,
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    eventType: "memories.created" | "memories.updated" | "memory.revised";
    memoryId: string;
    repositoryId: string;
    version: number;
  },
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    eventType: input.eventType,
    aggregateId: input.memoryId,
    aggregateVersion: input.version,
    payload: { resourceId: input.memoryId, resourceVersion: input.version },
    traceId: context.traceId,
  });
}

/**
 * Refuse a promotion whose evidence does not justify acceptance.
 *
 * The conflict scan runs against the entry's own repository only: a conflict in
 * another repository is not a conflict for this learning, and cross-repository
 * comparison is what the design forbids by default.
 */
async function assertSourceArtifactHeld(
  transaction: PgTransactionClient,
  input: { organizationId: string; sourceArtifactVersionId: string },
): Promise<void> {
  const source = await transaction.query<{ id: string }>(
    `select a.id
       from bakery.artifact_versions a
      where a.organization_id = $1 and a.id = $2`,
    [input.organizationId, input.sourceArtifactVersionId],
  );
  if (source.rows.length === 0) {
    // One refusal for absent and foreign alike: telling a caller that an id
    // exists in another organization would confirm a record they cannot see.
    throw new MemoryPromotionRefused(
      "source_artifact_unknown",
      "The source artifact version does not name evidence this organization holds.",
    );
  }
}

async function assertRepositoryInScope(
  transaction: PgTransactionClient,
  input: { organizationId: string; repositoryId: string },
): Promise<void> {
  const repository = await transaction.query<{ id: string }>(
    `select r.id
       from bakery.repositories r
      where r.organization_id = $1 and r.id = $2`,
    [input.organizationId, input.repositoryId],
  );
  if (repository.rows.length === 0) {
    throw new MemoryPromotionRefused(
      "repository_out_of_scope",
      "The repository is not one this organization holds.",
    );
  }
}

/**
 * Refuse when accepted memory already covers this topic in this repository.
 *
 * `excludeMemoryId` is what makes the check usable for a correction or a
 * reactivation: the entry being changed is active and shares its own topic, so
 * without the exclusion every correction would conflict with the thing it is
 * correcting. It never weakens the check - any *other* active entry still
 * refuses.
 */
async function assertNoConflictingActiveEntry(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    repositoryId: string;
    topic: string;
    excludeMemoryId?: string;
  },
): Promise<void> {
  const conflicts = await transaction.query<{ id: string }>(
    `select m.id
       from bakery.memory_entries m
      where m.organization_id = $1
        and m.repository_id = $2
        and m.status = 'active'
        and lower(m.topic) = lower($3)
        and ($4::uuid is null or m.id <> $4)`,
    [
      input.organizationId,
      input.repositoryId,
      input.topic,
      input.excludeMemoryId ?? null,
    ],
  );
  if (conflicts.rows.length > 0) {
    throw new MemoryPromotionRefused(
      "conflict_detected",
      "Accepted memory already covers this topic in the repository.",
    );
  }
}

function assertConfidenceAcceptable(confidence: number): void {
  if (confidence < MEMORY_MINIMUM_ACCEPTING_CONFIDENCE) {
    throw new MemoryPromotionRefused(
      "evidence_weak",
      "The evidence does not support accepting this as repository memory.",
    );
  }
}

async function assertPromotable(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    repositoryId: string;
    sourceArtifactVersionId: string;
    confidence: number;
    conflictScan: {
      verdict: MemoryConflictVerdict;
      conflictingMemoryIds: readonly string[];
    };
    topic: string;
    /** Set when the entry being changed is itself active and shares the topic. */
    excludeMemoryId?: string;
  },
): Promise<void> {
  await assertSourceArtifactHeld(transaction, input);
  await assertRepositoryInScope(transaction, input);

  if (input.conflictScan.verdict === "absent") {
    // Never default to clean: silence is not a scan.
    throw new MemoryPromotionRefused(
      "conflict_unscanned",
      "A conflict scan is required before memory can be accepted.",
    );
  }

  // The scan the caller reported, then the scan over this repository's accepted
  // memory. The second one is the authority: a caller-supplied verdict of
  // clean cannot make an actual conflict disappear.
  if (
    input.conflictScan.verdict === "conflict" ||
    input.conflictScan.conflictingMemoryIds.length > 0
  ) {
    throw new MemoryPromotionRefused(
      "conflict_detected",
      "Accepted memory already covers this topic in the repository.",
    );
  }
  await assertNoConflictingActiveEntry(transaction, input);

  assertConfidenceAcceptable(input.confidence);
}

/**
 * A promotion that was refused.
 *
 * A named error rather than a boolean because the caller needs to know which
 * check failed, and because "refused" must be distinguishable from "accepted"
 * at every layer - a null return could be ignored by a caller that wanted a
 * value, while an exception cannot.
 */
export class MemoryPromotionRefused extends StandardError {
  constructor(
    readonly refusal: string,
    detail: string,
  ) {
    super({
      code: "STATE_CONFLICT",
      detail,
      params: { reason: refusal },
    });
  }
}

/**
 * Parse the provenance a create carries.
 *
 * `MemoryCreate.provenance` is free JSON by contract because it carries
 * evidence of several shapes; it is validated here so the stored row can only
 * hold values the promotion rules can reason about.
 */
function parseProvenance(value: unknown) {
  const parsed = MemoryProvenanceSchema.safeParse(value);
  if (!parsed.success) {
    throw new StandardError({
      code: "MALFORMED_REQUEST",
      detail: "provenance is not a valid promotion record",
      params: { reason: "invalid_memory_provenance" },
    });
  }
  return parsed.data;
}

export async function createMemory(
  context: ActionContext,
  rawInput: unknown,
): Promise<MemoryEntry> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<typeof contractSchemas.MemoryCreate>;
  const provenance = parseProvenance(input.provenance);

  if (provenance.repositoryId !== input.repositoryId) {
    throw new StandardError({
      code: "MALFORMED_REQUEST",
      detail: "provenance names a different repository than the entry",
      params: { reason: "provenance_repository_mismatch" },
    });
  }

  await assertPromotable(transaction, {
    organizationId,
    repositoryId: input.repositoryId,
    sourceArtifactVersionId: provenance.sourceArtifactVersionId,
    confidence: provenance.confidence,
    conflictScan: provenance.conflictScan,
    topic: input.subject,
  });

  const entry = await transaction.query<MemoryRow>(
    `insert into bakery.memory_entries
       (organization_id, repository_id, topic, tags, status)
     values ($1, $2, $3, $4::jsonb, 'active')
     returning id, repository_id, topic, tags, current_revision_id, status,
               created_at, updated_at, version`,
    [organizationId, input.repositoryId, input.subject, JSON.stringify([])],
  );
  const created = entry.rows[0];

  const revision = await transaction.query<RevisionRow>(
    `insert into bakery.memory_revisions
       (organization_id, memory_id, revision, body, reason,
        source_artifact_version_id, confidence, expires_at, created_by)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8)
     returning ${REVISION_COLUMNS.replace(/\br\./g, "")}`,
    [
      organizationId,
      created.id,
      input.content,
      "initial promotion",
      provenance.sourceArtifactVersionId,
      provenance.confidence,
      provenance.expiresAt ?? null,
      principalId,
    ],
  );

  // The pointer moves in the same transaction that wrote the revision, so a
  // reader never sees an active entry with no current revision.
  const updated = await transaction.query<MemoryRow>(
    `update bakery.memory_entries
        set current_revision_id = $1, updated_at = now()
      where organization_id = $2 and id = $3
      returning id, repository_id, topic, tags, current_revision_id, status,
                created_at, updated_at, version`,
    [revision.rows[0].id, organizationId, created.id],
  );
  const row = updated.rows[0];
  await appendMemoryEvent(context, transaction, {
    organizationId,
    eventType: "memories.created",
    memoryId: row.id,
    repositoryId: row.repository_id,
    version: Number(row.version),
  });
  return (await entriesForReader(context, transaction, organizationId, [row]))[
    0
  ];
}

export async function addMemoryRevision(
  context: ActionContext,
  rawInput: unknown,
  memoryId: string,
): Promise<MemoryRevision> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<
    typeof contractSchemas.MemoryRevisionCreate
  >;

  // Lock the entry: two concurrent corrections must not both compute the same
  // next revision number from the same current one.
  const current = await transaction.query<MemoryRow>(
    `select id, repository_id, topic, tags, current_revision_id, status,
            created_at, updated_at, version
       from bakery.memory_entries
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, memoryId],
  );
  const entry = current.rows[0];
  if (!entry) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "memory_not_found" },
    });
  }
  if (entry.status === "retired") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      detail: "A retired entry cannot be revised.",
      params: { reason: "memory_retired" },
    });
  }

  // A correction is new evidence about the same topic, so it faces the same
  // checks a promotion does, excluding the entry it corrects.
  await assertSourceArtifactHeld(transaction, {
    organizationId,
    sourceArtifactVersionId: input.sourceArtifactVersionId,
  });
  await assertRepositoryInScope(transaction, {
    organizationId,
    repositoryId: entry.repository_id,
  });
  await assertNoConflictingActiveEntry(transaction, {
    organizationId,
    repositoryId: entry.repository_id,
    topic: entry.topic,
    excludeMemoryId: memoryId,
  });

  // The entry's own standing confidence, not the accepting minimum. Storing the
  // constant silently rewrote how well evidenced the memory was every time a
  // correction landed.
  const standing = await transaction.query<{ confidence: string | null }>(
    `select confidence from bakery.memory_revisions
      where organization_id = $1 and id = $2`,
    [organizationId, entry.current_revision_id],
  );
  const inheritedConfidence = Number(
    standing.rows[0]?.confidence ?? MEMORY_MINIMUM_ACCEPTING_CONFIDENCE,
  );
  assertConfidenceAcceptable(inheritedConfidence);

  const next = await transaction.query<{ next: number }>(
    `select coalesce(max(revision), 0) + 1 as next
       from bakery.memory_revisions
      where organization_id = $1 and memory_id = $2`,
    [organizationId, memoryId],
  );

  const inserted = await transaction.query<RevisionRow>(
    `insert into bakery.memory_revisions
       (organization_id, memory_id, revision, body, reason,
        source_artifact_version_id, supersedes_id, confidence, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${REVISION_COLUMNS.replace(/\br\./g, "")}`,
    [
      organizationId,
      memoryId,
      Number(next.rows[0].next),
      input.content,
      input.reason,
      input.sourceArtifactVersionId,
      entry.current_revision_id,
      // The entry's own standing confidence, carried forward unchanged.
      inheritedConfidence,
      principalId,
    ],
  );

  const moved = await transaction.query<{ version: number }>(
    `update bakery.memory_entries
        set current_revision_id = $1,
            updated_at = now(),
            version = version + 1
      where organization_id = $2 and id = $3
      returning version`,
    [inserted.rows[0].id, organizationId, memoryId],
  );
  await appendMemoryEvent(context, transaction, {
    organizationId,
    eventType: "memory.revised",
    memoryId,
    repositoryId: entry.repository_id,
    version: Number(moved.rows[0].version),
  });
  return (await revisionsForReader(context, transaction, organizationId, [
    inserted.rows[0],
  ]))[0];
}

export async function listMemoryRevisions(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  memoryId: string,
): Promise<{ items: MemoryRevision[]; nextCursor: string | null }> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const limit = search.limit ?? 25;
  const after = search.cursor ? Number(search.cursor) : null;
  const rows = await transaction.query<RevisionRow>(
    `select ${REVISION_COLUMNS}
       from bakery.memory_revisions r
      where r.organization_id = $1 and r.memory_id = $2
        and ($3::int is null or r.revision < $3)
      order by r.revision desc
      limit $4`,
    [organizationId, memoryId, after, limit + 1],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: await revisionsForReader(
      context,
      transaction,
      organizationId,
      visible,
    ),
    nextCursor: rows.rows.length > limit && last ? String(last.revision) : null,
  };
}

export async function getMemory(
  context: ActionContext,
  memoryId: string,
): Promise<MemoryEntry> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const rows = await transaction.query<MemoryRow>(
    `select ${MEMORY_COLUMNS}
       from bakery.memory_entries m
      where m.organization_id = $1 and m.id = $2`,
    [organizationId, memoryId],
  );
  if (rows.rows.length === 0) {
    // Scoped by organization, so another tenant's memory is not found rather
    // than forbidden.
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "memory_not_found" },
    });
  }
  return (await entriesForReader(context, transaction, organizationId, [
    rows.rows[0],
  ]))[0];
}

/**
 * Change an entry's subject or lifecycle status.
 *
 * Status can only move to `active` or `retired`. There is no `rejected`: a
 * refused promotion never wrote a row to move, which is what keeps "not
 * accepted" from becoming a status someone could filter incorrectly.
 */
export async function updateMemory(
  context: ActionContext,
  rawInput: unknown,
  memoryId: string,
): Promise<MemoryEntry> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const input = rawInput as z.output<typeof contractSchemas.MemoryUpdate>;

  // The version the caller read is part of the update, not decoration: an edit
  // computed against a stale read must fail rather than silently win.
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({
      code: "PRECONDITION_REQUIRED",
      params: { reason: "if_match_required" },
    });
  }

  // Moving an active entry onto another active entry's topic makes two active
  // entries share one topic just as surely as reactivating a retired one does,
  // so the subject change faces the same check and the same exemption for the
  // entry itself.
  if (input.subject !== undefined && input.status !== "retired") {
    const current = await transaction.query<
      { repository_id: string; topic: string; status: string }
    >(
      `select repository_id, topic, status from bakery.memory_entries
        where organization_id = $1 and id = $2`,
      [organizationId, memoryId],
    );
    const entry = current.rows[0];
    if (entry && entry.status === "active" && entry.topic !== input.subject) {
      await assertNoConflictingActiveEntry(transaction, {
        organizationId,
        repositoryId: entry.repository_id,
        topic: input.subject,
        excludeMemoryId: memoryId,
      });
    }
  }

  // Reactivation is a promotion claim, not a flag flip. Setting status back to
  // active would otherwise put a second active entry on a topic that already has
  // one, which is the exact state AC1 exists to prevent. It faces the same
  // checks a first promotion does, judged by the evidence the entry already
  // carries.
  if (input.status === "active") {
    const existing = await transaction.query<{
      repository_id: string;
      topic: string;
      status: string;
      source_artifact_version_id: string | null;
      confidence: string | null;
    }>(
      `select m.repository_id, m.topic, m.status,
              r.source_artifact_version_id, r.confidence
         from bakery.memory_entries m
         left join bakery.memory_revisions r
           on r.organization_id = m.organization_id
          and r.id = m.current_revision_id
        where m.organization_id = $1 and m.id = $2`,
      [organizationId, memoryId],
    );
    const current = existing.rows[0];
    if (current && current.status !== "active") {
      // An entry with no revision has no evidence, so it cannot be reactivated
      // by claiming active: there is nothing to judge it by.
      if (current.source_artifact_version_id === null) {
        throw new MemoryPromotionRefused(
          "source_artifact_unknown",
          "The entry has no revision, so there is no evidence to reactivate it on.",
        );
      }
      const topic = input.subject ?? current.topic;
      await assertSourceArtifactHeld(transaction, {
        organizationId,
        sourceArtifactVersionId: current.source_artifact_version_id,
      });
      await assertRepositoryInScope(transaction, {
        organizationId,
        repositoryId: current.repository_id,
      });
      await assertNoConflictingActiveEntry(transaction, {
        organizationId,
        repositoryId: current.repository_id,
        topic,
        excludeMemoryId: memoryId,
      });
      assertConfidenceAcceptable(Number(current.confidence ?? 0));
    }
  }

  const rows = await transaction.query<MemoryRow>(
    `update bakery.memory_entries
        set topic = coalesce($1, topic),
            status = coalesce($2, status),
            updated_at = now(),
            version = version + 1
      where organization_id = $3 and id = $4 and version = $5
      returning id, repository_id, topic, tags, current_revision_id, status,
                created_at, updated_at, version`,
    [
      input.subject ?? null,
      input.status ?? null,
      organizationId,
      memoryId,
      expectedVersion,
    ],
  );
  if (rows.rows.length === 0) {
    // Distinguish "someone else changed it" from "it is not here", so a caller
    // that should re-read is told to rather than left guessing.
    const exists = await transaction.query<{ id: string }>(
      `select id from bakery.memory_entries where organization_id = $1 and id = $2`,
      [organizationId, memoryId],
    );
    throw new StandardError({
      code: exists.rows.length === 0
        ? "RESOURCE_NOT_FOUND"
        : "PRECONDITION_FAILED",
      params: {
        reason: exists.rows.length === 0
          ? "memory_not_found"
          : "memory_version_stale",
      },
    });
  }
  const row = rows.rows[0];
  await appendMemoryEvent(context, transaction, {
    organizationId,
    eventType: "memories.updated",
    memoryId: row.id,
    repositoryId: row.repository_id,
    version: Number(row.version),
  });
  return (await entriesForReader(context, transaction, organizationId, [row]))[
    0
  ];
}

/** One row per accepted entry, newest first, joined to its current revision. */
export async function listMemory(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
): Promise<{ items: MemoryEntry[]; nextCursor: string | null }> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const limit = search.limit ?? 25;
  const after = search.cursor ?? null;
  const rows = await transaction.query<MemoryRow & { cursor_at: string }>(
    `select ${MEMORY_COLUMNS},
            to_char(m.created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
       from bakery.memory_entries m
      where m.organization_id = $1
        and ($2::timestamptz is null
             or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
      order by m.created_at desc, m.id desc
      limit $4`,
    [organizationId, after, after, limit + 1],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: await entriesForReader(
      context,
      transaction,
      organizationId,
      visible,
    ),
    nextCursor: rows.rows.length > limit && last ? last.cursor_at : null,
  };
}
