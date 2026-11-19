import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Organization groups (chapter 25 section 19, issue #458).
 *
 * A group is a named set of members a workflow or a person can ask by one name,
 * where any one member can answer. It is an audience, never a grant: members
 * keep only the access they already have. Only an organization Admin changes
 * groups (the registry's access policy); any member reads them.
 *
 * The shape of the handle and the length limits are owned here, not by CHECK
 * constraints. A person whose membership is no longer active stops being
 * listed (and counted) without their row being removed, so reactivating them
 * restores their place. The handle is fixed at creation: the application role has no
 * UPDATE on `mention_name` (migration 0243), so renaming it is impossible even
 * from a bug.
 */

export const GROUP_NAME_MAX = 80;
export const GROUP_PURPOSE_MAX = 140;
export const GROUP_MENTION_MIN = 2;
export const GROUP_MENTION_MAX = 40;
/** A group is for a team, not the whole directory. */
export const GROUP_MEMBERS_MAX = 200;

const MENTION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Handles Bakery makes from roles. A group may not take one, so asking
 * `@admins` always means everyone holding the Admin role at that moment.
 */
const SYSTEM_ROLE_HANDLES: readonly {
  roleKey: string;
  name: string;
  mentionName: string;
}[] = [
  { roleKey: "admin", name: "Administrators", mentionName: "admins" },
  { roleKey: "developer", name: "Developers", mentionName: "developers" },
];
/** Roles that cannot decide still reserve their plural so it is never ambiguous. */
const RESERVED_ONLY = ["viewers", "guests"];

type GroupRow = {
  id: string;
  name: string;
  mention_name: string;
  purpose: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};
type MemberRow = {
  group_id: string;
  principal_id: string;
  display_name: string;
};

const GROUP_COLUMNS =
  "id, name, mention_name, purpose, created_at, updated_at, version";

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function unprocessable(path: string[], code: string, message: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path, code, message }] },
  });
}

function conflict(reason: string, existingResourceId?: string): never {
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: {
      reason,
      ...(existingResourceId === undefined ? {} : { existingResourceId }),
    },
  });
}

/**
 * A concurrent create or rename that passed the pre-check loses at the unique
 * index. That is the same answer as the pre-check gives, not a server error.
 */
function conflictFromUniqueViolation(error: unknown): never {
  const failure = error as { code?: string; constraint?: string };
  if (failure.code === "23505") {
    conflict(
      failure.constraint?.includes("mention")
        ? "group_mention_taken"
        : "group_name_taken",
    );
  }
  throw error;
}

function toGroup(row: GroupRow, members: readonly MemberRow[]) {
  const mine = members
    .filter((member) => member.group_id === row.id)
    .map((member) => ({
      principalId: member.principal_id,
      displayName: member.display_name,
    }));
  return {
    id: row.id,
    name: row.name,
    mentionName: row.mention_name,
    purpose: row.purpose,
    members: mine,
    memberCount: mine.length,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

async function membersOf(
  transaction: PgTransactionClient,
  organizationId: string,
  groupIds: readonly string[],
): Promise<MemberRow[]> {
  if (groupIds.length === 0) return [];
  const found = await transaction.query<MemberRow>(
    `select member.group_id, member.principal_id, principal.display_name
       from bakery.organization_group_members as member
       join bakery.principals as principal on principal.id = member.principal_id
       join bakery.organization_memberships as membership
         on membership.organization_id = member.organization_id
        and membership.principal_id = member.principal_id
        and membership.status = 'active'
      where member.organization_id = $1 and member.group_id = any($2::uuid[])
      order by lower(principal.display_name), member.principal_id`,
    [organizationId, [...groupIds]],
  );
  return found.rows;
}

/** Everyone asked must be an active human member of this organization. */
async function assertActiveMembers(
  transaction: PgTransactionClient,
  organizationId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return [];
  const found = await transaction.query<{ id: string }>(
    `select principal.id
       from bakery.principals as principal
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
      where membership.organization_id = $1 and membership.status = 'active'
        and principal.principal_type = 'human'
        and principal.disabled_at is null
        and principal.id = any($2::uuid[])`,
    [organizationId, unique],
  );
  if (found.rows.length !== unique.length) {
    // One answer for an unknown, foreign, disabled or non-human id, so the
    // refusal does not say which one it was.
    unprocessable(
      ["memberIds"],
      "group_member_not_found",
      "Every member must be an active member of this organization",
    );
  }
  return unique;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > GROUP_NAME_MAX) {
    unprocessable(
      ["name"],
      "group_name_invalid",
      `Name must be 1 to ${GROUP_NAME_MAX} characters`,
    );
  }
  return trimmed;
}

function validatePurpose(purpose: string | null | undefined): string | null {
  if (purpose === undefined || purpose === null) return null;
  const trimmed = purpose.trim();
  if (trimmed.length > GROUP_PURPOSE_MAX) {
    unprocessable(
      ["purpose"],
      "group_purpose_too_long",
      `Purpose must be at most ${GROUP_PURPOSE_MAX} characters`,
    );
  }
  return trimmed === "" ? null : trimmed;
}

async function assertHandleFree(
  transaction: PgTransactionClient,
  organizationId: string,
  mentionName: string,
): Promise<void> {
  if (
    SYSTEM_ROLE_HANDLES.some((role) => role.mentionName === mentionName) ||
    RESERVED_ONLY.includes(mentionName)
  ) {
    conflict("group_mention_reserved");
  }
  const customRole = await transaction.query(
    `select 1 from bakery.organization_roles
      where organization_id = $1 and key = $2`,
    [organizationId, mentionName],
  );
  if (customRole.rows.length > 0) conflict("group_mention_reserved");
}

async function appendFacts(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    operation: string;
    eventType: string;
    groupId: string;
    version: number;
    details: Record<string, unknown>;
  }>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: facts.operation,
    resourceType: "organization_group",
    resourceId: facts.groupId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: facts.details,
  });
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    eventType: facts.eventType,
    aggregateId: facts.groupId,
    aggregateVersion: facts.version,
    payload: { resourceId: facts.groupId, resourceVersion: facts.version },
    traceId: context.traceId,
  });
}

