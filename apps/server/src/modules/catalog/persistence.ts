import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas, type JsonValue } from "@bakery/contracts/contracts";
import { z } from "zod";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { assertNotQuiesced } from "../../platform/maintenance.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  hiddenArtifactIds,
  reviewerIsolationOf,
} from "../knowledge/reviewer-isolation.ts";
import { assertMayAuthorSkill, SKILL_VISIBLE_TO } from "./skill-scope-guard.ts";
import { insertLocalSkillIdentity } from "./skill-identity.ts";
import {
  checkSkillDraft,
  deleteSkillDraftFile,
  discardSkillDraft,
  getSkillDraft,
  getSkillDraftFile,
  openSkillDraft,
  renameSkillDraftFile,
  saveSkillDraftFile,
  updateSkillDraft,
} from "./skill-drafts.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import { listSkillUsage } from "./skill-usage.ts";
import {
  type ArchiveRevisionContext,
  ArchiveRevisionPreflightRollbackError,
  archiveRevisionStage,
} from "./archive-revision.ts";
import {
  type SkillVersionRow,
  toSkillVersion,
  VERSION_COLUMNS,
} from "./publication.ts";
import { deleteSkillUseGrant, listSkillUseGrants } from "./skill-use-grants.ts";
import {
  type RunRow,
  runWorkspaceBaseShaColumn,
  toRun,
} from "../work/run-command.ts";
import {
  normalizeSkillSourceLocator,
  normalizeSkillSourcePath,
  normalizeSkillSourceRevision,
  SkillSourceAdapterError,
} from "./source-adapters.ts";

const PAGE_ORDERING = "createdAt:desc,id:desc";
const SOURCE_COLUMNS =
  `id, display_name, source_type, locator, publisher, license,
  last_checked_at, enabled, created_at, updated_at, version`;
export const SKILL_COLUMNS =
  `id, source_id, slug, name, description, active_version_id, enabled,
  scope, owner_principal_id, copied_from_skill_id, copied_from_version_id,
  created_at, updated_at, version`;
const IMPORT_RUN_COLUMNS = `run.id, run.kind, run.task_id,
  run.workflow_version_id, run.skill_source_id, run.repository_profile_id,
  run.repository_profile_revision, run.repository_profile_digest,
  run.observation_id, run.observation_digest, run.base_sha, run.requested_by,
  run.inngest_run_id, run.status, run.budget_limit_usd, run.started_at,
  run.finished_at, run.created_at, run.updated_at, run.version,
  ${runWorkspaceBaseShaColumn("run")}`;

type CursorInput = { cursor?: string; limit?: number };
type SourceCreateInput = z.output<typeof contractSchemas.SkillSourceCreate>;
type SourceUpdateInput = { name?: string; enabled?: boolean };
type SkillDraftUpdateInput = z.output<typeof contractSchemas.SkillDraftUpdate>;
type SkillDraftFileSaveInput = z.output<
  typeof contractSchemas.SkillDraftFileSave
>;
type SkillCreateInput = {
  slug: string;
  name: string;
  scope?: "global" | "organization" | "personal";
};
type SkillImportInput = z.output<typeof contractSchemas.SkillImport>;
type SkillUpdateInput = {
  name?: string;
  description?: string | null;
  enabled?: boolean;
};

/** Persistence-boundary contract for creating a local skill identity. */
export const SkillCreatePersistenceSchema = z.object({
  slug: z.string().min(1).max(120).describe("Tenant-unique skill slug."),
  name: z.string().min(1).max(200).describe("Human-readable skill name."),
  scope: z.enum(["global", "organization", "personal"]).optional().describe(
    "Whether the skill comes with Bakery, belongs to the organization or only to its creator.",
  ),
}).describe(
  "Validated local skill identity fields accepted before SQL writes.",
);

function requireSkillCreatePersistence(
  input: SkillCreateInput,
): SkillCreateInput {
  const result = SkillCreatePersistenceSchema.safeParse(input);
  if (!result.success) throw new StandardError({ code: "UNPROCESSABLE" });
  return result.data;
}

export const SkillSourceRegistrationPersistenceSchema = z.object({
  sourceType: z.enum(["git", "url"]).describe(
    "Explicit supported remote source type.",
  ),
  url: z.string().url().max(2_000).describe(
    "Canonical credential-free HTTPS source locator.",
  ),
  name: z.string().trim().min(1).max(200).describe(
    "Human-readable remote source name.",
  ),
  license: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/).describe(
    "Printable registered source license identifier.",
  ),
}).strict().describe(
  "Validated remote git or URL source registration before persistence.",
);

