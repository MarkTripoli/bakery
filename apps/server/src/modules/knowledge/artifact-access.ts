import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  type ActionRegistry,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { parseStrongIfMatch, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { signalInboxChanged } from "../work/notification-signal.ts";
import {
  ELIGIBLE_MEMBER_SQL,
  findSharers,
  memberRoleHolds,
} from "../conversation/mentions.ts";

/** What a direct document grant lets a person do. */
export type ArtifactAccessLevel = "read_comment" | "edit";

type GrantRow = {
  id: string;
  artifactId: string;
  principalId: string;
  displayName: string;
  level: ArtifactAccessLevel;
  grantedById: string;
  grantedByName: string;
  sourceCommentId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  version: number;
  cursorGrantedAt: string;
};

const GRANT_COLUMNS = `grant_row.id,
  grant_row.artifact_id as "artifactId",
  grant_row.principal_id as "principalId",
  holder.display_name as "displayName",
  grant_row.level,
  grant_row.granted_by as "grantedById",
  granter.display_name as "grantedByName",
  grant_row.source_comment_id as "sourceCommentId",
  grant_row.granted_at as "grantedAt", grant_row.revoked_at as "revokedAt",
  grant_row.version,
  to_char(grant_row.granted_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorGrantedAt"`;

const GRANT_FROM = `from bakery.artifact_access_grants as grant_row
  join bakery.principals as holder on holder.id = grant_row.principal_id
  join bakery.principals as granter on granter.id = grant_row.granted_by`;

function toGrant(row: GrantRow) {
  return contractSchemas.ArtifactAccessGrant.parse({
    id: row.id,
    artifactId: row.artifactId,
    principalId: row.principalId,
    displayName: row.displayName,
    level: row.level,
    grantedById: row.grantedById,
    grantedByName: row.grantedByName,
    sourceCommentId: row.sourceCommentId,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    version: row.version,
  });
}

/** The document a request names, with the scope its events carry. */
export type ArtifactScope = {
  id: string;
  taskId: string;
  applicationId: string | null;
  repositoryId: string | null;
  conversationId: string | null;
};

/**
 * Resolves one artifact inside the caller's organization, row-locked so a
 * concurrent grant or revoke is ordered with this request. A foreign or
 * missing artifact is RESOURCE_NOT_FOUND.
 */
export async function lockArtifactScope(
  transaction: PgTransactionClient,
  organizationId: string,
  artifactId: string,
  lock: "share" | "update",
): Promise<ArtifactScope> {
  const found = await transaction.query<{
    id: string;
    task_id: string;
    application_id: string | null;
    repository_id: string | null;
    conversation_id: string | null;
  }>(
    `select artifact.id, artifact.task_id, task.application_id,
            task.repository_id, task.conversation_id
       from bakery.artifacts as artifact
       join bakery.tasks as task
         on task.organization_id = artifact.organization_id
        and task.id = artifact.task_id
      where artifact.organization_id = $1 and artifact.id = $2
        for ${lock} of artifact`,
    [organizationId, artifactId],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    id: row.id,
    taskId: row.task_id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
  };
}

function artifactIdOf(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

/**
 * Creates, renews or changes one person's grant on one document and records
 * the change. A live grant at the same level is left alone and reported as
 * unchanged, so a repeat creates no second event or audit row. A live grant
 * changed by hand (no comment given) keeps the comment that first gave the
 * access, so a mentioned person stays one; a revoked grant that comes back
 * starts without one. Callers have
 * already checked the writer's sharing authority and that the person is an
 * active human member.
 */
export async function upsertArtifactGrant(
  context: ActionContext,
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    artifact: ArtifactScope;
    principalId: string;
    level: ArtifactAccessLevel;
    grantedBy: string;
    sourceCommentId: string | null;
  },
): Promise<{ id: string; changed: boolean }> {
  const { organizationId, artifact } = input;
  const result = await transaction.query<{ id: string; version: number }>(
    `insert into bakery.artifact_access_grants (
       organization_id, artifact_id, principal_id, level, granted_by,
       source_comment_id
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (organization_id, artifact_id, principal_id)
     do update set level = excluded.level, granted_by = excluded.granted_by,
       source_comment_id = case
         when bakery.artifact_access_grants.revoked_at is null
          and excluded.source_comment_id is null
         then bakery.artifact_access_grants.source_comment_id
         else excluded.source_comment_id
       end,
       granted_at = now(), revoked_at = null, revoked_by = null,
       version = bakery.artifact_access_grants.version + 1
     where bakery.artifact_access_grants.revoked_at is not null
        or bakery.artifact_access_grants.level <> excluded.level
     returning id, version`,
    [
      organizationId,
      artifact.id,
      input.principalId,
      input.level,
      input.grantedBy,
      input.sourceCommentId,
    ],
  );
  const grant = result.rows[0];
  if (!grant) {
    const live = await transaction.query<{ id: string }>(
      `select id from bakery.artifact_access_grants
        where organization_id = $1 and artifact_id = $2 and principal_id = $3`,
      [organizationId, artifact.id, input.principalId],
    );
    const existing = live.rows[0];
    if (!existing) throw new Error("ARTIFACT_GRANT_UPSERT_FAILED");
    return { id: existing.id, changed: false };
  }
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: artifact.applicationId,
    repositoryId: artifact.repositoryId,
    taskId: artifact.taskId,
    conversationId: artifact.conversationId,
    eventType: "artifacts.access_changed",
    aggregateId: grant.id,
    aggregateVersion: grant.version,
    payload: {
      resourceId: grant.id,
      resourceVersion: grant.version,
      artifactId: artifact.id,
      principalId: input.principalId,
      active: true,
    },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: input.grantedBy,
    operation: "artifactAccess.grant",
    resourceType: "artifact_access_grant",
    resourceId: grant.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      artifactId: artifact.id,
      recipientId: input.principalId,
      level: input.level,
      commentId: input.sourceCommentId,
      version: grant.version,
    },
  });
  return { id: grant.id, changed: true };
}

