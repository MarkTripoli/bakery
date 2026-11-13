import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { authorize } from "../auth/application/authorize.ts";
import { organizationActor } from "./auth-attempts.ts";
import { GITHUB_PROVIDER_ID } from "./postgres.ts";

type Connection = z.output<typeof contractSchemas.IntegrationConnection>;
type Resource = z.output<typeof contractSchemas.IntegrationResource>;
type ResourceQuery = z.output<typeof contractSchemas.IntegrationResourceQuery>;
type CursorQuery = z.output<typeof contractSchemas.CursorQuery>;

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

// Explicit projection: installation ids, health detail, problem codes and
// the creating principal stay internal.
const connectionColumns = `connection.id, connection.provider,
  connection.label, connection.external_account_id as "externalAccountId",
  connection.config, connection.secret_id as "secretId",
  connection.granted_permissions as "grantedScopes",
  connection.status, connection.health,
  to_char(connection.last_checked_at at time zone 'UTC', ${TIMESTAMP})
    as "lastCheckedAt",
  to_char(connection.created_at at time zone 'UTC', ${TIMESTAMP})
    as "createdAt",
  to_char(connection.updated_at at time zone 'UTC', ${TIMESTAMP})
    as "updatedAt",
  connection.version`;

type Effect = z.output<typeof contractSchemas.ExternalEffect>;
type EffectQuery = z.output<typeof contractSchemas.IntegrationEffectQuery>;

// #68 "Recent activity": a connection's external effects with their outcome.
// Explicit projection: arguments, results, evidence and credentials stay
// internal; `status` is the outcome (`uncertain` means unknown).
const effectColumns = `effect.id, effect.run_step_id as "runStepId",
  effect.operation, effect.target, effect.idempotency_key as "idempotencyKey",
  effect.status, effect.remote_id as "remoteId",
  to_char(effect.last_checked_at at time zone 'UTC', ${TIMESTAMP})
    as "lastCheckedAt",
  effect.requesting_principal_id as "requestingPrincipalId",
  effect.integration_connection_id as "integrationConnectionId",
  effect.mcp_connection_id as "mcpConnectionId",
  effect.repository_profile_id as "repositoryProfileId",
  effect.adapter_version as "adapterVersion",
  effect.credential_version_id as "credentialVersionId",
  to_char(effect.created_at at time zone 'UTC', ${TIMESTAMP}) as "createdAt",
  to_char(effect.updated_at at time zone 'UTC', ${TIMESTAMP}) as "updatedAt",
  effect.version`;

const connectionProjection = `select ${connectionColumns}
  from bakery.integration_connections as connection
  where connection.organization_id = $1 and connection.id = $2
    and connection.archived_at is null`;

type ConnectionRow = Omit<Connection, "status"> & {
  status: string;
  health: string;
};

function toConnection(
  { health, ...connection }: ConnectionRow,
): Connection {
  return contractSchemas.IntegrationConnection.parse({
    ...connection,
    status: connectionStatus(connection.status, health),
  });
}

/**
 * Client status folded from the separate lifecycle and health columns:
 * revoked, disabled and pending pass through; an enabled connection whose
 * health is degraded or auth_required reads degraded.
 */
export function connectionStatus(
  status: string,
  health: string,
): Connection["status"] {
  if (status === "pending" || status === "disabled" || status === "revoked") {
    return status;
  }
  if (status === "enabled") {
    return health === "degraded" || health === "auth_required"
      ? "degraded"
      : "enabled";
  }
  throw new StandardError({ code: "INTERNAL" });
}

/**
 * integrationConnections.get: a current member with connection read
 * permission reads the safe projection, pending connections included. Any
 * other organization's id, or an archived connection, is RESOURCE_NOT_FOUND.
 */
export async function getConnection(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IdPath>,
): Promise<Connection> {
  const { context: value, actor } = organizationActor(context);
  const result = await value.transaction.query<ConnectionRow>(
    connectionProjection,
    [actor.organizationId, input.id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return toConnection(row);
}

/**
 * integrationConnections.create: generic creation serves declared non-OAuth
 * secret providers only. GitHub binds through a completed auth attempt, so a
 * posted GitHub provider id (and with it any installation id in settings) is
 * STATE_CONFLICT; no other provider is registered yet, so any other id is
 * RESOURCE_NOT_FOUND. Nothing is written either way.
 */
export function createConnection(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IntegrationConnectionCreate>,
): never {
  organizationActor(context);
  if (input.providerId === GITHUB_PROVIDER_ID) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "auth_attempt_required" },
    });
  }
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

const ORDERING = "createdAt:desc,id:desc";
const DEFAULT_LIMIT = 25;
const cursorCreatedAt = (alias: string) =>
  `to_char(${alias}.created_at at time zone 'UTC', ${TIMESTAMP})
    as "cursorCreatedAt"`;

