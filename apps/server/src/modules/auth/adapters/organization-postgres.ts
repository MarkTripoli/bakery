import { assertAnotherAdminRemains } from "./last-admin-postgres.ts";
import {
  isMembershipStatus,
  isOrganizationRole,
  type JsonValue,
  MembershipStatus,
  OrganizationRole,
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
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../../platform/postgres-errors.ts";
import type { OrganizationActor } from "../application/authority.ts";
import { organizationPermissions } from "../application/authorize.ts";
import type { AuthenticatedSubject } from "../application/identity.ts";
import {
  type OrganizationCreateInput,
  type OrganizationInvitationCreateInput,
  type OrganizationInvitationPreviewGetInput,
  type OrganizationInvitationRecipientActionInput,
  type OrganizationInvitationRecipientGetInput,
  type OrganizationMembershipCreateInput,
  type OrganizationMembershipUpdateInput,
  type OrganizationUpdateInput,
  prepareInvitationCreate,
  prepareMembershipCreate,
  prepareMembershipUpdate,
  prepareOrganizationCreate,
  prepareOrganizationUpdate,
} from "../application/organizations.ts";

const CREATED_AT_ORDERING = "createdAt:asc,id:asc";
const MAX_METADATA_BYTES = 16 * 1024;
const invitationStatuses: Record<
  "pending" | "accepted" | "rejected" | "canceled",
  true
> = { pending: true, accepted: true, rejected: true, canceled: true };
type InvitationStatus = keyof typeof invitationStatuses;
function isInvitationStatus(value: string): value is InvitationStatus {
  return Object.hasOwn(invitationStatuses, value);
}

export type OrganizationCursorQuery = {
  cursor?: string;
  limit?: number;
};
type Timestamp = Date | string;
type KeysetRow = {
  id: string;
  cursorCreatedAt: Timestamp;
};
type OrganizationRow = KeysetRow & {
  name: string;
  slug: string;
  logo: string | null;
  metadata: unknown;
  defaultLocale: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  version: number;
};
type OrganizationAccessRow = OrganizationRow & { role: string | null };
type MembershipRow = KeysetRow & {
  organizationId: string;
  principalId: string | null;
  role: string | null;
  status: string;
  joinedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  version: number;
};
type InvitationRow = KeysetRow & {
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Timestamp;
  inviterPrincipalId: string | null;
  createdAt: Timestamp;
};
type OrganizationInvitationRecipientRow = {
  id: string;
  email: string;
  role: string;
  organizationId: string;
  inviterId: string | null;
  status: string;
  expiresAt: Timestamp;
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string | null;
};
type OrganizationInvitationPreviewRow = {
  invitationId: string;
  organizationName: string;
  inviterDisplayName: string | null;
  role: string;
  email: string;
  expiresAt: Timestamp;
};
type PrincipalRow = {
  id: string;
  providerUserId: string | null;
  principalType: PrincipalType;
  disabledAt: Timestamp | null;
};
type InvitationTransitionRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Timestamp;
  inviterId: string | null;
  createdAt: Timestamp;
};

type RecipientPrincipalRow = PrincipalRow & { email: string };

function timestamp(value: Timestamp): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("AUTH_READ_TIMESTAMP_INVALID");
  }
  return date.toISOString();
}

function cursorTimestamp(value: Timestamp): string {
  if (value instanceof Date) return timestamp(value);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("AUTH_READ_CURSOR_TIMESTAMP_INVALID");
  }
  return value;
}

function metadata(value: unknown): JsonValue {
  if (value === null) return {};
  let serialized: string | undefined;
  if (typeof value === "string") {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("AUTH_READ_METADATA_INVALID");
    }
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_METADATA_BYTES
  ) {
    throw new Error("AUTH_READ_METADATA_INVALID");
  }
  if (typeof value !== "string") {
    // `JSON.stringify` above proved `value` round-trips as JSON; the pg
    // driver's JSONB decode never produces functions, symbols, or cycles.
    return value as JsonValue;
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error("AUTH_READ_METADATA_INVALID");
  }
}

function organization(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logo: row.logo,
    metadata: metadata(row.metadata),
    defaultLocale: row.defaultLocale,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    version: row.version,
  };
}