/** Groups the organization made, and the read-only groups made from roles. */
export async function listGroups(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const rows = await transaction.query<GroupRow>(
    `select ${GROUP_COLUMNS} from bakery.organization_groups
      where organization_id = $1 order by lower(name), id`,
    [organizationId],
  );
  const members = await membersOf(
    transaction,
    organizationId,
    rows.rows.map((row) => row.id),
  );
  const holders = (roleSql: string, params: unknown[]) =>
    transaction.query<{ n: string }>(
      `select count(distinct principal.id)::text as n
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
        where membership.organization_id = $1 and membership.status = 'active'
          and principal.principal_type = 'human'
          and principal.disabled_at is null and ${roleSql}`,
      [organizationId, ...params],
    );
  const fromRoles: {
    roleKey: string;
    name: string;
    mentionName: string;
    kind: "system" | "custom";
    memberCount: number;
  }[] = [];
  for (const role of SYSTEM_ROLE_HANDLES) {
    const held = await holders(
      "membership.role = $2 and membership.custom_role_id is null",
      [role.roleKey],
    );
    fromRoles.push({
      ...role,
      kind: "system",
      memberCount: Number(held.rows[0]?.n ?? 0),
    });
  }
  const custom = await transaction.query<
    { id: string; key: string; name: string }
  >(
    `select id, key, name from bakery.organization_roles
      where organization_id = $1 order by lower(name), id`,
    [organizationId],
  );
  for (const role of custom.rows) {
    const held = await holders("membership.custom_role_id = $2", [role.id]);
    fromRoles.push({
      roleKey: role.key,
      name: role.name,
      mentionName: role.key,
      kind: "custom",
      memberCount: Number(held.rows[0]?.n ?? 0),
    });
  }
  return {
    groups: rows.rows.map((row) => toGroup(row, members)),
    fromRoles,
  };
}