export const SkillImportAdmissionPersistenceSchema = z.object({
  sourceId: z.string().uuid().describe("Registered remote source UUID."),
  revision: z.string().min(1).max(255).optional().describe(
    "Requested Git revision, strong HTTP ETag or sha256: content digest; a web-address archive may omit it and is pinned by its digest.",
  ),
  label: z.string().trim().min(1).max(200).optional().describe(
    "Optional name for the version the import makes.",
  ),
  scope: z.enum(["organization", "personal"]).optional().describe(
    "Whether the imported skill is the organization's (default) or the importer's own.",
  ),
  path: z.string().max(500).optional().describe(
    "Optional normalized path containing the imported skill.",
  ),
}).strict().describe(
  "Validated pinned skill import identity before durable admission.",
);

function invalidSourceInput(error?: unknown): never {
  throw new StandardError({ code: "UNPROCESSABLE", cause: error });
}

type SkillSourceRow = {
  id: string;
  display_name: string | null;
  source_type: "git" | "url" | "local_bundle";
  locator: string;
  publisher: string | null;
  license: string | null;
  last_checked_at: Date | string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};
export type SkillRow = {
  id: string;
  source_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  enabled: boolean;
  scope: "global" | "organization" | "personal";
  owner_principal_id: string | null;
  copied_from_skill_id: string | null;
  copied_from_version_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};
type ExistingSkillImportRow = RunRow & {
  registered_source_type: "git" | "url";
  registered_locator: string;
  registered_license: string;
};

type PageRow<T> = T & { cursor_created_at: string };

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toSkillSource(row: SkillSourceRow) {
  return {
    id: row.id,
    name: row.display_name,
    sourceType: row.source_type,
    locator: row.locator,
    publisher: row.publisher,
    license: row.license,
    lastCheckedAt: row.last_checked_at === null
      ? null
      : toIso(row.last_checked_at),
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toSkill(row: SkillRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    activeVersionId: row.active_version_id,
    enabled: row.enabled,
    scope: row.scope,
    ownerPrincipalId: row.owner_principal_id,
    copiedFromSkillId: row.copied_from_skill_id,
    copiedFromVersionId: row.copied_from_version_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export async function boundedMutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    const code = postgresErrorCode(error);
    if (code === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "STATE_CONFLICT", cause: error });
    }
    if (["22001", "22P02", "23502", "23503"].includes(code ?? "")) {
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    }
    throw error;
  }
}

export async function recordMutation(
  transaction: PgTransactionClient,
  context: ActionContext,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    eventType: string;
    resourceType: string;
    resourceId: string;
    resourceVersion: number;
  },
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: options.organizationId,
    principalId: options.principalId,
    operation: options.operation,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: options.organizationId,
    eventType: options.eventType,
    aggregateId: options.resourceId,
    aggregateVersion: options.resourceVersion,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.resourceVersion,
    },
    traceId: context.traceId,
  });
}

