import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  type ArtifactKindDefinition,
  artifactKindDefinitionBytes,
  artifactKindDefinitionDefects,
  ArtifactKindDefinitionSchema,
  MAX_KIND_DEFINITION_BYTES,
} from "@bakery/contracts/artifact-kinds";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { lockAndReauthorize } from "../repository-rules/postgres.ts";

const KIND_COLUMNS = `k.id,
  k.organization_id as "organizationId",
  k.key,
  v.revision,
  v.definition,
  v.digest,
  v.created_at as "createdAt",
  v.created_by as "createdBy"`;

const VERSION_COLUMNS = `v.id,
  v.organization_id as "organizationId",
  v.kind_id as "kindId",
  k.key,
  v.revision,
  v.definition,
  v.digest,
  v.created_at as "createdAt",
  v.created_by as "createdBy"`;

const KIND_ORDERING = "createdAt:desc,id:desc";
const VERSION_ORDERING = "revision:desc,id:desc";

export type ArtifactKindRow = {
  id: string;
  organizationId: string;
  key: string;
  revision: number;
  definition: unknown;
  digest: string;
  createdAt: Date | string;
  createdBy: string | null;
};

export type ArtifactKindVersionRow = ArtifactKindRow & { kindId: string };

type CursorQueryInput = { cursor?: string; limit?: number };

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * Digest of a published kind version: SHA-256 hex of the canonical JSON of
 * `{ key, revision, definition }`.
 *
 * The definition is hashed after parsing, not as it arrived, so key order in the
 * request cannot change the digest. A reader recomputes it from the returned
 * fields, which is what makes the digest a check on the response rather than a
 * value to trust.
 */
export async function artifactKindVersionDigest(
  key: string,
  revision: number,
  definition: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson({ key, revision, definition }));
}

function storedDefinition(row: ArtifactKindRow): ArtifactKindDefinition {
  // The row was written from a parsed definition, so this can only fail on a
  // database that was edited by hand - which is exactly the case a reader must
  // not paper over by returning whatever was stored.
  const parsed = ArtifactKindDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) throw new Error("ARTIFACT_KIND_DEFINITION_CORRUPT");
  return parsed.data;
}

function toKind(row: ArtifactKindRow, definition: ArtifactKindDefinition) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    revision: row.revision,
    definition,
    digest: row.digest,
    createdAt: toIso(row.createdAt),
    createdBy: row.createdBy,
  };
}

function toVersion(
  row: ArtifactKindVersionRow,
  definition: ArtifactKindDefinition,
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kindId: row.kindId,
    key: row.key,
    revision: row.revision,
    definition,
    digest: row.digest,
    createdAt: toIso(row.createdAt),
    createdBy: row.createdBy,
  };
}

/**
 * Refuses defects in a definition with a typed 422 naming every one of them.
 *
 * All of them at once, because an author fixing five problems should not have to
 * publish five times to discover them.
 */
function refuse(
  defects: ReadonlyArray<{
    path: (string | number)[];
    code: string;
    message: string;
  }>,
): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: defects.map((defect) => ({
        path: defect.path,
        code: defect.code,
        message: defect.message,
      })),
    },
  });
}

/**
 * Lists the organization's kinds, each resolved to its latest version.
 *
 * The latest version per kind is found with `distinct on`, so a kind with fifty
 * revisions costs one row here rather than fifty. Ordered and keyset by the
 * kind's creation time, which is stable across republication: re-publishing a
 * kind does not move it in this list, so a cursor taken before a publication
 * still means what it meant.
 */