export async function createGroup(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as {
    name: string;
    mentionName: string;
    purpose?: string | null;
    memberIds?: string[];
  };
  const name = validateName(value.name);
  const mentionName = value.mentionName;
  if (
    mentionName.length < GROUP_MENTION_MIN ||
    mentionName.length > GROUP_MENTION_MAX ||
    !MENTION_PATTERN.test(mentionName)
  ) {
    unprocessable(
      ["mentionName"],
      "group_mention_invalid",
      "Mention name is lowercase letters, digits and single hyphens",
    );
  }
  const purpose = validatePurpose(value.purpose);
  const memberIds = await assertActiveMembers(
    transaction,
    organizationId,
    value.memberIds ?? [],
  );
  await assertHandleFree(transaction, organizationId, mentionName);

  const taken = await transaction.query<{ id: string; mention_name: string }>(
    `select id, mention_name from bakery.organization_groups
      where organization_id = $1
        and (mention_name = $2 or lower(name) = lower($3))`,
    [organizationId, mentionName, name],
  );
  if (taken.rows[0]) {
    conflict(
      taken.rows[0].mention_name === mentionName
        ? "group_mention_taken"
        : "group_name_taken",
      taken.rows[0].id,
    );
  }
  const created = (await transaction.query<GroupRow>(
    `insert into bakery.organization_groups
       (organization_id, name, mention_name, purpose, created_by)
     values ($1, $2, $3, $4, $5)
     returning ${GROUP_COLUMNS}`,
    [organizationId, name, mentionName, purpose, principalId],
  ).catch(conflictFromUniqueViolation)).rows[0];
  if (!created) throw new Error("GROUP_INSERT_FAILED");
  for (const memberId of memberIds) {
    await transaction.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id) values ($1, $2, $3)`,
      [organizationId, created.id, memberId],
    );
  }
  await appendFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "groups.create",
    eventType: "organizationGroup.created",
    groupId: created.id,
    version: created.version,
    details: { mentionName, memberCount: memberIds.length },
  });
  return toGroup(
    created,
    await membersOf(transaction, organizationId, [created.id]),
  );
}

export async function updateGroup(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const groupId = context.params.id;
  if (!groupId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const value = input as {
    name?: string;
    purpose?: string | null;
    memberIds?: string[];
  };
  const current = (await transaction.query<GroupRow>(
    `select ${GROUP_COLUMNS} from bakery.organization_groups
      where organization_id = $1 and id = $2 for update`,
    [organizationId, groupId],
  )).rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const name = value.name === undefined
    ? current.name
    : validateName(value.name);
  const purpose = value.purpose === undefined
    ? current.purpose
    : validatePurpose(value.purpose);
  const memberIds = value.memberIds === undefined
    ? undefined
    : await assertActiveMembers(transaction, organizationId, value.memberIds);
  if (name.toLowerCase() !== current.name.toLowerCase()) {
    const taken = await transaction.query<{ id: string }>(
      `select id from bakery.organization_groups
        where organization_id = $1 and lower(name) = lower($2) and id <> $3`,
      [organizationId, name, groupId],
    );
    if (taken.rows[0]) conflict("group_name_taken", taken.rows[0].id);
  }
  const updated = (await transaction.query<GroupRow>(
    `update bakery.organization_groups
        set name = $3, purpose = $4, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning ${GROUP_COLUMNS}`,
    [organizationId, groupId, name, purpose],
  ).catch(conflictFromUniqueViolation)).rows[0];
  if (!updated) throw new Error("GROUP_UPDATE_FAILED");
  if (memberIds !== undefined) {
    await transaction.query(
      `delete from bakery.organization_group_members
        where organization_id = $1 and group_id = $2
          and not (principal_id = any($3::uuid[]))`,
      [organizationId, groupId, memberIds],
    );
    for (const memberId of memberIds) {
      await transaction.query(
        `insert into bakery.organization_group_members
           (organization_id, group_id, principal_id) values ($1, $2, $3)
         on conflict do nothing`,
        [organizationId, groupId, memberId],
      );
    }
  }
  const members = await membersOf(transaction, organizationId, [groupId]);
  await appendFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "groups.update",
    eventType: "organizationGroup.updated",
    groupId,
    version: updated.version,
    details: { mentionName: updated.mention_name, memberCount: members.length },
  });
  return toGroup(updated, members);
}

export async function deleteGroup(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const groupId = context.params.id;
  if (!groupId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // One compare-and-delete: the application role has no UPDATE on a deleted
  // row's handle, and a stale version deletes nothing.
  const removed = (await transaction.query<GroupRow>(
    `delete from bakery.organization_groups
      where organization_id = $1 and id = $2 and version = $3
      returning ${GROUP_COLUMNS}`,
    [organizationId, groupId, expectedVersion],
  )).rows[0];
  if (!removed) {
    const exists = await transaction.query(
      `select 1 from bakery.organization_groups
        where organization_id = $1 and id = $2`,
      [organizationId, groupId],
    );
    throw new StandardError({
      code: exists.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await appendFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "groups.delete",
    eventType: "organizationGroup.deleted",
    groupId,
    version: removed.version + 1,
    details: { mentionName: removed.mention_name },
  });
  return null;
}
