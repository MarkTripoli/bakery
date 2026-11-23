import type { ActionContext } from "@bakery/contracts/action-registry";
import { WorkflowStartsSchema } from "@bakery/contracts/workflow-starts";
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
import { reconcilePersonalSkillUse } from "../catalog/skill-use-grants.ts";
import {
  readWorkflowVersionSkills,
  stepSkillIssues,
} from "./version-skills.ts";
import {
  checkToolCallPins,
  writeToolCallBindings,
} from "./version-tool-bindings.ts";
import {
  insertSkillSlots,
  resolveSkillSlots,
  stripPersonalSkills,
} from "./skill-slots.ts";
import {
  assertCompilerPinTogether,
  compilerPinOf,
  jsonPointerToSegments,
  MAX_WORKFLOW_DEFINITION_BYTES,
  validateWorkflowBindings,
  validateWorkflowDefinitionStatic,
  validateWorkflowSourceYaml,
  type WorkflowValidationIssue,
} from "./validation.ts";
import { assertWorkflowSatisfiesRepositoryRules } from "./rule-guard.ts";
import { loadCalledWorkflows } from "./called-workflows.ts";
import { readStarts } from "./start-read.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  assertMayPublishDefinition,
  DefinitionKind,
} from "../auth/application/definition-publish-grants.ts";
import { supersedeWaitingProposals } from "./proposal-supersession.ts";
import {
  createAgentPowerGrant,
  deleteAgentPowerGrant,
} from "./agent-power-grants.ts";
import {
  createDefinitionPublishGrant,
  deleteDefinitionPublishGrant,
} from "./publish-grants.ts";
import type { WorkflowsActionHandlers } from "./actions.ts";
import {
  decideWorkflowDefinitionProposal,
  getWorkflowDefinitionProposal,
} from "./definition-proposals.ts";

const DEFINITIONS_ORDERING = "createdAt:desc,id:desc";
const VERSIONS_ORDERING = "revision:desc,id:desc";
const DEFINITION_COLUMNS =
  "id, slug, name, description, active_version_id, enabled, created_at, updated_at, version, origin_kind, origin_catalog_key, origin_catalog_version, origin_source_workflow_id, origin_source_version_id, origin_source_digest, visibility, origin_conversation_id, origin_turn_id";

export type WorkflowDefinitionRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  origin_kind: string;
  origin_catalog_key: string | null;
  origin_catalog_version: number | null;
  origin_source_workflow_id: string | null;
  origin_source_version_id: string | null;
  origin_source_digest: string | null;
  visibility: string;
  origin_conversation_id: string | null;
  origin_turn_id: string | null;
};

/** Library visibility of a definition (chapter 25 primitive 2). */
export const WorkflowVisibility = Object.freeze(
  { Listed: "listed", Unlisted: "unlisted" } as const,
);
export type WorkflowVisibility =
  typeof WorkflowVisibility[keyof typeof WorkflowVisibility];

/** Origin kind written for a definition a coordinator proposal created. */
export const COORDINATOR_ORIGIN_KIND = "coordinator";

/** Who and what a write is attributed to; the handlers' and proposals' shared facts. */
export type WorkflowWriteFacts = Readonly<{
  organizationId: string;
  principalId: string;
  requestId: string;
  traceId: string;
  /** Whether a person or an agent acted (O50); recorded in the audit row. Unset means a person. */
  actorKind?: "person" | "agent";
  /** The access token an agent presented, or null. */
  accessTokenId?: string | null;
}>;

function writeFactsOf(context: ActionContext): WorkflowWriteFacts {
  const { organizationId, principalId } = requireWorkTransaction(context);
  const attribution = attributeAction(context, principalId);
  return {
    organizationId,
    principalId,
    requestId: context.requestId,
    traceId: context.traceId,
    actorKind: attribution.actorKind,
    accessTokenId: attribution.accessTokenId,
  };
}

export type WorkflowVersionRow = {
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
  /** The version's starts as stored (jsonb), read back through the contract. */
  starts: unknown;
};