function idFromPath(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

async function listPage<
  T extends { id: string },
  O extends JsonValue,
>(options: {
  transaction: PgTransactionClient;
  organizationId: string;
  principalId: string;
  input: CursorInput;
  secret: string;
  action: string;
  table: "skill_sources" | "skills";
  columns: string;
  project: (row: T) => O;
  /** Only skills of this scope; the cursor is bound to it. Skills only. */
  scope?: "global" | "organization" | "personal";
  /** Only skills whose name contains this text; the cursor is bound to it. */
  q?: string;
}) {
  const visibility = options.table === "skills"
    ? `and ${SKILL_VISIBLE_TO("$5")}`
    : "";
  const scopeFilter = options.scope !== undefined
    ? "and scope = $6::text"
    : options.q !== undefined
    ? "and $6::text is null"
    : "";
  // strpos, not LIKE, so a % or _ in the text is matched literally.
  const nameFilter = options.q === undefined
    ? ""
    : "and strpos(lower(name), lower($7::text)) > 0";
  const binding: CursorBinding = {
    action: options.action,
    principalId: options.principalId,
    organizationId: options.organizationId,
    ordering: PAGE_ORDERING,
    filters: options.scope === undefined && options.q === undefined
      ? "{}"
      : options.q === undefined
      ? JSON.stringify({ scope: options.scope })
      : await sha256Hex(
        canonicalJson({ scope: options.scope ?? null, q: options.q }),
      ),
    schemaVersion: 1,
  };
  const position = await decodeCursor(
    options.secret,
    options.input.cursor,
    binding,
  );
  const limit = options.input.limit ?? 25;
  const result = await options.transaction.query<PageRow<T>>(
    `select ${options.columns},
       to_char(created_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from bakery.${options.table}
      where organization_id = $1
        and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        ${visibility}
        ${scopeFilter}
        ${nameFilter}
      order by created_at desc, id desc
      limit $4`,
    [
      options.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
      ...(visibility === "" ? [] : [options.principalId]),
      ...(scopeFilter === "" ? [] : [options.scope ?? null]),
      ...(nameFilter === "" ? [] : [options.q]),
    ],
  );
  const visible = result.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(options.project),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(options.secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

type LibrarySearchInput = z.output<typeof contractSchemas.LibrarySearchQuery>;
type LibrarySearchRow = {
  kind: "skill" | "agent" | "artifact";
  id: string;
  name: string;
  description: string | null;
  created_at: Date | string;
  cursor_created_at: string;
};

/**
 * Finds skills, agents and artifacts of one organization by text.
 *
 * Matching is a case-insensitive substring over the name (and the description,
 * where the kind has one), done with `strpos` so a `%` or `_` typed by the
 * caller is matched literally rather than as a wildcard. The page is keyset
 * ordered by (created_at, id) across the three tables, and its cursor is bound
 * to the caller, the organization, the query text and the kind filter, so a
 * cursor cannot be replayed against a different search.
 */
async function searchLibraryPage(options: {
  transaction: PgTransactionClient;
  organizationId: string;
  principalId: string;
  input: LibrarySearchInput;
  secret: string;
  /** False when a session lacks the scope artifacts need; see below. */
  includeArtifacts: boolean;
}) {
  const kind = options.input.kind ?? null;
  const binding: CursorBinding = {
    action: "library.search",
    principalId: options.principalId,
    organizationId: options.organizationId,
    ordering: PAGE_ORDERING,
    // Hashed: the query is up to 200 characters (600 bytes in UTF-8) and a raw
    // copy would overflow the cursor's size limit on the first full page.
    filters: await sha256Hex(
      canonicalJson({ query: options.input.query, kind }),
    ),
    schemaVersion: 1,
  };
  const position = await decodeCursor(
    options.secret,
    options.input.cursor,
    binding,
  );
  const limit = options.input.limit ?? 25;
  const result = await options.transaction.query<LibrarySearchRow>(
    `select kind, id, name, description, created_at,
            to_char(created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from (
         select 'skill'::text as kind, id, name, description, created_at
           from bakery.skills
          where organization_id = $1 and ($5::text is null or $5 = 'skill')
            and (scope <> 'personal' or owner_principal_id = $8::uuid)
            and (strpos(lower(name), lower($6)) > 0
              or strpos(lower(coalesce(description, '')), lower($6)) > 0)
         union all
         select 'agent'::text, id, name, description, created_at
           from bakery.agent_definitions
          where organization_id = $1 and ($5::text is null or $5 = 'agent')
            and (strpos(lower(name), lower($6)) > 0
              or strpos(lower(coalesce(description, '')), lower($6)) > 0)
         union all
         select 'artifact'::text, id, name, null::text, created_at
           from bakery.artifacts
          where organization_id = $1 and ($5::text is null or $5 = 'artifact')
            and $7::boolean
            and strpos(lower(name), lower($6)) > 0
       ) as hits
      where ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
      order by created_at desc, id desc
      limit $4`,
    [
      options.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
      kind,
      options.input.query,
      options.includeArtifacts,
      options.principalId,
    ],
  );
  const visible = result.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => ({
      kind: row.kind,
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: toIso(row.created_at),
    })),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(options.secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

/**
 * Admits one pinned import of a source folder at a revision: the same request
 * again is the same run. A reviewed update (skills.takeSourceUpdate) pins the
 * exact revision it showed and records the branch it follows, so the next
 * update check still follows that branch.
 */
export async function admitSkillImport(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: {
    organizationId: string;
    principalId: string;
    source: SkillSourceRow;
    requestedRevision: string;
    sourcePath: string;
    followedRevision?: string;
    scope?: "organization" | "personal";
    ownerPrincipalId?: string | null;
    label?: string;
  },
): Promise<ReturnType<typeof toRun>> {
  const {
    organizationId,
    principalId,
    source,
    requestedRevision,
    sourcePath,
    followedRevision,
    label,
  } = facts;
  const scope = facts.scope ?? "organization";
  const ownerPrincipalId = facts.ownerPrincipalId ?? null;
  const existing = await transaction.query<ExistingSkillImportRow>(
    `select ${IMPORT_RUN_COLUMNS}, import.registered_source_type,
                import.registered_locator, import.registered_license
           from bakery.skill_imports as import
           join bakery.workflow_runs as run
             on run.organization_id = import.organization_id
            and run.id = import.run_id
          where import.organization_id = $1 and import.source_id = $2
            and import.requested_revision = $3 and import.source_path = $4
            and import.scope = $5
            and import.owner_principal_id is not distinct from $6::uuid`,
    [
      organizationId,
      source.id,
      requestedRevision,
      sourcePath,
      scope,
      ownerPrincipalId,
    ],
  );
  const replay = existing.rows[0];
  if (replay) {
    if (
      replay.registered_source_type !== source.source_type ||
      replay.registered_locator !== source.locator ||
      replay.registered_license !== source.license
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "skill_import_source_identity_mismatch" },
      });
    }
    return toRun(replay);
  }
  if (!source.enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_import_source_disabled" },
    });
  }
  const runId = crypto.randomUUID();
  const snapshot = {
    schemaVersion: 1,
    kind: "skill_import",
    source: {
      id: source.id,
      sourceType: source.source_type,
      locator: source.locator,
      license: source.license,
    },
    request: {
      requestedRevision,
      sourcePath,
      ...(followedRevision === undefined ? {} : { followedRevision }),
      ...(label === undefined ? {} : { label }),
    },
  };
  const inserted = await transaction.query<RunRow>(
    `insert into bakery.workflow_runs (
           id, organization_id, kind, task_id, workflow_version_id,
           skill_source_id, requested_by, status, snapshot, budget_limit_usd
         ) values ($1, $2, 'skill_import', null, null, $3, $4, 'queued',
           $5::jsonb, 0)
         returning id, kind, task_id, workflow_version_id, skill_source_id,
           repository_profile_id, repository_profile_revision,
           repository_profile_digest, observation_id, observation_digest,
           base_sha, null::text as workspace_base_sha, requested_by,
           inngest_run_id, status, budget_limit_usd,
           started_at, finished_at, created_at, updated_at, version`,
    [
      runId,
      organizationId,
      source.id,
      principalId,
      JSON.stringify(snapshot),
    ],
  );
  const run = inserted.rows[0];
  if (!run) throw new Error("SKILL_IMPORT_RUN_INSERT_FAILED");
  await transaction.query(
    `insert into bakery.skill_imports (
           id, organization_id, run_id, source_id, requested_revision,
           source_path, registered_source_type, registered_locator,
           registered_license, state, scope, owner_principal_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)`,
    [
      crypto.randomUUID(),
      organizationId,
      run.id,
      source.id,
      requestedRevision,
      sourcePath,
      source.source_type,
      source.locator,
      source.license,
      scope,
      ownerPrincipalId,
    ],
  );
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "skills.import",
    resourceType: "skill_import",
    resourceId: run.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      sourceId: source.id,
      ...(followedRevision === undefined ? {} : { followedRevision }),
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "skill.import.requested",
    aggregateId: run.id,
    aggregateVersion: run.version,
    payload: { runId: run.id },
    traceId: context.traceId,
    outboxDeliveryKey: `skill-import:${run.id}:generation:0`,
  });
  return toRun(run);
}

