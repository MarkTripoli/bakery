import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  createNormalizedCommandMetadata,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { organizationActor } from "./auth-attempts.ts";
import {
  type AppCredentials,
  openAppSecret,
  readAppCredentials,
} from "./callbacks.ts";
import { getConnection, resourceColumns } from "./connections.ts";
import type { GitHubAppClient } from "./github-app.ts";
import {
  GITHUB_PROVIDER,
  type IntegrationsDependencies,
  isSelectionTaken,
} from "./postgres.ts";

type Connection = z.output<typeof contractSchemas.IntegrationConnection>;
type Resource = z.output<typeof contractSchemas.IntegrationResource>;
type ConnectionUpdate = z.output<
  typeof contractSchemas.IntegrationConnectionUpdate
>;
type ResourceUpdate = z.output<
  typeof contractSchemas.IntegrationResourceUpdate
>;

const CONNECTION_UPDATED = "integrationConnections.updated";
const RESOURCES_CHANGED = "integration.resources_changed";

/**
 * The same refusal for every repository the connection cannot select: not
 * available, no longer covered by the installation, or a suspended
 * installation. It names no other organization or installation.
 */
const resourceUnavailable = () =>
  new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "resource_unavailable" },
  });

/**
 * Whether another live connection, of any organization, has selected the
 * same repository of the same installation. The caller only learns that the
 * repository is unavailable, never who holds it.
 */
async function isReservedElsewhere(
  transaction: PgTransactionClient,
  organizationId: string,
  resourceId: string,
): Promise<boolean> {
  const held = await transaction.query(
    `select 1 from bakery.integration_resources as resource
       join bakery.integration_resources as other
         on other.installation_id = resource.installation_id
        and other.kind = resource.kind
        and other.external_id = resource.external_id
      where resource.organization_id = $1 and resource.id = $2
        and other.id <> resource.id and other.selected
        and other.archived_at is null
      limit 1`,
    [organizationId, resourceId],
  );
  return held.rows.length > 0;
}

type LockedConnection = {
  id: string;
  status: string;
  version: number;
  installationExternalId: string;
  installationStatus: string;
  secretId: string | null;
};

/**
 * The caller's live connection, row-locked for the write. Another
 * organization's, an archived or an unknown connection is RESOURCE_NOT_FOUND;
 * a stale If-Match is PRECONDITION_FAILED; a revoked connection is
 * STATE_CONFLICT. Nothing is written before these checks pass.
 */
async function lockConnection(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  expectedVersion: number,
  lock: boolean,
): Promise<LockedConnection> {
  const result = await transaction.query<LockedConnection>(
    `select connection.id, connection.status, connection.version,
       connection.secret_id as "secretId",
       connection.external_authorization_id as "installationExternalId",
       installation.status as "installationStatus"
       from bakery.integration_connections as connection
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1 and connection.id = $2
        and connection.archived_at is null
      ${lock ? "for update of connection" : ""}`,
    [organizationId, connectionId],
  );
  const connection = result.rows[0];
  if (connection === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (connection.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (connection.status === "revoked") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "connection_revoked" },
    });
  }
  return connection;
}

/**
 * Enabling a connection or selecting one of its repositories needs the
 * host-owned installation it is bound to to be active (not suspended or
 * revoked).
 */
function requireActiveInstallation(connection: LockedConnection): void {
  if (connection.installationStatus !== "enabled") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "installation_unavailable" },
    });
  }
}

/**
 * Whether the connection has a live, available selected resource other than
 * `except`: one the last complete discovery still found.
 */
async function hasSelection(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  except: string | null,
): Promise<boolean> {
  const selected = await transaction.query(
    `select 1 from bakery.integration_resources
      where organization_id = $1 and connection_id = $2 and selected
        and available and archived_at is null
        and ($3::uuid is null or id <> $3)
      limit 1`,
    [organizationId, connectionId, except],
  );
  return selected.rows.length > 0;
}

const noSelectedResource = () =>
  new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "no_selected_resource" },
  });

export function requireExpectedVersion(context: ActionContext): number {
  const version = requireCommandMetadata(context).expectedVersion;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return version;
}