type CursorQueryInput = { cursor?: string; limit?: number };
export type WorkflowCreateInput = {
  slug: string;
  name: string;
  description: string;
};
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
    // Provenance is part of the read shape so a caller can tell an installed
    // definition from an authored or copied one without parsing the slug.
    // `catalog` origins carry the key and version they were installed from;
    // the other kinds carry nulls rather than invented values.
    origin: originOf(row),
    // Unlisted definitions are readable by id and runnable at an exact
    // published version, but absent from the library list (#420).
    visibility: visibilityOf(row.visibility),
  };
}

/** Origin kinds a definition row may carry (0175 and #420). */
export const WorkflowOriginKinds = Object.freeze(
  ["authored", "catalog", "copy", "coordinator"] as const,
);
type WorkflowOriginKind = typeof WorkflowOriginKinds[number];

function originKindOf(value: string): WorkflowOriginKind {
  const kind = WorkflowOriginKinds.find((entry) => entry === value);
  if (!kind) throw new Error("WORKFLOW_ORIGIN_KIND_INVALID");
  return kind;
}

function visibilityOf(value: string): WorkflowVisibility {
  if (value === WorkflowVisibility.Listed) return WorkflowVisibility.Listed;
  if (value === WorkflowVisibility.Unlisted) return WorkflowVisibility.Unlisted;
  throw new Error("WORKFLOW_VISIBILITY_INVALID");
}

