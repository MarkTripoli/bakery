import type { ConnectedResource } from "@bakery/integration-sdk/provider";
import type { PgTransactionClient } from "../../platform/database.ts";
import { AUTHORITY_POLICY_REVISION } from "../auth/application/authority.ts";

export const SERVICE_INVOKE_CAPABILITY = "integrationConnections.invoke";

const OUT_OF_BAKERY = "out_of_bakery";

export type ConnectedResourceBinding = Readonly<{
  organizationId: string;
  connectionId: string;
  installationId: string;
  grantedBy: string;
  resource: ConnectedResource;
}>;

export type BoundConnectedResource = Readonly<{
  resourceId: string;
  servicePrincipalId: string;
}>;

export async function bindConnectedResource(
  transaction: PgTransactionClient,
  input: ConnectedResourceBinding,
): Promise<BoundConnectedResource> {
  const resourceId = await upsertResource(transaction, input);
  const servicePrincipalId = await ensureServicePrincipal(transaction, input);
  for (const grant of input.resource.serviceGrants) {
    await transaction.query(
      `insert into bakery.integration_grants (
         id, organization_id, connection_id, subject_type,
         subject_principal_id, direction, capability, action_version,
         resource_id, granted_by
       )
       select $1, $2, $3, 'principal', $4, $5, $6, $7, $8, $9
        where not exists (
          select 1 from bakery.integration_grants
           where organization_id = $2 and connection_id = $3
             and subject_type = 'principal' and subject_principal_id = $4
             and direction = $5 and capability = $6 and action_version = $7
             and resource_id = $8 and revoked_at is null
             and expires_at is null
        )`,
      [
        crypto.randomUUID(),
        input.organizationId,
        input.connectionId,
        servicePrincipalId,
        OUT_OF_BAKERY,
        grant.capability,
        grant.actionVersion,
        resourceId,
        input.grantedBy,
      ],
    );
  }
  return { resourceId, servicePrincipalId };
}

async function upsertResource(
  transaction: PgTransactionClient,
  input: ConnectedResourceBinding,
): Promise<string> {
  const { resource } = input;
  const result = await transaction.query<{ id: string }>(
    `insert into bakery.integration_resources (
       id, organization_id, connection_id, installation_id, kind,
       external_id, display_name, selected, available, capability_snapshot,
       last_discovery_generation
     ) values ($1, $2, $3, $4, $5, $6, $7, true, true,
       jsonb_build_object('binding', $8::jsonb), 1)
     on conflict (connection_id, kind, external_id) do update
       set display_name = excluded.display_name,
           capability_snapshot = excluded.capability_snapshot,
           selected = true, available = true, archived_at = null,
           updated_at = now(),
           version = bakery.integration_resources.version + 1
     returning id`,
    [
      crypto.randomUUID(),
      input.organizationId,
      input.connectionId,
      input.installationId,
      resource.kind,
      resource.externalId,
      resource.displayName,
      JSON.stringify(resource.binding),
    ],
  );
  return result.rows[0]!.id;
}

async function ensureServicePrincipal(
  transaction: PgTransactionClient,
  input: ConnectedResourceBinding,
): Promise<string> {
  const name = input.resource.servicePrincipalName;
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`service-principal:${input.organizationId}:${name}`],
  );
  const existing = await findServicePrincipal(
    transaction,
    input.organizationId,
    name,
  );
  if (existing !== null) return existing;
  const created = await transaction.query<{ id: string }>(
    `insert into bakery.principals (display_name, principal_type)
     values ($1, 'service') returning id`,
    [name],
  );
  const principalId = created.rows[0]!.id;
  await transaction.query(
    `insert into bakery.permission_grants (
       organization_id, principal_id, capability, granted_by_principal_id,
       policy_revision
     ) values ($1, $2, $3, $4, $5)`,
    [
      input.organizationId,
      principalId,
      SERVICE_INVOKE_CAPABILITY,
      input.grantedBy,
      AUTHORITY_POLICY_REVISION,
    ],
  );
  return principalId;
}

export async function findServicePrincipal(
  transaction: PgTransactionClient,
  organizationId: string,
  name: string,
): Promise<string | null> {
  const found = await transaction.query<{ id: string }>(
    `select principal.id
       from bakery.principals principal
       join bakery.permission_grants permission
         on permission.principal_id = principal.id
        and permission.organization_id = $1
        and permission.capability = $3
        and permission.revoked_at is null
        and permission.expires_at is null
      where principal.principal_type = 'service'
        and principal.display_name = $2
        and principal.provider_user_id is null
        and principal.created_by_principal_id is null
        and principal.disabled_at is null
        and not exists (
          select 1 from bakery.organization_memberships membership
           where membership.principal_id = principal.id
        )
      order by principal.id
      limit 1`,
    [organizationId, name, SERVICE_INVOKE_CAPABILITY],
  );
  return found.rows[0]?.id ?? null;
}
