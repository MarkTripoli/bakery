import type { z } from "zod";
import {
  type CatalogPermissionKey,
  contractSchemas,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";
import {
  generateAccessTokenSecret,
  normalizeTokenScopes,
  tokenExpiryAllowed,
} from "../application/access-tokens.ts";
import type { OrganizationActor } from "../application/authority.ts";
import {
  catalogPermissionForAction,
  effectivePermissions,
  rolePermissionsOf,
} from "../application/authorize.ts";
import { resolveOrganizationActor } from "./authority-postgres.ts";

const ORDERING = "createdAt:asc,id:asc";
export const TIMESTAMP_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export type Cursor = { cursor?: string; limit?: number };

export async function lockOrganization(
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

/**
 * Locks the organization, then re-resolves the caller's live authority under
 * the lock so a role removed a moment ago cannot still mint or grant.
 */
export async function freshActor(
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

export function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function pageOf<
  Row extends { id: string; cursorCreatedAt: string },
  Out,
>(
  secret: string,
  binding: CursorBinding,
  rows: Row[],
  limit: number,
  map: (row: Row) => Out,
) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursorCreatedAt,
        id: last.id,
      })
      : null,
  };
}

export function binding(
  action: string,
  actor: OrganizationActor,
): CursorBinding {
  return {
    action,
    principalId: actor.subject.principalId,
    organizationId: actor.organizationId,
    ordering: ORDERING,
    filters: "{}",
    schemaVersion: 1,
  };
}

// --- principals (service accounts) -----------------------------------------

type PrincipalRow = {
  id: string;
  principalType: string;
  displayName: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  cursorCreatedAt: string;
};

const PRINCIPAL_COLUMNS =
  `principal.id, principal.principal_type as "principalType",
  principal.display_name as "displayName",
  principal.disabled_at as "disabledAt",
  principal.created_at as "createdAt", principal.updated_at as "updatedAt",
  principal.version,
  to_char(principal.created_at at time zone 'UTC', ${TIMESTAMP_SQL}) as "cursorCreatedAt"`;