function originOf(row: WorkflowDefinitionRow) {
  return {
    kind: originKindOf(row.origin_kind),
    catalogKey: row.origin_catalog_key,
    catalogVersion: row.origin_catalog_version,
    // A copy names the definition, version and digest it was taken from; the
    // other kinds carry nulls.
    sourceWorkflowId: row.origin_source_workflow_id,
    sourceVersionId: row.origin_source_version_id,
    sourceDigest: row.origin_source_digest,
    // A coordinator definition names the conversation and turn that proposed
    // it; other kinds omit both (optional in WorkflowOrigin).
    ...(row.origin_kind === COORDINATOR_ORIGIN_KIND
      ? {
        conversationId: row.origin_conversation_id,
        turnId: row.origin_turn_id,
      }
      : {}),
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
    starts: WorkflowStartsSchema.parse(row.starts),
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
    /** Who acted (O50): every workflow audit row names the actor kind. */
    actorKind?: "person" | "agent";
    accessTokenId?: string | null;
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
    details: {
      actorKind: options.actorKind ?? "person",
      accessTokenId: options.accessTokenId ?? null,
    },
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
          and visibility = 'listed'
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
  const { transaction } = requireWorkTransaction(context);
  return toWorkflowDefinition(
    await insertWorkflowDefinition(
      transaction,
      writeFactsOf(context),
      input as WorkflowCreateInput,
    ),
  );
}

/** Where an unlisted definition came from; absent for an editor create. */
export type WorkflowDefinitionProvenance = Readonly<{
  visibility: WorkflowVisibility;
  originKind: string;
  originConversationId?: string;
  originTurnId?: string;
}>;

/**
 * The one statement that creates a definition, for the editor's create and a
 * person accepting a coordinator proposal alike. An editor create keeps the
 * column defaults (listed, authored, no conversation).
 */
export async function insertWorkflowDefinition(
  transaction: PgTransactionClient,
  facts: WorkflowWriteFacts,
  value: WorkflowCreateInput,
  provenance?: WorkflowDefinitionProvenance,
): Promise<WorkflowDefinitionRow> {
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<WorkflowDefinitionRow>(
      provenance
        ? `insert into bakery.workflow_definitions (
             id, organization_id, slug, name, description, visibility,
             origin_kind, origin_conversation_id, origin_turn_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning ${DEFINITION_COLUMNS}`
        : `insert into bakery.workflow_definitions (
             id, organization_id, slug, name, description
           ) values ($1, $2, $3, $4, $5)
           returning ${DEFINITION_COLUMNS}`,
      provenance
        ? [
          id,
          facts.organizationId,
          value.slug,
          value.name,
          value.description,
          provenance.visibility,
          provenance.originKind,
          provenance.originConversationId ?? null,
          provenance.originTurnId ?? null,
        ]
        : [
          id,
          facts.organizationId,
          value.slug,
          value.name,
          value.description,
        ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_DEFINITION_INSERT_FAILED");
  await appendWorkflowFacts(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "workflows.create",
    resourceType: "workflow_definition",
    resourceId: id,
    eventType: "workflows.created",
    resourceVersion: row.version,
    requestId: facts.requestId,
    traceId: facts.traceId,
  });
  return row;
}

type WorkflowCopyInput = {
  slug: string;
  name: string;
  description: string;
  sourceVersionId?: string;
  expectedDigest?: string;
};

/**
 * Copies a workflow into a new, organization-owned definition with an inactive
 * draft, in one transaction. The source is the published version the caller
 * names (the active one by default) or a draft of the source workflow, and its
 * definition is all that is carried over: no activation, run, effect, trigger,
 * grant or credential belongs to a copy. The copy's origin is `copy`, with the
 * source definition, version and digest recorded, so a later change to the
 * source never reaches it and a run started from it pins its own version.
 *
 * A catalog definition is a legitimate source: copying is how an organization
 * gets an editable one, and the source row is read, never written.
 */
export async function copyWorkflowDefinition(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId } = requireWorkTransaction(
    context,
  );
  const value = input as WorkflowCopyInput;
  const sourceWorkflowId = context.params.id;
  if (!sourceWorkflowId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const source = await transaction.query<{ active_version_id: string | null }>(
    `select active_version_id from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for share`,
    [organizationId, sourceWorkflowId],
  );
  if (source.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const sourceVersionId = value.sourceVersionId ??
    source.rows[0]!.active_version_id;
  if (sourceVersionId === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_copy_source_unavailable" },
    });
  }
  return toWorkflowDefinition(
    await insertWorkflowCopy(transaction, writeFactsOf(context), {
      sourceWorkflowId,
      sourceVersionId,
      expectedDigest: value.expectedDigest,
      slug: value.slug,
      name: value.name,
      description: value.description,
    }),
  );
}

/** What one copy is taken from and named; the copy writer's input. */
export type WorkflowCopySpec = Readonly<{
  sourceWorkflowId: string;
  sourceVersionId: string;
  expectedDigest?: string;
  slug: string;
  name: string;
  description: string;
}>;

/**
 * The one copy writer (#598), shared by "Make a copy" and save as workflow
 * (#420): a new definition with origin copy naming the source definition,
 * version and digest, plus its first draft. The copy takes the column
 * defaults, so it is listed. The caller has authorized and locked the source.
 */
export async function insertWorkflowCopy(
  transaction: PgTransactionClient,
  facts: WorkflowWriteFacts,
  copy: WorkflowCopySpec,
): Promise<WorkflowDefinitionRow> {
  type SourceContent = {
    source_yaml: string;
    definition: JsonValue;
    digest: string;
  };
  const published = await transaction.query<SourceContent>(
    `select source_yaml, normalized_spec as definition, digest
       from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [facts.organizationId, copy.sourceWorkflowId, copy.sourceVersionId],
  );
  const content = published.rows[0] ?? (await transaction.query<SourceContent>(
    `select source_yaml, definition, digest
       from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [facts.organizationId, copy.sourceWorkflowId, copy.sourceVersionId],
  )).rows[0];
  if (!content) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // A caller that read a source and copies it expects those bytes: a source
  // that changed since is refused rather than copied as something else.
  if (
    copy.expectedDigest !== undefined &&
    copy.expectedDigest !== content.digest
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "digest_mismatch" },
    });
  }
  // A copy never carries a personal skill: it is visible to its owner alone and
  // a use grant belongs to the workflow it was given to. Each step that named one
  // keeps an open slot instead.
  const stripped = await stripPersonalSkills(
    transaction,
    facts.organizationId,
    content.definition,
  );
  const canonical = requireDraftDefinition(stripped.definition);
  const draftDigest = await sha256Hex(canonical);
  const workflowId = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<WorkflowDefinitionRow>(
      `insert into bakery.workflow_definitions (
         id, organization_id, slug, name, description, origin_kind,
         origin_source_workflow_id, origin_source_version_id,
         origin_source_digest
       ) values ($1, $2, $3, $4, $5, 'copy', $6, $7, $8)
       returning ${DEFINITION_COLUMNS}`,
      [
        workflowId,
        facts.organizationId,
        copy.slug,
        copy.name,
        copy.description,
        copy.sourceWorkflowId,
        copy.sourceVersionId,
        content.digest,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_DEFINITION_INSERT_FAILED");
  await insertSkillSlots(
    transaction,
    facts.organizationId,
    workflowId,
    stripped.slots,
  );
  const draftId = crypto.randomUUID();
  await boundedMutation(() =>
    transaction.query(
      `insert into bakery.workflow_drafts (
         id, organization_id, workflow_id, revision, source_yaml, definition,
         digest, created_by, updated_by
       ) values ($1, $2, $3, 1, $4, $5::jsonb, $6, $7, $7)`,
      [
        draftId,
        facts.organizationId,
        workflowId,
        // The YAML the source was authored from still names the personal skill,
        // so a copy that dropped one stores the canonical JSON of what it kept.
        stripped.slots.length > 0 ? canonical : content.source_yaml,
        canonical,
        draftDigest,
        facts.principalId,
      ],
    )
  );
  await appendWorkflowFacts(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "workflows.copy",
    resourceType: "workflow_definition",
    resourceId: workflowId,
    eventType: "workflows.created",
    resourceVersion: row.version,
    requestId: facts.requestId,
    traceId: facts.traceId,
  });
  return row;
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
  const locked = await transaction.query<{ origin_kind: string }>(
    `select origin_kind from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, workflowId],
  );
  const target = locked.rows[0];
  if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  requireOrganizationMayEdit(target.origin_kind);
  // Switching a workflow on or off is an off-by-default power for an agent
  // (O52), granted with publishing; renaming and describing are authoring.
  const attribution = value.enabled === undefined
    ? attributeAction(context, principalId)
    : await assertMayPublishDefinition(transaction, context, {
      organizationId,
      principalId,
      kind: DefinitionKind.Workflow,
      definitionId: workflowId,
    });
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
    actorKind: attribution.actorKind,
    accessTokenId: attribution.accessTokenId,
  });
  return toWorkflowDefinition(row);
}

const PUBLISHED_VERSION_SELECT =
  `select id, workflow_id, revision, source_yaml, normalized_spec as spec,
          digest, status, created_by, created_at, updated_at, version, starts
     from bakery.workflow_versions
    where organization_id = $1 and workflow_id = $2`;
const DRAFT_VERSION_SELECT =
  `select id, workflow_id, revision, source_yaml, definition as spec,
          digest, 'draft'::text as status, created_by, created_at, updated_at,
          version, starts
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

export type DraftContentInput = {
  definition: JsonValue;
  sourceYaml?: string;
  revision?: number;
  digest?: string;
  /** Personal skill versions the author confirms letting this workflow use. */
  confirmPersonalSkillUse?: string[];
  /** Steps whose missing-skill slot the author settled with this save. */
  resolveSkillSlots?: string[];
  /**
   * The draft's whole starts list; omitted keeps the stored one. Checked on
   * save by the same readers publish uses, so an author hears about a start
   * that could never run now and not only when publishing.
   */
  starts?: unknown;
};

/** Settles the personal skills a draft's steps name before the draft is written. */
async function settlePersonalSkillUse(
  transaction: PgTransactionClient,
  facts: WorkflowWriteFacts,
  workflowId: string,
  value: DraftContentInput,
): Promise<void> {
  await resolveSkillSlots(
    transaction,
    facts.organizationId,
    workflowId,
    value.resolveSkillSlots,
  );
  await reconcilePersonalSkillUse(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    actorKind: facts.actorKind ?? "person",
    requestId: facts.requestId,
    traceId: facts.traceId,
    workflowId,
    definition: value.definition,
    confirmed: value.confirmPersonalSkillUse,
  });
}

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

/**
 * The canonical JSON of a save's starts, or null when the save names none (the
 * stored list is kept). A list the contract refuses, or a schedule the
 * scheduler cannot read, is refused here, where the author can fix it.
 */
function readDraftStarts(starts: unknown): string | null {
  if (starts === undefined) return null;
  const parsed = WorkflowStartsSchema.safeParse(starts);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw unprocessable(
      ["starts", ...(issue?.path ?? []).map(String)],
      "start_invalid",
    );
  }
  return canonicalJson(readStarts(parsed.data));
}