function membership(row: MembershipRow) {
  if (
    !row.principalId ||
    (row.role !== null && !isOrganizationRole(row.role)) ||
    !isMembershipStatus(row.status)
  ) throw new Error("AUTH_READ_MEMBERSHIP_INVALID");
  return {
    id: row.id,
    organizationId: row.organizationId,
    principalId: row.principalId,
    role: row.role === null ? null : row.role,
    status: row.status,
    joinedAt: timestamp(row.joinedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    version: row.version,
  };
}

function invitation(row: InvitationRow) {
  if (
    !row.role ||
    !isOrganizationRole(row.role) ||
    !isInvitationStatus(row.status)
  ) throw new Error("AUTH_READ_INVITATION_INVALID");
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: timestamp(row.expiresAt),
    inviterPrincipalId: row.inviterPrincipalId,
    createdAt: timestamp(row.createdAt),
  };
}

function recipientInvitation(row: OrganizationInvitationRecipientRow) {
  if (
    !row.id || !row.email || !isOrganizationRole(row.role) ||
    !isInvitationStatus(row.status) || !row.organizationId ||
    !row.organizationName || !row.organizationSlug
  ) throw new Error("AUTH_READ_INVITATION_RECIPIENT_INVALID");
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    organizationId: row.organizationId,
    inviterId: row.inviterId,
    status: row.status,
    expiresAt: timestamp(row.expiresAt),
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    inviterEmail: row.inviterEmail,
  };
}

function invitationPreview(row: OrganizationInvitationPreviewRow) {
  if (
    !row.invitationId || !row.organizationName ||
    !isOrganizationRole(row.role) || !row.email
  ) throw new Error("AUTH_READ_INVITATION_PREVIEW_INVALID");
  return {
    invitationId: row.invitationId,
    organizationName: row.organizationName,
    // Null when the inviter never had a principal (the canonical lifecycle
    // migration writes NULL for provider-only inviters); the invitation is
    // still live and acceptable.
    inviterDisplayName: row.inviterDisplayName || null,
    role: row.role,
    email: row.email,
    expiresAt: timestamp(row.expiresAt),
  };
}

async function boundedMutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    const code = postgresErrorCode(error);
    if (code === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "STATE_CONFLICT", cause: error });
    }
    if (["22001", "22P02", "23502", "23503", "23514"].includes(code ?? "")) {
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    }
    throw error;
  }
}

function binding(
  action: string,
  subject: AuthenticatedSubject,
  organizationId?: string,
): CursorBinding {
  return {
    action,
    principalId: subject.principalId,
    organizationId,
    ordering: CREATED_AT_ORDERING,
    filters: "{}",
    schemaVersion: 1,
  };
}

async function page<Row extends KeysetRow, Item>(
  secret: string,
  cursorBinding: CursorBinding,
  rows: Row[],
  limit: number,
  project: (row: Row) => Item,
) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(project),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, cursorBinding, {
        createdAt: cursorTimestamp(last.cursorCreatedAt),
        id: last.id,
      })
      : null,
  };
}