/**
 * skills.takeSourceUpdate's write: imports the reviewed revision from the
 * skill's own source and folder, and audits that a person took the update.
 */
export async function admitReviewedSkillUpdate(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    skillId: string;
    sourceId: string;
    sourcePath: string;
    revision: string;
    followedRevision: string;
    scope: "organization" | "personal";
    ownerPrincipalId: string | null;
  }>,
): Promise<ReturnType<typeof toRun>> {
  await assertNotQuiesced(transaction, "intake");
  const sourceResult = await transaction.query<SkillSourceRow>(
    `select ${SOURCE_COLUMNS} from bakery.skill_sources
      where organization_id = $1 and id = $2
      for update`,
    [facts.organizationId, facts.sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (source.source_type === "local_bundle") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_has_no_remote_source" },
    });
  }
  let requestedRevision: string;
  try {
    requestedRevision = normalizeSkillSourceRevision(
      source.source_type,
      facts.revision,
    );
  } catch (error) {
    if (error instanceof SkillSourceAdapterError) invalidSourceInput(error);
    throw error;
  }
  const run = await admitSkillImport(transaction, context, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    source,
    requestedRevision,
    sourcePath: facts.sourcePath,
    followedRevision: facts.followedRevision,
    scope: facts.scope,
    ownerPrincipalId: facts.ownerPrincipalId,
  });
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skills.takeSourceUpdate",
    resourceType: "skill",
    resourceId: facts.skillId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      runId: run.id,
      revision: requestedRevision,
      followedRevision: facts.followedRevision,
    },
  });
  return run;
}

