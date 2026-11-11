import type { ActionContext } from "@bakery/contracts/action-registry";
import type { AgentsActionHandlers } from "./actions.ts";
import {
  AgentVersionCreateConfigSchema,
  type JsonValue,
} from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
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
import { resolveAgentSkillBindings } from "../catalog/agent-skill-bindings.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

const DEFINITIONS_ORDERING = "createdAt:desc,id:desc";
const VERSIONS_ORDERING = "revision:desc,id:desc";
const DEFINITION_COLUMNS =
  "id, slug, name, description, active_version_id, enabled, created_at, updated_at, version";
const VERSION_COLUMNS =
  "id, agent_id, revision, config, digest, created_by, created_at, updated_at, version";

type AgentDefinitionRow = {
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

type AgentVersionRow = {
  id: string;
  agent_id: string;
  revision: number;
  config: unknown;
  digest: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type CursorQueryInput = { cursor?: string; limit?: number };
type AgentCreateInput = { slug: string; name: string; description: string };
type AgentUpdateInput = {
  name?: string;
  description?: string | null;
  enabled?: boolean;
};
type AgentVersionActivateInput = { versionId: string };
type AgentVersionCreateInput = {
  revision: number;
  config: unknown;
  digest: string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toAgentDefinition(row: AgentDefinitionRow) {
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

export function toAgentVersion(row: AgentVersionRow) {
  let config: JsonValue;
  try {
    config = JSON.parse(JSON.stringify(row.config)) as JsonValue;
  } catch {
    throw new Error("AGENT_VERSION_CONFIG_INVALID");
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    revision: row.revision,
    config,
    digest: row.digest,
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

function freezeConfig<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeConfig(child);
    Object.freeze(value);
  }
  return value;
}

export async function agentVersionDigest(config: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(config));
}

function assertNextRevision(currentMax: number, requested: number): void {
  const expectedRevision = currentMax + 1;
  if (requested !== expectedRevision) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "revision_not_next", expectedRevision },
    });
  }
}

function assertPromptBindingsAvailable(config: {
  promptBindings?: Record<string, string>;
}): void {
  if (config.promptBindings && Object.keys(config.promptBindings).length > 0) {
    throw unprocessable(
      ["config", "promptBindings"],
      "binding_source_unavailable",
    );
  }
}

async function appendCatalogFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    eventType: string;
    resourceVersion: number;
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
    aggregateVersion: options.resourceVersion,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.resourceVersion,
    },
    traceId: options.traceId,
  });
}

export function createAgentDefinitionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "agents.list",
      principalId,
      organizationId,
      ordering: DEFINITIONS_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      AgentDefinitionRow & { cursor_created_at: string }
    >(
      `select ${DEFINITION_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.agent_definitions
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
      items: visible.map(toAgentDefinition),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getAgentDefinition(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const agentId = context.params.id;
  if (!agentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<AgentDefinitionRow>(
    `select ${DEFINITION_COLUMNS}
       from bakery.agent_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, agentId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toAgentDefinition(row);
}

