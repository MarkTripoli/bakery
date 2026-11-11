import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import type {
  WorkflowActionCapability,
  WorkflowActionName,
} from "@bakery/contracts/workflow-action-registry";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
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
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  assertCompilerPinTogether,
  compilerPinOf,
  jsonPointerToSegments,
  MAX_WORKFLOW_DEFINITION_BYTES,
  validateWorkflowBindings,
  validateWorkflowDefinitionStatic,
  type WorkflowValidationIssue,
} from "./validation.ts";
import { assertWorkflowSatisfiesRepositoryRules } from "./rule-guard.ts";
import type { WorkflowsActionHandlers } from "./actions.ts";

const DEFINITIONS_ORDERING = "createdAt:desc,id:desc";
const VERSIONS_ORDERING = "revision:desc,id:desc";
const DEFINITION_COLUMNS =
  "id, slug, name, description, active_version_id, enabled, created_at, updated_at, version";
const PRESET_SLUG_PREFIX = "preset:";

type WorkflowDefinitionRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type WorkflowVersionRow = {
  id: string;
  workflow_id: string;
  revision: number;
  source_yaml: string;
  spec: unknown;
  digest: string;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type CursorQueryInput = { cursor?: string; limit?: number };
type WorkflowCreateInput = { slug: string; name: string; description: string };
type WorkflowUpdateInput = {
  name?: string;
  description?: string | null;
  enabled?: boolean;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toWorkflowDefinition(row: WorkflowDefinitionRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    activeVersionId: row.active_version_id,
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toWorkflowVersion(row: WorkflowVersionRow) {
  let normalizedSpec: JsonValue;
  try {
    normalizedSpec = JSON.parse(JSON.stringify(row.spec)) as JsonValue;
  } catch {
    throw new Error("WORKFLOW_VERSION_SPEC_INVALID");
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    revision: row.revision,
    sourceYaml: row.source_yaml,
    normalizedSpec,
    digest: row.digest,
    status: row.status as "draft" | "published" | "retired",
    createdBy: row.created_by,
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

/** Audit and event facts carry ids and versions only, never definition text. */
async function appendWorkflowFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    eventType: string;
    resourceVersion: number;
    /** Defaults to `resourceVersion`; set when the aggregate id continues an earlier version sequence. */
    aggregateVersion?: number;
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: options.organizationId,
    principalId: options.principalId,
    operation: options.operation,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    requestId: options.requestId,
    traceId: options.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: options.organizationId,
    eventType: options.eventType,
    aggregateId: options.resourceId,
    aggregateVersion: options.aggregateVersion ?? options.resourceVersion,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.resourceVersion,
    },
    traceId: options.traceId,
  });
}

export function createWorkflowDefinitionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "workflows.list",
      principalId,
      organizationId,
      ordering: DEFINITIONS_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      WorkflowDefinitionRow & { cursor_created_at: string }
    >(
      `select ${DEFINITION_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.workflow_definitions
        where organization_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toWorkflowDefinition),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getWorkflowDefinition(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<WorkflowDefinitionRow>(
    `select ${DEFINITION_COLUMNS}
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, workflowId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toWorkflowDefinition(row);
}

export async function createWorkflowDefinition(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as WorkflowCreateInput;
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<WorkflowDefinitionRow>(
      `insert into bakery.workflow_definitions (
         id, organization_id, slug, name, description
       ) values ($1, $2, $3, $4, $5)
       returning ${DEFINITION_COLUMNS}`,
      [id, organizationId, value.slug, value.name, value.description],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_DEFINITION_INSERT_FAILED");
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflows.create",
    resourceType: "workflow_definition",
    resourceId: id,
    eventType: "workflows.created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowDefinition(row);
}

export async function updateWorkflowDefinition(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as WorkflowUpdateInput;
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const locked = await transaction.query<{ slug: string }>(
    `select slug from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, workflowId],
  );
  const target = locked.rows[0];
  if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (target.slug.startsWith(PRESET_SLUG_PREFIX)) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_locked" },
    });
  }
  const updated = await boundedMutation(() =>
    transaction.query<WorkflowDefinitionRow>(
      `update bakery.workflow_definitions
          set name = case when $4::boolean then $5 else name end,
              description = case when $6::boolean then $7 else description end,
              enabled = case when $8::boolean then $9 else enabled end,
              updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      [
        organizationId,
        workflowId,
        expectedVersion,
        value.name !== undefined,
        value.name ?? null,
        value.description !== undefined,
        value.description ?? null,
        value.enabled !== undefined,
        value.enabled ?? null,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflows.update",
    resourceType: "workflow_definition",
    resourceId: workflowId,
    eventType: "workflows.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowDefinition(row);
}

const PUBLISHED_VERSION_SELECT =
  `select id, workflow_id, revision, source_yaml, normalized_spec as spec,
          digest, status, created_by, created_at, updated_at, version
     from bakery.workflow_versions
    where organization_id = $1 and workflow_id = $2`;
const DRAFT_VERSION_SELECT =
  `select id, workflow_id, revision, source_yaml, definition as spec,
          digest, 'draft'::text as status, created_by, created_at, updated_at,
          version
     from bakery.workflow_drafts
    where organization_id = $1 and workflow_id = $2`;

async function requireWorkflowVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<void> {
  const parent = await transaction.query(
    "select 1 from bakery.workflow_definitions where organization_id = $1 and id = $2",
    [organizationId, workflowId],
  );
  if (parent.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export function createWorkflowVersionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const workflowId = context.params.id;
    if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    await requireWorkflowVisible(transaction, organizationId, workflowId);
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "workflowVersions.list",
      principalId,
      organizationId,
      ordering: VERSIONS_ORDERING,
      filters: JSON.stringify({ workflowId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<WorkflowVersionRow>(
      `select * from (
         ${PUBLISHED_VERSION_SELECT}
         union all
         ${DRAFT_VERSION_SELECT}
       ) versions
        where ($3::integer is null or (revision, id) < ($3, $4::uuid))
        order by revision desc, id desc
        limit $5`,
      [
        organizationId,
        workflowId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toWorkflowVersion),
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

export async function getWorkflowVersion(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const workflowId = context.params.id;
  const versionId = context.params.versionId;
  if (!workflowId || !versionId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query<WorkflowVersionRow>(
    `select * from (
       ${PUBLISHED_VERSION_SELECT}
       union all
       ${DRAFT_VERSION_SELECT}
     ) versions
      where id = $3::uuid`,
    [organizationId, workflowId, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toWorkflowVersion(row);
}

type DraftContentInput = {
  definition: JsonValue;
  sourceYaml?: string;
  revision?: number;
  digest?: string;
};

/** Structural guard only: a JSON object within the size bound. */
function requireDraftDefinition(definition: unknown): string {
  if (
    definition === null || typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw unprocessable(["definition"], "definition_not_object");
  }
  let canonical: string;
  try {
    canonical = canonicalJson(definition);
  } catch {
    throw unprocessable(["definition"], "definition_not_object");
  }
  if (
    new TextEncoder().encode(canonical).byteLength >
      MAX_WORKFLOW_DEFINITION_BYTES
  ) {
    throw unprocessable(["definition"], "definition_too_large");
  }
  return canonical;
}

const DRAFT_RETURNING =
  `id, workflow_id, revision, source_yaml, definition as spec, digest,
   'draft'::text as status, created_by, created_at, updated_at, version`;

/** Locks the definition row; locked presets reject every authoring mutation. */
async function lockAuthoringDefinition(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<void> {
  const locked = await transaction.query<{ slug: string }>(
    `select slug from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, workflowId],
  );
  const target = locked.rows[0];
  if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (target.slug.startsWith(PRESET_SLUG_PREFIX)) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_locked" },
    });
  }
}

export async function createWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as DraftContentInput;
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const canonical = requireDraftDefinition(value.definition);
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  const existing = await transaction.query(
    `select 1 from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2`,
    [organizationId, workflowId],
  );
  if (existing.rows.length > 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "draft_exists" },
    });
  }
  const highest = await transaction.query<{ revision: number | null }>(
    `select max(revision) as revision from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2`,
    [organizationId, workflowId],
  );
  const revision = Number(highest.rows[0]?.revision ?? 0) + 1;
  if (value.revision !== undefined && value.revision !== revision) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "revision_not_next" },
    });
  }
  const digest = await sha256Hex(canonical);
  if (value.digest !== undefined && value.digest !== digest) {
    throw unprocessable(["digest"], "digest_mismatch");
  }
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<WorkflowVersionRow>(
      `insert into bakery.workflow_drafts (
         id, organization_id, workflow_id, revision, source_yaml, definition,
         digest, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8)
       returning ${DRAFT_RETURNING}`,
      [
        id,
        organizationId,
        workflowId,
        revision,
        value.sourceYaml ?? canonical,
        canonical,
        digest,
        principalId,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_DRAFT_INSERT_FAILED");
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflowVersions.create",
    resourceType: "workflow_version",
    resourceId: id,
    eventType: "workflow.version_created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowVersion(row);
}

export async function updateWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as DraftContentInput;
  const workflowId = context.params.id;
  const versionId = context.params.versionId;
  if (!workflowId || !versionId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const canonical = requireDraftDefinition(value.definition);
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  const draft = await transaction.query(
    `select 1 from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, versionId],
  );
  if (draft.rows.length !== 1) {
    const published = await transaction.query(
      `select 1 from bakery.workflow_versions
        where organization_id = $1 and workflow_id = $2 and id = $3`,
      [organizationId, workflowId, versionId],
    );
    if (published.rows.length === 1) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_version_immutable" },
      });
    }
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const digest = await sha256Hex(canonical);
  const updated = await boundedMutation(() =>
    transaction.query<WorkflowVersionRow>(
      `update bakery.workflow_drafts
          set source_yaml = $5, definition = $6::jsonb, digest = $7,
              updated_by = $8, updated_at = now(), version = version + 1
        where organization_id = $1 and workflow_id = $2 and id = $3
          and version = $4
        returning ${DRAFT_RETURNING}`,
      [
        organizationId,
        workflowId,
        versionId,
        expectedVersion,
        value.sourceYaml ?? canonical,
        canonical,
        digest,
        principalId,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflowVersions.update",
    resourceType: "workflow_version",
    resourceId: versionId,
    eventType: "workflow.version_updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowVersion(row);
}

const PUBLISH_ISSUE_MAX = 20;

export async function publishWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as { expectedDigest?: string };
  const workflowId = context.params.id;
  const versionId = context.params.versionId;
  if (!workflowId || !versionId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  const drafts = await transaction.query<
    {
      id: string;
      revision: number;
      source_yaml: string;
      definition: JsonValue;
      digest: string;
      created_by: string;
      version: number;
    }
  >(
    `select id, revision, source_yaml, definition, digest, created_by, version
       from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3
      for update`,
    [organizationId, workflowId, versionId],
  );
  const draft = drafts.rows[0];
  if (!draft) {
    const published = await transaction.query(
      `select 1 from bakery.workflow_versions
        where organization_id = $1 and workflow_id = $2 and id = $3`,
      [organizationId, workflowId, versionId],
    );
    throw published.rows.length === 1
      ? new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_version_immutable" },
      })
      : new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (draft.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (
    value.expectedDigest !== undefined && value.expectedDigest !== draft.digest
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "validation_stale" },
    });
  }
  const report = await validateWorkflowDefinitionStatic(draft.definition);
  const bindingErrors: readonly WorkflowValidationIssue[] = report.valid
    ? (await validateWorkflowBindings(
      transaction,
      organizationId,
      draft.definition,
    )).errors
    : [];
  const issues = [...report.errors, ...bindingErrors];
  if (!report.valid || issues.length > 0 || report.normalizedDigest === null) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: issues.slice(0, PUBLISH_ISSUE_MAX).map((item) => ({
          path: jsonPointerToSegments(item.path),
          code: item.code,
          message: item.message,
        })),
      },
    });
  }
  await assertWorkflowSatisfiesRepositoryRules(
    transaction,
    organizationId,
    draft.definition,
  );
  // The compile of exactly this definition, stored with the row. Published
  // rows are immutable, so this is what a later reader executes.
  const pin = compilerPinOf(report);
  const pinValues = [
    pin?.compilerVersion ?? null,
    pin?.semanticDigest ?? null,
  ] as const;
  // The database cannot hold this (no CHECK constraints here), so refuse a
  // half pin on the values the insert binds.
  assertCompilerPinTogether(pinValues[0], pinValues[1]);
  const inserted = await boundedMutation(() =>
    transaction.query<WorkflowVersionRow>(
      `insert into bakery.workflow_versions (
         id, organization_id, workflow_id, revision, source_yaml,
         normalized_spec, digest, status, created_by,
         compiler_version, semantic_digest
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'published', $8, $9, $10)
       returning id, workflow_id, revision, source_yaml,
                 normalized_spec as spec, digest, status, created_by,
                 created_at, updated_at, version`,
      [
        draft.id,
        organizationId,
        workflowId,
        draft.revision,
        draft.source_yaml,
        canonicalJson(draft.definition),
        report.normalizedDigest,
        // created_by is the draft author; the publisher is recorded in the
        // workflowVersions.publish audit row below.
        draft.created_by,
        pinValues[0],
        pinValues[1],
      ],
    )
  );
  await transaction.query(
    `delete from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, draft.id],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_VERSION_INSERT_FAILED");
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflowVersions.publish",
    resourceType: "workflow_version",
    resourceId: draft.id,
    eventType: "workflow.version_published",
    resourceVersion: row.version,
    // The published version reuses the draft's aggregate id, whose events ran
    // 1..draft.version; publish continues that sequence so it stays monotonic.
    aggregateVersion: draft.version + 1,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowVersion(row);
}

export async function activateWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { versionId } = input as { versionId: string };
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  const published = await transaction.query<
    { status: string; normalized_spec: JsonValue }
  >(
    `select status, normalized_spec from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, versionId],
  );
  const target = published.rows[0];
  if (!target) {
    const draft = await transaction.query(
      `select 1 from bakery.workflow_drafts
        where organization_id = $1 and workflow_id = $2 and id = $3`,
      [organizationId, workflowId, versionId],
    );
    throw draft.rows.length === 1
      ? new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_version_not_published" },
      })
      : new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (target.status !== "published") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_version_not_published" },
    });
  }
  await assertWorkflowSatisfiesRepositoryRules(
    transaction,
    organizationId,
    target.normalized_spec,
  );
  const updated = await boundedMutation(() =>
    transaction.query<WorkflowDefinitionRow>(
      `update bakery.workflow_definitions
          set active_version_id = $4, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      [organizationId, workflowId, expectedVersion, versionId],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflowActivations.create",
    resourceType: "workflow_definition",
    resourceId: workflowId,
    eventType: "workflows.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowDefinition(row);
}

export async function validateWorkflow(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const { definition } = input as { definition: JsonValue };
  const report = await validateWorkflowDefinitionStatic(definition);
  const bindingResult = report.valid
    ? await validateWorkflowBindings(transaction, organizationId, definition)
    : { errors: [] as readonly WorkflowValidationIssue[], bindings: [] };
  const bindingErrors = bindingResult.errors;
  const failed = !report.valid || bindingErrors.length > 0;
  const { graph, requiresRepository, registryVersion, registryDigest } = report;
  return {
    valid: !failed,
    errors: [...report.errors, ...bindingErrors].slice(0, 100),
    warnings: [...report.warnings],
    normalizedDigest: failed ? null : report.normalizedDigest,
    compilerVersion: report.compilerVersion,
    semanticDigest: report.semanticDigest,
    compilerDiagnostics: [...report.compilerDiagnostics],
    ...(failed ? {} : {
      graph: graph as JsonValue | undefined,
      requiresRepository,
      registryVersion,
      registryDigest,
      stepBindings: bindingResult.bindings.slice(0, 100).map((binding) => ({
        ...binding,
        // Static validation already proved the action is registered.
        action: binding.action as WorkflowActionName,
        requiredCapabilities: [
          ...binding.requiredCapabilities,
        ] as WorkflowActionCapability[],
      })),
    }),
  };
}

export function createWorkflowsHandlers(
  secret: string,
): WorkflowsActionHandlers {
  return {
    listWorkflows: createWorkflowDefinitionsListHandler(secret),
    getWorkflow: getWorkflowDefinition,
    createWorkflow: createWorkflowDefinition,
    updateWorkflow: updateWorkflowDefinition,
    listVersions: createWorkflowVersionsListHandler(secret),
    getVersion: getWorkflowVersion,
    createVersion: createWorkflowVersion,
    updateVersion: updateWorkflowVersion,
    publishVersion: publishWorkflowVersion,
    activate: activateWorkflowVersion,
    validate: validateWorkflow,
  };
}
