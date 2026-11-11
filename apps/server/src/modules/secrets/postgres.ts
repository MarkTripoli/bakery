import type { z } from "zod";
import { appendAudit } from "@bakery/persistence";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { SecretsImplementedAction } from "@bakery/contracts/implemented-actions";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  requireSecretPreparation,
  requireSecretRotationPreparation,
} from "./preflight.ts";
import {
  rejectCredentialMetadata,
  rejectCredentialMetadataFields,
} from "./redaction.ts";

type SecretMetadata = z.output<typeof contractSchemas.SecretMetadata>;
type SecretRow = {
  metadata: SecretMetadata;
  cursor_created_at: string;
  id: string;
};
// Explicit SQL projection deliberately excludes all cipher/key/version-storage fields.
const projection = `jsonb_build_object(
 'id',id,'applicationId',application_id,'name',name,'provider',provider,
 'verifiedProviderAccountId',verified_provider_account_id,'verifiedLogin',verified_login,
 'activeVersionId',active_version_id,'activeVersionRevision',active_version_revision,
 'generation',generation,'policyRevision',policy_revision,'invalidationGeneration',invalidation_generation,
 'allowedPrincipals',allowed_principals,'allowedActions',allowed_actions,
 'expiresAt',case when expires_at is null then null else to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
 'revokedAt',case when revoked_at is null then null else to_char(revoked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
 'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'version',version) as metadata`;
const scope =
  "organization_id=$1 and application_id=$2 and integration_installation_id is null";
function toMetadata(row: SecretRow): SecretMetadata {
  const parsed = contractSchemas.SecretMetadata.parse(row.metadata);
  rejectCredentialMetadata(parsed.name);
  rejectCredentialMetadata(parsed.verifiedLogin);
  return parsed;
}
export async function assertSecretApplication(
  context: ActionContext,
  applicationId: string,
): Promise<void> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<{ archived_at: Date | null }>(
    `select archived_at from bakery.applications where organization_id=$1 and id=$2 for share`,
    [organizationId, applicationId],
  );
  if (!result.rows[0] || result.rows[0].archived_at !== null) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}
