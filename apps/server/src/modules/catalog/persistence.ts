import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas, type JsonValue } from "@bakery/contracts/contracts";
import { z } from "zod";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
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
const SOURCE_COLUMNS = `id, source_type, locator, publisher, license,
  last_checked_at, enabled, created_at, updated_at, version`;
const SKILL_COLUMNS = `id, source_id, slug, name, active_version_id, enabled,
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
type SkillCreateInput = { slug: string; name: string };
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
  revision: z.string().min(1).max(255).describe(
    "Requested Git revision or strong HTTP ETag.",
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
type SkillRow = {
  id: string;
  source_id: string | null;
  slug: string;
  name: string;
  active_version_id: string | null;
  enabled: boolean;
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
    activeVersionId: row.active_version_id,
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

async function boundedMutation<T>(work: () => Promise<T>): Promise<T> {
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

async function recordMutation(
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
}) {
  const binding: CursorBinding = {
    action: options.action,
    principalId: options.principalId,
    organizationId: options.organizationId,
    ordering: PAGE_ORDERING,
    filters: "{}",
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
      order by created_at desc, id desc
      limit $4`,
    [
      options.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
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

export function createCatalogHandlers(
  secret: string,
  options: Readonly<{
    normalizeSourceLocator?: typeof normalizeSkillSourceLocator;
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
      let requestedRevision: string;
      let sourcePath: string;
      try {
        requestedRevision = normalizeSkillSourceRevision(
          source.source_type,
          parsed.data.revision,
        );
        sourcePath = normalizeSkillSourcePath(parsed.data.path);
      } catch (error) {
        if (error instanceof SkillSourceAdapterError) invalidSourceInput(error);
        throw error;
      }
      const existing = await transaction.query<ExistingSkillImportRow>(
        `select ${IMPORT_RUN_COLUMNS}, import.registered_source_type,
                import.registered_locator, import.registered_license
           from bakery.skill_imports as import
           join bakery.workflow_runs as run
             on run.organization_id = import.organization_id
            and run.id = import.run_id
          where import.organization_id = $1 and import.source_id = $2
            and import.requested_revision = $3 and import.source_path = $4`,
        [organizationId, source.id, requestedRevision, sourcePath],
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
        request: { requestedRevision, sourcePath },
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
           registered_license, state
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued')`,
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
        details: { sourceId: source.id },
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

    async listSkills(context: ActionContext, input: CursorInput) {
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
      });
    },

    async getSkill(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const result = await transaction.query<SkillRow>(
        `select ${SKILL_COLUMNS} from bakery.skills
          where organization_id = $1 and id = $2`,
        [organizationId, idFromPath(context)],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      return toSkill(row);
    },

    async createSkill(context: ActionContext, input: SkillCreateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const persistedInput = requireSkillCreatePersistence(input);
      const skillId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const locator =
        `bakery://organizations/${organizationId}/skills/${skillId}`;
      const result = await boundedMutation(async () => {
        await transaction.query(
          `insert into bakery.skill_sources (
             id, organization_id, source_type, locator, display_name,
             publisher, license, last_checked_at, enabled
           ) values ($1, $2, 'local_bundle', $3, $4, null, null, null, true)`,
          [sourceId, organizationId, locator, persistedInput.name],
        );
        return await transaction.query<SkillRow>(
          `insert into bakery.skills (
             id, organization_id, source_id, slug, name, active_version_id,
             enabled
           ) values ($1, $2, $3, $4, $5, null, true)
           returning ${SKILL_COLUMNS}`,
          [
            skillId,
            organizationId,
            sourceId,
            persistedInput.slug,
            persistedInput.name,
          ],
        );
      });
      const row = result.rows[0];
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

    createSkillVersion(
      _context: ActionContext,
      _input: z.output<typeof contractSchemas.LocalSkillVersion>,
    ) {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },

    async updateSkill(context: ActionContext, input: SkillUpdateInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const skillId = idFromPath(context);
      const expectedVersion = requireCommandMetadata(context).expectedVersion;
      if (expectedVersion === undefined) {
        throw new StandardError({ code: "PRECONDITION_REQUIRED" });
      }
      const result = await boundedMutation(() =>
        transaction.query<SkillRow>(
          `update bakery.skills
              set name = coalesce($4, name),
                  description = case when $5::boolean then $6 else description end,
                  enabled = coalesce($7, enabled),
                  updated_at = now(), version = version + 1
            where organization_id = $1 and id = $2 and version = $3
            returning ${SKILL_COLUMNS}`,
          [
            organizationId,
            skillId,
            expectedVersion,
            input.name ?? null,
            input.description !== undefined,
            input.description ?? null,
            input.enabled ?? null,
          ],
        )
      );
      const row = result.rows[0];
      if (!row) {
        const visible = await transaction.query(
          "select 1 from bakery.skills where organization_id = $1 and id = $2",
          [organizationId, skillId],
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
