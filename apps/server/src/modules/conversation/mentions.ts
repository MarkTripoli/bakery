import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type CatalogPermissionKey,
  contractSchemas,
  MembershipStatus,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import {
  authorize,
  organizationMemberRoleSql,
} from "../auth/application/authorize.ts";
import { scopeAllows } from "../auth/application/scopes.ts";
import { signalInboxChanged } from "../work/notification-signal.ts";

/** The most people one message or comment may mention. */
export const MAX_MENTIONS = 20;

/** Permissions that together mean "can already read and reply here". */
const CONVERSATION_REPLY: readonly CatalogPermissionKey[] = [
  "message:read",
  "message:write",
];
/** Reading an artifact's comment thread. */
const COMMENT_READ: readonly CatalogPermissionKey[] = ["artifactComment:read"];
/** The writer's own authority to widen a conversation to someone new. */
const SHARE: CatalogPermissionKey = "conversation:share";

/** Why one mention was refused, as the issue code the client localizes. */
export const MentionRefusal = Object.freeze(
  {
    /** Not an active human member of this organization. */
    NotMember: "mention_not_member",
    /** Has no access, and the writer may not give it. */
    ShareForbidden: "mention_share_forbidden",
    /** Cannot read this comment thread; a comment never widens access. */
    NoThreadAccess: "mention_no_thread_access",
  } as const,
);
type MentionRefusalCode = (typeof MentionRefusal)[keyof typeof MentionRefusal];

/** One organization member as the mention rules see them. */
export type MemberRow = {
  principalId: string;
  displayName: string;
  role: string | null;
  customRoleId: string | null;
  customPermissions: string[] | null;
  granted: boolean;
  /** A live direct grant on the document this comment thread belongs to. */
  artifactGranted?: boolean;
};

/** What a mention would do for one person, from current state. */
export type MentionAccess = {
  principalId: string;
  displayName: string;
  hasAccess: boolean;
  gainsAccessOnSend: boolean;
};

export type MentionScope =
  | { kind: "conversation"; conversationId: string }
  | {
    kind: "comment_thread";
    conversationId: string | null;
    /** The document the thread is on; a live grant on it counts as access. */
    artifactId: string;
    /**
     * Sent by the writer to give a mentioned person who cannot read the
     * document that level of access with the comment; omitted, such a mention
     * is refused.
     */
    accessLevel?: "read_comment" | "edit";
  };