function principalOut(row: PrincipalRow) {
  return contractSchemas.Principal.parse({
    id: row.id,
    principalType: row.principalType,
    displayName: row.displayName,
    disabledAt: iso(row.disabledAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  });
}

export async function listPrincipals(
  client: PgTransactionClient,
  actor: OrganizationActor,
  query: Cursor,
  secret: string,
) {
  const b = binding("principals.list", actor);
  const position = await decodeCursor(secret, query.cursor, b);
  const limit = query.limit ?? 25;
  const result = await client.query<PrincipalRow>(
    `select ${PRINCIPAL_COLUMNS}
    from bakery.organization_memberships as membership
    join bakery.principals as principal on principal.id = membership.principal_id
    where membership.organization_id = $1
      and ($2::timestamptz is null
        or (principal.created_at, principal.id) > ($2::timestamptz, $3::uuid))
    order by principal.created_at, principal.id
    limit $4`,
    [
      actor.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  return await pageOf(secret, b, result.rows, limit, principalOut);
}

/** Roles whose permissions the caller already holds may be given to a service account. */
function assertRoleWithinCaller(
  actor: OrganizationActor,
  role: string | null,
): void {
  if (role === null) return;
  const held = new Set(effectivePermissions(actor));
  const wanted = rolePermissionsOf(role);
  if (wanted === undefined || !wanted.every((p) => held.has(p))) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

export async function createServiceAccount(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  input: z.output<typeof contractSchemas.PrincipalCreate>,
) {
  const actor = await freshActor(client, actorInput);
  assertRoleWithinCaller(actor, input.role);
  const principal = await client.query<PrincipalRow>(
    `insert into bakery.principals (display_name, principal_type)
    values ($1, 'service')
    returning ${PRINCIPAL_COLUMNS.replaceAll("principal.", "")}`,
    [input.displayName.trim()],
  );
  await client.query(
    `insert into bakery.organization_memberships (
      id, organization_id, principal_id, role, status,
      joined_at, created_at, updated_at, version
    ) values ($1, $2, $3, $4, 'active', current_timestamp,
      current_timestamp, current_timestamp, 1)`,
    [
      crypto.randomUUID(),
      actor.organizationId,
      principal.rows[0].id,
      input.role,
    ],
  );
  return principalOut(principal.rows[0]);
}

/** A service principal that belongs to this organization and to no other. */
async function ownedServiceAccount(
  client: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<PrincipalRow> {
  const result = await client.query<PrincipalRow>(
    `select ${PRINCIPAL_COLUMNS}
    from bakery.principals as principal
    where principal.id = $1
      and principal.principal_type = 'service'
      and exists (
        select 1 from bakery.organization_memberships as membership
        where membership.organization_id = $2
          and membership.principal_id = principal.id
      )
      and not exists (
        select 1 from bakery.organization_memberships as other
        where other.principal_id = principal.id
          and other.organization_id <> $2
      )
    for update of principal`,
    [principalId, organizationId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return result.rows[0];
}

export async function updateServiceAccount(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  principalId: string,
  input: z.output<typeof contractSchemas.PrincipalUpdate>,
  expectedVersion: number,
) {
  const actor = await freshActor(client, actorInput);
  const current = await ownedServiceAccount(
    client,
    actor.organizationId,
    principalId,
  );
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const disabledAt = input.disabledAt === undefined
    ? current.disabledAt
    : input.disabledAt === null
    ? null
    : new Date(input.disabledAt);
  const result = await client.query<PrincipalRow>(
    `update bakery.principals as principal
    set display_name = $2, disabled_at = $3,
      updated_at = current_timestamp, version = principal.version + 1
    where principal.id = $1
    returning ${PRINCIPAL_COLUMNS}`,
    [principalId, input.displayName?.trim() ?? current.displayName, disabledAt],
  );
  return principalOut(result.rows[0]);
}

// --- permission grants -----------------------------------------------------

type GrantRow = {
  id: string;
  organizationId: string;
  principalId: string;
  capability: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  policyRevision: string | number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  cursorCreatedAt: string;
};

const GRANT_COLUMNS =
  `grant_record.id, grant_record.organization_id as "organizationId",
  grant_record.principal_id as "principalId", grant_record.capability,
  grant_record.expires_at as "expiresAt", grant_record.revoked_at as "revokedAt",
  grant_record.policy_revision as "policyRevision",
  grant_record.created_at as "createdAt", grant_record.updated_at as "updatedAt",
  grant_record.version,
  to_char(grant_record.created_at at time zone 'UTC', ${TIMESTAMP_SQL}) as "cursorCreatedAt"`;

function grantOut(row: GrantRow) {
  return contractSchemas.PermissionGrant.parse({
    id: row.id,
    organizationId: row.organizationId,
    principalId: row.principalId,
    capability: row.capability,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    policyRevision: Number(row.policyRevision),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  });
}

export async function listPermissionGrants(
  client: PgTransactionClient,
  actor: OrganizationActor,
  query: Cursor,
  secret: string,
) {
  const b = binding("permissionGrants.list", actor);
  const position = await decodeCursor(secret, query.cursor, b);
  const limit = query.limit ?? 25;
  const result = await client.query<GrantRow>(
    `select ${GRANT_COLUMNS}
    from bakery.permission_grants as grant_record
    where grant_record.organization_id = $1
      and ($2::timestamptz is null
        or (grant_record.created_at, grant_record.id) > ($2::timestamptz, $3::uuid))
    order by grant_record.created_at, grant_record.id
    limit $4`,
    [
      actor.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  return await pageOf(secret, b, result.rows, limit, grantOut);
}

export async function createPermissionGrant(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  input: z.output<typeof contractSchemas.PermissionGrantCreate>,
  now: Date = new Date(),
) {
  const actor = await freshActor(client, actorInput);
  const permission = catalogPermissionForAction(input.capability);
  if (permission === undefined) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? null
    : new Date(input.expiresAt);
  if (expiresAt !== null && !(expiresAt.getTime() > now.getTime())) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  // The target must be a live service or worker principal of this organization.
  const target = await client.query<{ principalType: string }>(
    `select principal.principal_type as "principalType"
    from bakery.principals as principal
    join bakery.organization_memberships as membership
      on membership.principal_id = principal.id
      and membership.organization_id = $2
    where principal.id = $1
      and principal.disabled_at is null
    for update of principal`,
    [input.principalId, actor.organizationId],
  );
  if (target.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (target.rows[0].principalType === PrincipalType.Human) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  // Anti-escalation: never beyond what the grantor holds, live, right now.
  if (!effectivePermissions(actor).includes(permission)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const result = await client.query<GrantRow>(
    `insert into bakery.permission_grants (
      organization_id, principal_id, capability, expires_at,
      granted_by_principal_id
    ) values ($1, $2, $3, $4, $5)
    returning ${GRANT_COLUMNS.replaceAll("grant_record.", "")}`,
    [
      actor.organizationId,
      input.principalId,
      input.capability,
      expiresAt,
      actor.subject.principalId,
    ],
  );
  return grantOut(result.rows[0]);
}

/**
 * Revokes a grant the caller could themselves have issued. The application
 * role cannot update `permission_grants`, so revocation deletes the row; the
 * audit row written beside it keeps the history.
 */
export async function revokePermissionGrant(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  grantId: string,
  expectedVersion: number,
): Promise<{ grant: z.output<typeof contractSchemas.PermissionGrant> }> {
  const actor = await freshActor(client, actorInput);
  const found = await client.query<GrantRow>(
    `select ${GRANT_COLUMNS}
    from bakery.permission_grants as grant_record
    where grant_record.organization_id = $1 and grant_record.id = $2`,
    [actor.organizationId, grantId],
  );
  if (found.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const row = found.rows[0];
  if (row.version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const permission = catalogPermissionForAction(row.capability);
  if (
    permission !== undefined &&
    !effectivePermissions(actor).includes(permission)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  // The application role holds no UPDATE on grants, so no row lock was taken
  // above; the delete itself is the serialization point.
  const deleted = await client.query(
    "delete from bakery.permission_grants where organization_id = $1 and id = $2",
    [actor.organizationId, grantId],
  );
  if (deleted.rowCount !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return { grant: grantOut(row) };
}

// --- access tokens ---------------------------------------------------------

type TokenRow = {
  id: string;
  organizationId: string;
  principalId: string;
  createdByPrincipalId: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  cursorCreatedAt: string;
};

const TOKEN_COLUMNS = `token.id, token.organization_id as "organizationId",
  token.principal_id as "principalId",
  token.created_by_principal_id as "createdByPrincipalId",
  token.name, token.prefix, token.scopes,
  token.expires_at as "expiresAt", token.last_used_at as "lastUsedAt",
  token.revoked_at as "revokedAt", token.created_at as "createdAt",
  token.updated_at as "updatedAt", token.version,
  to_char(token.created_at at time zone 'UTC', ${TIMESTAMP_SQL}) as "cursorCreatedAt"`;

function tokenFields(row: TokenRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    principalId: row.principalId,
    createdByPrincipalId: row.createdByPrincipalId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

function tokenOut(row: TokenRow) {
  return contractSchemas.AccessToken.parse(tokenFields(row));
}

export async function listAccessTokens(
  client: PgTransactionClient,
  actor: OrganizationActor,
  query: Cursor,
  secret: string,
) {
  const b = binding("accessTokens.list", actor);
  const position = await decodeCursor(secret, query.cursor, b);
  const limit = query.limit ?? 25;
  const result = await client.query<TokenRow>(
    `select ${TOKEN_COLUMNS}
    from bakery.access_tokens as token
    where token.organization_id = $1
      and ($2::timestamptz is null
        or (token.created_at, token.id) > ($2::timestamptz, $3::uuid))
    order by token.created_at, token.id
    limit $4`,
    [
      actor.organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  return await pageOf(secret, b, result.rows, limit, tokenOut);
}

export async function createAccessToken(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  input: z.output<typeof contractSchemas.AccessTokenCreate>,
  now: Date = new Date(),
) {
  const actor = await freshActor(client, actorInput);
  const scopes = normalizeTokenScopes(input.scopes);
  const expiresAt = new Date(input.expiresAt);
  if (scopes === null || !tokenExpiryAllowed(expiresAt, now)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const callerId = actor.subject.principalId;
  const targetId = input.principalId ?? callerId;
  let targetPermissions: readonly CatalogPermissionKey[];
  if (targetId === callerId) {
    targetPermissions = effectivePermissions(actor);
  } else {
    await ownedServiceAccount(client, actor.organizationId, targetId);
    const target = await resolveOrganizationActor(
      client,
      targetId as OrganizationActor["subject"]["principalId"],
      actor.organizationId,
    );
    targetPermissions = effectivePermissions(target);
    // Anti-escalation: a stronger service account cannot be minted a token.
    const held = new Set(effectivePermissions(actor));
    if (!targetPermissions.every((permission) => held.has(permission))) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  }
  const minted = await generateAccessTokenSecret();
  const result = await client.query<TokenRow>(
    `insert into bakery.access_tokens (
      organization_id, principal_id, created_by_principal_id, name, prefix,
      secret_sha256, scopes, expires_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)
    returning ${TOKEN_COLUMNS.replaceAll("token.", "")}`,
    [
      actor.organizationId,
      targetId,
      callerId,
      input.name.trim(),
      minted.prefix,
      minted.digest,
      scopes,
      expiresAt,
    ],
  );
  return contractSchemas.AccessTokenCreated.parse({
    ...tokenFields(result.rows[0]),
    secret: minted.secret,
  });
}

export async function revokeAccessToken(
  client: PgTransactionClient,
  actorInput: OrganizationActor,
  tokenId: string,
  expectedVersion: number,
): Promise<
  { token: z.output<typeof contractSchemas.AccessToken>; changed: boolean }
> {
  const actor = await freshActor(client, actorInput);
  const found = await client.query<TokenRow>(
    `select ${TOKEN_COLUMNS}
    from bakery.access_tokens as token
    where token.organization_id = $1 and token.id = $2
    for update of token`,
    [actor.organizationId, tokenId],
  );
  if (found.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (found.rows[0].revokedAt !== null) {
    return { token: tokenOut(found.rows[0]), changed: false };
  }
  if (found.rows[0].version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const updated = await client.query<TokenRow>(
    `update bakery.access_tokens as token
    set revoked_at = current_timestamp, updated_at = current_timestamp,
      version = token.version + 1
    where token.id = $1
    returning ${TOKEN_COLUMNS}`,
    [tokenId],
  );
  return { token: tokenOut(updated.rows[0]), changed: true };
}