export function createArtifactKindsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as CursorQueryInput;
    const limit = query.limit ?? 25;
    const binding: CursorBinding = {
      action: "artifactKinds.list",
      principalId,
      organizationId,
      ordering: KIND_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const result = await transaction.query<
      ArtifactKindRow & { cursorCreatedAt: string }
    >(
      `with latest as (
         select distinct on (v.kind_id)
                v.kind_id, v.id, v.revision, v.definition, v.digest,
                v.created_at, v.created_by
           from bakery.artifact_kind_versions v
          where v.organization_id = $1
          order by v.kind_id, v.revision desc
       )
       select ${KIND_COLUMNS},
              to_char(k.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
         from bakery.artifact_kinds k
         join latest v on v.kind_id = k.id
        where k.organization_id = $1
          and ($2::text is null or (k.created_at, k.id) < ($2::timestamptz, $3::uuid))
        order by k.created_at desc, k.id desc
        limit $4`,
      [
        organizationId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => toKind(row, storedDefinition(row))),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursorCreatedAt,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * Reads one kind by key, resolved to its latest version.
 *
 * The organization predicate is explicit and paired with the key: a kind of
 * another organization is not found, not forbidden, so the answer never confirms
 * that another tenant has a kind by that name.
 */
export async function getArtifactKind(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const key = (context.params as { key: string }).key;
  const result = await transaction.query<ArtifactKindRow>(
    `with latest as (
       select distinct on (v.kind_id)
              v.kind_id, v.id, v.revision, v.definition, v.digest,
              v.created_at, v.created_by
         from bakery.artifact_kind_versions v
        where v.organization_id = $1
        order by v.kind_id, v.revision desc
     )
     select ${KIND_COLUMNS}
       from bakery.artifact_kinds k
       join latest v on v.kind_id = k.id
      where k.organization_id = $1 and k.key = $2`,
    [organizationId, key],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toKind(row, storedDefinition(row));
}

/**
 * Publishes a new immutable version of one kind.
 *
 * The kind identity is created by the first publication, in the same
 * transaction, so an author publishes a first version rather than registering a
 * kind and then publishing to it. Everything after that is insert-only: the
 * revision is the previous maximum plus one, and the unique key on
 * `(organization, kind, revision)` turns a racing publisher into a
 * PRECONDITION_FAILED rather than two rows claiming the same revision.
 *
 * The definition is validated in three passes and each exists for a distinct
 * failure: the schema refuses a wrong shape, the cross-item checks refuse
 * duplicates and options a rule type does not read, and the size check refuses a
 * definition too large to hand to every publisher. None of them can evaluate
 * customer code, because a definition has nowhere to put any.
 */
export async function publishArtifactKindVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as { expectedRevision: number; definition: unknown };
  requireCommandMetadata(context);
  // Reuses the repository-rules lock: it takes the shared
  // `bakery:organization:<id>` key and re-resolves the caller under it, so a role
  // removed while this request waited is refused instead of publishing under an
  // authority the caller no longer has.
  await lockAndReauthorize(
    context,
    "artifactKind:manage",
    "artifactKindVersions.create",
  );
  const anyKey = (value.definition as { key?: unknown } | null)?.key;
  const key = typeof anyKey === "string" ? anyKey : null;
  const pathKey = (context.params as { key: string }).key;
  // The key is in the path and in the body. They must agree, because a
  // publication that addressed one kind while defining another would create a
  // kind nobody addressed under a revision this call claimed to be publishing.
  if (key !== null && key !== pathKey) {
    refuse([{
      path: ["definition", "key"],
      code: "kind_key_mismatch",
      message:
        `The definition names ${key} but the path addresses ${pathKey}; a publication must not rename the kind it addresses.`,
    }]);
  }
  const kind = await transaction.query<{ id: string }>(
    `select id from bakery.artifact_kinds
      where organization_id = $1 and key = $2`,
    [organizationId, pathKey],
  );
  const kindId = kind.rows[0]?.id ?? null;
  // Serialize publishers of one kind with an advisory lock rather than
  // `select ... for update`. The kind tables are insert-only - bakery_app has no
  // UPDATE privilege on them, which is what makes a published revision
  // immutable - and a row lock needs UPDATE.
  //
  // The lock key is the uniqueness key of
  // `artifact_kind_versions_revision_unique`, which is
  // (organization_id, kind_id, *not* key). Both halves matter, and a future
  // rename or a second key resolving to the same kind would make them disagree
  // silently: the lock would then serialize a different pair of requests than
  // the constraint protects, so two publishers could pass the expectedRevision
  // check under different locks and collide at insert instead of being ordered.
  // pin: artifact-kinds-lock-key-matches-unique-constraint
  await transaction.query(
    `select pg_advisory_xact_lock(
       hashtextextended($1::text || ':' || $2::text, 0))`,
    [organizationId, kindId ?? `new:${pathKey}`],
  );
  const latest = kindId === null ? 0 : (await transaction.query<
    { max: number }
  >(
    `select coalesce(max(revision), 0)::integer as max
       from bakery.artifact_kind_versions
      where organization_id = $1 and kind_id = $2`,
    [organizationId, kindId],
  )).rows[0]?.max ?? 0;
  if (latest !== value.expectedRevision) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const revision = latest + 1;
  const parsed = ArtifactKindDefinitionSchema.safeParse({
    ...(value.definition as object),
    // The server owns the revision-independent identity: the key comes from the
    // path, so a body that omitted it is not a way to publish to no kind.
    key: pathKey,
  });
  if (!parsed.success) {
    refuse(parsed.error.issues.map((issue) => ({
      // Zod types a path segment as a PropertyKey; the wire reports the string
      // and number segments an author can act on, which is all a path carries.
      path: issue.path.map((segment) =>
        typeof segment === "symbol" ? String(segment) : segment as
          | string
          | number
      ),
      code: issue.code,
      message: issue.message,
    })));
  }
  const definition = parsed.data;
  // Only refuse when there is something to refuse: an empty defect list is a
  // valid definition, not a failure with no reason.
  const defects = artifactKindDefinitionDefects(definition);
  if (defects.length > 0) refuse(defects);
  if (artifactKindDefinitionBytes(definition) > MAX_KIND_DEFINITION_BYTES) {
    refuse([{
      path: ["definition"],
      // Not a schema issue but still an author error: the definition is legal and
      // too large, which is a size verdict rather than a shape one.
      code: "artifact_kind_too_large",
      message:
        `A kind definition must stay within ${MAX_KIND_DEFINITION_BYTES} canonical bytes so every publisher computes the same digest for it.`,
    }]);
  }
  const digest = await artifactKindVersionDigest(
    pathKey,
    revision,
    definition,
  );
  const resolvedKindId = kindId ?? crypto.randomUUID();
  if (kindId === null) {
    await transaction.query(
      `insert into bakery.artifact_kinds (id, organization_id, key, created_by)
       values ($1, $2, $3, $4)`,
      [resolvedKindId, organizationId, pathKey, principalId],
    );
  }
  const versionId = crypto.randomUUID();
  let inserted: Awaited<
    ReturnType<typeof transaction.query<ArtifactKindVersionRow>>
  >;
  try {
    inserted = await transaction.query<ArtifactKindVersionRow>(
      `insert into bakery.artifact_kind_versions (
         id, organization_id, kind_id, revision, definition, digest, created_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       returning id, organization_id as "organizationId",
                 kind_id as "kindId", revision, definition, digest,
                 created_at as "createdAt", created_by as "createdBy"`,
      [
        versionId,
        organizationId,
        resolvedKindId,
        revision,
        JSON.stringify(definition),
        digest,
        principalId,
      ],
    );
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "PRECONDITION_FAILED", cause: error });
    }
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) throw new Error("ARTIFACT_KIND_VERSION_INSERT_FAILED");
  // No outbox row, following the repository-rules and agents precedent: an
  // unmapped Inngest event would make outbox delivery fail with
  // EVENT_TRIGGER_UNMAPPED.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifactKindVersions.create",
    resourceType: "artifact_kind_version",
    resourceId: versionId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "artifactKinds.published",
    aggregateId: versionId,
    aggregateVersion: revision,
    payload: {
      resourceId: versionId,
      resourceVersion: revision,
      kindId: resolvedKindId,
      key: pathKey,
    },
    traceId: context.traceId,
  });
  return toVersion({ ...row, key: pathKey }, definition);
}