function actorOf(context: ActionContext): OrganizationActor {
  const authority = (context as Partial<AuthorizedActionContext>).authority;
  if (!authority || !("organizationId" in authority)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return authority as OrganizationActor;
}

/**
 * True when a member's organization role (system or custom) holds every
 * permission. Capabilities are deliberately ignored: an exact action grant is
 * not a person's standing access to a conversation.
 */
export function memberHolds(
  row: Pick<MemberRow, "role" | "customRoleId" | "customPermissions">,
  permissions: readonly CatalogPermissionKey[],
): boolean {
  if (row.role === null) return false;
  const principal = {
    subject: { principalType: PrincipalType.Human },
    role: row.role as OrganizationActor["role"],
    ...(row.customRoleId === null ? {} : {
      customRole: {
        id: row.customRoleId,
        key: row.customRoleId,
        permissions: (row.customPermissions ?? []) as CatalogPermissionKey[],
      },
    }),
    capabilities: [],
  };
  try {
    for (const permission of permissions) authorize(principal, permission);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the acting writer may give someone new access to a conversation:
 * a person (never a service or agent principal, chapter 25 O55), acting on
 * their own organization role rather than a mention grant (a mention-only
 * recipient cannot reshare), whose role holds conversation:share, through a
 * token that carries that scope when one is used.
 */
export function writerMayShare(actor: OrganizationActor): boolean {
  if (actor.subject.principalType !== PrincipalType.Human) return false;
  if (actor.conversationGrant !== undefined) return false;
  if (
    actor.tokenScopes !== undefined && !scopeAllows(SHARE, actor.tokenScopes)
  ) return false;
  return memberHolds({
    role: actor.role ?? null,
    customRoleId: actor.customRole?.id ?? null,
    customPermissions: actor.customRole
      ? [...actor.customRole.permissions]
      : [],
  }, [SHARE]);
}

/**
 * Whether the acting writer may give someone new access to a document: a
 * person acting on their own organization role (never a document grant, which
 * cannot reshare, and never a service or agent), whose role holds
 * artifact:share, through a token that carries that scope when one is used.
 */
export function writerMayShareArtifact(actor: OrganizationActor): boolean {
  if (actor.subject.principalType !== PrincipalType.Human) return false;
  if (
    actor.conversationGrant !== undefined || actor.artifactGrant !== undefined
  ) return false;
  if (
    actor.tokenScopes !== undefined &&
    !scopeAllows("artifact:share", actor.tokenScopes)
  ) return false;
  return memberHolds({
    role: actor.role ?? null,
    customRoleId: actor.customRole?.id ?? null,
    customPermissions: actor.customRole
      ? [...actor.customRole.permissions]
      : [],
  }, ["artifact:share"]);
}

/**
 * Active human members who can be mentioned at all: enabled account, active
 * membership, a system role other than a bare guest. Disabled, removed and
 * invited-but-not-joined people are not members here and never match.
 */
export const ELIGIBLE_MEMBER_SQL = `
  from bakery.organization_memberships as membership
  join bakery.principals as principal on principal.id = membership.principal_id
  left join public."user" as account on account.id = principal.provider_user_id
  left join bakery.organization_roles as custom
    on custom.organization_id = membership.organization_id
   and custom.id = membership.custom_role_id
  where membership.organization_id = $1::uuid
    and membership.status = '${MembershipStatus.Active}'
    and ${organizationMemberRoleSql("membership")}
    and principal.principal_type = '${PrincipalType.Human}'
    and principal.disabled_at is null`;

/** The member columns, with the document grant read from parameter `artifactParam`. */
function memberColumns(artifactParam: number | null): string {
  const grant = artifactParam === null ? "false" : `exists (
    select 1 from bakery.artifact_access_grants as artifact_grant
    where artifact_grant.organization_id = membership.organization_id
      and artifact_grant.artifact_id = $${artifactParam}::uuid
      and artifact_grant.principal_id = principal.id
      and artifact_grant.revoked_at is null
  )`;
  return `${MEMBER_COLUMNS},\n  ${grant} as "artifactGranted"`;
}

const MEMBER_COLUMNS = `principal.id as "principalId",
  principal.display_name as "displayName", membership.role,
  membership.custom_role_id as "customRoleId",
  custom.permissions as "customPermissions",
  ($2::uuid is not null and exists (
    select 1 from bakery.conversation_access_grants as grant_row
    where grant_row.organization_id = membership.organization_id
      and grant_row.conversation_id = $2::uuid
      and grant_row.principal_id = principal.id
      and grant_row.revoked_at is null
  )) as granted`;

function accessFor(
  row: MemberRow,
  scope: MentionScope,
  mayShare: boolean,
): MentionAccess {
  if (scope.kind === "comment_thread") {
    const hasAccess = row.artifactGranted === true ||
      memberHolds(row, COMMENT_READ);
    return {
      principalId: row.principalId,
      displayName: row.displayName,
      hasAccess,
      gainsAccessOnSend: !hasAccess && mayShare,
    };
  }
  const hasAccess = row.granted || memberHolds(row, CONVERSATION_REPLY);
  return {
    principalId: row.principalId,
    displayName: row.displayName,
    hasAccess,
    gainsAccessOnSend: !hasAccess && mayShare,
  };
}

/**
 * Whether one member's organization role (system or custom) holds a
 * permission. Capabilities are ignored, as in memberHolds.
 */
export async function memberRoleHolds(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  permission: CatalogPermissionKey,
): Promise<boolean> {
  const result = await transaction.query<MemberRow>(
    `select principal.id as "principalId",
            principal.display_name as "displayName", membership.role,
            membership.custom_role_id as "customRoleId",
            custom.permissions as "customPermissions", false as granted
     ${ELIGIBLE_MEMBER_SQL}
       and principal.id = $2::uuid`,
    [organizationId, principalId],
  );
  const row = result.rows[0];
  return row !== undefined && memberHolds(row, [permission]);
}

/** The most people a "who can give access" answer names. */
export const MAX_SHARERS = 3;

/**
 * Up to MAX_SHARERS active human members whose organization role holds
 * `permission`, the author first when the author is one of them, then by
 * display name. People are read in pages of 100 so a large organization with
 * few sharers still finds them, and the answer never reaches outside the
 * organization. It names nobody the reader could not already see in the
 * mention picker: display names only.
 */
export async function findSharers(
  transaction: PgTransactionClient,
  organizationId: string,
  authorId: string | null,
  permission: CatalogPermissionKey,
): Promise<{ principalId: string; displayName: string }[]> {
  const found: { principalId: string; displayName: string }[] = [];
  let after: string | null = null;
  let authorChecked = authorId === null;
  while (found.length < MAX_SHARERS) {
    const result: { rows: MemberRow[] } = await transaction.query<MemberRow>(
      `select ${MEMBER_COLUMNS}
       ${ELIGIBLE_MEMBER_SQL}
         and ($3::uuid is null or principal.id = $3::uuid)
         and ($4::uuid is null or (lower(principal.display_name), principal.id) >
           (select lower(after_row.display_name), after_row.id
            from bakery.principals as after_row where after_row.id = $4::uuid))
       order by lower(principal.display_name), principal.id
       limit 100`,
      [
        organizationId,
        null,
        authorChecked ? null : authorId,
        authorChecked ? after : null,
      ],
    );
    for (const row of result.rows) {
      if (!memberHolds(row, [permission])) continue;
      if (found.some((person) => person.principalId === row.principalId)) {
        continue;
      }
      found.push({
        principalId: row.principalId,
        displayName: row.displayName,
      });
      if (found.length === MAX_SHARERS) break;
    }
    if (!authorChecked) {
      authorChecked = true;
      continue;
    }
    if (result.rows.length < 100) break;
    after = result.rows.at(-1)?.principalId ?? null;
  }
  return found;
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The shared cursor primitive carries an ordinal or a timestamp position. The
 * candidate order is by name, so its cursor carries only the last principal
 * id (position and iteration fixed at 0) and the next page restarts after
 * that person's current sort key; the binding still ties it to this action,
 * scope and query.
 */
const CANDIDATE_ORDERING = "position:asc,iteration:asc,id:asc";

/**
 * One bounded page of people the writer may mention here. The query matches
 * display name or email, but only the safe directory identity is returned.
 * Keyset ordered by lower(display_name) then id; the cursor holds only the
 * last principal id and the next page starts after that person's current
 * sort key, so it is a plain index-friendly comparison with no offset.
 */
export async function searchMentionCandidates(
  context: ActionContext,
  transaction: PgTransactionClient,
  input: {
    action: string;
    secret: string;
    scope: MentionScope;
    scopeId: string;
    query: z.output<typeof contractSchemas.MentionCandidateQuery>;
  },
) {
  const actor = actorOf(context);
  const query = (input.query.query ?? "").trim();
  const limit = input.query.limit ?? 10;
  const binding = {
    action: input.action,
    principalId: actor.subject.principalId,
    organizationId: actor.organizationId,
    ordering: CANDIDATE_ORDERING,
    filters: JSON.stringify({ scope: input.scopeId, query }),
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(input.secret, input.query.cursor, binding);
  const conversationId = input.scope.kind === "conversation"
    ? input.scope.conversationId
    : null;
  const result = await transaction.query<MemberRow>(
    `select ${memberColumns(input.scope.kind === "comment_thread" ? 7 : null)}
     ${ELIGIBLE_MEMBER_SQL}
       and ($3::text = '' or principal.display_name ilike $4 escape '\\'
         or account.email ilike $4 escape '\\')
       and ($5::uuid is null or (lower(principal.display_name), principal.id) >
         (select lower(after_row.display_name), after_row.id
          from bakery.principals as after_row where after_row.id = $5::uuid))
     order by lower(principal.display_name), principal.id
     limit $6`,
    [
      actor.organizationId,
      conversationId,
      query,
      likePattern(query),
      cursor?.id ?? null,
      limit + 1,
      ...(input.scope.kind === "comment_thread"
        ? [input.scope.artifactId]
        : []),
    ],
  );
  const mayShare = input.scope.kind === "comment_thread"
    ? writerMayShareArtifact(actor)
    : writerMayShare(actor);
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => accessFor(row, input.scope, mayShare)),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(input.secret, binding, {
        position: 0,
        iteration: 0,
        id: last.principalId,
      })
      : null,
  };
}

/** Distinct ids in first-seen order. */
function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function refuse(
  refusals: readonly { index: number; code: MentionRefusalCode }[],
): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: refusals.map(({ index, code }) => ({
        path: ["mentions", index],
        code,
        message: code.replaceAll("_", " "),
      })),
    },
  });
}

