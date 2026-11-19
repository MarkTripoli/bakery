import type {
  PgDatabase,
  PgTransactionClient,
} from "../../../platform/database.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOrganizationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export type SsoActor = Readonly<{
  providerUserId: string;
  principalId: string;
}>;

export type OrganizationAccess =
  | { organizationExists: false }
  | {
    organizationExists: true;
    /** Active membership role, absent when the caller has none. */
    role: string | null;
  };

/**
 * Tenant lookup and the caller's live canonical membership in one read. The
 * Better Auth `member` table is not Bakery's authority, so the SSO guard never
 * trusts it.
 */
export async function readOrganizationAccess(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  actor: SsoActor,
): Promise<OrganizationAccess> {
  const result = await database.query<{ role: string | null }>(
    `select membership.role
     from bakery.organizations as organization
     left join bakery.organization_memberships as membership
       on membership.organization_id = organization.id
      and membership.principal_id = $2
      and membership.status = 'active'
     where organization.id = $1`,
    [organizationId, actor.principalId],
  );
  const row = result.rows[0];
  if (!row) return { organizationExists: false };
  return { organizationExists: true, role: row.role };
}

export async function readActor(
  database: Pick<PgDatabase, "query">,
  providerUserId: string,
): Promise<SsoActor | null> {
  const result = await database.query<{ id: string }>(
    `select id from bakery.principals
     where provider_user_id = $1 and principal_type = 'human'
       and disabled_at is null`,
    [providerUserId],
  );
  const row = result.rows[0];
  return row ? { providerUserId, principalId: row.id } : null;
}

export type ProviderRow = Readonly<{
  providerId: string;
  organizationId: string | null;
  protocol: "oidc" | "saml";
  domain: string;
  domainVerified: boolean;
}>;

export async function readProvider(
  database: Pick<PgDatabase, "query">,
  providerId: string,
): Promise<ProviderRow | null> {
  const result = await database.query<
    {
      providerId: string;
      organizationId: string | null;
      oidc: boolean;
      domain: string;
      domainVerified: boolean | null;
    }
  >(
    `select "providerId", "organizationId", "oidcConfig" is not null as oidc,
            domain, "domainVerified"
     from public."ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    providerId: row.providerId,
    organizationId: row.organizationId,
    protocol: row.oidc ? "oidc" : "saml",
    domain: row.domain,
    domainVerified: row.domainVerified === true,
  };
}

/** Organizations where the person holds an active membership, with role and enforcement. */
export async function readEnforcedMemberships(
  database: Pick<PgDatabase, "query">,
  providerUserId: string,
): Promise<{ organizationId: string; role: string | null }[]> {
  const result = await database.query<
    { organizationId: string; role: string | null }
  >(
    `select membership.organization_id as "organizationId", membership.role
     from bakery.principals as principal
     join bakery.organization_memberships as membership
       on membership.principal_id = principal.id and membership.status = 'active'
     join bakery.organization_sso_settings as settings
       on settings.organization_id = membership.organization_id
      and settings.enforce
     where principal.provider_user_id = $1`,
    [providerUserId],
  );
  return result.rows;
}

/** True when the person can still sign in with a password or a passkey. */
export async function holdsPasswordOrPasskey(
  database: Pick<PgDatabase, "query">,
  providerUserId: string,
): Promise<boolean> {
  const result = await database.query<{ found: boolean }>(
    `select (
       exists (select 1 from public.account
               where "userId" = $1 and "providerId" = 'credential'
                 and password is not null)
       or exists (select 1 from public.passkey where "userId" = $1)
     ) as found`,
    [providerUserId],
  );
  return result.rows[0]?.found === true;
}

/**
 * What removing one provider does to an organization's SSO requirement.
 * `locksOut` is true when SSO is required, the provider's domain is verified
 * and no other verified provider remains: removing it would leave only
 * break-glass administrators able to sign in.
 */
export type RemovalEffect = Readonly<{
  enforced: boolean;
  providerVerified: boolean;
  otherVerifiedProviders: number;
  locksOut: boolean;
}>;

export async function readRemovalEffect(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  providerId: string,
): Promise<RemovalEffect> {
  const result = await database.query<{
    enforced: boolean;
    providerVerified: boolean;
    others: string;
  }>(
    // The settings table keys the organization as a uuid and the provider table
    // as text, so the id is passed once per type (one parameter cannot be both).
    `select
       coalesce((select enforce from bakery.organization_sso_settings
                  where organization_id = $1::uuid), false) as enforced,
       coalesce((select "domainVerified" is true from public."ssoProvider"
                  where "providerId" = $2 and "organizationId" = $3::text), false)
         as "providerVerified",
       (select count(*)::text from public."ssoProvider"
         where "organizationId" = $3::text and "providerId" <> $2
           and "domainVerified" is true) as others`,
    [organizationId, providerId, organizationId],
  );
  const row = result.rows[0];
  const otherVerifiedProviders = Number(row.others);
  return {
    enforced: row.enforced,
    providerVerified: row.providerVerified,
    otherVerifiedProviders,
    locksOut: row.enforced && row.providerVerified &&
      otherVerifiedProviders === 0,
  };
}

/** A provider row and its linked accounts as they were before a mutation. */
export type ProviderSnapshot = Readonly<{
  provider: Record<string, unknown> | null;
  accounts: readonly Record<string, unknown>[];
}>;

export async function snapshotProvider(
  database: Pick<PgDatabase, "query">,
  providerId: string,
): Promise<ProviderSnapshot> {
  const result = await database.query<
    {
      provider: Record<string, unknown> | null;
      accounts: Record<string, unknown>[];
    }
  >(
    `select
       (select to_jsonb(provider) from public."ssoProvider" as provider
         where provider."providerId" = $1) as provider,
       coalesce((select jsonb_agg(to_jsonb(account))
                 from public.account as account
                 where account."providerId" = $1), '[]'::jsonb) as accounts`,
    [providerId],
  );
  return result.rows[0];
}

/**
 * Puts a provider and its linked accounts back exactly as snapshotted. Used
 * when the audit row for a mutation could not be written, so no SSO change
 * stands without its record.
 */
export async function restoreProvider(
  transaction: Pick<PgTransactionClient, "query">,
  providerId: string,
  snapshot: ProviderSnapshot,
): Promise<void> {
  if (!snapshot.provider) return;
  await transaction.query(
    `delete from public.account where "providerId" = $1`,
    [providerId],
  );
  await transaction.query(
    `delete from public."ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  await transaction.query(
    `insert into public."ssoProvider"
     select * from jsonb_populate_record(null::public."ssoProvider", $1::jsonb)`,
    [JSON.stringify(snapshot.provider)],
  );
  if (snapshot.accounts.length > 0) {
    await transaction.query(
      `insert into public.account
       select * from jsonb_populate_recordset(null::public.account, $1::jsonb)`,
      [JSON.stringify(snapshot.accounts)],
    );
  }
}
