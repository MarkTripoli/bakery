/**
 * File grants for agents (chapter 25 section 17.6, O45, O51, O52, issue
 * #448). A person grants the agent sessions of one workflow read or write
 * access to one storage folder until an expiry, and may revoke it. Only a
 * person grants or revokes: an agent widening its own file scope is off by
 * default (O52), so the agent-facing path refuses outright. The guard that
 * reads grants is assertAgentFileWrite in agent-file-guard.ts.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  agentAreaRefusal,
  AgentFileRefusal,
  isAgentFileAccess,
  MAX_FILE_GRANT_DAYS,
  storageAuditActor,
} from "./agent-file-scope.ts";
import type { StoragePolicy } from "./storage-tree.ts";

type GrantRow = {
  id: string;
  workflow_id: string;
  folder_id: string;
  access: "read" | "write";
  granted_by: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_at: Date;
  version: number;
};

const GRANT_COLUMNS = "id, workflow_id, folder_id, access, granted_by," +
  " expires_at, revoked_at, revoked_by, created_at, version";

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    folderId: row.folder_id,
    access: row.access,
    grantedBy: row.granted_by,
    expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    revokedBy: row.revoked_by,
    createdAt: iso(row.created_at),
    version: Number(row.version),
  };
}

/** Granting is a person's act; every agent actor is refused the same way. */
function assertPerson(context: ActionContext, principalId: string): void {
  if (attributeAction(context, principalId).actorKind === "person") return;
  throw new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: AgentFileRefusal.GrantRequiresPerson },
  });
}

function unprocessable(field: string, code: string, message: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [field], code, message }] },
  });
}

type FolderRow = {
  id: string;
  kind: string;
  policy: StoragePolicy;
  owner_id: string | null;
  system_key: string | null;
  trashed_at: Date | null;
  purged_at: Date | null;
};

async function grantableFolder(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
  folderId: string,
): Promise<FolderRow> {
  const found = await tx.query<FolderRow>(
    "select id, kind, policy, owner_id, system_key, trashed_at, purged_at" +
      " from bakery.storage_entries" +
      " where organization_id = $1 and id = $2 for share",
    [organizationId, folderId],
  );
  const folder = found.rows[0];
  // Missing, foreign, trashed, purged, a file, or another member's personal
  // folder all answer the same not found, so a refusal confirms nothing.
  if (
    !folder || folder.kind !== "folder" || folder.trashed_at !== null ||
    folder.purged_at !== null ||
    ((folder.policy === "personal" || folder.policy === "scratch") &&
      folder.owner_id !== principalId)
  ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return folder;
}

async function auditGrant(
  tx: PgTransactionClient,
  context: ActionContext,
  input: {
    organizationId: string;
    principalId: string;
    operation: string;
    row: GrantRow;
  },
): Promise<void> {
  await appendAudit(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    agentSessionId: null,
    operation: input.operation,
    resourceType: "agent_file_grant",
    resourceId: input.row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      workflowId: input.row.workflow_id,
      folderId: input.row.folder_id,
      access: input.row.access,
      expiresAt: iso(input.row.expires_at),
      actor: storageAuditActor(
        attributeAction(context, input.principalId),
        null,
      ),
    },
  });
}

export type AgentFileGrantCreateInput = Readonly<{
  workflowId: string;
  folderId: string;
  access: string;
  expiresAt: string;
}>;

export async function createAgentFileGrant(
  context: ActionContext,
  input: AgentFileGrantCreateInput,
  now: Date = new Date(),
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  assertPerson(context, principalId);
  if (!isAgentFileAccess(input.access)) {
    unprocessable("access", "agent_file_access_unknown", "read or write");
  }
  const expiresAt = new Date(input.expiresAt);
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() > now.getTime() + MAX_FILE_GRANT_DAYS * DAY_MS
  ) {
    unprocessable(
      "expiresAt",
      "agent_file_grant_expiry",
      "expiresAt must be in the future and at most 30 days ahead",
    );
  }
  const workflow = await tx.query(
    "select 1 from bakery.workflow_definitions" +
      " where organization_id = $1 and id = $2",
    [organizationId, input.workflowId],
  );
  if (workflow.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const folder = await grantableFolder(
    tx,
    organizationId,
    principalId,
    input.folderId,
  );
  // The same area rule the guard applies to a write, judged with this person
  // as the grantor, so a grant that could never be used is never made.
  const area = agentAreaRefusal({
    policy: folder.policy,
    ownerId: folder.owner_id,
    systemKey: folder.system_key,
  }, principalId);
  if (area !== undefined) {
    throw new StandardError({
      code: "STORAGE_AREA_REFUSED",
      params: { reason: area },
    });
  }
  const inserted = await tx.query<GrantRow>(
    "insert into bakery.agent_file_grants" +
      " (organization_id, workflow_id, folder_id, access, granted_by," +
      " expires_at) values ($1, $2, $3, $4, $5, $6)" +
      " returning " + GRANT_COLUMNS,
    [
      organizationId,
      input.workflowId,
      folder.id,
      input.access,
      principalId,
      expiresAt,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("AGENT_FILE_GRANT_INSERT_FAILED");
  await auditGrant(tx, context, {
    organizationId,
    principalId,
    operation: "agentFileGrants.create",
    row,
  });
  return toGrant(row);
}

/**
 * Revokes a grant: stamps it, never deletes it, so the next write an agent
 * tries under it is refused as withdrawn rather than as never allowed.
 */
export async function revokeAgentFileGrant(context: ActionContext) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  assertPerson(context, principalId);
  const grantId = context.params.id ?? "";
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const current = await tx.query<GrantRow>(
    "select " + GRANT_COLUMNS + " from bakery.agent_file_grants" +
      " where organization_id = $1 and id = $2 for update",
    [organizationId, grantId],
  );
  const row = current.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (Number(row.version) !== expected) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (row.revoked_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "agent_file_grant_revoked" },
    });
  }
  const updated = await tx.query<GrantRow>(
    "update bakery.agent_file_grants" +
      " set revoked_at = now(), revoked_by = $3, version = version + 1" +
      " where organization_id = $1 and id = $2 returning " + GRANT_COLUMNS,
    [organizationId, grantId, principalId],
  );
  const revoked = updated.rows[0];
  if (!revoked) throw new Error("AGENT_FILE_GRANT_REVOKE_FAILED");
  await auditGrant(tx, context, {
    organizationId,
    principalId,
    operation: "agentFileGrants.revoke",
    row: revoked,
  });
  return toGrant(revoked);
}