/** A validated mention set, checked against current state before any write. */
export type ResolvedMentions = {
  /** Every mentioned person, self included, in first-seen order. */
  people: MentionAccess[];
  /** People to grant access to on send. */
  toGrant: string[];
  /** Distinct non-self people to notify. */
  toNotify: string[];
};

/**
 * Checks every mention against current membership, access and the writer's
 * sharing authority. Any refusal throws UNPROCESSABLE naming each refused
 * mention by its input index, before the caller has written anything.
 */
export async function resolveMentions(
  context: ActionContext,
  transaction: PgTransactionClient,
  scope: MentionScope,
  mentions: readonly string[] | undefined,
): Promise<ResolvedMentions> {
  const ids = distinct(mentions ?? []);
  if (ids.length === 0) return { people: [], toGrant: [], toNotify: [] };
  if (ids.length > MAX_MENTIONS) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const actor = actorOf(context);
  const conversationId = scope.conversationId;
  // Lock the membership rows so a concurrent removal or role change is ordered
  // with this send instead of slipping between the check and the commit.
  const result = await transaction.query<MemberRow>(
    `select ${memberColumns(scope.kind === "comment_thread" ? 4 : null)}
     ${ELIGIBLE_MEMBER_SQL}
       and principal.id = any($3::uuid[])
     for share of membership, principal`,
    [
      actor.organizationId,
      conversationId,
      ids,
      ...(scope.kind === "comment_thread" ? [scope.artifactId] : []),
    ],
  );
  const byId = new Map(result.rows.map((row) => [row.principalId, row]));
  const mayShare = scope.kind === "comment_thread"
    ? writerMayShareArtifact(actor)
    : writerMayShare(actor);
  const writer = actor.subject.principalId.toLowerCase();
  const refusals: { index: number; code: MentionRefusalCode }[] = [];
  const people: MentionAccess[] = [];
  const raw = (mentions ?? []).map((id) => id.toLowerCase());
  for (const id of ids) {
    const index = raw.indexOf(id);
    const row = byId.get(id);
    if (!row) {
      refusals.push({ index, code: MentionRefusal.NotMember });
      continue;
    }
    const access = accessFor(row, scope, mayShare);
    // A comment gives access only when the writer asked for it with an
    // accessLevel; without one, someone who cannot read the thread is refused.
    const offered = scope.kind !== "comment_thread" ||
      scope.accessLevel !== undefined;
    if (
      id !== writer && !access.hasAccess &&
      (!access.gainsAccessOnSend || !offered)
    ) {
      refusals.push({
        index,
        code: scope.kind !== "comment_thread" ||
            (scope.accessLevel !== undefined && !access.gainsAccessOnSend)
          ? MentionRefusal.ShareForbidden
          : MentionRefusal.NoThreadAccess,
      });
      continue;
    }
    people.push(access);
  }
  if (refusals.length > 0) refuse(refusals);
  return {
    people,
    toGrant: people.filter((person) =>
      person.principalId !== writer && !person.hasAccess &&
      person.gainsAccessOnSend
    ).map((person) => person.principalId),
    toNotify: people.filter((person) => person.principalId !== writer).map((
      person,
    ) => person.principalId),
  };
}