async function readGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
) {
  const row = await transaction.query<GrantRow>(
    `select ${GRANT_COLUMNS} ${GRANT_FROM}
      where grant_row.organization_id = $1 and grant_row.id = $2`,
    [organizationId, grantId],
  );
  const result = row.rows[0];
  if (!result) throw new Error("ARTIFACT_GRANT_READ_FAILED");
  return toGrant(result);
}

/** `artifactAccess.grant`: gives one active human member direct access. */
async function grantAccess(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const body = input as z.output<
    typeof contractSchemas.ArtifactAccessGrantCreate
  >;
  const artifact = await lockArtifactScope(
    transaction,
    organizationId,
    artifactIdOf(context),
    "share",
  );
  const member = await transaction.query(
    `select 1 ${ELIGIBLE_MEMBER_SQL} and principal.id = $2::uuid
       for share of membership, principal`,
    [organizationId, body.principalId],
  );
  if (member.rows.length !== 1) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["principalId"],
          code: "mention_not_member",
          message: "mention not member",
        }],
      },
    });
  }
  // Someone whose role already reads and comments has nothing to be given; a
  // grant row there would be a second, revocable-looking source of access.
  if (
    await memberRoleHolds(
      transaction,
      organizationId,
      body.principalId,
      "artifactComment:read",
    )
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["principalId"],
          code: "already_has_access",
          message: "already has access",
        }],
      },
    });
  }
  const grant = await upsertArtifactGrant(context, transaction, {
    organizationId,
    artifact,
    principalId: body.principalId,
    level: body.level ?? "read_comment",
    grantedBy: principalId,
    sourceCommentId: null,
  });
  return await readGrant(transaction, organizationId, grant.id);
}

