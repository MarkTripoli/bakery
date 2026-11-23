import { z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { McpConnectionImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import { encryptMcpCredential, loadSecretKey } from "../secrets/crypto.ts";
import { compileConfigSchema } from "./server-commands.ts";

/**
 * MCP connections (#434, chapter 25 section 15.4): one use of a server definition.
 *
 * Two scopes. An organization connection is registered by an Admin and is the
 * organization's. A personal connection (O27) belongs to the member who registered
 * it: only they can see or change it, and to anyone else it is absent, not
 * forbidden, so its existence is not disclosed.
 *
 * The credential is write-only. It is sealed under the installation key as a
 * version of an organization-owned secret, the connection stores only that secret's
 * id, and nothing returns, audits or logs the value.
 */

type ConnectionOutput = z.output<typeof contractSchemas.McpConnection>;
type ConnectionCreate = z.output<typeof contractSchemas.McpConnectionCreate>;
type ConnectionUpdate = z.output<typeof contractSchemas.McpConnectionUpdate>;
type ConnectionPage = { items: ConnectionOutput[]; nextCursor: string | null };

export type McpConnectionDependencies = {
  /** Sealing key reference; without it a credential cannot be written. */
  secretsKey: SecretsKeyConfig | undefined;
  /** Signs list cursors. */
  cursorSecret: string;
};

export type ConnectionRow = {
  id: string;
  server_id: string;
  integration_connection_id: string | null;
  worker_host_id: string | null;
  owner_principal_id: string | null;
  label: string;
  config: unknown;
  secret_id: string | null;
  enabled_capabilities: unknown;
  status: string;
  current_snapshot_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
};

const COLUMNS = `connection.id, connection.server_id,
  connection.integration_connection_id, connection.worker_host_id,
  connection.owner_principal_id, connection.label, connection.config,
  connection.secret_id, connection.enabled_capabilities, connection.status,
  connection.current_snapshot_id, connection.created_at, connection.updated_at,
  connection.version`;

/**
 * What an agent may not do to a connection (chapter 25 section 18.3, O51): it
 * prepares the connection and a person completes it, because a secret must never
 * enter model context and consent binds a person's identity.
 */
export const AgentConnectionRefusal = Object.freeze(
  {
    /** An agent cannot attach or change a secret. */
    Secret: "agent_connection_secret_stays_with_people",
    /** An agent drafts a personal connection, which its person then completes. */
    Personal: "agent_connection_draft_is_personal",
    /** An agent cannot switch a connection on; a person reviews the draft first. */
    Enable: "agent_connection_enable_stays_with_people",
    /**
     * An agent edits only its person's own disabled draft with no secret, and
     * never revokes: a live or organization connection is a person's to change.
     */
    NotDraft: "agent_connection_edits_only_its_draft",
  } as const,
);

/** An agent's refusal names the field and the rule, as an issue a client can show. */
function refuseAgent(field: string, reason: string) {
  return unprocessable([field], reason);
}

/** Statuses a person may set. `degraded` is the system's finding, never a choice. */
const SETTABLE_STATUSES = new Set(["enabled", "disabled", "revoked"]);

function toConnection(row: ConnectionRow): ConnectionOutput {
  return {
    id: row.id,
    serverId: row.server_id,
    integrationConnectionId: row.integration_connection_id,
    workerHostId: row.worker_host_id,
    ownerPrincipalId: row.owner_principal_id,
    label: row.label,
    config: row.config ?? {},
    secretId: row.secret_id,
    enabledCapabilities: Array.isArray(row.enabled_capabilities)
      ? row.enabled_capabilities.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : [],
    status: row.status as ConnectionOutput["status"],
    currentSnapshotId: row.current_snapshot_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as ConnectionOutput;
}

/** Whether the actor holds the organization role Admin. */
function isAdmin(context: ActionContext): boolean {
  const authority = (context as unknown as { authority?: { role?: string } })
    .authority;
  return authority?.role === "admin";
}

export function connectionId(context: ActionContext): string {
  if (!context.params.id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return context.params.id;
}

/**
 * A connection the actor may see: the organization's, or their own personal one.
 * Someone else's personal connection is absent, the same as an unknown id.
 */
export async function loadVisible(
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  id: string,
  options: { lock?: boolean } = {},
): Promise<ConnectionRow> {
  const result = await transaction.query<ConnectionRow>(
    `select ${COLUMNS} from bakery.mcp_connections as connection
      where connection.organization_id = $1 and connection.id = $2
        and (connection.owner_principal_id is null
             or connection.owner_principal_id = $3)${
      options.lock ? " for update of connection" : ""
    }`,
    [actor.organizationId, id, actor.principalId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/**
 * Who may change a connection: an Admin an organization connection, and only its
 * owner a personal one. An Admin has no say over a member's personal connection.
 */
export function requireMayChange(
  context: ActionContext,
  row: { owner_principal_id: string | null },
): void {
  if (row.owner_principal_id === null && !isAdmin(context)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

/** Seals a credential as the first or next revision of the connection's secret. */
async function sealCredential(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    principalId: string;
    secretId: string | null;
    label: string;
    secret: string;
    secretsKey: SecretsKeyConfig | undefined;
  },
): Promise<{ secretId: string; revision: number }> {
  // Resolved first: without a key nothing is written, not even a secret row.
  const key = await loadSecretKey(input.secretsKey);
  const keyId = input.secretsKey!.keyId;
  const secretId = input.secretId ?? crypto.randomUUID();
  let revision = 1;
  if (input.secretId !== null) {
    const current = await transaction.query<{ revision: number }>(
      `select active_version_revision as revision from bakery.secrets
        where organization_id = $1 and id = $2 and application_id is null
          for update`,
      [input.organizationId, input.secretId],
    );
    if (!current.rows[0]) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    revision = current.rows[0].revision + 1;
  } else {
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, $2, null, $3, 'mcp', '[]'::jsonb, '[]'::jsonb)`,
      [secretId, input.organizationId, `${input.label} credential`],
    );
  }
  const cipher = await encryptMcpCredential(
    key,
    { organizationId: input.organizationId, secretId, revision, keyId },
    input.secret,
  );
  const versionId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.secret_versions (id, organization_id, application_id,
       secret_id, revision, ciphertext, nonce, key_id, created_by)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8)`,
    [
      versionId,
      input.organizationId,
      secretId,
      revision,
      cipher.ciphertext,
      cipher.nonce,
      keyId,
      input.principalId,
    ],
  );
  await transaction.query(
    input.secretId === null
      ? `update bakery.secrets set active_version_id = $3
          where organization_id = $1 and id = $2 and application_id is null`
      : `update bakery.secrets set active_version_id = $3,
           active_version_revision = $4, generation = generation + 1,
           invalidation_generation = invalidation_generation + 1,
           version = version + 1, updated_at = now()
          where organization_id = $1 and id = $2 and application_id is null`,
    input.secretId === null
      ? [input.organizationId, secretId, versionId]
      : [input.organizationId, secretId, versionId, revision],
  );
  return { secretId, revision };
}

export async function loadServerForConnection(
  transaction: PgTransactionClient,
  organizationId: string,
  serverId: string,
): Promise<
  {
    enabled: boolean;
    transport: string;
    configSchema: unknown;
    requiredCapabilities: string[];
  }
> {
  const result = await transaction.query<{
    enabled: boolean;
    transport: string;
    config_schema: unknown;
    required_capabilities: unknown;
  }>(
    `select enabled, transport, config_schema, required_capabilities
       from bakery.mcp_servers
      where organization_id = $1 and id = $2`,
    [organizationId, serverId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    enabled: row.enabled,
    transport: row.transport,
    configSchema: row.config_schema,
    requiredCapabilities: Array.isArray(row.required_capabilities)
      ? row.required_capabilities.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : [],
  };
}

/**
 * Where a connection's server runs (#441). A remote server runs nowhere in
 * particular and names no host. A local (`stdio`) server runs on exactly one
 * worker host, which is a placement requirement: the connection names a host of
 * this organization that advertises every capability the server requires, and
 * a call is dispatched only there.
 */
export async function requirePlacement(
  transaction: PgTransactionClient,
  organizationId: string,
  server: { transport: string; requiredCapabilities: readonly string[] },
  workerHostId: string | null,
): Promise<string | null> {
  if (server.transport !== "stdio") {
    if (workerHostId !== null) {
      throw unprocessable(["workerHostId"], "worker_host_not_for_remote");
    }
    return null;
  }
  if (workerHostId === null) {
    throw unprocessable(["workerHostId"], "worker_host_required");
  }
  const host = (await transaction.query<{ capabilities: unknown }>(
    `select capabilities from bakery.worker_hosts
      where organization_id = $1 and id = $2`,
    [organizationId, workerHostId],
  )).rows[0];
  if (host === undefined) {
    throw unprocessable(["workerHostId"], "worker_host_unknown");
  }
  const offered = new Set(
    Array.isArray(host.capabilities) ? host.capabilities : [],
  );
  if (!server.requiredCapabilities.every((name) => offered.has(name))) {
    throw unprocessable(["workerHostId"], "worker_host_lacks_capabilities");
  }
  return workerHostId;
}

/** Refuses a config the server's schema does not accept, naming the path. */
function requireValidConfig(configSchema: unknown, config: unknown): void {
  const compiled = compileConfigSchema(configSchema);
  if (!compiled) throw unprocessable(["config"], "config_schema_unsupported");
  const parsed = compiled.safeParse(config);
  if (!parsed.success) {
    throw unprocessable(
      [
        "config",
        ...(parsed.error.issues[0]?.path ?? []).map((part) =>
          typeof part === "symbol" ? String(part) : part
        ),
      ],
      "config_invalid",
    );
  }
}

/** Tool names a snapshot's manifest lists. */
async function snapshotToolNames(
  transaction: PgTransactionClient,
  organizationId: string,
  snapshotId: string | null,
): Promise<Set<string>> {
  if (snapshotId === null) return new Set();
  const result = await transaction.query<{ manifest: unknown }>(
    `select manifest from bakery.mcp_capability_snapshots
      where organization_id = $1 and id = $2`,
    [organizationId, snapshotId],
  );
  const tools = (result.rows[0]?.manifest as { tools?: unknown } | undefined)
    ?.tools;
  const names = new Set<string>();
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

export async function record(
  context: ActionContext,
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  connection: ConnectionOutput,
  operation: string,
  eventType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    operation,
    resourceType: "mcp_connection",
    resourceId: connection.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    applicationId: null,
    repositoryId: null,
    eventType,
    aggregateId: connection.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      actor.organizationId,
      connection.id,
      eventType,
    ),
    payload: { resourceId: connection.id, resourceVersion: connection.version },
    traceId: context.traceId,
  });
}

/** `mcpConnections.get`: the organization's connections and the actor's own. */
export async function getMcpConnection(
  context: ActionContext,
): Promise<ConnectionOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  return toConnection(
    await loadVisible(
      transaction,
      { organizationId, principalId },
      connectionId(context),
    ),
  );
}

/** `mcpConnections.list`: the organization's connections and the actor's own. */
export function createMcpConnectionsListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ): Promise<ConnectionPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: McpConnectionImplementedAction.McpConnectionsList,
      organizationId,
      principalId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      ConnectionRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(connection.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.mcp_connections as connection
        where connection.organization_id = $1
          and (connection.owner_principal_id is null
               or connection.owner_principal_id = $2)
          and ($3::timestamptz is null
               or (connection.created_at, connection.id) < ($3, $4::uuid))
        order by connection.created_at desc, connection.id desc
        limit $5`,
      [
        organizationId,
        principalId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toConnection),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(cursorSecret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * `mcpConnections.create`: Developer for a personal connection, Admin for an
 * organization one. It starts with no tools enabled and no snapshot: what a server
 * offers is learned by discovery, and enabling a tool is a later, deliberate change.
 */
export function createMcpConnectionCreator(
  dependencies: McpConnectionDependencies,
) {
  return async (
    context: ActionContext,
    input: ConnectionCreate,
  ): Promise<ConnectionOutput> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const personal = input.scope === "personal";
    if (!personal && !isAdmin(context)) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    // An agent's connection is a draft: personal, with no secret, and off until
    // the person it acts for completes and enables it.
    const draft = attributeAction(context, principalId).actorKind === "agent";
    if (draft && input.secret != null) {
      throw refuseAgent("secret", AgentConnectionRefusal.Secret);
    }
    if (draft && !personal) {
      throw refuseAgent("scope", AgentConnectionRefusal.Personal);
    }
    if (input.integrationConnectionId != null) {
      throw unprocessable(
        ["integrationConnectionId"],
        "integration_connection_not_supported_yet",
      );
    }
    if (input.enabledCapabilities.length > 0) {
      throw unprocessable(
        ["enabledCapabilities"],
        "capabilities_need_discovery",
      );
    }
    const server = await loadServerForConnection(
      transaction,
      organizationId,
      input.serverId,
    );
    if (!server.enabled) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "mcp_server_disabled" },
      });
    }
    const workerHostId = await requirePlacement(
      transaction,
      organizationId,
      server,
      input.workerHostId ?? null,
    );
    requireValidConfig(server.configSchema, input.config);
    const id = crypto.randomUUID();
    // The credential is sealed first, in this transaction: if the key is missing
    // or anything below fails, no secret and no connection remain.
    const sealed = input.secret == null ? null : await sealCredential(
      transaction,
      {
        organizationId,
        principalId,
        secretId: null,
        label: input.label,
        secret: input.secret,
        secretsKey: dependencies.secretsKey,
      },
    );
    await transaction.query(
      `insert into bakery.mcp_connections (
         id, organization_id, server_id, owner_principal_id, label, config,
         secret_id, enabled_capabilities, status, worker_host_id
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, '[]'::jsonb, $8, $9)`,
      [
        id,
        organizationId,
        input.serverId,
        personal ? principalId : null,
        input.label,
        JSON.stringify(input.config),
        sealed?.secretId ?? null,
        draft ? "disabled" : "enabled",
        workerHostId,
      ],
    );
    const created = toConnection(
      await loadVisible(transaction, { organizationId, principalId }, id),
    );
    await record(
      context,
      transaction,
      { organizationId, principalId },
      created,
      "mcpConnections.create",
      "mcpConnections.created",
      {
        scope: personal ? "personal" : "organization",
        serverId: input.serverId,
        draft,
        credential: sealed ? "set" : "none",
        ...(sealed ? { secretRevision: sealed.revision } : {}),
      },
    );
    return created;
  };
}

/**
 * `mcpConnections.update`: an Admin for an organization connection, only the
 * owner for a personal one; `If-Match` against the version. Never the server, the
 * owner or the scope. A tool is enabled only if the pinned snapshot lists it.
 */
export function createMcpConnectionUpdater(
  dependencies: McpConnectionDependencies,
) {
  return async (
    context: ActionContext,
    input: ConnectionUpdate,
  ): Promise<ConnectionOutput> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const expectedVersion = requireCommandMetadata(context).expectedVersion;
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    const changed =
      (["label", "config", "secret", "enabledCapabilities", "status"] as const)
        .filter((field) => input[field] !== undefined);
    if (changed.length === 0) {
      throw unprocessable(["label"], "mcp_connection_update_empty");
    }
    if (input.status !== undefined && !SETTABLE_STATUSES.has(input.status)) {
      throw unprocessable(["status"], "status_not_settable");
    }
    if (attributeAction(context, principalId).actorKind === "agent") {
      if (input.secret !== undefined) {
        throw refuseAgent("secret", AgentConnectionRefusal.Secret);
      }
      if (input.status === "enabled") {
        throw refuseAgent("status", AgentConnectionRefusal.Enable);
      }
    }
    const id = connectionId(context);
    const current = await loadVisible(
      transaction,
      { organizationId, principalId },
      id,
      { lock: true },
    );
    requireMayChange(context, current);
    if (attributeAction(context, principalId).actorKind === "agent") {
      if (
        current.owner_principal_id !== principalId ||
        current.status !== "disabled" || current.secret_id !== null
      ) throw refuseAgent("id", AgentConnectionRefusal.NotDraft);
      if (input.status === "revoked") {
        throw refuseAgent("status", AgentConnectionRefusal.NotDraft);
      }
    }
    if (current.version !== expectedVersion) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    // Revocation is final: nothing revives a revoked connection.
    if (current.status === "revoked") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "mcp_connection_revoked" },
      });
    }
    if (input.config !== undefined) {
      const server = await loadServerForConnection(
        transaction,
        organizationId,
        current.server_id,
      );
      requireValidConfig(server.configSchema, input.config);
    }
    if (input.enabledCapabilities !== undefined) {
      const known = await snapshotToolNames(
        transaction,
        organizationId,
        current.current_snapshot_id,
      );
      if (known.size === 0 && input.enabledCapabilities.length > 0) {
        throw unprocessable(
          ["enabledCapabilities"],
          "capabilities_need_discovery",
        );
      }
      const unknown = input.enabledCapabilities.findIndex((name) =>
        !known.has(name)
      );
      if (unknown !== -1) {
        throw unprocessable(["enabledCapabilities", unknown], "unknown_tool");
      }
    }
    const sealed = input.secret == null ? null : await sealCredential(
      transaction,
      {
        organizationId,
        principalId,
        secretId: current.secret_id,
        label: input.label ?? current.label,
        secret: input.secret,
        secretsKey: dependencies.secretsKey,
      },
    );
    await transaction.query(
      `update bakery.mcp_connections
          set label = $3, config = $4::jsonb, secret_id = $5,
              enabled_capabilities = $6::jsonb, status = $7,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [
        organizationId,
        id,
        input.label ?? current.label,
        JSON.stringify(input.config ?? current.config),
        sealed?.secretId ?? current.secret_id,
        JSON.stringify(
          input.enabledCapabilities ?? current.enabled_capabilities ?? [],
        ),
        input.status ?? current.status,
      ],
    );
    const updated = toConnection(
      await loadVisible(transaction, { organizationId, principalId }, id),
    );
    await record(
      context,
      transaction,
      { organizationId, principalId },
      updated,
      "mcpConnections.update",
      "mcpConnections.updated",
      {
        // Field names only: no value, and above all no credential, is recorded.
        changed: changed.filter((field) => field !== "secret"),
        credential: sealed ? "rotated" : "unchanged",
        ...(sealed ? { secretRevision: sealed.revision } : {}),
        status: updated.status,
      },
    );
    return updated;
  };
}