/** The mention set already stored on a message, for idempotent replay. */
export async function storedMessageMentions(
  transaction: PgTransactionClient,
  organizationId: string,
  messageId: string,
): Promise<string[]> {
  const result = await transaction.query<{ principal_id: string }>(
    `select principal_id from bakery.message_mentions
     where organization_id = $1 and message_id = $2
     order by ordinal`,
    [organizationId, messageId],
  );
  return result.rows.map((row) => row.principal_id);
}

/** True when a replayed send names the same people as the stored one. */
export function sameMentions(
  stored: readonly string[],
  requested: readonly string[] | undefined,
): boolean {
  const wanted = distinct(requested ?? []);
  return stored.length === wanted.length &&
    stored.every((id, index) => id.toLowerCase() === wanted[index]);
}

/** The task a conversation belongs to, for routing an inbox item. */
async function taskOfConversation(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  const result = await transaction.query<{ id: string }>(
    `select id from bakery.tasks
     where organization_id = $1 and conversation_id = $2
     order by created_at, id limit 1`,
    [organizationId, conversationId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Writes the side effects of an accepted message mention set inside the send's
 * transaction: mention references, grants (new or reactivated, each audited
 * and signalled), and one inbox item per distinct non-self recipient keyed on
 * the message's own domain event, so a replay cannot add a second.
 */
export async function commitMessageMentions(
  context: ActionContext,
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    conversationId: string;
    applicationId: string | null;
    repositoryId: string | null;
    messageId: string;
    messageSequence: string;
    sourceEventId: string;
    resolved: ResolvedMentions;
  },
): Promise<void> {
  const { resolved, organizationId, conversationId } = input;
  if (resolved.people.length === 0) return;
  const actor = actorOf(context);
  const writer = actor.subject.principalId;
  for (const [ordinal, person] of resolved.people.entries()) {
    await transaction.query(
      `insert into bakery.message_mentions (
         organization_id, message_id, principal_id, ordinal, display_name
       ) values ($1, $2, $3, $4, $5)`,
      [
        organizationId,
        input.messageId,
        person.principalId,
        ordinal,
        person.displayName,
      ],
    );
  }
  for (const principalId of resolved.toGrant) {
    const granted = await transaction.query<{ id: string; version: number }>(
      `insert into bakery.conversation_access_grants (
         organization_id, conversation_id, principal_id, granted_by,
         source_message_id
       ) values ($1, $2, $3, $4, $5)
       on conflict (organization_id, conversation_id, principal_id)
       do update set granted_by = excluded.granted_by,
         source_message_id = excluded.source_message_id,
         granted_at = now(), revoked_at = null, revoked_by = null,
         version = bakery.conversation_access_grants.version + 1
       where bakery.conversation_access_grants.revoked_at is not null
       returning id, version`,
      [organizationId, conversationId, principalId, writer, input.messageId],
    );
    const grant = granted.rows[0];
    // No row: a live grant already existed (a concurrent send won); nothing new.
    if (!grant) continue;
    await appendDomainEvent(transaction, {
      organizationId,
      applicationId: input.applicationId,
      repositoryId: input.repositoryId,
      conversationId,
      eventType: "conversations.access_changed",
      aggregateId: grant.id,
      aggregateVersion: grant.version,
      payload: {
        resourceId: grant.id,
        resourceVersion: grant.version,
        conversationId,
        principalId,
        active: true,
      },
      traceId: context.traceId,
    });
    await appendAudit(transaction, {
      organizationId,
      principalId: writer,
      operation: "conversationAccess.grant",
      resourceType: "conversation_access_grant",
      resourceId: grant.id,
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        conversationId,
        recipientId: principalId,
        messageId: input.messageId,
        version: grant.version,
      },
    });
  }
  const taskId = await taskOfConversation(
    transaction,
    organizationId,
    conversationId,
  );
  for (const recipientId of resolved.toNotify) {
    await insertMentionNotification(context, transaction, {
      organizationId,
      recipientId,
      kind: "mention",
      targetKind: "conversation_message",
      targetId: input.messageId,
      targetAnchor: `message:${input.messageId}`,
      conversationId,
      taskId,
      sourceEventId: input.sourceEventId,
    });
  }
}

/** Mention references and inbox items for an accepted artifact comment. */
export async function commitCommentMentions(
  context: ActionContext,
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    commentId: string;
    conversationId: string | null;
    taskId: string | null;
    sourceEventId: string;
    resolved: ResolvedMentions;
  },
): Promise<void> {
  const { resolved, organizationId } = input;
  for (const [ordinal, person] of resolved.people.entries()) {
    await transaction.query(
      `insert into bakery.artifact_comment_mentions (
         organization_id, comment_id, principal_id, ordinal, display_name
       ) values ($1, $2, $3, $4, $5)`,
      [
        organizationId,
        input.commentId,
        person.principalId,
        ordinal,
        person.displayName,
      ],
    );
  }
  for (const recipientId of resolved.toNotify) {
    await insertMentionNotification(context, transaction, {
      organizationId,
      recipientId,
      kind: "comment_mention",
      targetKind: "comment",
      targetId: input.commentId,
      targetAnchor: null,
      conversationId: input.conversationId,
      taskId: input.taskId,
      sourceEventId: input.sourceEventId,
    });
  }
}

async function insertMentionNotification(
  context: ActionContext,
  transaction: PgTransactionClient,
  item: {
    organizationId: string;
    recipientId: string;
    kind: "mention" | "comment_mention";
    targetKind: "conversation_message" | "comment";
    targetId: string;
    targetAnchor: string | null;
    conversationId: string | null;
    taskId: string | null;
    sourceEventId: string;
  },
): Promise<void> {
  const actor = actorOf(context);
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.notifications (
       organization_id, recipient_id, kind, target_kind, target_id,
       target_anchor, conversation_id, task_id, actor_id, source_event_id,
       source_version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
     on conflict (organization_id, recipient_id, kind, source_event_id,
       source_version) do nothing
     returning id`,
    [
      item.organizationId,
      item.recipientId,
      item.kind,
      item.targetKind,
      item.targetId,
      item.targetAnchor,
      item.conversationId,
      item.taskId,
      actor.subject.principalId,
      item.sourceEventId,
    ],
  );
  if (inserted.rows.length === 0) return;
  await signalInboxChanged(transaction, {
    organizationId: item.organizationId,
    recipientId: item.recipientId,
    traceId: context.traceId,
  });
}
