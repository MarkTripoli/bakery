import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { parseStrongIfMatch, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { lockConversationScope } from "./postgres.ts";
import { findSharers, searchMentionCandidates } from "./mentions.ts";

type GrantRow = {
  id: string;
  conversationId: string;
  principalId: string;
  displayName: string;
  grantedById: string;
  grantedByName: string;
  sourceMessageId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  version: number;
  cursorGrantedAt: string;
};

const GRANT_COLUMNS = `grant_row.id,
  grant_row.conversation_id as "conversationId",
  grant_row.principal_id as "principalId",
  holder.display_name as "displayName",
  grant_row.granted_by as "grantedById",
  granter.display_name as "grantedByName",
  grant_row.source_message_id as "sourceMessageId",
  grant_row.granted_at as "grantedAt", grant_row.revoked_at as "revokedAt",
  grant_row.version,
  to_char(grant_row.granted_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorGrantedAt"`;

const GRANT_FROM = `from bakery.conversation_access_grants as grant_row
  join bakery.principals as holder on holder.id = grant_row.principal_id
  join bakery.principals as granter on granter.id = grant_row.granted_by`;

function toGrant(row: GrantRow) {
  return contractSchemas.ConversationAccessGrant.parse({
    id: row.id,
    conversationId: row.conversationId,
    principalId: row.principalId,
    displayName: row.displayName,
    grantedById: row.grantedById,
    grantedByName: row.grantedByName,
    sourceMessageId: row.sourceMessageId,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    version: row.version,
  });
}

function conversationIdOf(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

/** `conversations.mentionCandidates`: the picker's people for one chat. */
export function createConversationMentionCandidatesHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId } = requireWorkTransaction(context);
    const conversationId = conversationIdOf(context);
    await lockConversationScope(
      transaction,
      organizationId,
      conversationId,
      "share",
    );
    return await searchMentionCandidates(context, transaction, {
      action: "conversations.mentionCandidates",
      secret,
      scope: { kind: "conversation", conversationId },
      scopeId: conversationId,
      query: input as z.output<typeof contractSchemas.MentionCandidateQuery>,
    });
  };
}

/**
 * `conversationAccess.sharers`: up to three people in the reader's
 * organization who may give access to this conversation, its author first.
 * It names who to ask when the writer cannot share; it grants nothing.
 */
export function createConversationAccessSharersHandler() {
  return async (context: ActionContext) => {
    const { transaction, organizationId } = requireWorkTransaction(context);
    const conversationId = conversationIdOf(context);
    await lockConversationScope(
      transaction,
      organizationId,
      conversationId,
      "share",
    );
    const author = await transaction.query<{ created_by: string }>(
      `select created_by from bakery.conversations
        where organization_id = $1 and id = $2`,
      [organizationId, conversationId],
    );
    return {
      items: await findSharers(
        transaction,
        organizationId,
        author.rows[0]?.created_by ?? null,
        "conversation:share",
      ),
    };
  };
}

/** `conversationAccess.list`: live direct grants, oldest first. */
export function createConversationAccessListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const conversationId = conversationIdOf(context);
    await lockConversationScope(
      transaction,
      organizationId,
      conversationId,
      "share",
    );
    const query = input as z.output<
      typeof contractSchemas.ConversationAccessQuery
    >;
    const binding = {
      action: "conversationAccess.list",
      principalId,
      organizationId,
      ordering: "createdAt:asc,id:asc",
      filters: JSON.stringify({ conversationId }),
      schemaVersion: 1,
    };
    const cursor = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<GrantRow>(
      `select ${GRANT_COLUMNS} ${GRANT_FROM}
       where grant_row.organization_id = $1 and grant_row.conversation_id = $2
         and grant_row.revoked_at is null
         and ($3::timestamptz is null
           or (grant_row.granted_at, grant_row.id) > ($3::timestamptz, $4::uuid))
       order by grant_row.granted_at, grant_row.id
       limit $5`,
      [
        organizationId,
        conversationId,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toGrant),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursorGrantedAt,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * `conversationAccess.revoke`: removes one person's direct grant under the
 * grant version in If-Match. The action's own permission
 * (conversation:share) is the sharing authority, checked by the authority
 * runner on the caller's role; a grant never reaches this action. Inherited
 * access has no grant row, so it cannot be removed here.
 */
export async function revokeConversationAccess(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const conversationId = conversationIdOf(context);
  const { principalId: holderId } = input as z.output<
    typeof contractSchemas.ConversationAccessRevoke
  >;
  const scope = await lockConversationScope(
    transaction,
    organizationId,
    conversationId,
    "update",
  );
  const expected = parseStrongIfMatch(context.request.headers.get("if-match"));
  const locked = await transaction.query<{ version: number; revoked: boolean }>(
    `select version, revoked_at is not null as revoked
     from bakery.conversation_access_grants
     where organization_id = $1 and conversation_id = $2 and principal_id = $3
     for update`,
    [organizationId, conversationId, holderId],
  );
  const current = locked.rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (String(current.version) !== String(expected)) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (current.revoked) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "grant_revoked" },
    });
  }
  const updated = await transaction.query<{ id: string; version: number }>(
    `update bakery.conversation_access_grants
     set revoked_at = now(), revoked_by = $4, version = version + 1
     where organization_id = $1 and conversation_id = $2 and principal_id = $3
     returning id, version`,
    [organizationId, conversationId, holderId, principalId],
  );
  const grant = updated.rows[0];
  if (!grant) throw new Error("CONVERSATION_GRANT_REVOKE_FAILED");
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    conversationId,
    eventType: "conversations.access_changed",
    aggregateId: grant.id,
    aggregateVersion: grant.version,
    payload: {
      resourceId: grant.id,
      resourceVersion: grant.version,
      conversationId,
      principalId: holderId,
      active: false,
    },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "conversationAccess.revoke",
    resourceType: "conversation_access_grant",
    resourceId: grant.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { conversationId, recipientId: holderId, version: grant.version },
  });
  const row = await transaction.query<GrantRow>(
    `select ${GRANT_COLUMNS} ${GRANT_FROM}
     where grant_row.organization_id = $1 and grant_row.id = $2`,
    [organizationId, grant.id],
  );
  const result = row.rows[0];
  if (!result) throw new Error("CONVERSATION_GRANT_READ_FAILED");
  return toGrant(result);
}
