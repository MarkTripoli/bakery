import { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { McpServerImplementedAction } from "@bakery/contracts/implemented-actions";
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
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * MCP server definitions (#434, chapter 25 section 15.4).
 *
 * A server is the shared, organization-scoped record of what a remote MCP server
 * is: its transport, where it lives and what it requires. It holds no credential
 * and grants nothing. A connection (a separate group) is one use of it, and
 * discovery pins what the server offers.
 *
 * Remote only. A `stdio` server is launched by a worker on a particular host, which
 * this version does not do, so one is refused at registration rather than stored
 * as a definition nothing can use.
 */

type ServerOutput = z.output<typeof contractSchemas.McpServer>;
type ServerCreate = z.output<typeof contractSchemas.McpServerCreate>;
type ServerUpdate = z.output<typeof contractSchemas.McpServerUpdate>;
type ServerPage = {
  items: ServerOutput[];
  nextCursor: string | null;
};

type ServerRow = {
  id: string;
  slug: string;
  name: string;
  transport: string;
  launch_spec: unknown;
  endpoint_template: string | null;
  config_schema: unknown;
  required_capabilities: unknown;
  source_revision: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
};

const COLUMNS = `id, slug, name, transport, launch_spec, endpoint_template,
  config_schema, required_capabilities, source_revision, enabled,
  created_at, updated_at, version`;

function toServer(row: ServerRow): ServerOutput {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    transport: row.transport as ServerOutput["transport"],
    launchSpec: row.launch_spec ?? null,
    endpointTemplate: row.endpoint_template,
    configSchema: row.config_schema ?? {},
    requiredCapabilities: Array.isArray(row.required_capabilities)
      ? row.required_capabilities.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : [],
    sourceRevision: row.source_revision,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as ServerOutput;
}

const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,63})\}/g;

/**
 * The reason an endpoint template is not acceptable, or `null` when it is.
 *
 * A template is `https://` and nothing else, names no credential, and is not a
 * literal address or `localhost`. It may carry `{name}` placeholders that a
 * connection's config fills in, but never in the last two labels of the host, so a
 * config value can pick a tenant (`{tenant}.example.com`) and cannot pick the
 * destination. This is registration-time hygiene; what actually stops a request
 * reaching a private address is the resolve-time check at discovery.
 */
export function endpointTemplateProblem(template: string): string | null {
  // No whitespace, control character or backslash anywhere: URL parsers disagree
  // about all three, and a template is read by more than one of them.
  for (const character of template) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || character === "\\") {
      return "endpoint_invalid";
    }
  }
  const stripped = template.replaceAll(PLACEHOLDER, "x");
  if (stripped.includes("{") || stripped.includes("}")) {
    return "endpoint_placeholder_invalid";
  }
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    return "endpoint_invalid";
  }
  if (url.protocol !== "https:") return "endpoint_not_https";
  if (url.username !== "" || url.password !== "") {
    return "endpoint_has_credentials";
  }
  if (url.hash !== "") return "endpoint_has_fragment";
  const rawHost = /^https:\/\/([^/?#]+)/i.exec(template)?.[1] ?? "";
  const labels = rawHost.replace(/:\d+$/, "").split(".");
  if (labels.slice(-2).some((label) => label.includes("{"))) {
    return "endpoint_placeholder_in_domain";
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "" || host === "localhost" || host.endsWith(".localhost") ||
    host.startsWith("[") || /^[0-9.]+$/.test(host) || !host.includes(".")
  ) return "endpoint_host_not_public";
  return null;
}

/** What a remote definition may and may not carry, as field problems. */
function remoteProblem(
  input: {
    transport?: string;
    launchSpec?: unknown;
    endpointTemplate?: string | null;
    requiredCapabilities?: readonly string[];
  },
): { path: string[]; code: string } | null {
  if (input.transport !== undefined && input.transport !== "streamable_http") {
    return { path: ["transport"], code: "transport_not_supported_yet" };
  }
  if (input.launchSpec !== undefined && input.launchSpec !== null) {
    return { path: ["launchSpec"], code: "launch_spec_not_for_remote" };
  }
  if (
    input.requiredCapabilities !== undefined &&
    input.requiredCapabilities.length > 0
  ) {
    return {
      path: ["requiredCapabilities"],
      code: "capabilities_not_for_remote",
    };
  }
  if (input.endpointTemplate !== undefined) {
    if (input.endpointTemplate === null) {
      return { path: ["endpointTemplate"], code: "endpoint_required" };
    }
    const problem = endpointTemplateProblem(input.endpointTemplate);
    if (problem) return { path: ["endpointTemplate"], code: problem };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when a JSON Schema reaches outside itself with a `$ref` that is not local. */
function hasRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRemoteRef);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    key === "$ref"
      ? typeof entry !== "string" || !entry.startsWith("#")
      : hasRemoteRef(entry)
  );
}