/** `artifactAccess.list`: live direct grants on one document, oldest first. */
function createListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const artifactId = artifactIdOf(context);
    await lockArtifactScope(transaction, organizationId, artifactId, "share");
    const query = input as z.output<typeof contractSchemas.ArtifactAccessQuery>;
    const binding = {
      action: "artifactAccess.list",
      principalId,
      organizationId,
      ordering: "createdAt:asc,id:asc",
      filters: JSON.stringify({ artifactId }),
      schemaVersion: 1,
    };
    const cursor = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<GrantRow>(
      `select ${GRANT_COLUMNS} ${GRANT_FROM}
       where grant_row.organization_id = $1 and grant_row.artifact_id = $2
         and grant_row.revoked_at is null
         and ($3::timestamptz is null
           or (grant_row.granted_at, grant_row.id) > ($3::timestamptz, $4::uuid))
       order by grant_row.granted_at, grant_row.id
       limit $5`,
      [
        organizationId,
        artifactId,
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
 * `artifactAccess.revoke`: removes one person's direct grant under the grant
 * version in If-Match, and withdraws that person's unread mention
 * notifications for the document so the Undo leaves nothing that points at it.
 */
async function revokeAccess(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { principalId: holderId } = input as z.output<
    typeof contractSchemas.ArtifactAccessRevoke
  >;
  const artifact = await lockArtifactScope(
    transaction,
    organizationId,
    artifactIdOf(context),
    "update",
  );
  const expected = parseStrongIfMatch(context.request.headers.get("if-match"));
  const locked = await transaction.query<{ version: number; revoked: boolean }>(
    `select version, revoked_at is not null as revoked
       from bakery.artifact_access_grants
      where organization_id = $1 and artifact_id = $2 and principal_id = $3
        for update`,
    [organizationId, artifact.id, holderId],
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
    `update bakery.artifact_access_grants
        set revoked_at = now(), revoked_by = $4, version = version + 1
      where organization_id = $1 and artifact_id = $2 and principal_id = $3
      returning id, version`,
    [organizationId, artifact.id, holderId, principalId],
  );
  const grant = updated.rows[0];
  if (!grant) throw new Error("ARTIFACT_GRANT_REVOKE_FAILED");
  const withdrawn = await transaction.query(
    `delete from bakery.notifications as item
      where item.organization_id = $1 and item.recipient_id = $2
        and item.read_at is null and item.kind = 'comment_mention'
        and item.target_kind = 'comment'
        and exists (
          select 1 from bakery.artifact_comments as comment
            join bakery.artifact_versions as version
              on version.organization_id = comment.organization_id
             and version.id = comment.artifact_version_id
           where comment.organization_id = item.organization_id
             and comment.id = item.target_id and version.artifact_id = $3
        )`,
    [organizationId, holderId, artifact.id],
  );
  if ((withdrawn.rowCount ?? 0) > 0) {
    await signalInboxChanged(transaction, {
      organizationId,
      recipientId: holderId,
      traceId: context.traceId,
    });
  }
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: artifact.applicationId,
    repositoryId: artifact.repositoryId,
    taskId: artifact.taskId,
    conversationId: artifact.conversationId,
    eventType: "artifacts.access_changed",
    aggregateId: grant.id,
    aggregateVersion: grant.version,
    payload: {
      resourceId: grant.id,
      resourceVersion: grant.version,
      artifactId: artifact.id,
      principalId: holderId,
      active: false,
    },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifactAccess.revoke",
    resourceType: "artifact_access_grant",
    resourceId: grant.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      artifactId: artifact.id,
      recipientId: holderId,
      version: grant.version,
      notificationsWithdrawn: withdrawn.rowCount ?? 0,
    },
  });
  return await readGrant(transaction, organizationId, grant.id);
}

/**
 * `artifactAccess.sharers`: up to three people who may give access to this
 * document, its first author leading. It grants nothing.
 */
async function sharers(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const artifactId = artifactIdOf(context);
  await lockArtifactScope(transaction, organizationId, artifactId, "share");
  const author = await transaction.query<{ author_id: string }>(
    `select author_id from bakery.artifact_versions
      where organization_id = $1 and artifact_id = $2
      order by revision asc limit 1`,
    [organizationId, artifactId],
  );
  return {
    items: await findSharers(
      transaction,
      organizationId,
      author.rows[0]?.author_id ?? null,
      "artifact:share",
    ),
  };
}

export function registerArtifactAccessActions(
  registry: ActionRegistry,
  secret: string,
): void {
  const read = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const write = { ...read, type: ActionKind.Command } as const;
  registry.register({
    name: "artifactAccess.grant",
    method: HttpMethod.Post,
    path: "/v1/artifacts/:id/access",
    input: contractSchemas.ArtifactAccessGrantCreate,
    output: contractSchemas.ArtifactAccessGrant,
    policy: write,
    successStatus: 200,
    handler: grantAccess,
  });
  registry.register({
    name: "artifactAccess.list",
    method: HttpMethod.Get,
    path: "/v1/artifacts/:id/access",
    input: contractSchemas.ArtifactAccessQuery,
    output: contractSchemas["Page<ArtifactAccessGrant>"],
    policy: read,
    handler: createListHandler(secret),
  });
  registry.register({
    name: "artifactAccess.sharers",
    method: HttpMethod.Get,
    path: "/v1/artifacts/:id/access/sharers",
    input: contractSchemas.IdPath,
    output: contractSchemas.ArtifactSharers,
    policy: read,
    handler: (context) => sharers(context),
  });
  registry.register({
    name: "artifactAccess.revoke",
    method: HttpMethod.Post,
    path: "/v1/artifacts/:id/access/revoke",
    input: contractSchemas.ArtifactAccessRevoke,
    output: contractSchemas.ArtifactAccessGrant,
    policy: write,
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    handler: revokeAccess,
  });
}
