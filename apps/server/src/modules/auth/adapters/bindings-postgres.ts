import type { z } from "zod";
import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { OrganizationActor } from "../application/authority.ts";
import { isBindingRole, isBindingScopeType } from "../application/bindings.ts";
import {
  effectivePermissions,
  rolePermissionsOf,
} from "../application/authorize.ts";
import { resolveOrganizationActor } from "./authority-postgres.ts";

const ORDERING = "createdAt:asc,id:asc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- access bindings (management) ------------------------------------------

type BindingRow = {
  id: string;
  organizationId: string;
  principalId: string;
  roleKey: string;
  scopeType: string;
  scopeId: string;
  grantedByPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  cursorCreatedAt: string;
};

const BINDING_COLUMNS =
  `binding.id, binding.organization_id as "organizationId",
  binding.principal_id as "principalId", binding.role_key as "roleKey",
  binding.scope_type as "scopeType",
  coalesce(binding.application_id, binding.repository_id) as "scopeId",
  binding.granted_by_principal_id as "grantedByPrincipalId",
  binding.created_at as "createdAt", binding.updated_at as "updatedAt",
  binding.version,
  to_char(binding.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"`;

function bindingOut(row: BindingRow) {
  return contractSchemas.AccessBinding.parse({
    id: row.id,
    organizationId: row.organizationId,
    principalId: row.principalId,
    roleKey: row.roleKey,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    grantedByPrincipalId: row.grantedByPrincipalId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    version: row.version,
  });
}

function cursorBinding(actor: OrganizationActor): CursorBinding {
  return {
    action: "accessBindings.list",
    principalId: actor.subject.principalId,
    organizationId: actor.organizationId,
    ordering: ORDERING,
    filters: "{}",
    schemaVersion: 1,
  };
}

async function lockOrganization(
  client: PgTransactionClient,
  organizationId: string,
): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(
      hashtextextended('bakery:organization:' || $1::text, 0)
    )`,
    [organizationId],
  );
}

async function freshActor(
  client: PgTransactionClient,
  actor: OrganizationActor,
): Promise<OrganizationActor> {
  await lockOrganization(client, actor.organizationId);
  const live = await resolveOrganizationActor(
    client,
    actor.subject.principalId,
    actor.organizationId,
  );
  return { ...live, tokenScopes: actor.tokenScopes };
}

export async function listAccessBindings(
  client: PgTransactionClient,
  actor: OrganizationActor,
  query: { cursor?: string; limit?: number },
  secret: string,
) {
  const b = cursorBinding(actor);
  const position = await decodeCursor(secret, query.cursor, b);
  const limit = query.limit ?? 25;
  const result = await client.query<BindingRow>(
    `select ${BINDING_COLUMNS}
    from bakery.access_bindings as binding
    where binding.organization_id = $1
      and ($2::timestamptz is null
        or (binding.created_at, binding.id) > ($2::timestamptz, $3::uuid))
    order by binding.created_at, binding.id
    limit $4`,
    [
      actor.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const items = result.rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(bindingOut),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, b, {
        createdAt: last.cursorCreatedAt,
        id: last.id,
      })
      : null,
  };
}

export async function createAccessBinding(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  input: z.output<typeof contractSchemas.AccessBindingCreate>,
) {
  const actor = await freshActor(client, actorInput);
  if (!isBindingRole(input.roleKey) || !isBindingScopeType(input.scopeType)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  // The target principal must belong to this organization and be live. Humans
  // need an active membership; service accounts hold an organization role or
  // grants (a member row either way).
  const target = await client.query<{ principalType: string; status: string }>(
    `select principal.principal_type as "principalType",
      membership.status
    from bakery.principals as principal
    join bakery.organization_memberships as membership
      on membership.principal_id = principal.id
      and membership.organization_id = $2
    where principal.id = $1 and principal.disabled_at is null
    for update of principal`,
    [input.principalId, actor.organizationId],
  );
  const row = target.rows[0];
  if (row === undefined || row.status !== "active") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (
    row.principalType !== PrincipalType.Human &&
    row.principalType !== PrincipalType.Service
  ) throw new StandardError({ code: "UNPROCESSABLE" });
  // The resource must exist in this organization.
  const resource = input.scopeType === "application"
    ? await client.query(
      "select 1 from bakery.applications where organization_id = $1 and id = $2",
      [actor.organizationId, input.scopeId],
    )
    : await client.query(
      "select 1 from bakery.repositories where organization_id = $1 and id = $2",
      [actor.organizationId, input.scopeId],
    );
  if (resource.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // Anti-escalation: a binding never confers more than the grantor holds now.
  const held = new Set(effectivePermissions(actor));
  const roleKeys = rolePermissionsOf(input.roleKey) ?? [];
  if (!roleKeys.every((permission) => held.has(permission))) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const duplicate = await client.query(
    `select 1 from bakery.access_bindings
    where organization_id = $1 and principal_id = $2 and role_key = $3
      and coalesce(application_id, repository_id) = $4`,
    [actor.organizationId, input.principalId, input.roleKey, input.scopeId],
  );
  if (duplicate.rows.length > 0) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const result = await client.query<BindingRow>(
    `insert into bakery.access_bindings (
      organization_id, principal_id, role_key, scope_type, application_id,
      repository_id, granted_by_principal_id
    ) values ($1, $2, $3, $4, $5, $6, $7)
    returning ${BINDING_COLUMNS.replaceAll("binding.", "")}`,
    [
      actor.organizationId,
      input.principalId,
      input.roleKey,
      input.scopeType,
      input.scopeType === "application" ? input.scopeId : null,
      input.scopeType === "repository" ? input.scopeId : null,
      actor.subject.principalId,
    ],
  );
  return bindingOut(result.rows[0]);
}

export async function deleteAccessBinding(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  bindingId: string,
  expectedVersion: number,
) {
  const actor = await freshActor(client, actorInput);
  if (!UUID.test(bindingId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const found = await client.query<BindingRow>(
    `select ${BINDING_COLUMNS}
    from bakery.access_bindings as binding
    where binding.organization_id = $1 and binding.id = $2`,
    [actor.organizationId, bindingId],
  );
  if (found.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const row = found.rows[0];
  if (row.version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const deleted = await client.query(
    "delete from bakery.access_bindings where organization_id = $1 and id = $2",
    [actor.organizationId, bindingId],
  );
  if (deleted.rowCount !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return bindingOut(row);
}