/** One kind's published versions, newest revision first, keyset by revision. */
export function createArtifactKindVersionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const key = (context.params as { key: string }).key;
    const query = input as CursorQueryInput;
    const limit = query.limit ?? 25;
    const kind = await transaction.query<{ id: string }>(
      `select id from bakery.artifact_kinds
        where organization_id = $1 and key = $2`,
      [organizationId, key],
    );
    const kindId = kind.rows[0]?.id;
    // A key nobody has published yet is not found rather than an empty page: an
    // empty page would be indistinguishable from a kind whose versions were all
    // removed, and versions are never removed.
    if (!kindId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const binding: CursorBinding = {
      action: "artifactKindVersions.list",
      principalId,
      organizationId,
      ordering: VERSION_ORDERING,
      filters: JSON.stringify({ kindId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const result = await transaction.query<ArtifactKindVersionRow>(
      `select ${VERSION_COLUMNS}
         from bakery.artifact_kind_versions v
         join bakery.artifact_kinds k
           on k.organization_id = v.organization_id and k.id = v.kind_id
        where v.organization_id = $1
          and v.kind_id = $2
          and ($3::integer is null or (v.revision, v.id) < ($3, $4::uuid))
        order by v.revision desc, v.id desc
        limit $5`,
      [
        organizationId,
        kindId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => toVersion(row, storedDefinition(row))),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: last.revision,
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}
