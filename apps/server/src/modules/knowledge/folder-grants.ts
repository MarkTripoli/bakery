import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import { storageAuditActor } from "./agent-file-scope.ts";
import {
  FOLDER_GRANT_LEVELS,
  type FolderGrantLevel,
  grantRefusal,
  mayManage,
} from "./folder-access.ts";
import { accessAt, ancestorChain } from "./folder-access-store.ts";
import { writeRefusal } from "./storage-areas.ts";
import type { StoragePolicy } from "./storage-tree.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTED = 200;

type FolderRow = {
  id: string;
  kind: "folder" | "file";
  policy: StoragePolicy;
  owner_id: string | null;
  system_key: string | null;
  restricted: boolean;
  version: number;
  trashed_at: Date | null;
  purged_at: Date | null;
};

type GrantRow = {
  id: string;
  folder_id: string;
  principal_id: string;
  level: FolderGrantLevel;
  granted_by: string;
  revoked_at: Date | null;
  created_at: Date;
  version: number;
};

const GRANT_COLUMNS =
  "id, folder_id, principal_id, level, granted_by, revoked_at, created_at, version";

const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    principalId: row.principal_id,
    level: row.level,
    grantedBy: row.granted_by,
    createdAt: iso(row.created_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    version: Number(row.version),
  };
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function refuse(reason: string): never {
  throw new StandardError({ code: "STORAGE_AREA_REFUSED", params: { reason } });
}

function unprocessable(path: string, code: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [path], message: code, code }] },
  });
}

function requirePerson(context: ActionContext, principalId: string): void {
  if (attributeAction(context, principalId).actorKind !== "person") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

async function manageableFolder(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  id: string | undefined,
): Promise<FolderRow> {
  if (!id || !UUID.test(id)) notFound();
  const found = await tx.query<FolderRow>(
    `select id, kind, policy, owner_id, system_key, restricted, version,
            trashed_at, purged_at
       from bakery.storage_entries
      where organization_id = $1 and id = $2 for update`,
    [organizationId, id],
  );
  const folder = found.rows[0];
  if (
    !folder || folder.kind !== "folder" || folder.purged_at !== null ||
    folder.trashed_at !== null
  ) notFound();
  if (
    (folder.policy === "personal" || folder.policy === "scratch") &&
    folder.owner_id !== null && folder.owner_id !== principalId
  ) notFound();
  const access = await accessAt(tx, organizationId, principalId, folder.id);
  if (access.restricted && access.level === null) notFound();
  const chain = await ancestorChain(tx, organizationId, folder.id);
  const refusal = grantRefusal(chain);
  if (refusal) refuse(refusal);
  const mayWriteArea = writeRefusal({
    policy: folder.policy,
    ownerId: folder.owner_id,
    systemKey: folder.system_key,
  }, principalId) === undefined;
  if (!mayManage(access, mayWriteArea)) refuse("folder_manage_required");
  return folder;
}

async function audit(
  tx: PgTransactionClient,
  context: ActionContext,
  input: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceId: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await appendAudit(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    agentSessionId: null,
    operation: input.operation,
    resourceType: "storage_folder",
    resourceId: input.resourceId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      ...input.details,
      actor: storageAuditActor(
        attributeAction(context, input.principalId),
        null,
      ),
    },
  });
}

export type FolderGrantCreateInput = Readonly<{
  principalId: string;
  level: FolderGrantLevel;
}>;

