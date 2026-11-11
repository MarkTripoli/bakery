import { StandardError } from "@bakery/contracts/http";
import { recordAuthAudit } from "../application/audit.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type { McpGrantStore } from "../../../platform/mcp/guard.ts";

/** Anything that can run a parameterized query: a pool or a transaction client. */
export type Queryable = Pick<PgTransactionClient, "query">;

export type ConnectedClientGrant = {
  id: string;
  clientId: string;
  clientName: string;
  organizationId: string;
  organizationName: string;
  scopes: string[];
  authorizedAt: string;
  lastUsedAt: string | null;
};

type GrantRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  organizationId: string;
  organizationName: string | null;
  scopes: unknown;
  authorizedAt: Date;
  lastUsedAt: Date | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Consents a person gave that still bind a real organization, newest first.
 * A consent whose organization reference is not a live organization id cannot
 * be used by the MCP guard, so it is not listed.
 */
export async function listConnectedClientGrants(
  client: Queryable,
  providerUserId: string,
): Promise<ConnectedClientGrant[]> {
  const result = await client.query<GrantRow>(
    `select consent.id,
        consent."clientId" as "clientId",
        oauth_client.name as "clientName",
        organization.id as "organizationId",
        organization.name as "organizationName",
        consent.scopes,
        consent."createdAt" as "authorizedAt",
        activity.last_used_at as "lastUsedAt"
      from public."oauthConsent" as consent
      join public."oauthClient" as oauth_client
        on oauth_client."clientId" = consent."clientId"
      join bakery.organizations as organization
        on organization.id::text = consent."referenceId"
      left join bakery.oauth_grant_activity as activity
        on activity.user_id = consent."userId"
        and activity.client_id = consent."clientId"
        and activity.organization_id = organization.id
      where consent."userId" = $1
      order by consent."createdAt" desc, consent.id`,
    [providerUserId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName ?? row.clientId,
    organizationId: row.organizationId,
    organizationName: row.organizationName ?? "",
    scopes: stringArray(row.scopes),
    authorizedAt: row.authorizedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export type RevokedGrant = {
  clientId: string;
  clientName: string;
  organizationId: string;
};

/**
 * Revokes one consent the person owns, scoped to the consent's organization,
 * in the caller's transaction: access and refresh tokens, pending
 * authorization codes and the consent row go, the revocation epoch is written
 * and an audit event is recorded. Another person's grant, or none, is
 * `RESOURCE_NOT_FOUND`.
 */
export async function revokeConnectedClientGrant(
  transaction: PgTransactionClient,
  input: {
    providerUserId: string;
    principalId: string;
    grantId: string;
    requestId: string;
    traceId: string;
  },
): Promise<RevokedGrant> {
  const consent = await transaction.query<{
    clientId: string;
    clientName: string | null;
    organizationId: string | null;
  }>(
    `select consent."clientId" as "clientId",
        oauth_client.name as "clientName",
        consent."referenceId" as "organizationId"
      from public."oauthConsent" as consent
      join public."oauthClient" as oauth_client
        on oauth_client."clientId" = consent."clientId"
      where consent.id = $1 and consent."userId" = $2
      for update of consent`,
    [input.grantId, input.providerUserId],
  );
  const row = consent.rows[0];
  if (!row || !row.organizationId || !UUID_PATTERN.test(row.organizationId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const { clientId, organizationId } = row;
  // Refresh tokens cascade to the access tokens minted from them.
  await transaction.query(
    `delete from public."oauthRefreshToken"
      where "userId" = $1 and "clientId" = $2 and "referenceId" = $3`,
    [input.providerUserId, clientId, organizationId],
  );
  await transaction.query(
    `delete from public."oauthAccessToken"
      where "userId" = $1 and "clientId" = $2 and "referenceId" = $3`,
    [input.providerUserId, clientId, organizationId],
  );
  // Codes are `verification` rows holding compact JSON; match the exact
  // `userId`, `referenceId` and `client_id` members rather than parsing values
  // that may not be JSON.
  await transaction.query(
    `delete from public.verification
      where position('"type":"authorization_code"' in value) > 0
        and position($1 in value) > 0
        and position($2 in value) > 0
        and position($3 in value) > 0`,
    [
      `"userId":${JSON.stringify(input.providerUserId)}`,
      `"referenceId":${JSON.stringify(organizationId)}`,
      `"client_id":${JSON.stringify(clientId)}`,
    ],
  );
  await transaction.query(
    `delete from public."oauthConsent" where id = $1`,
    [input.grantId],
  );
  await transaction.query(
    `insert into bakery.oauth_grant_revocations
        (user_id, client_id, organization_id, revoked_at)
      values ($1, $2, $3, clock_timestamp())
      on conflict (user_id, client_id, organization_id)
      do update set revoked_at = excluded.revoked_at`,
    [input.providerUserId, clientId, organizationId],
  );
  await transaction.query(
    `delete from bakery.oauth_grant_activity
      where user_id = $1 and client_id = $2 and organization_id = $3`,
    [input.providerUserId, clientId, organizationId],
  );
  await recordAuthAudit(transaction, input, {
    organizationId,
    principalId: input.principalId,
    operation: "connectedClients.revoke",
    resourceType: "oauth_client",
    resourceId: input.grantId,
    details: { clientId },
  });
  return {
    clientId,
    clientName: row.clientName ?? clientId,
    organizationId,
  };
}

export type LiveConsent = { scopes: string[] };

/** The consent that exists right now for one person, client and organization. */
export async function findLiveConsent(
  database: Queryable,
  input: { providerUserId: string; clientId: string; organizationId: string },
): Promise<LiveConsent | undefined> {
  const result = await database.query<{ scopes: unknown }>(
    `select scopes from public."oauthConsent"
      where "userId" = $1 and "clientId" = $2 and "referenceId" = $3
      order by "updatedAt" desc
      limit 1`,
    [input.providerUserId, input.clientId, input.organizationId],
  );
  const row = result.rows[0];
  return row ? { scopes: stringArray(row.scopes) } : undefined;
}

/**
 * When the grant was last revoked, as whole epoch seconds, or `undefined` when
 * it never was. Compared against a token's `iat` (also whole seconds), so a
 * token minted in the same second as a revoke fails closed.
 */
export async function revocationEpochSeconds(
  database: Queryable,
  input: { providerUserId: string; clientId: string; organizationId: string },
): Promise<number | undefined> {
  const result = await database.query<{ epoch: string }>(
    `select floor(extract(epoch from revoked_at))::text as epoch
      from bakery.oauth_grant_revocations
      where user_id = $1 and client_id = $2 and organization_id = $3`,
    [input.providerUserId, input.clientId, input.organizationId],
  );
  const epoch = result.rows[0]?.epoch;
  return epoch === undefined ? undefined : Number(epoch);
}

/** Records use of a grant at most once a minute; the write is skipped while the stored time is fresh. */
export async function touchGrantActivity(
  database: Queryable,
  input: { providerUserId: string; clientId: string; organizationId: string },
): Promise<void> {
  await database.query(
    `insert into bakery.oauth_grant_activity
        (user_id, client_id, organization_id, last_used_at)
      values ($1, $2, $3, now())
      on conflict (user_id, client_id, organization_id)
      do update set last_used_at = excluded.last_used_at
        where bakery.oauth_grant_activity.last_used_at
          < now() - interval '1 minute'`,
    [input.providerUserId, input.clientId, input.organizationId],
  );
}

/** The active human principal for a provider user, or none when disabled or missing. */
export async function findActiveHumanPrincipal(
  database: Queryable,
  providerUserId: string,
): Promise<{ principalId: string } | undefined> {
  const result = await database.query<{ principalId: string }>(
    `select id as "principalId" from bakery.principals
      where provider_user_id = $1
        and principal_type = 'human'
        and disabled_at is null`,
    [providerUserId],
  );
  return result.rows[0];
}

/** Whether the person holds a live (active) membership of the organization. */
export async function hasLiveMembership(
  database: Queryable,
  input: { principalId: string; organizationId: string },
): Promise<boolean> {
  const result = await database.query<{ live: boolean }>(
    `select exists (
        select 1 from bakery.organization_memberships
        where principal_id = $1 and organization_id = $2 and status = 'active'
      ) as live`,
    [input.principalId, input.organizationId],
  );
  return result.rows[0]?.live === true;
}

/** The guard's view of live grant state, read through the runtime pool. */
export function createMcpGrantStore(database: Queryable): McpGrantStore {
  return {
    findLiveConsent: (input) => findLiveConsent(database, input),
    revocationEpochSeconds: (input) => revocationEpochSeconds(database, input),
    findActivePrincipal: (providerUserId) =>
      findActiveHumanPrincipal(database, providerUserId),
    hasLiveMembership: (input) => hasLiveMembership(database, input),
    touchActivity: (input) => touchGrantActivity(database, input),
  };
}