/**
 * Cursor binding for one list: action, caller, organization and a digest of
 * the canonical filters (the connection id included), so a cursor replayed
 * against another connection, other filters or another organization is
 * INVALID_CURSOR. The digest keeps the cursor under its 512-byte cap.
 */
async function listBinding(
  action: string,
  actor: { organizationId: string; subject: { principalId: string } },
  filters: Record<string, unknown>,
): Promise<CursorBinding> {
  return {
    action,
    principalId: actor.subject.principalId,
    organizationId: actor.organizationId,
    ordering: ORDERING,
    filters: await sha256Hex(canonicalJson(filters)),
    schemaVersion: 1,
  };
}

/** One (created_at, id) keyset page: visible rows and the next cursor. */
async function keysetPage<Row extends { id: string; cursorCreatedAt: string }>(
  cursorSecret: string,
  binding: CursorBinding,
  limit: number | undefined,
  rows: Row[],
): Promise<{ rows: Row[]; nextCursor: string | null }> {
  const size = limit ?? DEFAULT_LIMIT;
  const visible = rows.slice(0, size);
  const last = visible.at(-1);
  return {
    rows: visible,
    nextCursor: rows.length > size && last !== undefined
      ? await encodeCursor(cursorSecret, binding, {
        createdAt: last.cursorCreatedAt,
        id: last.id,
      })
      : null,
  };
}

export const resourceColumns = `resource.id,
  resource.organization_id as "organizationId",
  resource.connection_id as "connectionId",
  resource.installation_id as "installationId",
  resource.external_id as "externalId", resource.kind,
  resource.display_name as "displayName", resource.safe_url as "safeUrl",
  resource.selected, resource.available, resource.enabled,
  resource.capability_snapshot as "capabilitySnapshot",
  resource.last_discovery_generation as "lastDiscoveryGeneration",
  to_char(resource.archived_at at time zone 'UTC', ${TIMESTAMP})
    as "archivedAt",
  to_char(resource.created_at at time zone 'UTC', ${TIMESTAMP})
    as "createdAt",
  to_char(resource.updated_at at time zone 'UTC', ${TIMESTAMP})
    as "updatedAt",
  resource.version`;

/**
 * integrationConnections.list and integrationResources.list: signed keyset
 * pages, newest first. Every query names the caller's organization; the
 * cursor is checked before any row is read.
 */