/**
 * Compiles a server's config schema into a validator, or `null` when it is not an
 * object schema this server can enforce (an unsupported keyword, or a `$ref` that
 * would have to be fetched). Refused at registration, so no connection ever meets
 * a stored schema it cannot check.
 */
export function compileConfigSchema(schema: unknown): z.ZodType | null {
  if (!isPlainObject(schema) || hasRemoteRef(schema)) return null;
  try {
    return z.fromJSONSchema(schema as never);
  } catch {
    return null;
  }
}

function serverId(context: ActionContext): string {
  if (!context.params.id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return context.params.id;
}

async function loadServer(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ServerOutput> {
  const result = await transaction.query<ServerRow>(
    `select ${COLUMNS} from bakery.mcp_servers
      where organization_id = $1 and id = $2${
      options.lock ? " for update" : ""
    }`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toServer(row);
}

async function record(
  context: ActionContext,
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  server: ServerOutput,
  operation: string,
  eventType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    operation,
    resourceType: "mcp_server",
    resourceId: server.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    applicationId: null,
    repositoryId: null,
    eventType,
    aggregateId: server.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      actor.organizationId,
      server.id,
      eventType,
    ),
    payload: { resourceId: server.id, resourceVersion: server.version },
    traceId: context.traceId,
  });
}

/** `mcpServers.get`: Developer. */
export async function getMcpServer(
  context: ActionContext,
): Promise<ServerOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  return await loadServer(transaction, organizationId, serverId(context));
}

/** `mcpServers.list`: Developer, newest first, cursor-paged. */
export function createMcpServersListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ): Promise<ServerPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: McpServerImplementedAction.McpServersList,
      organizationId,
      principalId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      ServerRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.mcp_servers
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
      items: visible.map(toServer),
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
 * `mcpServers.create`: Admin. Remote (`streamable_http`) only; a definition starts
 * disabled, so registering one never makes it usable on its own.
 */
export async function createMcpServer(
  context: ActionContext,
  input: ServerCreate,
): Promise<ServerOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const problem = remoteProblem(input);
  if (problem) throw unprocessable(problem.path, problem.code);
  if (!isPlainObject(input.configSchema)) {
    throw unprocessable(["configSchema"], "config_schema_not_object");
  }
  if (!compileConfigSchema(input.configSchema)) {
    throw unprocessable(["configSchema"], "config_schema_unsupported");
  }
  if (input.endpointTemplate === undefined || input.endpointTemplate === null) {
    throw unprocessable(["endpointTemplate"], "endpoint_required");
  }
  let id: string;
  try {
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.mcp_servers (
         organization_id, slug, name, transport, launch_spec, endpoint_template,
         config_schema, required_capabilities, source_revision
       ) values ($1, $2, $3, 'streamable_http', null, $4, $5::jsonb, '[]'::jsonb, $6)
       returning id`,
      [
        organizationId,
        input.slug,
        input.name,
        input.endpointTemplate,
        JSON.stringify(input.configSchema),
        input.sourceRevision,
      ],
    );
    id = inserted.rows[0]!.id;
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "mcp_server_exists" },
      });
    }
    throw error;
  }
  const created = await loadServer(transaction, organizationId, id);
  await record(
    context,
    transaction,
    { organizationId, principalId },
    created,
    "mcpServers.create",
    "mcpServers.created",
    {
      slug: created.slug,
      transport: created.transport,
      sourceRevision: created.sourceRevision,
    },
  );
  return created;
}

/**
 * `mcpServers.update`: Admin, `If-Match` against the version. The name, whether the
 * definition is enabled, and (for a remote server, always empty) its required
 * capabilities. Slug, transport, endpoint and source revision are identity: a
 * different one is a different server, so the grant does not let them move.
 */
export async function updateMcpServer(
  context: ActionContext,
  input: ServerUpdate,
): Promise<ServerOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (
    input.name === undefined && input.enabled === undefined &&
    input.requiredCapabilities === undefined
  ) throw unprocessable(["name"], "mcp_server_update_empty");
  const problem = remoteProblem({
    requiredCapabilities: input.requiredCapabilities,
  });
  if (problem) throw unprocessable(problem.path, problem.code);
  const id = serverId(context);
  const current = await loadServer(transaction, organizationId, id, {
    lock: true,
  });
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    `update bakery.mcp_servers
        set name = $3, enabled = $4, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      id,
      input.name ?? current.name,
      input.enabled ?? current.enabled,
    ],
  );
  const updated = await loadServer(transaction, organizationId, id);
  await record(
    context,
    transaction,
    { organizationId, principalId },
    updated,
    "mcpServers.update",
    "mcpServers.updated",
    {
      renamed: input.name !== undefined && input.name !== current.name,
      enabled: updated.enabled,
    },
  );
  return updated;
}