/** The router validated the path; parse it again so no unchecked value is used. */
export function connectionPath(context: ActionContext): string {
  const parsed = contractSchemas.IdPath.safeParse({ id: context.params.id });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

function resourcePath(context: ActionContext): string {
  const parsed = contractSchemas.IdPath.safeParse({
    id: context.params.resourceId,
  });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

/**
 * Fields this child does not implement are refused rather than ignored:
 * provider settings have no config schema yet, and resource dispatch and
 * renaming belong to later children.
 */
function connectionChange(input: ConnectionUpdate) {
  if (input.settings !== undefined) {
    throw unprocessable(["settings"], "settings_not_supported");
  }
  const label = input.name?.trim();
  if (label !== undefined && label.length === 0) {
    throw unprocessable(["name"], "name_blank");
  }
  if (label === undefined && input.enabled === undefined) {
    throw unprocessable([], "no_change_requested");
  }
  return { label, enabled: input.enabled };
}

function resourceChange(input: ResourceUpdate): boolean {
  if (input.enabled !== undefined) {
    throw unprocessable(["enabled"], "resource_enable_not_supported");
  }
  if (input.displayName !== undefined) {
    throw unprocessable(["displayName"], "resource_rename_not_supported");
  }
  if (input.selected === undefined) {
    throw unprocessable([], "no_change_requested");
  }
  return input.selected;
}

/**
 * integrationConnections.update: an Admin renames the connection or switches
 * it on or off under compare-and-swap on its version, following
 * pending -> enabled <-> disabled. Enabling needs an active installation and
 * at least one live, available selected resource and keeps health
 * unchanged; disabling keeps every selection.
 */
export async function updateConnection(
  context: ActionContext,
  input: ConnectionUpdate,
): Promise<Connection> {
  const { context: value, actor } = organizationActor(context);
  const id = connectionPath(value);
  const change = connectionChange(input);
  const expectedVersion = requireExpectedVersion(value);
  const { transaction } = value;
  const current = await lockConnection(
    transaction,
    actor.organizationId,
    id,
    expectedVersion,
    true,
  );
  let status = current.status;
  if (change.enabled === true) {
    requireActiveInstallation(current);
    if (!await hasSelection(transaction, actor.organizationId, id, null)) {
      throw noSelectedResource();
    }
    status = "enabled";
  } else if (change.enabled === false) {
    // pending -> enabled <-> disabled: a pending connection is enabled first.
    if (current.status === "pending") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "connection_pending" },
      });
    }
    status = "disabled";
  }
  const updated = await transaction.query<{ version: number }>(
    `update bakery.integration_connections
        set label = coalesce($4, label), status = $5,
            version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 and version = $3
      returning version`,
    [actor.organizationId, id, expectedVersion, change.label ?? null, status],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationConnectionsUpdate,
    resourceType: "integration_connection",
    resourceId: id,
    details: {
      provider: GITHUB_PROVIDER,
      from: current.status,
      to: status,
      labelChanged: change.label !== undefined,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: CONNECTION_UPDATED,
    aggregateId: id,
    aggregateVersion: version,
    payload: { resourceId: id, resourceVersion: version },
    traceId: value.traceId,
  });
  return await getConnection(value, { id });
}

const preparationSlot = Symbol("private repository selection recheck");

/**
 * Request-private proof that GitHub confirmed, outside any transaction, that
 * the connection's installation still covers the repository. The mutation
 * accepts it only for the same principal, connection, resource, version and
 * provider identity, and only briefly.
 */
const SelectionCheckSchema = z.object({
  principalId: z.string().uuid().describe(
    "Principal whose request ran the recheck.",
  ),
  connectionId: z.string().uuid().describe("Connection the recheck covered."),
  resourceId: z.string().uuid().describe("Resource the recheck covered."),
  expectedVersion: z.number().int().positive().describe(
    "Connection version the request's If-Match named.",
  ),
  installationExternalId: z.string().min(1).describe(
    "GitHub installation id GitHub confirmed covers the repository.",
  ),
  externalId: z.string().min(1).describe(
    "Stable GitHub repository id GitHub confirmed is covered.",
  ),
  expires: z.number().int().positive().describe(
    "Unix milliseconds after which the recheck no longer counts; 30 seconds.",
  ),
}).strict().describe(
  "Request-local live recheck result; never an input, grant or replay payload.",
);
type SelectionCheck = z.infer<typeof SelectionCheckSchema>;
type CheckedContext = ActionContext & { [preparationSlot]?: SelectionCheck };

type LockedResource = {
  id: string;
  externalId: string;
  available: boolean;
  selected: boolean;
};