const DRAFT_RETURNING =
  `id, workflow_id, revision, source_yaml, definition as spec, digest,
   'draft'::text as status, created_by, created_at, updated_at, version,
   starts`;

/**
 * A definition installed from the code-owned catalog is system managed: only
 * the catalog publisher changes it, so every organization-facing authoring
 * mutation refuses it. The decision reads the definition's origin, the
 * immutable column the install wrote, and never the slug, which is a string a
 * person can also type. An organization that wants its own version copies the
 * definition; the copy's origin is not `catalog`.
 */
function requireOrganizationMayEdit(originKind: string): void {
  if (originKind === "catalog") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_locked" },
    });
  }
}

/** Locks the definition row; a system-managed definition rejects every authoring mutation. */
async function lockAuthoringDefinition(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<void> {
  const locked = await transaction.query<{ origin_kind: string }>(
    `select origin_kind from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, workflowId],
  );
  const target = locked.rows[0];
  if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  requireOrganizationMayEdit(target.origin_kind);
}

export async function createWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction } = requireWorkTransaction(context);
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toWorkflowVersion(
    await createWorkflowDraft(
      transaction,
      writeFactsOf(context),
      workflowId,
      input as DraftContentInput,
    ),
  );
}

/**
 * Opens a workflow's one draft. The editor's create and an accepted
 * coordinator proposal both write a draft through this, so there is one
 * draft writer (#420).
 */
export async function createWorkflowDraft(
  transaction: PgTransactionClient,
  facts: WorkflowWriteFacts,
  workflowId: string,
  value: DraftContentInput,
): Promise<WorkflowVersionRow> {
  const { organizationId, principalId } = facts;
  const canonical = requireDraftDefinition(value.definition);
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  await settlePersonalSkillUse(transaction, facts, workflowId, value);
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
    requestId: facts.requestId,
    traceId: facts.traceId,
    actorKind: facts.actorKind,
    accessTokenId: facts.accessTokenId,
  });
  return row;
}

export async function updateWorkflowVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction } = requireWorkTransaction(context);
  const workflowId = context.params.id;
  const versionId = context.params.versionId;
  if (!workflowId || !versionId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return toWorkflowVersion(
    await updateWorkflowDraft(
      transaction,
      writeFactsOf(context),
      { workflowId, versionId, expectedVersion },
      input as DraftContentInput,
    ),
  );
}

/** Replaces a draft's content under its compare-and-set version; the one draft update writer. */
export async function updateWorkflowDraft(
  transaction: PgTransactionClient,
  facts: WorkflowWriteFacts,
  target: Readonly<
    { workflowId: string; versionId: string; expectedVersion: number }
  >,
  value: DraftContentInput,
): Promise<WorkflowVersionRow> {
  const { organizationId, principalId } = facts;
  const { workflowId, versionId, expectedVersion } = target;
  const canonical = requireDraftDefinition(value.definition);
  const starts = readDraftStarts(value.starts);
  await lockAuthoringDefinition(transaction, organizationId, workflowId);
  await settlePersonalSkillUse(transaction, facts, workflowId, value);
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
              updated_by = $8, starts = coalesce($9::jsonb, starts),
              updated_at = now(), version = version + 1
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
        starts,
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
    requestId: facts.requestId,
    traceId: facts.traceId,
    actorKind: facts.actorKind,
    accessTokenId: facts.accessTokenId,
  });
  return row;
}

/** The columns of one published workflow version, as the single insert binds them. */
export type WorkflowVersionInsert = Readonly<{
  id: string;
  organizationId: string;
  workflowId: string;
  revision: number;
  sourceYaml: string;
  /** Canonical JSON text of the normalized definition. */
  normalizedSpec: string;
  digest: string;
  createdBy: string;
  /** The compiler pin: both set or both null, enforced here, not by the database. */
  compilerVersion: string | null;
  semanticDigest: string | null;
  /**
   * Canonical JSON text of the version's starts. Beside the specification, not
   * inside it, so the digest a version was published under is unchanged by a
   * start, and a start is switched on by publishing rather than by editing.
   */
  starts: string;
}>;

/**
 * The one statement that writes a published workflow version, and so the one
 * place the compiler pin is checked. The database cannot hold "both null or
 * both set" (the PostgreSQL boundary rail forbids a CHECK constraint, and the
 * application role may insert), so a half pin is refused here, before any
 * statement reaches the database and so before any row is stored.
 */
export async function insertWorkflowVersion(
  transaction: PgTransactionClient,
  row: WorkflowVersionInsert,
) {
  assertCompilerPinTogether(row.compilerVersion, row.semanticDigest);
  return await boundedMutation(() =>
    transaction.query<WorkflowVersionRow>(
      `insert into bakery.workflow_versions (
         id, organization_id, workflow_id, revision, source_yaml,
         normalized_spec, digest, status, created_by,
         compiler_version, semantic_digest, starts
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'published', $8, $9, $10,
                 $11::jsonb)
       returning id, workflow_id, revision, source_yaml,
                 normalized_spec as spec, digest, status, created_by,
                 created_at, updated_at, version, starts`,
      [
        row.id,
        row.organizationId,
        row.workflowId,
        row.revision,
        row.sourceYaml,
        row.normalizedSpec,
        row.digest,
        row.createdBy,
        row.compilerVersion,
        row.semanticDigest,
        row.starts,
      ],
    )
  );
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
  // An agent publishes only under a grant (O52); refused before any read, so
  // a refusal writes no version, event or audit row.
  const attribution = await assertMayPublishDefinition(transaction, context, {
    organizationId,
    principalId,
    kind: DefinitionKind.Workflow,
    definitionId: workflowId,
  });
  const drafts = await transaction.query<
    {
      id: string;
      revision: number;
      source_yaml: string;
      definition: JsonValue;
      digest: string;
      created_by: string;
      version: number;
      starts: unknown;
    }
  >(
    `select id, revision, source_yaml, definition, digest, created_by, version,
            starts
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
  // The published versions this draft calls, from its own organization only.
  const calls = await loadCalledWorkflows(
    transaction,
    organizationId,
    draft.definition,
  );
  const report = await validateWorkflowDefinitionStatic(
    draft.definition,
    calls,
  );
  const bindingErrors: readonly WorkflowValidationIssue[] = report.valid
    ? (await validateWorkflowBindings(
      transaction,
      organizationId,
      draft.definition,
    )).errors
    : [];
  // The source the draft was authored from is stored beside the definition, so
  // an unsafe one, or one that is not this definition's, blocks publication.
  const sourceErrors = validateWorkflowSourceYaml(
    draft.source_yaml,
    draft.definition,
  );
  // A step must not be published naming a skill nobody can use at it.
  const skillErrors = report.valid
    ? await stepSkillIssues(transaction, {
      organizationId,
      principalId,
      workflowId,
      definition: draft.definition,
    })
    : [];
  // A tool.call step over an MCP connection is pinned to the connection's
  // current snapshot and the exact tool, or the version is refused.
  const toolPins = report.valid
    ? await checkToolCallPins(transaction, {
      organizationId,
      principalId,
      workflowId,
      definition: draft.definition,
      calls,
    })
    : { issues: [], pins: [] };
  const issues = [
    ...report.errors,
    ...bindingErrors,
    ...skillErrors,
    ...toolPins.issues,
    ...sourceErrors,
  ];
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
  const inserted = await insertWorkflowVersion(transaction, {
    id: draft.id,
    organizationId,
    workflowId,
    revision: draft.revision,
    sourceYaml: draft.source_yaml,
    normalizedSpec: canonicalJson(draft.definition),
    digest: report.normalizedDigest,
    // created_by is the draft author; the publisher is recorded in the
    // workflowVersions.publish audit row below.
    createdBy: draft.created_by,
    compilerVersion: pin?.compilerVersion ?? null,
    semanticDigest: pin?.semanticDigest ?? null,
    // Validated on the way in, because the column is jsonb and the database
    // can say nothing about its shape: a version that published a start the
    // contract refuses would be one no matcher could ever read back.
    starts: canonicalJson(
      readStarts(WorkflowStartsSchema.parse(draft.starts)),
    ),
  });
  await writeToolCallBindings(transaction, {
    organizationId,
    workflowVersionId: draft.id,
    pins: toolPins.pins,
  });
  await transaction.query(
    `delete from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, draft.id],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("WORKFLOW_VERSION_INSERT_FAILED");
  // The draft is gone, so a proposal still waiting on it is settled as
  // superseded by this version, in this transaction (#421 item 4.14).
  await supersedeWaitingProposals(transaction, {
    organizationId,
    workflowId,
    versionId: draft.id,
    principalId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    actorKind: attribution.actorKind,
    accessTokenId: attribution.accessTokenId,
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
  // "Use this version" by an agent needs the same grant as publishing (O52).
  const attribution = await assertMayPublishDefinition(transaction, context, {
    organizationId,
    principalId,
    kind: DefinitionKind.Workflow,
    definitionId: workflowId,
  });
  // "Use this version" is a library act: an unlisted definition runs only at
  // an exact published version until a person saves it as a workflow.
  const listed = await transaction.query<{ visibility: string }>(
    `select visibility from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, workflowId],
  );
  if (listed.rows[0]?.visibility !== WorkflowVisibility.Listed) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_unlisted" },
    });
  }
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
          set active_version_id = $4, active_version_set_by = $5,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      // The principal who uses the version is who its starts run as.
      [organizationId, workflowId, expectedVersion, versionId, principalId],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendWorkflowFacts(transaction, {
    organizationId,
    principalId,
    operation: "workflowActivations.create",
    actorKind: attribution.actorKind,
    accessTokenId: attribution.accessTokenId,
    resourceType: "workflow_definition",
    resourceId: workflowId,
    eventType: "workflows.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toWorkflowDefinition(row);
}

/** Origin kind of a definition copied from another one (0175's vocabulary). */
export const COPY_ORIGIN_KIND = "copy";

/**
 * Save as workflow (factory-modes.md section 4.2 step 5): a person copies one
 * published version of an unlisted definition into a NEW listed definition
 * with its own draft, written by the editor's definition and draft writers.
 * The copy's origin is `copy` naming the source definition and version; the
 * unlisted source and every run pinned to it stay unchanged. If-Match is the
 * source definition's version. Only a person saves (chapter 25 O52).
 */
export async function createWorkflowListing(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPersonActs(context, principalId, "workflow_listing_requires_person");
  const value = input as { versionId: string; slug?: string; name?: string };
  const workflowId = context.params.id;
  if (!workflowId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // Lock the source so the version check and the copy read one state.
  const source = (await transaction.query<{
    visibility: string;
    version: number;
    name: string;
    description: string | null;
  }>(
    `select visibility, version, name, description
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, workflowId],
  )).rows[0];
  if (!source) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (source.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (source.visibility !== WorkflowVisibility.Unlisted) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_already_listed" },
    });
  }
  const version = (await transaction.query<
    { status: string; source_yaml: string; normalized_spec: JsonValue }
  >(
    `select status, source_yaml, normalized_spec from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, value.versionId],
  )).rows[0];
  if (!version) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (version.status !== "published") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_version_not_published" },
    });
  }
  // The source never changes, so its If-Match alone would let every save make
  // another copy. One source version has one library copy: under the source
  // lock above, a second save names the existing copy so the UI can open it.
  // An Idempotency-Key replay is answered by the command runner before this
  // handler runs, so it still returns the original 201.
  const existing = (await transaction.query<{ id: string }>(
    `select id from bakery.workflow_definitions
      where organization_id = $1 and origin_source_workflow_id = $2
        and origin_source_version_id = $3
      limit 1`,
    [organizationId, workflowId, value.versionId],
  )).rows[0];
  if (existing) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: "workflow_copy_exists",
        existingResourceId: existing.id,
      },
    });
  }
  const facts = writeFactsOf(context);
  // The one copy writer: origin copy naming source definition, version and
  // digest, a first draft, and the copy's own (listed) visibility default.
  const copy = await insertWorkflowCopy(transaction, facts, {
    sourceWorkflowId: workflowId,
    sourceVersionId: value.versionId,
    slug: value.slug ?? `copy-${crypto.randomUUID()}`,
    name: value.name ?? source.name,
    description: source.description ?? "",
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "workflowListings.create",
    resourceType: "workflow_definition",
    resourceId: copy.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { sourceWorkflowId: workflowId, sourceVersionId: value.versionId },
  });
  return toWorkflowDefinition(copy);
}

