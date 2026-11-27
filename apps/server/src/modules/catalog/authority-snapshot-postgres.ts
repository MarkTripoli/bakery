import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type { OrganizationId, PrincipalId } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { organizationPermissions } from "../auth/application/authorize.ts";
import type {
  ActiveIntegrationRegistry,
  AuthoritySnapshot,
  AuthoritySnapshotPort,
  IntegrationGrantRecord,
  SnapshotKey,
} from "./integration-gate.ts";
import type { HostResourceKind } from "./integration-gate-profiles.ts";

/**
 * The deployed provider id each stored installation provider binds (#20).
 * Only GitHub is installable today.
 */
const PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
  github: "bakery.github",
});

/** Stored resource kinds as the gate's provider resource kinds. */
const RESOURCE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  repository: "github.repository",
});

type Row = {
  principal_id: string;
  disabled_at: string | null;
  connection_status: string;
  connection_health: string;
  granted_permissions: Record<string, string> | null;
  installation_id: string;
  installation_provider: string;
  installation_status: string;
  external_authorization_id: string;
  bot_user_id: string | null;
  resource_kind: string;
  resource_external_id: string;
  resource_display_name: string;
  resource_selected: boolean;
  resource_available: boolean;
  resource_archived: boolean;
  resource_binding: unknown;
};

type SnapshotResource = Pick<
  AuthoritySnapshot["resource"],
  "binding" | "providerRepositoryId" | "repositoryId"
>;