export function createCatalogHandlers(
  secret: string,
  options: Readonly<{
    normalizeSourceLocator?: typeof normalizeSkillSourceLocator;
    /** Where a published version's files are read back from, to start a draft. */
    skillFileStore?: SkillFileStoreOperations;
  }> = {},
) {
  const normalizeSourceLocator = options.normalizeSourceLocator ??
    normalizeSkillSourceLocator;
  return {
    async listSources(context: ActionContext, input: CursorInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return await listPage<SkillSourceRow, ReturnType<typeof toSkillSource>>({
        transaction,
        organizationId,
        principalId,
        input,
        secret,
        action: "skillSources.list",
        table: "skill_sources",
        columns: SOURCE_COLUMNS,
        project: toSkillSource,
      });
    },

    async getSource(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const result = await transaction.query<SkillSourceRow>(
        `select ${SOURCE_COLUMNS} from bakery.skill_sources
          where organization_id = $1 and id = $2`,
        [organizationId, idFromPath(context)],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      return toSkillSource(row);
    },

    async createSource(context: ActionContext, input: SourceCreateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      requireCommandMetadata(context);
      const parsed = SkillSourceRegistrationPersistenceSchema.safeParse(input);
      if (!parsed.success) invalidSourceInput(parsed.error);
      let locator: string;
      try {
        locator = normalizeSourceLocator(parsed.data.url);
      } catch (error) {
        if (error instanceof SkillSourceAdapterError) invalidSourceInput(error);
        throw error;
      }
      const sourceId = crypto.randomUUID();
      const result = await boundedMutation(() =>
        transaction.query<SkillSourceRow>(
          `insert into bakery.skill_sources (
             id, organization_id, source_type, locator, display_name,
             publisher, license, last_checked_at, enabled
           ) values ($1, $2, $3, $4, $5, null, $6, null, true)
           returning ${SOURCE_COLUMNS}`,
          [
            sourceId,
            organizationId,
            parsed.data.sourceType,
            locator,
            parsed.data.name,
            parsed.data.license,
          ],
        )
      );
      const row = result.rows[0];
      if (!row) throw new Error("CATALOG_SKILL_SOURCE_INSERT_FAILED");
      await recordMutation(transaction, context, {
        organizationId,
        principalId,
        operation: "skillSources.create",
        eventType: "skillSources.created",
        resourceType: "skill_source",
        resourceId: sourceId,
        resourceVersion: row.version,
      });
      return toSkillSource(row);
    },

    async importSkill(context: ActionContext, input: SkillImportInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      // A backup holds the installation: no import starts until it lets go.
      await assertNotQuiesced(transaction, "intake");
      requireCommandMetadata(context);
      const parsed = SkillImportAdmissionPersistenceSchema.safeParse(input);
      if (!parsed.success) invalidSourceInput(parsed.error);
      const sourceResult = await transaction.query<SkillSourceRow>(
        `select ${SOURCE_COLUMNS} from bakery.skill_sources
          where organization_id = $1 and id = $2
          for update`,
        [organizationId, parsed.data.sourceId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (source.source_type === "local_bundle" || source.license === null) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "skill_import_source_unsupported" },
        });
      }
      // A personal import is its importer's own skill, and only a person owns
      // one; an organization import is an Admin's.
      const scope = parsed.data.scope ?? "organization";
      if (
        scope === "personal" &&
        attributeAction(context, principalId).actorKind !== "person"
      ) {
        throw new StandardError({
          code: "AUTH_FORBIDDEN",
          params: { reason: "personal_skill_requires_person" },
        });
      }
      const ownerPrincipalId = scope === "personal" ? principalId : null;
      await assertMayAuthorSkill(transaction, organizationId, principalId, {
        scope,
        ownerPrincipalId,
      });
      let requestedRevision: string;
      let sourcePath: string;
      let followedRevision: string | undefined;
      try {
        sourcePath = normalizeSkillSourcePath(parsed.data.path);
        if (parsed.data.revision !== undefined) {
          requestedRevision = normalizeSkillSourceRevision(
            source.source_type,
            parsed.data.revision,
          );
        } else {
          // Only an archive at a web address can be pinned by its content; a
          // Git source must name what to import.
          if (source.source_type !== "url") invalidSourceInput();
          const stage = (context as ArchiveRevisionContext)[
            archiveRevisionStage
          ];
          if (stage === undefined) {
            throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
          }
          if (stage.revision === undefined) {
            stage.locator = source.locator;
            stage.path = sourcePath;
            throw new ArchiveRevisionPreflightRollbackError();
          }
          requestedRevision = normalizeSkillSourceRevision(
            source.source_type,
            stage.revision,
          );
          // The next update check reads the address as it is then.
          followedRevision = "";
        }
      } catch (error) {
        if (error instanceof SkillSourceAdapterError) invalidSourceInput(error);
        throw error;
      }
      return await admitSkillImport(transaction, context, {
        organizationId,
        principalId,
        source,
        requestedRevision,
        sourcePath,
        followedRevision,
        scope,
        ownerPrincipalId,
        label: parsed.data.label,
      });
    },

    async updateSource(context: ActionContext, input: SourceUpdateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const sourceId = idFromPath(context);
      const expectedVersion = requireCommandMetadata(context).expectedVersion;
      if (expectedVersion === undefined) {
        throw new StandardError({ code: "PRECONDITION_REQUIRED" });
      }
      const result = await boundedMutation(() =>
        transaction.query<SkillSourceRow>(
          `update bakery.skill_sources
              set display_name = coalesce($4, display_name),
                  enabled = coalesce($5, enabled),
                  updated_at = now(), version = version + 1
            where organization_id = $1 and id = $2 and version = $3
            returning ${SOURCE_COLUMNS}`,
          [
            organizationId,
            sourceId,
            expectedVersion,
            input.name ?? null,
            input.enabled ?? null,
          ],
        )
      );
      const row = result.rows[0];
      if (!row) {
        const visible = await transaction.query(
          "select 1 from bakery.skill_sources where organization_id = $1 and id = $2",
          [organizationId, sourceId],
        );
        throw new StandardError({
          code: visible.rows.length === 1
            ? "PRECONDITION_FAILED"
            : "RESOURCE_NOT_FOUND",
        });
      }
      await recordMutation(transaction, context, {
        organizationId,
        principalId,
        operation: "skillSources.update",
        eventType: "skillSources.updated",
        resourceType: "skill_source",
        resourceId: sourceId,
        resourceVersion: row.version,
      });
      return toSkillSource(row);
    },

    async listSkills(
      context: ActionContext,
      input: z.output<typeof contractSchemas.SkillQuery>,
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return await listPage<SkillRow, ReturnType<typeof toSkill>>({
        transaction,
        organizationId,
        principalId,
        input,
        secret,
        action: "skills.list",
        table: "skills",
        columns: SKILL_COLUMNS,
        project: toSkill,
        scope: input.scope,
        q: input.q,
      });
    },

    async searchLibrary(context: ActionContext, input: LibrarySearchInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      // Artifacts are gated by their own scope (`artifacts.read`), which the
      // `library.read` scope that offers this tool does not imply. A session
      // that holds the one and not the other must not list artifacts through
      // search that `artifacts.list` would refuse it. A person's own request
      // carries no session scopes and is bounded by their permissions alone.
      const includeArtifacts = context.sessionScopes === undefined ||
        context.sessionScopes.includes("artifacts.read");
      if (!includeArtifacts && input.kind === "artifact") {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const page = await searchLibraryPage({
        transaction,
        organizationId,
        principalId,
        input,
        secret,
        includeArtifacts,
      });
      // A reviewer session never finds another step's transcript (O47).
      const hidden = await hiddenArtifactIds(
        transaction,
        await reviewerIsolationOf(transaction, context, organizationId),
        organizationId,
        page.items.filter((item) => item.kind === "artifact").map((item) =>
          item.id
        ),
      );
      return {
        ...page,
        items: page.items.filter((item) =>
          item.kind !== "artifact" || !hidden.has(item.id)
        ),
      };
    },

    async getSkill(context: ActionContext) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const result = await transaction.query<SkillRow>(
        `select ${SKILL_COLUMNS} from bakery.skills
          where organization_id = $1 and id = $2
            and ${SKILL_VISIBLE_TO("$3")}`,
        [organizationId, idFromPath(context), principalId],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      return toSkill(row);
    },

    async createSkill(context: ActionContext, input: SkillCreateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const persistedInput = requireSkillCreatePersistence(input);
      const scope = persistedInput.scope ?? "organization";
      // A global skill comes with Bakery and is never created through the API.
      if (scope === "global") {
        throw new StandardError({
          code: "AUTH_FORBIDDEN",
          params: { reason: "global_skill_comes_with_bakery" },
        });
      }
      // A personal skill is a person's own; an agent or a token never owns one.
      if (
        scope === "personal" &&
        attributeAction(context, principalId).actorKind !== "person"
      ) {
        throw new StandardError({
          code: "AUTH_FORBIDDEN",
          params: { reason: "personal_skill_requires_person" },
        });
      }
      await assertMayAuthorSkill(transaction, organizationId, principalId, {
        scope,
        ownerPrincipalId: scope === "personal" ? principalId : null,
      });
      const skillId = crypto.randomUUID();
      const row = await boundedMutation(() =>
        insertLocalSkillIdentity<SkillRow>(transaction, organizationId, {
          skillId,
          sourceId: crypto.randomUUID(),
          slug: persistedInput.slug,
          name: persistedInput.name,
          scope,
          ownerPrincipalId: scope === "personal" ? principalId : null,
          copiedFrom: null,
        }, SKILL_COLUMNS)
      );
      if (!row) throw new Error("CATALOG_SKILL_INSERT_FAILED");
      await recordMutation(transaction, context, {
        organizationId,
        principalId,
        operation: "skills.create",
        eventType: "skills.created",
        resourceType: "skill",
        resourceId: skillId,
        resourceVersion: row.version,
      });
      return toSkill(row);
    },

    listSkillUseGrants(context: ActionContext, input: CursorInput) {
      return listSkillUseGrants(context, input, secret);
    },

    openSkillDraft(context: ActionContext) {
      return openSkillDraft(context, options.skillFileStore);
    },

    getSkillDraft(context: ActionContext) {
      return getSkillDraft(context);
    },

    updateSkillDraft(context: ActionContext, input: SkillDraftUpdateInput) {
      return updateSkillDraft(context, input);
    },

    discardSkillDraft(context: ActionContext) {
      return discardSkillDraft(context);
    },

    checkSkillDraft(context: ActionContext) {
      return checkSkillDraft(context);
    },

    checkSkillSourceUpdate(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.IdPath>,
    ) {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    // Served behind the staged source runners in routes.ts, like the check.
    takeSkillSourceUpdate(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.SkillSourceUpdateTake>,
    ): Promise<ReturnType<typeof toRun>> {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    saveSkillDraftFile(context: ActionContext, input: SkillDraftFileSaveInput) {
      return saveSkillDraftFile(context, input);
    },

    renameSkillDraftFile(
      context: ActionContext,
      input: z.output<typeof contractSchemas.SkillDraftFileRename>,
    ) {
      return renameSkillDraftFile(context, input);
    },

    getSkillDraftFile(context: ActionContext) {
      return getSkillDraftFile(context);
    },

    deleteSkillDraftFile(context: ActionContext) {
      return deleteSkillDraftFile(context);
    },

    listSkillUsage(context: ActionContext, input: CursorInput) {
      return listSkillUsage(context, input, secret);
    },

    deleteSkillUseGrant(context: ActionContext) {
      return deleteSkillUseGrant(context);
    },

    copySkill(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.SkillCopy>,
    ) {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    publishSkillDraft(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.IdPath>,
    ) {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    createSkillVersion(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.LocalSkillVersion>,
    ) {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    async getSkillImport(context: ActionContext) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const runId = idFromPath(context);
      const result = await transaction.query<{
        run_id: string;
        state:
          | "queued"
          | "resolved"
          | "reserved"
          | "stored"
          | "completed"
          | "failed";
        skill_id: string | null;
        skill_version_id: string | null;
        terminal_fault: { code?: unknown } | null;
        visible: boolean | null;
      }>(
        `select import.run_id, import.state, import.skill_id,
                import.skill_version_id, import.terminal_fault,
                (skill.id is null or skill.scope <> 'personal'
                  or skill.owner_principal_id = $3::uuid) as visible
           from bakery.skill_imports as import
           left join bakery.skills as skill
             on skill.organization_id = import.organization_id
            and skill.id = import.skill_id
          where import.organization_id = $1 and import.run_id = $2`,
        [organizationId, runId, principalId],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      // What it made is reported once it is complete, and only to someone who
      // may see that skill.
      const made = row.state === "completed" && row.visible === true;
      const code = row.terminal_fault?.code;
      return {
        runId: row.run_id,
        state: row.state,
        skillId: made ? row.skill_id : null,
        versionId: made ? row.skill_version_id : null,
        failureCode: row.state === "failed" && typeof code === "string"
          ? code
          : null,
      };
    },

    async listSkillVersions(context: ActionContext, input: CursorInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const skillId = idFromPath(context);
      // The same visibility as skills.get: another person's personal skill is
      // not found, and so are its versions.
      const visible = await transaction.query(
        `select 1 from bakery.skills
          where organization_id = $1 and id = $2 and ${SKILL_VISIBLE_TO("$3")}`,
        [organizationId, skillId, principalId],
      );
      if (visible.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const binding: CursorBinding = {
        action: "skillVersions.list",
        principalId,
        organizationId,
        ordering: PAGE_ORDERING,
        filters: await sha256Hex(canonicalJson({ skillId })),
        schemaVersion: 1,
      };
      const position = await decodeCursor(secret, input.cursor, binding);
      const limit = input.limit ?? 25;
      // A reserved draft is not a version yet: only published and retired
      // versions are listed, newest first (revisions are created in order).
      const result = await transaction.query<
        SkillVersionRow & { cursor_created_at: string }
      >(
        `select ${VERSION_COLUMNS},
                to_char(created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
           from bakery.skill_versions
          where organization_id = $1 and skill_id = $2
            and status <> 'draft'
            and ($3::timestamptz is null or (created_at, id) < ($3, $4::uuid))
          order by created_at desc, id desc
          limit $5`,
        [
          organizationId,
          skillId,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const page = result.rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toSkillVersion),
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            createdAt: last.cursor_created_at,
            id: last.id,
          })
          : null,
      };
    },

    async setSkillActiveVersion(
      context: ActionContext,
      input: { versionId: string },
    ) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const skillId = idFromPath(context);
      const expectedVersion = requireCommandMetadata(context).expectedVersion;
      if (expectedVersion === undefined) {
        throw new StandardError({ code: "PRECONDITION_REQUIRED" });
      }
      const current = await transaction.query<
        Pick<SkillRow, "scope" | "owner_principal_id">
      >(
        `select scope, owner_principal_id from bakery.skills
          where organization_id = $1 and id = $2
            and ${SKILL_VISIBLE_TO("$3")}
          for update`,
        [organizationId, skillId, principalId],
      );
      const target = current.rows[0];
      if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      await assertMayAuthorSkill(transaction, organizationId, principalId, {
        scope: target.scope,
        ownerPrincipalId: target.owner_principal_id,
      });
      // Only a published version of this same skill can be put in use.
      const chosen = await transaction.query<{ status: string }>(
        `select status from bakery.skill_versions
          where organization_id = $1 and skill_id = $2 and id = $3`,
        [organizationId, skillId, input.versionId],
      );
      if (chosen.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      if (chosen.rows[0].status !== "published") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "skill_version_not_published" },
        });
      }
      const result = await transaction.query<SkillRow>(
        `update bakery.skills
            set active_version_id = $4, updated_at = now(),
                version = version + 1
          where organization_id = $1 and id = $2 and version = $3
          returning ${SKILL_COLUMNS}`,
        [organizationId, skillId, expectedVersion, input.versionId],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
      await recordMutation(transaction, context, {
        organizationId,
        principalId,
        operation: "skills.setActiveVersion",
        eventType: "skills.updated",
        resourceType: "skill",
        resourceId: skillId,
        resourceVersion: row.version,
      });
      return toSkill(row);
    },

    async updateSkill(context: ActionContext, input: SkillUpdateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const skillId = idFromPath(context);
      const expectedVersion = requireCommandMetadata(context).expectedVersion;
      if (expectedVersion === undefined) {
        throw new StandardError({ code: "PRECONDITION_REQUIRED" });
      }
      // The caller must be able to see the skill at all, then to author it.
      const current = await transaction.query<
        Pick<SkillRow, "scope" | "owner_principal_id">
      >(
        `select scope, owner_principal_id from bakery.skills
          where organization_id = $1 and id = $2
            and ${SKILL_VISIBLE_TO("$3")}`,
        [organizationId, skillId, principalId],
      );
      const target = current.rows[0];
      if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      await assertMayAuthorSkill(transaction, organizationId, principalId, {
        scope: target.scope,
        ownerPrincipalId: target.owner_principal_id,
      });
      const result = await boundedMutation(() =>
        transaction.query<SkillRow>(
          `update bakery.skills
              set name = coalesce($4, name),
                  description = case when $5::boolean then $6 else description end,
                  enabled = coalesce($7, enabled),
                  updated_at = now(), version = version + 1
            where organization_id = $1 and id = $2 and version = $3
              and ${SKILL_VISIBLE_TO("$8")}
            returning ${SKILL_COLUMNS}`,
          [
            organizationId,
            skillId,
            expectedVersion,
            input.name ?? null,
            input.description !== undefined,
            input.description ?? null,
            input.enabled ?? null,
            principalId,
          ],
        )
      );
      const row = result.rows[0];
      if (!row) {
        const visible = await transaction.query(
          `select 1 from bakery.skills where organization_id = $1 and id = $2
              and ${SKILL_VISIBLE_TO("$3")}`,
          [organizationId, skillId, principalId],
        );
        throw new StandardError({
          code: visible.rows.length === 1
            ? "PRECONDITION_FAILED"
            : "RESOURCE_NOT_FOUND",
        });
      }
      await recordMutation(transaction, context, {
        organizationId,
        principalId,
        operation: "skills.update",
        eventType: "skills.updated",
        resourceType: "skill",
        resourceId: skillId,
        resourceVersion: row.version,
      });
      return toSkill(row);
    },
  };
}
