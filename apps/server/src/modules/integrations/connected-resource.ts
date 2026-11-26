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
  const servicePrincipal = await ensureServicePrincipal(transaction, input);
  const servicePrincipalId = servicePrincipal.principalId;
  if (!servicePrincipal.created) {
    return { resourceId, servicePrincipalId };
  }
  for (const grant of input.resource.serviceGrants) {
    await transaction.query(
      `insert into bakery.integration_grants (
         id, organization_id, connection_id, subject_type,
         subject_principal_id, direction, capability, action_version,
         resource_id, granted_by
       )
       values ($1, $2, $3, 'principal', $4, $5, $6, $7, $8, $9)`,
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
): Promise<{ principalId: string; created: boolean }> {
  const purpose = input.resource.servicePurpose;
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`delivery-principal:${input.organizationId}:${purpose}`],
  );
  const existing = await findDeliveryPrincipal(
    transaction,
    input.organizationId,
    purpose,
  );
  if (existing !== null) return { principalId: existing, created: false };
  const created = await transaction.query<{ id: string }>(
    `insert into bakery.principals (display_name, principal_type)
     values ($1, 'service') returning id`,
    [input.resource.servicePrincipalName],
  );
  const principalId = created.rows[0]!.id;
  await transaction.query(
    `insert into bakery.delivery_principals
       (organization_id, purpose, principal_id)
     values ($1, $2, $3)`,
    [input.organizationId, purpose, principalId],
  );
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
  return { principalId, created: true };
}

export async function findDeliveryPrincipal(
  transaction: PgTransactionClient,
  organizationId: string,
  purpose: string,
): Promise<string | null> {
  const found = await transaction.query<{ principalId: string }>(
    `select principal_id as "principalId" from bakery.delivery_principals
      where organization_id = $1 and purpose = $2`,
    [organizationId, purpose],
  );
  return found.rows[0]?.principalId ?? null;
}
