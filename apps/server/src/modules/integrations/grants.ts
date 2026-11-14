import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { appendDomainEvent } from "@bakery/persistence";
import { decodeCursor } from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { organizationActor } from "./auth-attempts.ts";
import {
  cursorCreatedAt,
  DEFAULT_LIMIT,
  keysetPage,
  listBinding,
} from "./connections.ts";
import { connectionPath, requireExpectedVersion } from "./updates.ts";

type Grant = z.output<typeof contractSchemas.IntegrationGrant>;
type GrantCreate = z.output<typeof contractSchemas.IntegrationGrantCreate>;
type GrantQuery = z.output<typeof contractSchemas.IntegrationGrantQuery>;

/** Domain event for a connection whose grants changed (#20). */
export const GRANTS_CHANGED = "integration.grants_changed";

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

// Explicit projection: who granted and who revoked stay internal (audit has
// them); the policy revision is part of the contract.
const grantColumns = `grant_row.id,
  grant_row.connection_id as "connectionId",
  grant_row.subject_type as "subjectType",
  grant_row.subject_principal_id as "subjectPrincipalId",
  grant_row.subject_role as "subjectRole",
  grant_row.automation_definition_id as "automationDefinitionId",
  grant_row.direction, grant_row.capability,
  grant_row.action_version as "actionVersion",
  grant_row.resource_id as "resourceId",
  grant_row.application_id as "applicationId",
  grant_row.repository_id as "repositoryId",
  to_char(grant_row.expires_at at time zone 'UTC', ${TIMESTAMP})
    as "expiresAt",
  to_char(grant_row.revoked_at at time zone 'UTC', ${TIMESTAMP})
    as "revokedAt",
  grant_row.policy_revision as "policyRevision",
  to_char(grant_row.created_at at time zone 'UTC', ${TIMESTAMP})
    as "createdAt",
  to_char(grant_row.updated_at at time zone 'UTC', ${TIMESTAMP})
    as "updatedAt",
  grant_row.version`;

/** The caller's live connection, or RESOURCE_NOT_FOUND. */
async function requireConnection(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const found = await transaction.query(
    `select 1 from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, connectionId],
  );
  if (found.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/**
 * The subject and scope a grant names must be exact and must exist in the
 * caller's organization: a principal subject is a current member, a resource
 * belongs to this connection, an application or repository to this
 * organization. Automations do not exist yet, so an automation grant is
 * refused rather than recorded for something that cannot be checked.
 */
async function validateGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  input: GrantCreate,
): Promise<void> {
  const fields: string[] = [];
  if (input.subjectType === "principal") {
    if (!input.subjectPrincipalId) fields.push("subjectPrincipalId");
    if (input.subjectRole !== undefined) fields.push("subjectRole");
    if (input.automationDefinitionId !== undefined) {
      fields.push("automationDefinitionId");
    }
  } else if (input.subjectType === "organization_role") {
    if (!input.subjectRole) fields.push("subjectRole");
    if (input.subjectPrincipalId !== undefined) {
      fields.push("subjectPrincipalId");
    }
    if (input.automationDefinitionId !== undefined) {
      fields.push("automationDefinitionId");
    }
  } else {
    throw unprocessable(["subjectType"], "automation_unavailable");
  }
  if (input.capability.includes("*") || input.capability.trim() === "") {
    fields.push("capability");
  }
  if (fields.length > 0) throw unprocessable(fields, "grant_subject_invalid");

  if (input.subjectPrincipalId) {
    const member = await transaction.query(
      `select 1 from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2
          and status = 'active'`,
      [organizationId, input.subjectPrincipalId],
    );
    if (member.rows.length === 0) {
      throw unprocessable(["subjectPrincipalId"], "grant_subject_unknown");
    }
  }
  if (input.resourceId) {
    const resource = await transaction.query(
      `select 1 from bakery.integration_resources
        where organization_id = $1 and connection_id = $2 and id = $3
          and archived_at is null`,
      [organizationId, connectionId, input.resourceId],
    );
    if (resource.rows.length === 0) {
      throw unprocessable(["resourceId"], "grant_resource_unknown");
    }
  }
  for (
    const [field, table, value] of [
      ["applicationId", "applications", input.applicationId],
      ["repositoryId", "repositories", input.repositoryId],
    ] as const
  ) {
    if (!value) continue;
    const found = await transaction.query(
      `select 1 from bakery.${table} where organization_id = $1 and id = $2`,
      [organizationId, value],
    );
    if (found.rows.length === 0) {
      throw unprocessable([field], "grant_scope_unknown");
    }
  }
}

async function readGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  grantId: string,
): Promise<Grant | undefined> {
  const result = await transaction.query<Grant>(
    `select ${grantColumns} from bakery.integration_grants as grant_row
      where grant_row.organization_id = $1 and grant_row.connection_id = $2
        and grant_row.id = $3`,
    [organizationId, connectionId, grantId],
  );
  const row = result.rows[0];
  return row ? contractSchemas.IntegrationGrant.parse(row) : undefined;
}

/** integrationGrants.create (#20): an Admin grants one exact capability. */
export async function createGrant(
  context: ActionContext,
  input: GrantCreate,
): Promise<Grant> {
  const { context: value, actor } = organizationActor(context);
  const connectionId = connectionPath(value);
  const { transaction } = value;
  await requireConnection(transaction, actor.organizationId, connectionId);
  await validateGrant(transaction, actor.organizationId, connectionId, input);
  const id = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.integration_grants (
       id, organization_id, connection_id, subject_type, subject_principal_id,
       subject_role, automation_definition_id, direction, capability,
       action_version, resource_id, application_id, repository_id,
       expires_at, granted_by
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14::timestamptz, $15
     )`,
    [
      id,
      actor.organizationId,
      connectionId,
      input.subjectType,
      input.subjectPrincipalId ?? null,
      input.subjectRole ?? null,
      input.automationDefinitionId ?? null,
      input.direction,
      input.capability,
      input.actionVersion ?? null,
      input.resourceId ?? null,
      input.applicationId ?? null,
      input.repositoryId ?? null,
      input.expiresAt ?? null,
      actor.subject.principalId,
    ],
  );
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationGrantsCreate,
    resourceType: "integration_grant",
    resourceId: id,
    details: {
      connectionId,
      subjectType: input.subjectType,
      direction: input.direction,
      capability: input.capability,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: GRANTS_CHANGED,
    aggregateId: connectionId,
    aggregateVersion: 1,
    payload: { resourceId: connectionId, grantId: id },
    traceId: value.traceId,
  });
  const created = await readGrant(
    transaction,
    actor.organizationId,
    connectionId,
    id,
  );
  if (!created) throw new Error("INTEGRATION_GRANT_INSERT_FAILED");
  return created;
}