export async function getSecret(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretGet>,
): Promise<SecretMetadata> {
  await assertSecretApplication(context, input.applicationId);
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<SecretRow>(
    `select ${projection} from bakery.secrets where ${scope} and id=$3`,
    [organizationId, input.applicationId, input.id],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toMetadata(result.rows[0]);
}
export function createSecretsListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SecretList>,
  ) => {
    await assertSecretApplication(context, input.applicationId);
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: SecretsImplementedAction.List,
      organizationId,
      principalId,
      ordering: "createdAt:desc,id:desc",
      filters: JSON.stringify({ applicationId: input.applicationId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<SecretRow>(
      `select ${projection}, id, to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at from bakery.secrets where ${scope} and ($3::timestamptz is null or (created_at,id)<($3,$4::uuid)) order by created_at desc,id desc limit $5`,
      [
        organizationId,
        input.applicationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toMetadata),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(cursorSecret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}
export async function createSecret(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretCreate>,
): Promise<SecretMetadata> {
  await assertSecretApplication(context, input.applicationId);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const prepared = await requireSecretPreparation(context, input);
  const grants = input.allowedPrincipalIds ?? [];
  if (grants.length) {
    const allowed = await transaction.query<{ id: string }>(
      `select principal_id as id from bakery.organization_memberships where organization_id=$1 and principal_id=any($2::uuid[]) and status='active'`,
      [organizationId, grants],
    );
    if (new Set(allowed.rows.map((r) => r.id)).size !== new Set(grants).size) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  await transaction.query(
    `insert into bakery.secrets(id,organization_id,application_id,name,provider,verified_provider_account_id,verified_login,allowed_principals,allowed_actions,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
    [
      prepared.secretId,
      organizationId,
      input.applicationId,
      input.name,
      input.provider,
      prepared.identity.accountId,
      prepared.identity.login,
      JSON.stringify(grants),
      JSON.stringify(input.allowedActions ?? []),
      input.expiresAt ?? null,
    ],
  );
  await transaction.query(
    `insert into bakery.secret_versions(id,organization_id,application_id,secret_id,revision,ciphertext,nonce,key_id,created_by,expires_at) values($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`,
    [
      prepared.versionId,
      organizationId,
      input.applicationId,
      prepared.secretId,
      prepared.cipher.ciphertext,
      prepared.cipher.nonce,
      prepared.keyId,
      principalId,
      input.expiresAt ?? null,
    ],
  );
  // Initial pointer has column-only update privilege; cipher history has no update/delete privilege.
  await transaction.query(
    `update bakery.secrets set active_version_id=$4 where ${scope} and id=$3`,
    [
      organizationId,
      input.applicationId,
      prepared.secretId,
      prepared.versionId,
    ],
  );
  const sequence = await nextOrganizationSequence(transaction, organizationId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: SecretsImplementedAction.Create,
    resourceType: "secret",
    resourceId: prepared.secretId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await transaction.query(
    `insert into bakery.domain_events(organization_id,organization_sequence,event_type,schema_version,application_id,aggregate_id,aggregate_version,payload,trace_id) values($1,$2,'secret.created',1,$3,$4,1,$5::jsonb,$6)`,
    [
      organizationId,
      sequence,
      input.applicationId,
      prepared.secretId,
      JSON.stringify({ resourceId: prepared.secretId, resourceVersion: 1 }),
      context.traceId,
    ],
  );
  return await getSecret(context, {
    applicationId: input.applicationId,
    id: prepared.secretId,
  });
}

export async function rotateSecret(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretRotation>,
): Promise<SecretMetadata> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const prepared = await requireSecretRotationPreparation(context, input);
  const currentResult = await transaction.query<
    SecretRow & {
      active_version_revision: number;
      revoked_at: string | null;
    }
  >(
    `select ${projection},active_version_revision,revoked_at from bakery.secrets where ${scope} and id=$3 for update`,
    [organizationId, input.applicationId, context.params.id],
  );
  const current = currentResult.rows[0];
  if (!current || current.revoked_at !== null) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (current.active_version_revision + 1 !== prepared.revision) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    `insert into bakery.secret_versions(id,organization_id,application_id,secret_id,revision,ciphertext,nonce,key_id,created_by,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      prepared.versionId,
      organizationId,
      input.applicationId,
      prepared.secretId,
      prepared.revision,
      prepared.cipher.ciphertext,
      prepared.cipher.nonce,
      prepared.keyId,
      principalId,
      input.expiresAt ?? null,
    ],
  );
  const version = current.metadata.version + 1;
  await transaction.query(
    `update bakery.secrets set active_version_id=$4,active_version_revision=$5,generation=generation+1,invalidation_generation=invalidation_generation+1,version=$6,expires_at=$7,verified_provider_account_id=$8,verified_login=$9,updated_at=now() where ${scope} and id=$3`,
    [
      organizationId,
      input.applicationId,
      prepared.secretId,
      prepared.versionId,
      prepared.revision,
      version,
      input.expiresAt ?? null,
      prepared.identity.accountId,
      prepared.identity.login,
    ],
  );
  const sequence = await nextOrganizationSequence(transaction, organizationId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: SecretsImplementedAction.Rotate,
    resourceType: "secret",
    resourceId: prepared.secretId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await transaction.query(
    `insert into bakery.domain_events(organization_id,organization_sequence,event_type,schema_version,application_id,aggregate_id,aggregate_version,payload,trace_id) values($1,$2,'secret.rotated',1,$3,$4,$5,$6::jsonb,$7)`,
    [
      organizationId,
      sequence,
      input.applicationId,
      prepared.secretId,
      version,
      JSON.stringify({
        resourceId: prepared.secretId,
        resourceVersion: version,
        revision: prepared.revision,
      }),
      context.traceId,
    ],
  );
  return await getSecret(context, {
    applicationId: input.applicationId,
    id: prepared.secretId,
  }).then((metadata) => {
    // The response persists verbatim in replay storage: fail closed rather
    // than store a projected metadata string that contains the new
    // credential or one of its encoded variants.
    rejectCredentialMetadataFields(
      { name: metadata.name, verifiedLogin: metadata.verifiedLogin },
      input.value,
    );
    return metadata;
  });
}

export async function updateSecretPolicy(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretPolicyUpdate>,
): Promise<SecretMetadata> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (
    new Set(input.allowedPrincipalIds).size !==
      input.allowedPrincipalIds.length ||
    new Set(input.allowedActions).size !== input.allowedActions.length ||
    !input.allowedActions.every((action) => action === "identity.read")
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const grants = await transaction.query<{ id: string }>(
    `select principal_id as id from bakery.organization_memberships where organization_id=$1 and principal_id=any($2::uuid[]) and status='active'`,
    [organizationId, input.allowedPrincipalIds],
  );
  if (
    new Set(grants.rows.map((row) => row.id)).size !==
      new Set(input.allowedPrincipalIds).size
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query<SecretRow>(
    `select ${projection} from bakery.secrets where ${scope} and id=$3 for update`,
    [organizationId, input.applicationId, context.params.id],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const current = toMetadata(result.rows[0]);
  if (current.version !== expectedVersion || current.revokedAt !== null) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const version = current.version + 1;
  await transaction.query(
    `update bakery.secrets set allowed_principals=$4::jsonb,allowed_actions=$5::jsonb,policy_revision=policy_revision+1,invalidation_generation=invalidation_generation+1,version=$6,updated_at=now() where ${scope} and id=$3`,
    [
      organizationId,
      input.applicationId,
      context.params.id,
      JSON.stringify(input.allowedPrincipalIds),
      JSON.stringify(input.allowedActions),
      version,
    ],
  );
  const sequence = await nextOrganizationSequence(transaction, organizationId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: SecretsImplementedAction.UpdatePolicy,
    resourceType: "secret",
    resourceId: context.params.id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await transaction.query(
    `insert into bakery.domain_events(organization_id,organization_sequence,event_type,schema_version,application_id,aggregate_id,aggregate_version,payload,trace_id) values($1,$2,'secret.policy_updated',1,$3,$4,$5,$6::jsonb,$7)`,
    [
      organizationId,
      sequence,
      input.applicationId,
      context.params.id,
      version,
      JSON.stringify({
        resourceId: context.params.id,
        resourceVersion: version,
      }),
      context.traceId,
    ],
  );
  return await getSecret(context, {
    applicationId: input.applicationId,
    id: context.params.id!,
  });
}

export async function revokeSecret(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretRevoke>,
): Promise<null> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const result = await transaction.query<SecretRow>(
    `select ${projection} from bakery.secrets where ${scope} and id=$3 for update`,
    [organizationId, input.applicationId, input.id],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const current = toMetadata(result.rows[0]);
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (current.revokedAt !== null) return null;
  const version = current.version + 1;
  await transaction.query(
    `update bakery.secrets set revoked_at=now(),invalidation_generation=$4,version=$5,updated_at=now() where ${scope} and id=$3`,
    [
      organizationId,
      input.applicationId,
      input.id,
      current.invalidationGeneration + 1,
      version,
    ],
  );
  const sequence = await nextOrganizationSequence(transaction, organizationId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: SecretsImplementedAction.Revoke,
    resourceType: "secret",
    resourceId: input.id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await transaction.query(
    `insert into bakery.domain_events(organization_id,organization_sequence,event_type,schema_version,application_id,aggregate_id,aggregate_version,payload,trace_id) values($1,$2,'secret.revoked',1,$3,$4,$5,$6::jsonb,$7)`,
    [
      organizationId,
      sequence,
      input.applicationId,
      input.id,
      version,
      JSON.stringify({ resourceId: input.id, resourceVersion: version }),
      context.traceId,
    ],
  );
  return null;
}
