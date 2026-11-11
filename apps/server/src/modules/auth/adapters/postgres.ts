import { symmetricDecrypt, verifyPassword } from "better-auth/crypto";
import type { PrincipalType } from "@bakery/contracts/contracts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import type {
  BootstrapStore,
  BootstrapTransaction,
} from "../application/createsuperuser.ts";
import {
  countBackupCodes,
  type IdentityStore,
} from "../application/identity.ts";
import type {
  BootstrapState,
  HumanPrincipalInput,
} from "../domain/bootstrap.ts";
import {
  BootstrapInstallationSchema,
  INSTALLATION_BOOTSTRAP_REPAIR_VERSION,
  personalOrganization,
} from "../domain/bootstrap.ts";
import {
  lockInstallationPrincipals,
  readInstallationSettings,
} from "./installation-settings-postgres.ts";
import { OrganizationRole } from "../domain/authorization.ts";
import type { RegistrationStore } from "../domain/registration.ts";
import { AuthErrorCode } from "../domain/errors.ts";

export type AuthPersistence = RegistrationStore & {
  upsertHumanPrincipal(user: HumanPrincipalInput): Promise<void>;
  upsertHumanPrincipalForProviderUser(providerUserId: string): Promise<void>;
};

export type SessionState = {
  id: string;
  expiresAt: Date;
  twoFactorEnabled: boolean;
  factorVerifiedAt: Date | null;
};

export type SessionStore = {
  findSessionState(token: string): Promise<SessionState | null>;
};

/** A bearer access token that is unrevoked and unexpired, with its enabled principal. */
export type LiveAccessToken = {
  tokenId: string;
  organizationId: string;
  scopes: string[];
  principal: {
    principalId: string;
    principalType: PrincipalType;
    displayName: string;
    preferredLocale: string | null;
  };
};

export type AccessTokenAuthStore = {
  findLiveAccessToken(digest: string): Promise<LiveAccessToken | null>;
};

export type PostgresAuthPersistence =
  & AuthPersistence
  & BootstrapStore
  & IdentityStore
  & SessionStore
  & AccessTokenAuthStore;

type Query = (
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null }>;

async function upsertHumanPrincipal(
  query: Query,
  user: HumanPrincipalInput,
): Promise<void> {
  const result = await query(
    `insert into bakery.principals (
      provider_user_id,
      display_name,
      principal_type
    ) values ($1, $2, 'human')
    on conflict (provider_user_id) do update
      set display_name = excluded.display_name
    returning id`,
    [user.providerUserId, user.displayName],
  );
  if (result.rowCount !== 1) {
    throw new Error(AuthErrorCode.PrincipalConvergenceFailed);
  }
}