export async function createAgentDefinition(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as AgentCreateInput;
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<AgentDefinitionRow>(
      `insert into bakery.agent_definitions (
         id, organization_id, slug, name, description
       ) values ($1, $2, $3, $4, $5)
       returning ${DEFINITION_COLUMNS}`,
      [id, organizationId, value.slug, value.name, value.description],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("AGENT_DEFINITION_INSERT_FAILED");
  await appendCatalogFacts(transaction, {
    organizationId,
    principalId,
    operation: "agents.create",
    resourceType: "agent_definition",
    resourceId: id,
    eventType: "agents.created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAgentDefinition(row);
}

export async function updateAgentDefinition(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as AgentUpdateInput;
  const agentId = context.params.id;
  if (!agentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const updated = await boundedMutation(() =>
    transaction.query<AgentDefinitionRow>(
      `update bakery.agent_definitions
          set name = case when $4::boolean then $5 else name end,
              description = case when $6::boolean then $7 else description end,
              enabled = case when $8::boolean then $9 else enabled end,
              updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      [
        organizationId,
        agentId,
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
  if (!row) {
    const visible = await transaction.query(
      "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2",
      [organizationId, agentId],
    );
    throw new StandardError({
      code: visible.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await appendCatalogFacts(transaction, {
    organizationId,
    principalId,
    operation: "agents.update",
    resourceType: "agent_definition",
    resourceId: agentId,
    eventType: "agents.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAgentDefinition(row);
}

/**
 * Makes one published version the definition's active version. Admin only,
 * compare-and-swap on the definition's version (`If-Match`), audited as
 * `agents.activateVersion`. The version must belong to this agent in this
 * organization; activating the version that is already active is a no-op.
 */
export async function activateAgentVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as AgentVersionActivateInput;
  const agentId = context.params.id;
  if (!agentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const locked = await transaction.query<AgentDefinitionRow>(
    `select ${DEFINITION_COLUMNS}
       from bakery.agent_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, agentId],
  );
  const current = locked.rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const published = await transaction.query(
    `select 1 from bakery.agent_versions
      where organization_id = $1 and agent_id = $2 and id = $3`,
    [organizationId, agentId, value.versionId],
  );
  if (published.rows.length !== 1) {
    throw unprocessable(["versionId"], "agent_version_unknown");
  }
  if (current.active_version_id === value.versionId) {
    return toAgentDefinition(current);
  }
  const updated = await boundedMutation(() =>
    transaction.query<AgentDefinitionRow>(
      `update bakery.agent_definitions
          set active_version_id = $4,
              updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      [organizationId, agentId, expectedVersion, value.versionId],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendCatalogFacts(transaction, {
    organizationId,
    principalId,
    operation: "agents.activateVersion",
    resourceType: "agent_definition",
    resourceId: agentId,
    eventType: "agents.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAgentDefinition(row);
}

export function createAgentVersionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const agentId = context.params.id;
    if (!agentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const parent = await transaction.query(
      "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2",
      [organizationId, agentId],
    );
    if (parent.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "agentVersions.list",
      principalId,
      organizationId,
      ordering: VERSIONS_ORDERING,
      filters: JSON.stringify({ agentId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<AgentVersionRow>(
      `select ${VERSION_COLUMNS}
         from bakery.agent_versions
        where organization_id = $1 and agent_id = $2
          and ($3::integer is null or (revision, id) < ($3, $4::uuid))
        order by revision desc, id desc
        limit $5`,
      [
        organizationId,
        agentId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toAgentVersion),
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

export async function createAgentVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as AgentVersionCreateInput;
  const agentId = context.params.id;
  if (!agentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const parsed = AgentVersionCreateConfigSchema.safeParse(value.config);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: parsed.error.issues.map((issue) => ({
          path: ["config", ...issue.path],
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  const config = freezeConfig(parsed.data);
  assertPromptBindingsAvailable(config);
  const digest = value.digest.toLowerCase();
  if (await agentVersionDigest(config) !== digest) {
    throw unprocessable(["digest"], "digest_mismatch");
  }

  const locked = await transaction.query<{ id: string }>(
    `select id from bakery.agent_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, agentId],
  );
  if (!locked.rows[0]) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const max = await transaction.query<{ max: number }>(
    `select coalesce(max(revision), 0) as max
       from bakery.agent_versions
      where organization_id = $1 and agent_id = $2`,
    [organizationId, agentId],
  );
  assertNextRevision(max.rows[0]?.max ?? 0, value.revision);
  await resolveAgentSkillBindings(
    transaction,
    organizationId,
    config.skillBindings,
  );

  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<AgentVersionRow>(
      `insert into bakery.agent_versions (
         id, organization_id, agent_id, revision, config, digest, created_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       returning ${VERSION_COLUMNS}`,
      [
        id,
        organizationId,
        agentId,
        value.revision,
        JSON.stringify(config),
        digest,
        principalId,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("AGENT_VERSION_INSERT_FAILED");
  await appendCatalogFacts(transaction, {
    organizationId,
    principalId,
    operation: "agentVersions.create",
    resourceType: "agent_version",
    resourceId: id,
    eventType: "agent.version_created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAgentVersion(row);
}

export function createAgentsHandlers(secret: string): AgentsActionHandlers {
  return {
    listAgents: createAgentDefinitionsListHandler(secret),
    getAgent: getAgentDefinition,
    createAgent: createAgentDefinition,
    updateAgent: updateAgentDefinition,
    activateVersion: activateAgentVersion,
    createVersion: createAgentVersion,
    listVersions: createAgentVersionsListHandler(secret),
  };
}