export function createIntegrationListHandlers(cursorSecret: string) {
  return {
    /** The caller's organization's live connections, pending included. */
    async listConnections(
      context: ActionContext,
      input: CursorQuery,
    ): Promise<{ items: Connection[]; nextCursor: string | null }> {
      const { context: value, actor } = organizationActor(context);
      const binding = await listBinding(
        Action.IntegrationConnectionsList,
        actor,
        {},
      );
      const position = await decodeCursor(cursorSecret, input.cursor, binding);
      const result = await value.transaction.query<
        ConnectionRow & { cursorCreatedAt: string }
      >(
        `select ${connectionColumns}, ${cursorCreatedAt("connection")}
           from bakery.integration_connections as connection
          where connection.organization_id = $1
            and connection.archived_at is null
            and ($2::timestamptz is null
              or (connection.created_at, connection.id) < ($2, $3::uuid))
          order by connection.created_at desc, connection.id desc
          limit $4`,
        [
          actor.organizationId,
          position?.createdAt ?? null,
          position?.id ?? null,
          (input.limit ?? DEFAULT_LIMIT) + 1,
        ],
      );
      const page = await keysetPage(
        cursorSecret,
        binding,
        input.limit,
        result.rows,
      );
      return {
        items: page.rows.map(({ cursorCreatedAt: _, ...row }) =>
          toConnection(row)
        ),
        nextCursor: page.nextCursor,
      };
    },

    /**
     * One live connection's resources in the caller's organization. Another
     * organization's or an archived connection is RESOURCE_NOT_FOUND.
     */
    async listResources(
      context: ActionContext,
      input: ResourceQuery,
    ): Promise<{ items: Resource[]; nextCursor: string | null }> {
      const { context: value, actor } = organizationActor(context);
      // The router already validated the path id; parse it here as well so
      // this handler never trusts an unchecked value.
      const parsed = contractSchemas.IdPath.safeParse({ id: value.params.id });
      if (!parsed.success) {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      const connectionId = parsed.data.id;
      const filters = {
        available: input.available ?? null,
        connectionId,
        kind: input.kind ?? null,
        selected: input.selected ?? null,
      };
      const binding = await listBinding(
        Action.IntegrationResourcesList,
        actor,
        filters,
      );
      // A replayed cursor is refused before the connection is looked up.
      const position = await decodeCursor(cursorSecret, input.cursor, binding);
      const connection = await value.transaction.query(
        `select 1 from bakery.integration_connections
          where organization_id = $1 and id = $2 and archived_at is null`,
        [actor.organizationId, connectionId],
      );
      if (connection.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const result = await value.transaction.query<
        Resource & { cursorCreatedAt: string }
      >(
        `select ${resourceColumns}, ${cursorCreatedAt("resource")}
           from bakery.integration_resources as resource
          where resource.organization_id = $1 and resource.connection_id = $2
            and resource.archived_at is null
            and ($3::text is null or resource.kind = $3)
            and ($4::boolean is null or resource.selected = $4)
            and ($5::boolean is null or resource.available = $5)
            and ($6::timestamptz is null
              or (resource.created_at, resource.id) < ($6, $7::uuid))
          order by resource.created_at desc, resource.id desc
          limit $8`,
        [
          actor.organizationId,
          connectionId,
          filters.kind,
          filters.selected,
          filters.available,
          position?.createdAt ?? null,
          position?.id ?? null,
          (input.limit ?? DEFAULT_LIMIT) + 1,
        ],
      );
      const page = await keysetPage(
        cursorSecret,
        binding,
        input.limit,
        result.rows,
      );
      return {
        items: page.rows.map(({ cursorCreatedAt: _, ...row }) =>
          contractSchemas.IntegrationResource.parse(row)
        ),
        nextCursor: page.nextCursor,
      };
    },
    /** integrationEffects.list (#68): one connection's effects, newest first. */
    async listEffects(
      context: ActionContext,
      input: EffectQuery,
    ): Promise<{ items: Effect[]; nextCursor: string | null }> {
      const { context: value, actor } = organizationActor(context);
      const connectionId = requirePathId(value.params.id);
      const filters = {
        connectionId,
        resourceId: input.resourceId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        status: input.status ?? null,
      };
      const binding = await listBinding(
        Action.IntegrationEffectsList,
        actor,
        filters,
      );
      const position = await decodeCursor(cursorSecret, input.cursor, binding);
      await requireLiveConnection(value, actor.organizationId, connectionId);
      const result = await value.transaction.query<
        Effect & { cursorCreatedAt: string }
      >(
        `select ${effectColumns}, ${cursorCreatedAt("effect")}
           from bakery.external_effects as effect
          where effect.organization_id = $1
            and effect.integration_connection_id = $2
            and ($3::uuid is null or effect.integration_resource_id = $3)
            and ($4::uuid is null or effect.subscription_id = $4)
            and ($5::text is null or effect.status = $5)
            and ($6::timestamptz is null
              or (effect.created_at, effect.id) < ($6, $7::uuid))
          order by effect.created_at desc, effect.id desc
          limit $8`,
        [
          actor.organizationId,
          connectionId,
          filters.resourceId,
          filters.subscriptionId,
          filters.status,
          position?.createdAt ?? null,
          position?.id ?? null,
          (input.limit ?? DEFAULT_LIMIT) + 1,
        ],
      );
      const page = await keysetPage(
        cursorSecret,
        binding,
        input.limit,
        result.rows,
      );
      return {
        items: page.rows.map(({ cursorCreatedAt: _, ...row }) =>
          contractSchemas.ExternalEffect.parse(row)
        ),
        nextCursor: page.nextCursor,
      };
    },
  };
}

/**
 * The guard for integrationEffects.list and .get ("Developer+resource read"):
 * reading what a connection did needs the effect read and read access to the
 * connection's resources. Either missing reads as not found.
 */
export function authorizeEffectRead(context: ActionContext): void {
  const { actor } = organizationActor(context);
  authorize(actor, "integrationEffect:read", {
    action: Action.IntegrationEffectsList,
  });
  authorize(actor, "integrationResource:read", {
    action: Action.IntegrationEffectsList,
  });
}

function requirePathId(raw: unknown): string {
  const parsed = contractSchemas.IdPath.safeParse({ id: raw });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

async function requireLiveConnection(
  value: { transaction: PgTransactionClient },
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const connection = await value.transaction.query(
    `select 1 from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, connectionId],
  );
  if (connection.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/**
 * integrationEffects.get (#68): one effect of one connection. Another
 * connection's or organization's effect is RESOURCE_NOT_FOUND.
 */
export async function getIntegrationEffect(
  context: ActionContext,
): Promise<Effect> {
  const { context: value, actor } = organizationActor(context);
  const connectionId = requirePathId(value.params.id);
  const effectId = requirePathId(value.params.effectId);
  const result = await value.transaction.query<Effect>(
    `select ${effectColumns}
       from bakery.external_effects as effect
       join bakery.integration_connections as connection
         on connection.organization_id = effect.organization_id
        and connection.id = effect.integration_connection_id
        and connection.archived_at is null
      where effect.organization_id = $1
        and effect.integration_connection_id = $2 and effect.id = $3`,
    [actor.organizationId, connectionId, effectId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return contractSchemas.ExternalEffect.parse(row);
}