type GrantRow = {
  id: string;
  subject_type: string;
  subject_principal_id: string | null;
  subject_role: string | null;
  automation_definition_id: string | null;
  direction: string;
  capability: string;
  action_version: number | null;
  resource_id: string | null;
  application_id: string | null;
  repository_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  policy_revision: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A positive safe integer from a stored numeric string, else null. */
function positiveId(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The connection state the gate understands, folded like the connection read
 * (connections.ts connectionStatus): an enabled connection whose credential
 * needs re-authorization is reconnect_required; anything not enabled is
 * disabled.
 */
function connectionState(
  status: string,
  health: string,
): AuthoritySnapshot["connection"]["state"] {
  if (status !== "enabled") return "disabled";
  return health === "auth_required" ? "reconnect_required" : "active";
}

/**
 * The production AuthoritySnapshotPort (#20): fresh authority read from
 * Postgres for one actor, connection and resource. Answers null (so nothing
 * dispatches) when any part is missing or cannot be bound exactly: an unknown
 * or foreign connection or resource, an archived resource, an installation
 * whose provider is not deployed, or a binding without the App's bot user id
 * or a well-formed owner/repo.
 */
export function createPostgresAuthorityPort(
  database: PgDatabase,
  registry: ActiveIntegrationRegistry,
): AuthoritySnapshotPort {
  return {
    load: (key) =>
      withPgTransaction(
        database,
        (transaction) => loadSnapshot(transaction, registry, key),
      ),
  };
}

export async function loadSnapshot(
  transaction: PgTransactionClient,
  registry: ActiveIntegrationRegistry,
  key: SnapshotKey,
): Promise<AuthoritySnapshot | null> {
  // A key that names no well-formed record answers null, never a database
  // error the gate would surface as a 500.
  if (
    ![key.organizationId, key.actorRef, key.connectionId, key.resourceId]
      .every((value) => typeof value === "string" && UUID.test(value))
  ) return null;
  const result = await transaction.query<Row>(
    `select principal.id as principal_id,
            principal.disabled_at::text as disabled_at,
            connection.status as connection_status,
            connection.health as connection_health,
            connection.granted_permissions,
            installation.id as installation_id,
            installation.provider as installation_provider,
            installation.status as installation_status,
            installation.external_authorization_id,
            registration.bot_user_id::text as bot_user_id,
            resource.kind as resource_kind,
            resource.external_id as resource_external_id,
            resource.display_name as resource_display_name,
            resource.selected as resource_selected,
            resource.available as resource_available,
            resource.archived_at is not null as resource_archived,
            resource.capability_snapshot -> 'binding' as resource_binding
       from bakery.integration_connections connection
       join bakery.integration_installations installation
         on installation.id = connection.installation_id
       join bakery.integration_app_registrations registration
         on registration.id = installation.registration_id
       join bakery.integration_resources resource
         on resource.organization_id = connection.organization_id
        and resource.connection_id = connection.id and resource.id = $4
       join bakery.principals principal on principal.id = $2
      where connection.organization_id = $1 and connection.id = $3
        and connection.archived_at is null`,
    [key.organizationId, key.actorRef, key.connectionId, key.resourceId],
  );
  const row = result.rows[0];
  if (!row || row.resource_archived) return null;

  const providerId = Object.hasOwn(PROVIDER_IDS, row.installation_provider)
    ? PROVIDER_IDS[row.installation_provider]
    : registry.getProvider(row.installation_provider)?.integrationId;
  const integration = providerId ? registry.get(providerId) : undefined;
  if (!providerId || !integration) return null;
  const kind = Object.hasOwn(RESOURCE_KINDS, row.resource_kind)
    ? RESOURCE_KINDS[row.resource_kind]
    : Object.hasOwn(integration.profile.resourceKinds, row.resource_kind)
    ? row.resource_kind
    : undefined;
  if (!kind) return null;

  const resource = Object.hasOwn(RESOURCE_KINDS, row.resource_kind)
    ? await trackedRepositoryResource(transaction, key, row)
    : storedResource(row, integration.profile.resourceKinds[kind]);
  if (resource === null) return null;

  const grants = await transaction.query<GrantRow>(
    `select id, subject_type, subject_principal_id, subject_role,
            automation_definition_id, direction, capability, action_version,
            resource_id, application_id, repository_id,
            to_char(expires_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
            to_char(revoked_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revoked_at,
            policy_revision
       from bakery.integration_grants
      where organization_id = $1 and connection_id = $2
        and revoked_at is null
        and (expires_at is null or expires_at > now())`,
    [key.organizationId, key.connectionId],
  );

  // The actor exactly as the API derives it (QA on #377): the canonical
  // resolver applies membership state, SCIM deprovisioning, custom roles and
  // exact capability grants. Any refusal is an inactive actor holding
  // nothing; a savepoint keeps a refusal from aborting this transaction.
  let active = false;
  let role: string | undefined;
  let permissions: readonly string[] = [];
  await transaction.query("savepoint snapshot_actor");
  let actor: Awaited<ReturnType<typeof resolveOrganizationActor>> | undefined;
  try {
    actor = await resolveOrganizationActor(
      transaction,
      key.actorRef as PrincipalId,
      key.organizationId as OrganizationId,
    );
  } catch (error) {
    // Only the resolver runs under the savepoint, so this rollback always
    // targets a live savepoint and never masks a later error.
    await transaction.query("rollback to savepoint snapshot_actor");
    if (!(error instanceof StandardError)) throw error;
  }
  if (actor) {
    await transaction.query("release savepoint snapshot_actor");
    active = row.disabled_at === null;
    role = actor.role;
    permissions = active ? organizationPermissions(actor) : [];
  }
  // The revision effects record as authorization_revision: the newest policy
  // interpretation among the grants in force, or 1 when there are none.
  const policyRevision = grants.rows.reduce(
    (highest, grant) => Math.max(highest, grant.policy_revision),
    1,
  );
  return {
    organizationId: key.organizationId,
    actor: {
      principalId: row.principal_id,
      subjectType: "principal",
      active,
      ...(role && active ? { membershipRoleKey: role } : {}),
      permissions,
    },
    install: {
      id: row.installation_id,
      providerId,
      manifestDigest: integration.manifestDigest,
      enabled: row.installation_status === "enabled",
      // No Bakery scopes are approved per installation yet.
      approvedScopes: [],
    },
    connection: {
      id: key.connectionId,
      installId: row.installation_id,
      state: connectionState(row.connection_status, row.connection_health),
      providerPermissions: (row.granted_permissions ?? {}) as Record<
        string,
        AuthoritySnapshot["connection"]["providerPermissions"][string]
      >,
    },
    resource: {
      id: key.resourceId,
      kind,
      selected: row.resource_selected,
      available: row.resource_available,
      ...resource,
    },
    grants: grants.rows.map((grant): IntegrationGrantRecord =>
      ({
        grantId: grant.id,
        organizationId: key.organizationId,
        connectionId: key.connectionId,
        subjectType: grant.subject_type,
        ...(grant.subject_principal_id
          ? { subjectPrincipalId: grant.subject_principal_id }
          : {}),
        ...(grant.subject_role ? { subjectRole: grant.subject_role } : {}),
        ...(grant.automation_definition_id
          ? { automationDefinitionId: grant.automation_definition_id }
          : {}),
        direction: grant.direction,
        capability: grant.capability,
        ...(grant.action_version !== null
          ? { actionVersion: grant.action_version }
          : {}),
        ...(grant.resource_id ? { resourceId: grant.resource_id } : {}),
        ...(grant.application_id
          ? { applicationId: grant.application_id }
          : {}),
        ...(grant.repository_id ? { repositoryId: grant.repository_id } : {}),
        expiresAt: grant.expires_at,
        revokedAt: grant.revoked_at,
        policyRevision: grant.policy_revision,
      }) as IntegrationGrantRecord
    ),
    policyRevision,
  };
}

async function trackedRepositoryResource(
  transaction: PgTransactionClient,
  key: SnapshotKey,
  row: Row,
): Promise<SnapshotResource | null> {
  const [owner, repo, ...rest] = row.resource_display_name.split("/");
  const repositoryId = positiveId(row.resource_external_id);
  const installationExternalId = positiveId(row.external_authorization_id);
  const botUserId = positiveId(row.bot_user_id);
  if (
    !owner || !repo || rest.length > 0 || repositoryId === null ||
    installationExternalId === null || botUserId === null
  ) return null;
  const tracked = await transaction.query<{ id: string }>(
    `select id from bakery.repositories
      where organization_id = $1 and integration_connection_id = $2
        and archived_at is null
        and (provider_repo_id = $3 or provider_repo_id = $4)
      limit 2`,
    [
      key.organizationId,
      key.connectionId,
      String(repositoryId),
      row.resource_display_name,
    ],
  );
  const bakeryRepositoryId = tracked.rows.length === 1
    ? tracked.rows[0]!.id
    : undefined;
  return {
    providerRepositoryId: String(repositoryId),
    ...(bakeryRepositoryId ? { repositoryId: bakeryRepositoryId } : {}),
    binding: {
      owner,
      repo,
      repositoryId,
      installationId: installationExternalId,
      botUserId,
    },
  };
}

function storedResource(
  row: Row,
  kind: HostResourceKind | undefined,
): SnapshotResource | null {
  if (kind === undefined) return null;
  const binding = kind.bindingSchema.safeParse(row.resource_binding);
  if (!binding.success) return null;
  const account = binding.data[kind.externalIdentity.account];
  if (String(account) !== row.external_authorization_id) return null;
  return { binding: binding.data };
}