/** Refuses an agent's request where chapter 25 reserves the act for a person. */
export function assertPersonActs(
  context: ActionContext,
  principalId: string,
  reason: string,
): void {
  if (attributeAction(context, principalId).actorKind === "person") return;
  throw new StandardError({ code: "AUTH_FORBIDDEN", params: { reason } });
}

export async function validateWorkflow(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { definition } = input as { definition: JsonValue };
  const calls = await loadCalledWorkflows(
    transaction,
    organizationId,
    definition,
  );
  const report = await validateWorkflowDefinitionStatic(definition, calls);
  const bindingResult = report.valid
    ? await validateWorkflowBindings(transaction, organizationId, definition)
    : { errors: [] as readonly WorkflowValidationIssue[], bindings: [] };
  const skillErrors = report.valid
    ? await stepSkillIssues(transaction, {
      organizationId,
      principalId,
      workflowId: null,
      definition,
    })
    : [];
  // The dry run says what publish would say about a tool.call step's MCP pin.
  const toolErrors = report.valid
    ? (await checkToolCallPins(transaction, {
      organizationId,
      principalId,
      workflowId: null,
      definition,
      calls,
    })).issues
    : [];
  const bindingErrors = [
    ...bindingResult.errors,
    ...skillErrors,
    ...toolErrors,
  ];
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
    copyWorkflow: copyWorkflowDefinition,
    listVersions: createWorkflowVersionsListHandler(secret),
    getVersion: getWorkflowVersion,
    getVersionSkills: readWorkflowVersionSkills,
    createVersion: createWorkflowVersion,
    updateVersion: updateWorkflowVersion,
    publishVersion: publishWorkflowVersion,
    activate: activateWorkflowVersion,
    validate: validateWorkflow,
    createListing: createWorkflowListing,
    getProposal: getWorkflowDefinitionProposal,
    decideProposal: decideWorkflowDefinitionProposal,
    createPublishGrant: createDefinitionPublishGrant,
    deletePublishGrant: deleteDefinitionPublishGrant,
    createAgentPowerGrant,
    deleteAgentPowerGrant,
  };
}