async function readResource(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  resourceId: string,
  lock: boolean,
): Promise<LockedResource> {
  const result = await transaction.query<LockedResource>(
    `select id, external_id as "externalId", available, selected
       from bakery.integration_resources
      where organization_id = $1 and connection_id = $2 and id = $3
        and archived_at is null
      ${lock ? "for update" : ""}`,
    [organizationId, connectionId, resourceId],
  );
  const resource = result.rows[0];
  if (resource === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return resource;
}

/**
 * integrationConnections.remove (#68): an Admin removes a connection. It ends
 * as `revoked`, which no update can change; its repository selections are
 * released (selection is exclusive, so another connection may take them) and
 * its reference to an organization secret is dropped. The secret itself is an
 * organization resource and is not deleted here. The host-owned provider
 * installation is untouched; connecting it again through the provider setup
 * returns the connection to `pending`.
 */
export async function removeConnection(
  context: ActionContext,
): Promise<Connection> {
  const { context: value, actor } = organizationActor(context);
  const id = connectionPath(value);
  const expectedVersion = requireExpectedVersion(value);
  const { transaction } = value;
  const current = await lockConnection(
    transaction,
    actor.organizationId,
    id,
    expectedVersion,
    true,
  );
  const released = await transaction.query(
    `update bakery.integration_resources
        set selected = false, version = version + 1, updated_at = now()
      where organization_id = $1 and connection_id = $2 and selected`,
    [actor.organizationId, id],
  );
  const updated = await transaction.query<{ version: number }>(
    `update bakery.integration_connections
        set status = 'revoked', secret_id = null,
            version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 and version = $3
      returning version`,
    [actor.organizationId, id, expectedVersion],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationConnectionsRemove,
    resourceType: "integration_connection",
    resourceId: id,
    details: {
      provider: GITHUB_PROVIDER,
      from: current.status,
      to: "revoked",
      releasedResources: released.rowCount ?? 0,
      secretUnbound: current.secretId !== null,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: CONNECTION_UPDATED,
    aggregateId: id,
    aggregateVersion: version,
    payload: { resourceId: id, resourceVersion: version },
    traceId: value.traceId,
  });
  return await getConnection(value, { id });
}

/**
 * integrationResources.update: an Admin selects or deselects one repository
 * of a live connection. The connection version is compared and incremented
 * in the same transaction that flips the flag; selecting additionally needs
 * the live GitHub recheck the authority runner attached.
 */
export async function updateResource(
  context: ActionContext,
  input: ResourceUpdate,
): Promise<Resource> {
  const { context: value, actor } = organizationActor(context);
  const connectionId = connectionPath(value);
  const resourceId = resourcePath(value);
  const selected = resourceChange(input);
  const expectedVersion = requireExpectedVersion(value);
  const { transaction } = value;
  const connection = await lockConnection(
    transaction,
    actor.organizationId,
    connectionId,
    expectedVersion,
    true,
  );
  const resource = await readResource(
    transaction,
    actor.organizationId,
    connectionId,
    resourceId,
    true,
  );
  if (selected) {
    requireActiveInstallation(connection);
    if (!resource.available) throw resourceUnavailable();
    const check = (context as CheckedContext)[preparationSlot];
    if (
      check === undefined || check.expires < Date.now() ||
      check.principalId !== actor.subject.principalId ||
      check.connectionId !== connectionId || check.resourceId !== resourceId ||
      check.expectedVersion !== expectedVersion ||
      check.installationExternalId !== connection.installationExternalId ||
      check.externalId !== resource.externalId
    ) {
      throw resourceUnavailable();
    }
  } else if (
    connection.status === "enabled" && resource.selected &&
    !await hasSelection(
      transaction,
      actor.organizationId,
      connectionId,
      resourceId,
    )
  ) {
    // An enabled connection keeps at least one selection; disable it first.
    throw noSelectedResource();
  }
  // Selecting a repository another connection holds fails on the partial
  // unique index; the transaction rolls back with nothing written.
  const updated = await transaction.query<Resource>(
    `update bakery.integration_resources as resource
        set selected = $4, version = version + 1, updated_at = now()
      where organization_id = $1 and connection_id = $2 and id = $3
      returning ${resourceColumns}`,
    [actor.organizationId, connectionId, resourceId, selected],
  ).catch((error: unknown) => {
    throw isSelectionTaken(error) ? resourceUnavailable() : error;
  });
  const bumped = await transaction.query<{ version: number }>(
    `update bakery.integration_connections
        set version = version + 1, updated_at = now()
      where organization_id = $1 and id = $2 and version = $3
      returning version`,
    [actor.organizationId, connectionId, expectedVersion],
  );
  const row = updated.rows[0];
  const version = bumped.rows[0]?.version;
  if (row === undefined || version === undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const output = contractSchemas.IntegrationResource.parse(row);
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationResourcesUpdate,
    resourceType: "integration_resource",
    resourceId,
    details: {
      provider: GITHUB_PROVIDER,
      connectionId,
      externalId: resource.externalId,
      selected,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: RESOURCES_CHANGED,
    aggregateId: resourceId,
    aggregateVersion: output.version,
    payload: { resourceId, resourceVersion: output.version },
    traceId: value.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: CONNECTION_UPDATED,
    aggregateId: connectionId,
    aggregateVersion: version,
    payload: { resourceId: connectionId, resourceVersion: version },
    traceId: value.traceId,
  });
  return output;
}

type SelectionProbe = {
  principalId: string;
  connectionId: string;
  resourceId: string;
  expectedVersion: number;
  installationExternalId: string;
  externalId: string;
  appId: number;
  privateKey: AppCredentials["privateKey"];
};

/**
 * Wraps integrationResources.update so GitHub is asked between committed
 * transactions (secrets/preflight.ts precedent):
 * 1. a probe transaction, under the live Admin check, answers a replay from
 *    its stored response and refuses an unknown resource (404), a stale
 *    If-Match (412) or an unselectable resource (409), including one another
 *    connection has selected, before any GitHub call;
 * 2. selecting asks GitHub with App authority, outside any transaction,
 *    whether the connection's installation is active and still covers the
 *    repository, by their stable ids; deselecting never needs provider
 *    authority;
 * 3. the mutation runs in the action's transaction through `next`, which
 *    rechecks the Admin, the version and the resource under row locks; the
 *    partial unique index decides a race with another organization.
 * The per-user GitHub permission the setup scan verified cannot be rechecked
 * here: the setup user token is discarded by design.
 */
export function createResourceUpdateRunner(
  authority: ActionAuthorityRunner,
  dependencies: IntegrationsDependencies & { github: GitHubAppClient },
): ActionAuthorityRunner["run"] {
  return async (action, context, input, next) => {
    const parsed = contractSchemas.IntegrationResourceUpdate.parse(input);
    const metadata = createNormalizedCommandMetadata(
      action,
      context.request,
      context.params,
      parsed,
    );
    const probe = await authority.run(
      action,
      context,
      parsed,
      async (authorized) => {
        const replay = await readCompletedCommandReplay({
          context: authorized,
          metadata,
          input: parsed,
        });
        if (replay) {
          return { replay: validateEncodedSuccessResponse(action, replay) };
        }
        const { context: value, actor } = organizationActor(authorized);
        const connectionId = connectionPath(value);
        const resourceId = resourcePath(value);
        const selected = resourceChange(parsed);
        if (metadata.expectedVersion === undefined) {
          throw new StandardError({ code: "PRECONDITION_REQUIRED" });
        }
        const connection = await lockConnection(
          value.transaction,
          actor.organizationId,
          connectionId,
          metadata.expectedVersion,
          false,
        );
        const resource = await readResource(
          value.transaction,
          actor.organizationId,
          connectionId,
          resourceId,
          false,
        );
        if (!selected) return { probe: null };
        requireActiveInstallation(connection);
        if (
          !resource.available ||
          await isReservedElsewhere(
            value.transaction,
            actor.organizationId,
            resourceId,
          )
        ) {
          throw resourceUnavailable();
        }
        const credentials = await readAppCredentials(value.transaction);
        if (credentials === null) {
          throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
        }
        return {
          probe: {
            principalId: actor.subject.principalId,
            connectionId,
            resourceId,
            expectedVersion: metadata.expectedVersion,
            installationExternalId: connection.installationExternalId,
            externalId: resource.externalId,
            appId: credentials.appId,
            privateKey: credentials.privateKey,
          } satisfies SelectionProbe,
        };
      },
    ) as
      | { replay: ReturnType<typeof validateEncodedSuccessResponse> }
      | { probe: SelectionProbe | null };
    if ("replay" in probe) return probe.replay;
    let check: SelectionCheck | undefined;
    if (probe.probe !== null) {
      const { appId, privateKey, ...target } = probe.probe;
      context.signal.throwIfAborted();
      const key = await loadSecretKey(dependencies.secretsKey);
      const covered = await dependencies.github.isRepositoryCovered(
        {
          appId,
          privateKeyPem: await openAppSecret(key, privateKey),
          installationId: Number(target.installationExternalId),
          repositoryId: Number(target.externalId),
        },
        context.signal,
      );
      if (!covered) throw resourceUnavailable();
      check = SelectionCheckSchema.parse({
        ...target,
        expires: Date.now() + 30_000,
      });
    }
    return await authority.run(
      action,
      context,
      parsed,
      (authorized) =>
        next(
          check === undefined
            ? authorized
            : Object.assign({}, authorized, { [preparationSlot]: check }),
        ),
    );
  };
}