export class PostgresOrganizationStore {
  constructor(
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async lockOrganizationAndCallerAuthority(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    capability: string,
  ): Promise<void> {
    if (actor.organizationId !== resourceOrganizationId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    await client.query(
      `select pg_advisory_xact_lock(
        hashtextextended('bakery:organization:' || $1::text, 0)
      )`,
      [resourceOrganizationId],
    );
    const principal = await client.query<PrincipalRow>(
      `select id, provider_user_id as "providerUserId",
        principal_type as "principalType", disabled_at as "disabledAt"
      from bakery.principals
      where id = $1
      for update`,
      [actor.subject.principalId],
    );
    if (
      principal.rows.length !== 1 ||
      principal.rows[0].disabledAt !== null
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const membership = await client.query<{
      role: string | null;
      status: string;
    }>(
      `select role, status
      from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2`,
      [actor.organizationId, actor.subject.principalId],
    );
    const currentMembership = membership.rows[0];
    if (currentMembership?.status === MembershipStatus.Inactive) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const exactGrant = await client.query(
      `select 1
      from bakery.permission_grants
      where organization_id = $1
        and principal_id = $2
        and capability = $3
        and policy_revision = 1
        and revoked_at is null
        and (expires_at is null or expires_at > current_timestamp)
      limit 1`,
      [actor.organizationId, actor.subject.principalId, capability],
    );
    const roleAllows = currentMembership?.role === OrganizationRole.Admin;
    const grantAllows = exactGrant.rows.length === 1;
    if (!roleAllows && !grantAllows) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    if (
      actor.subject.principalType === PrincipalType.Human &&
      currentMembership?.role !== OrganizationRole.Admin
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  }

  async createOrganization(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationCreateInput,
  ) {
    return await boundedMutation(async () => {
      if (subject.principalType !== PrincipalType.Human) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const values = prepareOrganizationCreate(input);
      const principal = await client.query<PrincipalRow>(
        `select id, provider_user_id as "providerUserId",
          principal_type as "principalType", disabled_at as "disabledAt"
        from bakery.principals as principal
        where principal.id = $1
          and principal.principal_type = $2
          and principal.disabled_at is null
        for update`,
        [subject.principalId, PrincipalType.Human],
      );
      if (principal.rows.length !== 1) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const organizationId = crypto.randomUUID();
      const createdAt = this.now();
      const inserted = await client.query(
        `insert into bakery.organizations (
          id, name, slug, logo, metadata, created_at, updated_at, version
        ) values ($1, $2, $3, null, '{}'::jsonb, $4, $4, 1)`,
        [organizationId, values.name, values.slug, createdAt],
      );
      if (inserted.rowCount !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      await client.query(
        `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status,
          joined_at, created_at, updated_at, version
        ) values ($1, $2, $3, $4, $5, $6, $6, $6, 1)`,
        [
          crypto.randomUUID(),
          organizationId,
          subject.principalId,
          OrganizationRole.Admin,
          MembershipStatus.Active,
          createdAt,
        ],
      );
      const created = await client.query<OrganizationRow>(
        `select id, name, slug, logo, metadata,
          default_locale as "defaultLocale",
          created_at as "createdAt", updated_at as "updatedAt", version,
          created_at as "cursorCreatedAt"
        from bakery.organizations
        where id = $1`,
        [organizationId],
      );
      return organization(created.rows[0]);
    });
  }

  async updateOrganization(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    input: OrganizationUpdateInput,
    expectedVersion?: number,
  ) {
    return await boundedMutation(async () => {
      const values = prepareOrganizationUpdate(input);
      await this.lockOrganizationAndCallerAuthority(
        client,
        actor,
        resourceOrganizationId,
        "organizations.update",
      );
      const result = await client.query<OrganizationRow>(
        `update bakery.organizations
        set name = case when $3 then $4 else name end,
          logo = case when $5 then $6 else logo end,
          metadata = case when $7 then $8 else metadata end,
          default_locale = case when $9 then $10 else default_locale end,
          updated_at = current_timestamp,
          version = version + 1
        where id = $1 and id = $2
          and ($11::integer is null or version = $11::integer)
        returning id, name, slug, logo, metadata,
          default_locale as "defaultLocale",
          created_at as "createdAt", updated_at as "updatedAt", version,
          created_at as "cursorCreatedAt"`,
        [
          actor.organizationId,
          resourceOrganizationId,
          values.name !== undefined,
          values.name ?? null,
          values.logo !== undefined,
          values.logo ?? null,
          values.metadata !== undefined,
          values.metadata ?? null,
          values.defaultLocale !== undefined,
          values.defaultLocale ?? null,
          expectedVersion ?? null,
        ],
      );
      if (result.rows.length !== 1) {
        // The caller's authority and the organization row were locked above,
        // so a miss with a version precondition means the version moved.
        throw new StandardError({
          code: expectedVersion === undefined
            ? "RESOURCE_NOT_FOUND"
            : "VERSION_CONFLICT",
        });
      }
      return organization(result.rows[0]);
    });
  }

  async createMembership(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    input: OrganizationMembershipCreateInput,
  ) {
    return await boundedMutation(async () => {
      const values = prepareMembershipCreate(input);
      await this.lockOrganizationAndCallerAuthority(
        client,
        actor,
        resourceOrganizationId,
        "organizationMemberships.create",
      );
      const principal = await client.query<PrincipalRow>(
        `select id, provider_user_id as "providerUserId",
          principal_type as "principalType", disabled_at as "disabledAt"
        from bakery.principals as principal
        where principal.id = $1
          and principal.disabled_at is null
        for update`,
        [values.principalId],
      );
      if (principal.rows.length !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const now = this.now();
      const result = await client.query<MembershipRow>(
        `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status,
          joined_at, created_at, updated_at, version
        ) values ($1, $2, $3, $4, $5, $6, $6, $6, 1)
        returning id, organization_id as "organizationId",
          principal_id as "principalId", role, status,
          joined_at as "joinedAt", created_at as "createdAt",
          updated_at as "updatedAt", version,
          created_at as "cursorCreatedAt"`,
        [
          crypto.randomUUID(),
          actor.organizationId,
          principal.rows[0].id,
          values.role,
          MembershipStatus.Active,
          now,
        ],
      );
      return membership(result.rows[0]);
    });
  }

  private async membershipForChange(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    membershipId: string,
    capability: string,
  ): Promise<{ target: MembershipRow }> {
    await this.lockOrganizationAndCallerAuthority(
      client,
      actor,
      resourceOrganizationId,
      capability,
    );
    const target = await client.query<MembershipRow>(
      `select membership.id,
        membership.organization_id as "organizationId",
        membership.principal_id as "principalId", membership.role,
        membership.status, membership.joined_at as "joinedAt",
        membership.created_at as "createdAt",
        membership.updated_at as "updatedAt", membership.version,
        membership.created_at as "cursorCreatedAt"
      from bakery.organization_memberships as membership
      where membership.organization_id = $1
        and membership.id = $2
      for update of membership`,
      [actor.organizationId, membershipId],
    );
    if (target.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return { target: target.rows[0] };
  }

  async updateMembership(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    membershipId: string,
    input: OrganizationMembershipUpdateInput,
  ) {
    return await boundedMutation(async () => {
      const values = prepareMembershipUpdate(input);
      const { target } = await this.membershipForChange(
        client,
        actor,
        resourceOrganizationId,
        membershipId,
        "organizationMemberships.update",
      );
      const nextRole = values.role === undefined ? target.role : values.role;
      const nextStatus = values.status ?? target.status;
      if (
        target.role === OrganizationRole.Admin &&
        target.status === MembershipStatus.Active &&
        (nextRole !== OrganizationRole.Admin ||
          nextStatus !== MembershipStatus.Active)
      ) {
        await assertAnotherAdminRemains(
          client,
          actor.organizationId,
          target.id,
        );
      }
      if (nextRole === target.role && nextStatus === target.status) {
        return membership(target);
      }
      const result = await client.query<MembershipRow>(
        `update bakery.organization_memberships as membership
        set role = $3, status = $4,
          custom_role_id = case when $3::text = membership.role
            then membership.custom_role_id else null end,
          updated_at = current_timestamp,
          version = membership.version + 1
        where membership.organization_id = $1
          and membership.id = $2
        returning membership.id,
          membership.organization_id as "organizationId",
          membership.principal_id as "principalId", membership.role,
          membership.status, membership.joined_at as "joinedAt",
          membership.created_at as "createdAt",
          membership.updated_at as "updatedAt", membership.version,
          membership.created_at as "cursorCreatedAt"`,
        [actor.organizationId, membershipId, nextRole, nextStatus],
      );
      if (result.rows.length !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      return membership(result.rows[0]);
    });
  }

  async deleteMembership(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    membershipId: string,
  ): Promise<{ permissionGrantsRemoved: number; bindingsRemoved: number }> {
    return await boundedMutation(async () => {
      const { target } = await this.membershipForChange(
        client,
        actor,
        resourceOrganizationId,
        membershipId,
        "organizationMemberships.delete",
      );
      if (
        target.role === OrganizationRole.Admin &&
        target.status === MembershipStatus.Active
      ) {
        await assertAnotherAdminRemains(
          client,
          actor.organizationId,
          target.id,
        );
      }

      const grants = await client.query(
        `delete from bakery.permission_grants
        where organization_id = $1 and principal_id = $2`,
        [actor.organizationId, target.principalId],
      );
      // Resource bindings die with the membership, so re-adding the person
      // later cannot silently restore the old narrower access.
      const bindings = await client.query(
        `delete from bakery.access_bindings
        where organization_id = $1 and principal_id = $2`,
        [actor.organizationId, target.principalId],
      );
      const result = await client.query(
        `delete from bakery.organization_memberships
        where organization_id = $1 and id = $2`,
        [actor.organizationId, membershipId],
      );
      if (result.rowCount !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      return {
        permissionGrantsRemoved: grants.rowCount ?? 0,
        bindingsRemoved: bindings.rowCount ?? 0,
      };
    });
  }

  async createInvitation(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    input: OrganizationInvitationCreateInput,
  ) {
    return await boundedMutation(async () => {
      const values = prepareInvitationCreate(input, this.now());
      await this.lockOrganizationAndCallerAuthority(
        client,
        actor,
        resourceOrganizationId,
        "organizationInvitations.create",
      );
      const maySupersede = actor.role === OrganizationRole.Admin ||
        actor.capabilities.includes("organizationInvitations.cancel");
      if (maySupersede) {
        await client.query(
          `update bakery.organization_invitations
          set status = 'canceled', updated_at = current_timestamp,
            version = version + 1
          where organization_id = $1
            and email = $2
            and status = 'pending'
            and expires_at <= current_timestamp`,
          [actor.organizationId, values.email],
        );
      }
      const conflict = await client.query(
        `select 1
        from bakery.organization_invitations
        where organization_id = $1
          and lower(email) = $2
          and status = 'pending'
          and expires_at > current_timestamp
        union all
        select 1
        from bakery.organization_memberships as membership
        join bakery.principals as principal
          on principal.id = membership.principal_id
        join public."user" as provider_user
          on provider_user.id = principal.provider_user_id
        where membership.organization_id = $1
          and lower(btrim(provider_user.email)) = $2
        limit 1`,
        [actor.organizationId, values.email],
      );
      if (conflict.rows.length) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const result = await client.query<InvitationRow>(
        `insert into bakery.organization_invitations (
          id, organization_id, email, role, status, expires_at,
          inviter_principal_id, inviter_membership_id, created_at,
          updated_at, version
        ) values (
          $1, $2, $3, $4, 'pending', $5, $6,
          (select id from bakery.organization_memberships
           where organization_id = $2 and principal_id = $6),
          $7, $7, 1
        )
        returning id, organization_id as "organizationId", email, role,
          status, expires_at as "expiresAt", inviter_principal_id as
          "inviterPrincipalId", created_at as "createdAt",
          created_at as "cursorCreatedAt"`,
        [
          crypto.randomUUID(),
          actor.organizationId,
          values.email,
          values.role,
          values.expiresAt,
          actor.subject.principalId,
          this.now(),
        ],
      );
      return invitation(result.rows[0]);
    });
  }

  async cancelInvitation(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    invitationId: string,
    expectedVersion?: number,
  ): Promise<null> {
    return await boundedMutation(async () => {
      await this.lockOrganizationAndCallerAuthority(
        client,
        actor,
        resourceOrganizationId,
        "organizationInvitations.cancel",
      );
      const current = await client.query<{ status: string; version: number }>(
        `select status, version
        from bakery.organization_invitations
        where organization_id = $1 and id = $2
        for update`,
        [actor.organizationId, invitationId],
      );
      if (current.rows.length !== 1) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      if (
        expectedVersion !== undefined &&
        current.rows[0].version !== expectedVersion
      ) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      if (current.rows[0].status !== "pending") {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const result = await client.query(
        `update bakery.organization_invitations
        set status = 'canceled', updated_at = current_timestamp,
          version = version + 1
        where organization_id = $1 and id = $2 and status = 'pending'`,
        [actor.organizationId, invitationId],
      );
      if (result.rowCount !== 1) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      return null;
    });
  }

  async getRecipientInvitation(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationInvitationRecipientGetInput,
  ) {
    if (subject.principalType !== PrincipalType.Human) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const result = await client.query<OrganizationInvitationRecipientRow>(
      `select invitation.id,
        invitation.email, invitation.role,
        invitation.organization_id as "organizationId",
        inviter.provider_user_id as "inviterId",
        invitation.status,
        invitation.expires_at as "expiresAt",
        organization.name as "organizationName",
        organization.slug as "organizationSlug",
        inviter_user.email as "inviterEmail"
      from bakery.organization_invitations as invitation
      join bakery.organizations as organization
        on organization.id = invitation.organization_id
      join bakery.principals as recipient
        on recipient.id = $1
        and recipient.principal_type = $3
        and recipient.disabled_at is null
      join public."user" as recipient_user
        on recipient_user.id = recipient.provider_user_id
      left join bakery.principals as inviter
        on inviter.id = invitation.inviter_principal_id
      left join public."user" as inviter_user
        on inviter_user.id = inviter.provider_user_id
      where invitation.id = $2
        and invitation.status = 'pending'
        and invitation.expires_at > current_timestamp
        and invitation.email = lower(btrim(recipient_user.email))`,
      [subject.principalId, input.id, PrincipalType.Human],
    );
    if (result.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return recipientInvitation(result.rows[0]);
  }

  /**
   * Anonymous preview for the invitation link. Resolves only a pending,
   * unexpired invitation; expired, canceled, accepted, rejected and unknown
   * identifiers are indistinguishable (`RESOURCE_NOT_FOUND`) so the public
   * route cannot be used to enumerate invitation history, and the projection
   * carries no organization or inviter identifier.
   */
  async previewInvitation(
    client: PgTransactionClient,
    input: OrganizationInvitationPreviewGetInput,
  ) {
    const result = await client.query<OrganizationInvitationPreviewRow>(
      `select invitation.id as "invitationId",
        organization.name as "organizationName",
        inviter.display_name as "inviterDisplayName",
        invitation.role,
        invitation.email,
        invitation.expires_at as "expiresAt"
      from bakery.organization_invitations as invitation
      join bakery.organizations as organization
        on organization.id = invitation.organization_id
      left join bakery.principals as inviter
        on inviter.id = invitation.inviter_principal_id
      where invitation.id = $1
        and invitation.status = 'pending'
        and invitation.expires_at > current_timestamp`,
      [input.invitationId],
    );
    if (result.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return invitationPreview(result.rows[0]);
  }

  private async transitionRecipientInvitation(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationInvitationRecipientActionInput,
    nextStatus: "accepted" | "rejected",
  ) {
    if (subject.principalType !== PrincipalType.Human) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const candidate = await client.query<{ organizationId: string }>(
      `select invitation.organization_id as "organizationId"
      from bakery.organization_invitations as invitation
      join bakery.principals as recipient
        on recipient.id = $2
        and recipient.principal_type = $3
        and recipient.disabled_at is null
      join public."user" as recipient_user
        on recipient_user.id = recipient.provider_user_id
      where invitation.id = $1
        and invitation.email = lower(btrim(recipient_user.email))`,
      [input.invitationId, subject.principalId, PrincipalType.Human],
    );
    if (candidate.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const organizationId = candidate.rows[0].organizationId;
    await client.query(
      `select pg_advisory_xact_lock(
        hashtextextended('bakery:organization:' || $1::text, 0)
      )`,
      [organizationId],
    );
    const recipient = await client.query<RecipientPrincipalRow>(
      `select principal.id,
        principal.provider_user_id as "providerUserId",
        principal.principal_type as "principalType",
        principal.disabled_at as "disabledAt",
        lower(btrim(provider_user.email)) as email
      from bakery.principals as principal
      join public."user" as provider_user
        on provider_user.id = principal.provider_user_id
      where principal.id = $1
        and principal.principal_type = $2
      for update of principal`,
      [subject.principalId, PrincipalType.Human],
    );
    if (
      recipient.rows.length !== 1 ||
      recipient.rows[0].disabledAt !== null ||
      !recipient.rows[0].providerUserId
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const invitation = await client.query<InvitationTransitionRow>(
      `select invitation.id,
        invitation.organization_id as "organizationId",
        invitation.email, invitation.role, invitation.status,
        invitation.expires_at as "expiresAt",
        inviter.provider_user_id as "inviterId",
        invitation.created_at as "createdAt",
        invitation.created_at as "cursorCreatedAt"
      from bakery.organization_invitations as invitation
      left join bakery.principals as inviter
        on inviter.id = invitation.inviter_principal_id
      where invitation.id = $1
        and invitation.organization_id = $2
        and invitation.email = $3
        and invitation.status = 'pending'
        and invitation.expires_at > current_timestamp
      for update of invitation`,
      [input.invitationId, organizationId, recipient.rows[0].email],
    );
    if (invitation.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const invitedRole = invitation.rows[0].role;
    if (!invitedRole || !isOrganizationRole(invitedRole)) {
      throw new Error("AUTH_READ_INVITATION_INVALID");
    }
    let member: {
      id: string;
      organizationId: string;
      userId: string;
      role: OrganizationRole;
      createdAt: string;
    } | null = null;
    if (nextStatus === "accepted") {
      const existing = await client.query(
        `select id
        from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2
        for update`,
        [organizationId, subject.principalId],
      );
      if (existing.rows.length !== 0) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const createdAt = this.now();
      const created = await client.query<{ id: string }>(
        `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status,
          joined_at, created_at, updated_at, version
        ) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)
        returning id`,
        [
          crypto.randomUUID(),
          organizationId,
          subject.principalId,
          invitedRole,
          createdAt,
        ],
      );
      member = {
        id: created.rows[0].id,
        organizationId,
        userId: recipient.rows[0].providerUserId,
        role: invitedRole,
        createdAt: timestamp(createdAt),
      };
    }
    const transitioned = await client.query<InvitationTransitionRow>(
      `update bakery.organization_invitations as invitation
      set status = $3, updated_at = current_timestamp,
        version = invitation.version + 1
      where invitation.id = $1
        and invitation.organization_id = $2
        and invitation.status = 'pending'
      returning invitation.id,
        invitation.organization_id as "organizationId",
        invitation.email, invitation.role, invitation.status,
        invitation.expires_at as "expiresAt",
        (select inviter.provider_user_id
         from bakery.principals as inviter
         where inviter.id = invitation.inviter_principal_id) as "inviterId",
        invitation.created_at as "createdAt",
        invitation.created_at as "cursorCreatedAt"`,
      [input.invitationId, organizationId, nextStatus],
    );
    if (transitioned.rows.length !== 1) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const row = transitioned.rows[0];
    if (!isOrganizationRole(row.role) || !isInvitationStatus(row.status)) {
      throw new Error("AUTH_READ_INVITATION_INVALID");
    }
    return {
      invitation: {
        id: row.id,
        organizationId: row.organizationId,
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: timestamp(row.expiresAt),
        inviterId: row.inviterId,
        createdAt: timestamp(row.createdAt),
      },
      member,
    };
  }

  async acceptRecipientInvitation(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationInvitationRecipientActionInput,
  ) {
    return await boundedMutation(() =>
      this.transitionRecipientInvitation(client, subject, input, "accepted")
    );
  }

  async rejectRecipientInvitation(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationInvitationRecipientActionInput,
  ) {
    return await boundedMutation(() =>
      this.transitionRecipientInvitation(client, subject, input, "rejected")
    );
  }

  async listOrganizations(
    client: PgTransactionClient,
    subject: AuthenticatedSubject,
    input: OrganizationCursorQuery,
  ) {
    const cursorBinding = binding("organizations.list", subject);
    const position = await decodeCursor(
      this.secret,
      input.cursor,
      cursorBinding,
    );
    const limit = input.limit ?? 25;
    const result = await client.query<OrganizationAccessRow>(
      `select organization.id, organization.name, organization.slug,
        organization.logo, organization.metadata,
        organization.default_locale as "defaultLocale",
        organization.created_at as "createdAt",
        organization.updated_at as "updatedAt", organization.version,
        membership.role,
        to_char(
          organization.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "cursorCreatedAt"
      from bakery.organizations as organization
      join bakery.principals as principal
        on principal.id = $1
      left join bakery.organization_memberships as membership
        on membership.organization_id = organization.id
        and membership.principal_id = principal.id
      where principal.id = $1
        and principal.disabled_at is null
        and (
          (
            membership.status = 'active'
            and (
              membership.role is not null
              or (
                principal.principal_type in ('service', 'worker')
                and exists (
                  select 1
                  from bakery.permission_grants as grant_record
                  where grant_record.organization_id = organization.id
                    and grant_record.principal_id = principal.id
                    and grant_record.capability = 'organizations.list'
                    and grant_record.policy_revision = 1
                    and grant_record.revoked_at is null
                    and (
                      grant_record.expires_at is null
                      or grant_record.expires_at > current_timestamp
                    )
                )
              )
            )
          )
          or (
            principal.principal_type in ('service', 'worker')
            and membership.id is null
            and exists (
              select 1
              from bakery.permission_grants as grant_record
              where grant_record.organization_id = organization.id
                and grant_record.principal_id = principal.id
                and grant_record.capability = 'organizations.list'
                and grant_record.policy_revision = 1
                and grant_record.revoked_at is null
                and (
                  grant_record.expires_at is null
                  or grant_record.expires_at > current_timestamp
                )
            )
          )
        )
        and (
          $2::timestamptz is null or
          (organization.created_at, organization.id) >
            ($2::timestamptz, $3::uuid)
        )
      order by organization.created_at, organization.id
      limit $4`,
      [
        subject.principalId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return await page(
      this.secret,
      cursorBinding,
      result.rows,
      limit,
      (row) => {
        if (row.role !== null && !isOrganizationRole(row.role)) {
          throw new Error("AUTH_READ_MEMBERSHIP_ROLE_INVALID");
        }
        return { ...organization(row), role: row.role };
      },
    );
  }

  async getOrganization(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
  ) {
    const result = await client.query<OrganizationRow>(
      `select organization.id, organization.name, organization.slug,
        organization.logo, organization.metadata,
        organization.default_locale as "defaultLocale",
        organization.created_at as "createdAt",
        organization.updated_at as "updatedAt", organization.version,
        organization.created_at as "cursorCreatedAt"
      from bakery.organizations as organization
      where organization.id = $1
        and organization.id = $2`,
      [actor.organizationId, resourceOrganizationId],
    );
    if (result.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return organization(result.rows[0]);
  }

  effectiveAccess(
    actor: OrganizationActor,
    resourceOrganizationId: string,
  ) {
    if (actor.organizationId !== resourceOrganizationId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return {
      organizationId: actor.organizationId,
      role: actor.role ?? null,
      capabilities: organizationPermissions(actor),
    };
  }

  async listMemberships(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    input: OrganizationCursorQuery,
  ) {
    const cursorBinding = binding(
      "organizationMemberships.list",
      actor.subject,
      actor.organizationId,
    );
    const position = await decodeCursor(
      this.secret,
      input.cursor,
      cursorBinding,
    );
    const limit = input.limit ?? 25;
    const result = await client.query<MembershipRow>(
      `select membership.id,
        membership.organization_id as "organizationId",
        principal.id as "principalId", membership.role, membership.status,
        membership.joined_at as "joinedAt",
        membership.created_at as "createdAt",
        membership.updated_at as "updatedAt", membership.version,
        to_char(
          membership.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "cursorCreatedAt"
      from bakery.organization_memberships as membership
      join bakery.principals as principal
        on principal.id = membership.principal_id
      where membership.organization_id = $1
        and membership.organization_id = $2
        and (
          $3::timestamptz is null or
          (membership.created_at, membership.id) >
            ($3::timestamptz, $4::uuid)
        )
      order by membership.created_at, membership.id
      limit $5`,
      [
        actor.organizationId,
        resourceOrganizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const rows = result.rows.filter((row) =>
      row.organizationId === actor.organizationId &&
      row.organizationId === resourceOrganizationId
    );
    return await page(
      this.secret,
      cursorBinding,
      rows,
      limit,
      membership,
    );
  }

  async listInvitations(
    client: PgTransactionClient,
    actor: OrganizationActor,
    resourceOrganizationId: string,
    input: OrganizationCursorQuery,
  ) {
    const cursorBinding = binding(
      "organizationInvitations.list",
      actor.subject,
      actor.organizationId,
    );
    const position = await decodeCursor(
      this.secret,
      input.cursor,
      cursorBinding,
    );
    const limit = input.limit ?? 25;
    const result = await client.query<InvitationRow>(
      `select invitation.id,
        invitation.organization_id as "organizationId", invitation.email,
        invitation.role, invitation.status,
        invitation.expires_at as "expiresAt",
        principal.id as "inviterPrincipalId",
        invitation.created_at as "createdAt",
        to_char(
          invitation.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "cursorCreatedAt"
      from bakery.organization_invitations as invitation
      left join bakery.principals as principal
        on principal.id = invitation.inviter_principal_id
      where invitation.organization_id = $1
        and invitation.organization_id = $2
        and (
          $3::timestamptz is null or
          (invitation.created_at, invitation.id) >
            ($3::timestamptz, $4::uuid)
        )
      order by invitation.created_at, invitation.id
      limit $5`,
      [
        actor.organizationId,
        resourceOrganizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const rows = result.rows.filter((row) =>
      row.organizationId === actor.organizationId &&
      row.organizationId === resourceOrganizationId
    );
    return await page(
      this.secret,
      cursorBinding,
      rows,
      limit,
      invitation,
    );
  }
}