function createBootstrapTransaction(
  client: PgTransactionClient,
): BootstrapTransaction {
  return {
    async inspect() {
      const settings = await client.query<{
        id: boolean;
        principalId: string | null;
        repairVersion: number | null;
        grantedByPrincipalId: string | null;
        revoked: boolean;
      }>(
        `select settings.id, settings.bootstrap_principal_id as "principalId",
          settings.bootstrap_repair_version as "repairVersion",
          administrator.granted_by_principal_id as "grantedByPrincipalId",
          administrator.revoked_at is not null as revoked
        from bakery.installation_settings as settings
        left join bakery.installation_administrators as administrator
          on administrator.principal_id = settings.bootstrap_principal_id
        order by settings.id`,
      );
      if (settings.rows.length !== 1 || settings.rows[0].id !== true) {
        throw new Error(AuthErrorCode.BootstrapMarkerInvalid);
      }
      const { id: _id, ...rawMarker } = settings.rows[0];
      const parsedMarker = BootstrapInstallationSchema.safeParse(rawMarker);
      if (!parsedMarker.success) {
        throw new Error(AuthErrorCode.BootstrapMarkerInvalid);
      }
      const installation = parsedMarker.data;
      const users = await client.query<BootstrapState["users"][number]>(
        installation.principalId === null
          ? 'select id, email, name from public."user" order by id'
          : `select provider.id, provider.email, provider.name
             from public."user" as provider
             join bakery.principals as principal on principal.provider_user_id = provider.id
             where principal.id = $1`,
        installation.principalId === null ? [] : [installation.principalId],
      );
      if (installation.principalId === null && users.rows.length > 1) {
        throw new Error(AuthErrorCode.BootstrapLegacyAmbiguous);
      }
      const providerUserId = users.rows.length === 1 ? users.rows[0].id : null;
      const principal = providerUserId
        ? await client.query<BootstrapState["principals"][number]>(
          `select id, provider_user_id as "providerUserId",
            principal_type as "principalType", disabled_at is not null as disabled
          from bakery.principals
          where provider_user_id = $1`,
          [providerUserId],
        )
        : { rows: [] };
      if (installation.principalId !== null) {
        if (installation.revoked || principal.rows[0]?.disabled) {
          throw new Error(AuthErrorCode.BootstrapUnavailable);
        }
      }
      const organizations = providerUserId
        ? await client.query<BootstrapState["organizations"][number]>(
          `select distinct organization.id, organization.name, organization.slug
          from bakery.organizations as organization
          join bakery.organization_memberships as membership
            on membership.organization_id = organization.id
          where membership.principal_id = $1
          order by organization.id`,
          [principal.rows[0]?.id ?? crypto.randomUUID()],
        )
        : { rows: [] };
      const members = providerUserId
        ? await client.query<BootstrapState["members"][number]>(
          `select membership.id,
            membership.organization_id as "organizationId",
            principal.provider_user_id as "userId", membership.role
          from bakery.organization_memberships as membership
          join bakery.principals as principal
            on principal.id = membership.principal_id
          where membership.principal_id = $1
          order by membership.id`,
          [principal.rows[0]?.id ?? crypto.randomUUID()],
        )
        : { rows: [] };
      return {
        users: users.rows,
        organizations: organizations.rows,
        members: members.rows,
        principals: principal.rows,
        installation,
      };
    },

    async lockInstallation() {
      await readInstallationSettings(client, "update");
      const marker = await client.query<{ id: string }>(
        `select principal.id from bakery.principals as principal
         join public."user" as provider on provider.id = principal.provider_user_id
         where principal.id = (select bootstrap_principal_id from bakery.installation_settings where id = true)
           or (select bootstrap_principal_id from bakery.installation_settings where id = true) is null
         order by principal.id`,
      );
      await lockInstallationPrincipals(
        client,
        marker.rows.map((row) => row.id),
      );
    },

    async ensureInstallationAdministrator(principalId) {
      const principal = await client.query(
        `select id from bakery.principals
         where id = $1 and principal_type = 'human' and disabled_at is null for update`,
        [principalId],
      );
      if (principal.rows.length !== 1) {
        throw new Error(AuthErrorCode.BootstrapUnavailable);
      }
      const marker = await client.query<
        { principalId: string | null; repairVersion: number | null }
      >(
        `select bootstrap_principal_id as "principalId", bootstrap_repair_version as "repairVersion"
         from bakery.installation_settings where id = true for update`,
      );
      if (
        marker.rows.length !== 1 || marker.rows[0].principalId !== null ||
        marker.rows[0].repairVersion !== null
      ) {
        throw new Error(AuthErrorCode.BootstrapMarkerInvalid);
      }
      const existing = await client.query(
        "select principal_id from bakery.installation_administrators where principal_id = $1 for update",
        [principalId],
      );
      if (existing.rows.length !== 0) {
        throw new Error(AuthErrorCode.BootstrapConflict);
      }
      const now = new Date();
      await client.query(
        `insert into bakery.installation_administrators (
          principal_id, granted_by_principal_id, created_at, updated_at, version
        ) values ($1, $1, $2, $2, 1)`,
        [principalId, now],
      );
      const recorded = await client.query(
        `update bakery.installation_settings
         set bootstrap_principal_id = $1, bootstrap_repair_version = $2
         where id = true and bootstrap_principal_id is null and bootstrap_repair_version is null
         returning id`,
        [principalId, INSTALLATION_BOOTSTRAP_REPAIR_VERSION],
      );
      if (recorded.rowCount !== 1) {
        throw new Error(AuthErrorCode.BootstrapMarkerInvalid);
      }
    },

    async createAdminMember(userId, organizationId) {
      const principal = await client.query<{ id: string }>(
        `select id
        from bakery.principals
        where provider_user_id = $1
          and principal_type = 'human'
          and disabled_at is null
        for update`,
        [userId],
      );
      if (principal.rows.length !== 1) {
        throw new Error(AuthErrorCode.PrincipalConvergenceFailed);
      }
      const result = await client.query(
        `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status,
          joined_at, created_at, updated_at, version
        ) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)
        returning id`,
        [
          crypto.randomUUID(),
          organizationId,
          principal.rows[0].id,
          OrganizationRole.Admin,
          new Date(),
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error(AuthErrorCode.BootstrapMemberConvergenceFailed);
      }
    },

    async createPersonalOrganization(userId) {
      const principal = await client.query<{ id: string }>(
        `select id
        from bakery.principals
        where provider_user_id = $1
          and principal_type = 'human'
          and disabled_at is null
        for update`,
        [userId],
      );
      if (principal.rows.length !== 1) {
        throw new Error(AuthErrorCode.PrincipalConvergenceFailed);
      }
      const organizationId = crypto.randomUUID();
      const now = new Date();
      const organization = await client.query(
        `insert into bakery.organizations (
          id, name, slug, logo, metadata, created_at, updated_at, version
        ) values ($1, $2, $3, null, '{}'::jsonb, $4, $4, 1)
        returning id`,
        [
          organizationId,
          personalOrganization.name,
          personalOrganization.slug,
          now,
        ],
      );
      if (organization.rowCount !== 1) {
        throw new Error(AuthErrorCode.BootstrapFailed);
      }
      const member = await client.query(
        `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status,
          joined_at, created_at, updated_at, version
        ) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)
        returning id`,
        [
          crypto.randomUUID(),
          organizationId,
          principal.rows[0].id,
          OrganizationRole.Admin,
          now,
        ],
      );
      if (member.rowCount !== 1) {
        throw new Error(AuthErrorCode.BootstrapMemberConvergenceFailed);
      }
    },

    upsertHumanPrincipal(user) {
      return upsertHumanPrincipal(
        (text, values) => client.query(text, values),
        user,
      );
    },

    async verifyCredentialPassword(userId, password) {
      const result = await client.query<{ password: string | null }>(
        `select password
         from public.account
         where "userId" = $1::uuid
           and "providerId" = 'credential'
           and "accountId" = $1::text`,
        [userId],
      );
      const hash = result.rows.length === 1 ? result.rows[0].password : null;
      return hash !== null && await verifyPassword({ hash, password });
    },
  };
}

export function createPostgresAuthPersistence(
  database: PgDatabase,
): PostgresAuthPersistence {
  return {
    async loadEnabledPrincipal(providerUserId) {
      const result = await database.query<{
        principalId: string;
        principalType: PrincipalType;
        displayName: string;
        preferredLocale: string | null;
      }>(
        `select id as "principalId", principal_type as "principalType",
          display_name as "displayName", preferred_locale as "preferredLocale"
        from bakery.principals
        where provider_user_id = $1
          and disabled_at is null
        limit 1`,
        [providerUserId],
      );
      if (result.rows.length !== 1) return null;
      return result.rows[0];
    },

    async findLiveAccessToken(digest) {
      const result = await database.query<{
        tokenId: string;
        organizationId: string;
        scopes: string[];
        principalId: string;
        principalType: PrincipalType;
        displayName: string;
        preferredLocale: string | null;
      }>(
        `select token.id as "tokenId", token.organization_id as "organizationId",
          token.scopes, principal.id as "principalId",
          principal.principal_type as "principalType",
          principal.display_name as "displayName",
          principal.preferred_locale as "preferredLocale"
        from bakery.access_tokens as token
        join bakery.principals as principal on principal.id = token.principal_id
        where token.secret_sha256 = $1
          and token.revoked_at is null
          and token.expires_at > current_timestamp
          and principal.disabled_at is null`,
        [digest],
      );
      const row = result.rows[0];
      if (!row) return null;
      // Throttled so a busy token does not rewrite its row on every request.
      await database.query(
        `update bakery.access_tokens
        set last_used_at = current_timestamp
        where id = $1
          and (last_used_at is null
            or last_used_at < current_timestamp - interval '1 minute')`,
        [row.tokenId],
      );
      return {
        tokenId: row.tokenId,
        organizationId: row.organizationId,
        scopes: row.scopes,
        principal: {
          principalId: row.principalId,
          principalType: row.principalType,
          displayName: row.displayName,
          preferredLocale: row.preferredLocale,
        },
      };
    },

    async hasLiveInvitation(email, now) {
      const result = await database.query<{ allowed: boolean }>(
        `select exists (
          select 1
          from bakery.organization_invitations as invitation
          where invitation.email = lower(btrim($1))
            and invitation.status = 'pending'
            and invitation.expires_at > $2
        ) as allowed`,
        [email, now],
      );
      return result.rows[0]?.allowed === true;
    },

    async hasEnabledPrincipal(providerUserId) {
      const result = await database.query<{ allowed: boolean }>(
        `select exists (
          select 1
          from bakery.principals
          where provider_user_id = $1
            and principal_type = 'human'
            and disabled_at is null
        ) as allowed`,
        [providerUserId],
      );
      return result.rows[0]?.allowed === true;
    },

    upsertHumanPrincipal(user) {
      return upsertHumanPrincipal(
        (text, values) => database.query(text, values),
        user,
      );
    },

    async upsertHumanPrincipalForProviderUser(providerUserId) {
      const result = await database.query<{ name: string }>(
        'select name from public."user" where id = $1',
        [providerUserId],
      );
      if (result.rows.length !== 1) {
        throw new Error(AuthErrorCode.ProviderUserNotFound);
      }
      await upsertHumanPrincipal(
        (text, values) => database.query(text, values),
        { providerUserId, displayName: result.rows[0].name },
      );
    },

    async withBootstrapLock(work) {
      return await withPgTransaction(database, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended('bakery:createsuperuser', 0))",
        );
        return await work(createBootstrapTransaction(client));
      });
    },

    async findSessionState(token) {
      const result = await database.query<{
        id: string;
        expiresAt: Date;
        factorVerifiedAt: Date | null;
        twoFactorEnabled: boolean;
      }>(
        `select s.id as "id",
            s."expiresAt" as "expiresAt",
            s."factorVerifiedAt" as "factorVerifiedAt",
            coalesce(u."twoFactorEnabled", false) as "twoFactorEnabled"
          from public.session s
          join public."user" u on u.id = s."userId"
          where s.token = $1`,
        [token],
      );
      if (result.rows.length !== 1) return null;
      return {
        id: result.rows[0].id,
        expiresAt: new Date(result.rows[0].expiresAt),
        factorVerifiedAt: result.rows[0].factorVerifiedAt
          ? new Date(result.rows[0].factorVerifiedAt)
          : null,
        twoFactorEnabled: result.rows[0].twoFactorEnabled,
      };
    },
  };
}

/**
 * Unused two-factor backup codes Better Auth still holds for a provider user.
 * The plugin stores the set as one JSON array encrypted with the auth secret
 * (`backupCodeOptions.storeBackupCodes: "encrypted"`) and rewrites it without
 * the consumed code on every successful recovery, so the live count is the
 * decrypted array's length. Read-only: never returns or rewrites the codes.
 */
export async function countUnusedBackupCodes(
  database: PgDatabase,
  providerUserId: string,
  secret: string,
): Promise<number> {
  const result = await database.query<{ backupCodes: string | null }>(
    `select "backupCodes" from public."twoFactor" where "userId" = $1`,
    [providerUserId],
  );
  const encrypted = result.rows[0]?.backupCodes ?? null;
  if (encrypted === null) return 0;
  // A blob that no longer decrypts (corrupt, or written under a rotated
  // secret) holds no usable codes: count zero rather than failing /v1/me,
  // which every signed-in page depends on, over a display-only number.
  let serialized: string;
  try {
    serialized = await symmetricDecrypt({ key: secret, data: encrypted });
  } catch {
    return 0;
  }
  return countBackupCodes(serialized);
}
