import {
  MembershipStatus,
  OrganizationRole,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import type { ScimHost } from "./host.ts";
import { recordAuthAudit } from "../application/audit.ts";
import { createPostgresAuthPersistence } from "../adapters/postgres.ts";

type Role = typeof OrganizationRole[keyof typeof OrganizationRole];

/**
 * IdP group display names that grant a Bakery system role. The `bakery-`
 * prefix is deliberate: a directory group that happens to be called `admin`
 * must never become an administrator by accident.
 */
const GROUP_ROLES: Readonly<Record<string, Role>> = {
  "bakery-admin": OrganizationRole.Admin,
  "bakery-developer": OrganizationRole.Developer,
  "bakery-viewer": OrganizationRole.Viewer,
  "bakery-guest": OrganizationRole.Guest,
};

/** Role of a provisioned member that no mapped group grants a role to. */
export const SCIM_DEFAULT_ROLE: Role = OrganizationRole.Viewer;

const ROLE_RANK: Readonly<Record<Role, number>> = {
  [OrganizationRole.Guest]: 0,
  [OrganizationRole.Viewer]: 1,
  [OrganizationRole.Developer]: 2,
  [OrganizationRole.Admin]: 3,
};

export function roleForGroup(displayName: string): Role | undefined {
  return GROUP_ROLES[displayName.trim().toLowerCase()];
}

export function isMappedRole(role: string): role is Role {
  return Object.values(GROUP_ROLES).includes(role as Role);
}

/** Highest-ranked role among the grants, or the default when there is none. */
export function effectiveRole(roles: readonly string[]): Role {
  let best: Role | undefined;
  for (const role of roles) {
    if (!isMappedRole(role)) continue;
    if (best === undefined || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best ?? SCIM_DEFAULT_ROLE;
}

type DesiredUser = {
  userId: string;
  active: boolean;
  roles: string[];
};

type MembershipRow = {
  id: string;
  role: string;
  status: string;
  managed: boolean;
};

export type ScimReconcileResult = {
  created: number;
  updated: number;
  deactivated: number;
  deleted: number;
  skipped: number;
};

/**
 * Brings Bakery memberships in line with the SCIM state of one organization.
 * Source of truth is the SCIM plugin's own tables, so the run is idempotent and
 * can repeat after any SCIM request or crash. It only touches memberships the
 * projection created (`bakery.scim_memberships`), writes every change and its
 * audit row in one transaction, and never removes the last active
 * administrator.
 */
export async function reconcileScimOrganization(
  host: ScimHost,
  organizationId: string,
  correlation: { requestId: string; traceId: string } = {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  },
): Promise<ScimReconcileResult> {
  const persistence = createPostgresAuthPersistence(host.database);
  const result: ScimReconcileResult = {
    created: 0,
    updated: 0,
    deactivated: 0,
    deleted: 0,
    skipped: 0,
  };
  await withPgTransaction(host.database, async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(
        hashtextextended('bakery:organization:' || $1::text, 0)
      )`,
      [organizationId],
    );
    const scimUsers = await client.query<
      { userId: string; active: boolean }
    >(
      `select "userId", bool_or(active) as active
      from public."scimUser"
      where "provisioningDomainId" = $1
      group by "userId"`,
      [organizationId],
    );
    const grants = await client.query<{ userId: string; role: string }>(
      `select "userId", role
      from public."scimProjectionGrant"
      where "provisioningDomainId" = $1`,
      [organizationId],
    );
    const managed = await client.query<{ providerUserId: string }>(
      `select principal.provider_user_id as "providerUserId"
      from bakery.scim_memberships as link
      join bakery.principals as principal on principal.id = link.principal_id
      where link.organization_id = $1`,
      [organizationId],
    );
    const desired = new Map<string, DesiredUser>();
    for (const row of scimUsers.rows) {
      desired.set(row.userId, {
        userId: row.userId,
        active: row.active,
        roles: [],
      });
    }
    for (const grant of grants.rows) {
      desired.get(grant.userId)?.roles.push(
        grant.role,
      );
    }
    const gone = managed.rows.map((row) => row.providerUserId).filter(
      (userId) => !desired.has(userId),
    );
    const work = [
      ...[...desired.values()].sort((a, b) => a.userId.localeCompare(b.userId)),
      ...gone.sort().map((userId) => ({
        userId,
        active: false,
        roles: [],
        removed: true,
      })),
    ];
    for (const entry of work) {
      const removed = "removed" in entry;
      await client.query("savepoint scim_user");
      try {
        const outcome = await reconcileUser(client, {
          organizationId,
          entry,
          removed,
          ensurePrincipal: (userId) =>
            persistence.upsertHumanPrincipalForProviderUser(userId),
          correlation,
        });
        result[outcome] += 1;
        await client.query("release savepoint scim_user");
      } catch (error) {
        await client.query("rollback to savepoint scim_user");
        if (error instanceof StandardError) {
          result.skipped += 1;
          continue;
        }
        throw error;
      }
    }
  });
  return result;
}

async function reconcileUser(
  client: PgTransactionClient,
  context: {
    organizationId: string;
    entry: DesiredUser;
    removed: boolean;
    ensurePrincipal: (providerUserId: string) => Promise<void>;
    correlation: { requestId: string; traceId: string };
  },
): Promise<keyof ScimReconcileResult> {
  const { organizationId, entry, correlation } = context;
  const wantsActive = entry.active && !context.removed;
  const wantedRole = effectiveRole(entry.roles);

  let principal = await findPrincipal(client, entry.userId);
  if (!principal) {
    if (!wantsActive) return "skipped";
    await context.ensurePrincipal(entry.userId);
    principal = await findPrincipal(client, entry.userId);
    if (!principal) return "skipped";
  }
  const membership = await findMembership(client, organizationId, principal);

  if (!membership) {
    if (!wantsActive) return "skipped";
    const membershipId = crypto.randomUUID();
    await client.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status,
        joined_at, created_at, updated_at, version
      ) values ($1, $2, $3, $4, 'active', current_timestamp,
        current_timestamp, current_timestamp, 1)`,
      [membershipId, organizationId, principal, wantedRole],
    );
    await client.query(
      `insert into bakery.scim_memberships (organization_id, principal_id)
      values ($1, $2)
      on conflict do nothing`,
      [organizationId, principal],
    );
    await audit(
      client,
      correlation,
      organizationId,
      "scimProvisioning.create",
      {
        membershipId,
        role: wantedRole,
      },
    );
    return "created";
  }
  if (!membership.managed) return "skipped";

  if (!wantsActive) {
    if (membership.status === MembershipStatus.Inactive && !context.removed) {
      return "skipped";
    }
    if (await isLastActiveAdmin(client, organizationId, membership)) {
      return "skipped";
    }
    if (context.removed) {
      await client.query(
        `delete from bakery.permission_grants
        where organization_id = $1 and principal_id = $2`,
        [organizationId, principal],
      );
      await client.query(
        `delete from bakery.organization_memberships
        where organization_id = $1 and id = $2`,
        [organizationId, membership.id],
      );
      await client.query(
        `delete from bakery.scim_memberships
        where organization_id = $1 and principal_id = $2`,
        [organizationId, principal],
      );
      await client.query(
        `update bakery.access_tokens
        set revoked_at = current_timestamp
        where organization_id = $1 and principal_id = $2
          and revoked_at is null`,
        [organizationId, principal],
      );
      await audit(
        client,
        correlation,
        organizationId,
        "scimProvisioning.delete",
        { membershipId: membership.id },
      );
      return "deleted";
    }
    await client.query(
      `update bakery.organization_memberships
      set status = 'inactive', updated_at = current_timestamp,
        version = version + 1
      where organization_id = $1 and id = $2`,
      [organizationId, membership.id],
    );
    await client.query(
      `update bakery.access_tokens
      set revoked_at = current_timestamp
      where organization_id = $1 and principal_id = $2
        and revoked_at is null`,
      [organizationId, principal],
    );
    await audit(
      client,
      correlation,
      organizationId,
      "scimProvisioning.deactivate",
      { membershipId: membership.id },
    );
    return "deactivated";
  }

  const reactivating = membership.status === MembershipStatus.Inactive;
  if (!reactivating && wantedRole === membership.role) return "skipped";
  if (
    membership.role === OrganizationRole.Admin &&
    wantedRole !== OrganizationRole.Admin &&
    await isLastActiveAdmin(client, organizationId, membership)
  ) return "skipped";
  await client.query(
    `update bakery.organization_memberships
    set role = $3, status = 'active', updated_at = current_timestamp,
      version = version + 1
    where organization_id = $1 and id = $2`,
    [organizationId, membership.id, wantedRole],
  );
  await audit(client, correlation, organizationId, "scimProvisioning.update", {
    membershipId: membership.id,
    role: wantedRole,
    previousRole: membership.role,
    reactivated: reactivating,
  });
  return "updated";
}

async function findPrincipal(
  client: PgTransactionClient,
  providerUserId: string,
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `select id from bakery.principals
    where provider_user_id = $1 and principal_type = 'human'
      and disabled_at is null
    for update`,
    [providerUserId],
  );
  return found.rows[0]?.id ?? null;
}

async function findMembership(
  client: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<MembershipRow | null> {
  const found = await client.query<MembershipRow>(
    `select membership.id, membership.role, membership.status,
      exists (
        select 1 from bakery.scim_memberships as link
        where link.organization_id = membership.organization_id
          and link.principal_id = membership.principal_id
      ) as managed
    from bakery.organization_memberships as membership
    where membership.organization_id = $1 and membership.principal_id = $2
    for update of membership`,
    [organizationId, principalId],
  );
  return found.rows[0] ?? null;
}

async function isLastActiveAdmin(
  client: PgTransactionClient,
  organizationId: string,
  membership: MembershipRow,
): Promise<boolean> {
  if (
    membership.role !== OrganizationRole.Admin ||
    membership.status !== MembershipStatus.Active
  ) return false;
  const admins = await client.query<{ id: string }>(
    `select membership.id
    from bakery.organization_memberships as membership
    join bakery.principals as principal
      on principal.id = membership.principal_id
    where membership.organization_id = $1
      and membership.role = 'admin' and membership.status = 'active'
      and principal.principal_type = 'human' and principal.disabled_at is null
    for update of membership`,
    [organizationId],
  );
  return admins.rows.length === 1;
}

function audit(
  client: PgTransactionClient,
  correlation: { requestId: string; traceId: string },
  organizationId: string,
  operation: string,
  details: Record<string, unknown>,
) {
  return recordAuthAudit(client, correlation, {
    organizationId,
    principalId: null,
    operation,
    resourceType: "organization_membership",
    resourceId: String(details.membershipId),
    details,
  });
}

export type { PgDatabase };