export async function createFolderGrant(
  context: ActionContext,
  input: FolderGrantCreateInput,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  requirePerson(context, principalId);
  if (!FOLDER_GRANT_LEVELS.includes(input.level)) {
    unprocessable("level", "unknown_level");
  }
  const folder = await manageableFolder(
    tx,
    organizationId,
    principalId,
    context.params.id,
  );
  const access = await accessAt(tx, organizationId, principalId, folder.id);
  if (!access.restricted) refuse("folder_not_restricted");
  const member = await tx.query(
    `select 1 from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2 and status = 'active'`,
    [organizationId, input.principalId],
  );
  if (member.rows.length === 0) unprocessable("principalId", "not_a_member");
  const existing = await tx.query<GrantRow>(
    `select ${GRANT_COLUMNS} from bakery.storage_folder_grants
      where organization_id = $1 and folder_id = $2 and principal_id = $3
        and revoked_at is null for update`,
    [organizationId, folder.id, input.principalId],
  );
  let row: GrantRow;
  if (existing.rows[0]) {
    row = (await tx.query<GrantRow>(
      `update bakery.storage_folder_grants
          set level = $4, version = version + 1
        where organization_id = $1 and folder_id = $2 and id = $3
        returning ${GRANT_COLUMNS}`,
      [organizationId, folder.id, existing.rows[0].id, input.level],
    )).rows[0]!;
  } else {
    const live = await tx.query<{ n: number }>(
      `select count(*)::integer as n from bakery.storage_folder_grants
        where organization_id = $1 and folder_id = $2 and revoked_at is null`,
      [organizationId, folder.id],
    );
    if (live.rows[0].n >= MAX_LISTED) {
      unprocessable("principalId", "folder_grant_limit");
    }
    row = (await tx.query<GrantRow>(
      `insert into bakery.storage_folder_grants
         (organization_id, folder_id, principal_id, level, granted_by)
       values ($1, $2, $3, $4, $5)
       returning ${GRANT_COLUMNS}`,
      [organizationId, folder.id, input.principalId, input.level, principalId],
    )).rows[0]!;
  }
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFolderGrants.create",
    resourceId: folder.id,
    details: {
      grantId: row.id,
      grantee: input.principalId,
      level: input.level,
    },
  });
  return toGrant(row);
}

export async function revokeFolderGrant(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  requirePerson(context, principalId);
  const grantId = context.params.id;
  if (!grantId || !UUID.test(grantId)) notFound();
  const found = await tx.query<GrantRow>(
    `select ${GRANT_COLUMNS} from bakery.storage_folder_grants
      where organization_id = $1 and id = $2 for update`,
    [organizationId, grantId],
  );
  const grant = found.rows[0];
  if (!grant) notFound();
  await manageableFolder(tx, organizationId, principalId, grant.folder_id);
  if (grant.revoked_at !== null) return toGrant(grant);
  const row = (await tx.query<GrantRow>(
    `update bakery.storage_folder_grants
        set revoked_at = now(), revoked_by = $3, version = version + 1
      where organization_id = $1 and id = $2
      returning ${GRANT_COLUMNS}`,
    [organizationId, grant.id, principalId],
  )).rows[0]!;
  await audit(tx, context, {
    organizationId,
    principalId,
    operation: "storageFolderGrants.revoke",
    resourceId: grant.folder_id,
    details: {
      grantId: grant.id,
      grantee: grant.principal_id,
      level: grant.level,
    },
  });
  return toGrant(row);
}

export async function listFolderGrants(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const folder = await manageableFolder(
    tx,
    organizationId,
    principalId,
    context.params.id,
  );
  const found = await tx.query<GrantRow>(
    `select ${GRANT_COLUMNS} from bakery.storage_folder_grants
      where organization_id = $1 and folder_id = $2 and revoked_at is null
      order by created_at, id limit ${MAX_LISTED}`,
    [organizationId, folder.id],
  );
  return { items: found.rows.map(toGrant) };
}

export type FolderRestrictionInput = Readonly<{ restricted: boolean }>;

export async function setFolderRestriction(
  context: ActionContext,
  input: FolderRestrictionInput,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  requirePerson(context, principalId);
  const folder = await manageableFolder(
    tx,
    organizationId,
    principalId,
    context.params.id,
  );
  if (folder.restricted !== input.restricted) {
    await tx.query(
      `update bakery.storage_entries
          set restricted = $3, version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2`,
      [organizationId, folder.id, input.restricted],
    );
    if (input.restricted) {
      const held = await tx.query(
        `select 1 from bakery.storage_folder_grants
          where organization_id = $1 and folder_id = $2 and principal_id = $3
            and revoked_at is null`,
        [organizationId, folder.id, principalId],
      );
      if (held.rows.length === 0) {
        await tx.query(
          `insert into bakery.storage_folder_grants
             (organization_id, folder_id, principal_id, level, granted_by)
           values ($1, $2, $3, 'manage', $3)`,
          [organizationId, folder.id, principalId],
        );
      }
    }
    await audit(tx, context, {
      organizationId,
      principalId,
      operation: "storageFolders.restrict",
      resourceId: folder.id,
      details: { restricted: input.restricted },
    });
  }
  const after = await tx.query<{ version: number }>(
    `select version from bakery.storage_entries
      where organization_id = $1 and id = $2`,
    [organizationId, folder.id],
  );
  return {
    folderId: folder.id,
    restricted: input.restricted,
    version: Number(after.rows[0]!.version),
  };
}