/**
 * integrationGrants.delete (#20): an Admin revokes a grant. The row is kept,
 * revoked, so audit and effect provenance still resolve; revoking again or
 * with a stale If-Match changes nothing.
 */
export async function revokeGrant(context: ActionContext): Promise<null> {
  const { context: value, actor } = organizationActor(context);
  const connectionId = connectionPath(value);
  const parsed = contractSchemas.IdPath.safeParse({ id: value.params.grantId });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  const grantId = parsed.data.id;
  const expectedVersion = requireExpectedVersion(value);
  const { transaction } = value;
  await requireConnection(transaction, actor.organizationId, connectionId);
  const current = await transaction.query<
    { version: number; revoked: boolean }
  >(
    `select version, revoked_at is not null as revoked
       from bakery.integration_grants
      where organization_id = $1 and connection_id = $2 and id = $3
      for update`,
    [actor.organizationId, connectionId, grantId],
  );
  const row = current.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (row.revoked) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "grant_revoked" },
    });
  }
  await transaction.query(
    `update bakery.integration_grants
        set revoked_at = now(), revoked_by = $4, updated_at = now(),
            version = version + 1
      where organization_id = $1 and connection_id = $2 and id = $3`,
    [actor.organizationId, connectionId, grantId, actor.subject.principalId],
  );
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationGrantsDelete,
    resourceType: "integration_grant",
    resourceId: grantId,
    details: { connectionId, to: "revoked" },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    eventType: GRANTS_CHANGED,
    aggregateId: connectionId,
    aggregateVersion: row.version + 1,
    payload: { resourceId: connectionId, grantId },
    traceId: value.traceId,
  });
  return null;
}

/** integrationGrants.list (#20): a connection's grants, revoked included. */
export function createGrantListHandler(cursorSecret: string) {
  return async function listGrants(
    context: ActionContext,
    input: GrantQuery,
  ): Promise<{ items: Grant[]; nextCursor: string | null }> {
    const { context: value, actor } = organizationActor(context);
    const connectionId = connectionPath(value);
    const binding = await listBinding(
      Action.IntegrationGrantsList,
      actor,
      { connectionId },
    );
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    await requireConnection(
      value.transaction,
      actor.organizationId,
      connectionId,
    );
    const result = await value.transaction.query<
      Grant & { cursorCreatedAt: string }
    >(
      `select ${grantColumns}, ${cursorCreatedAt("grant_row")}
         from bakery.integration_grants as grant_row
        where grant_row.organization_id = $1
          and grant_row.connection_id = $2
          and ($3::timestamptz is null
            or (grant_row.created_at, grant_row.id) < ($3, $4::uuid))
        order by grant_row.created_at desc, grant_row.id desc
        limit $5`,
      [
        actor.organizationId,
        connectionId,
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
        contractSchemas.IntegrationGrant.parse(row)
      ),
      nextCursor: page.nextCursor,
    };
  };
}
