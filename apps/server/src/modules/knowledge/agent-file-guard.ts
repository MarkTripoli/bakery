/**
 * The database half of an agent's file write (chapter 25 section 17.6, issue
 * #448). The storage handlers call it for a call that came through a session
 * credential (the action context carries `agentSession`); a person's own
 * request passes untouched, because their role and the folder policy already
 * decided it. The rules themselves are the pure functions in
 * agent-file-scope.ts; this module only gathers the rows they judge, every one
 * of them read with an explicit organization predicate.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { attemptOrigin } from "../auth/application/agent-power-grants.ts";
import {
  agentAreaRefusal,
  type AgentFileAccess,
  type AgentFileGrant,
  AgentFileRefusal,
  agentPathRefusal,
  type AgentWrite,
  grantRefusal,
  pathSpellingRefusal,
  principalAuthorityRefusal,
  storageScopeRefusal,
} from "./agent-file-scope.ts";
import type { AreaEntry } from "./storage-areas.ts";
import type { StoragePolicy } from "./storage-tree.ts";

/** The folder a write lands in (or, for mv and rm, the folder it leaves). */
export type AgentFileTarget = Readonly<{
  id: string;
  policy: StoragePolicy;
  owner_id: string | null;
  system_key: string | null;
}>;

function forbidden(reason: AgentFileRefusal): never {
  throw new StandardError({ code: "AUTH_FORBIDDEN", params: { reason } });
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

/**
 * Layer 3, lexical, for a session call: refuses a path an agent sent before
 * the tree's own parser could trim or normalize it into something else. A
 * person's request is not checked here; the parser's rules apply to both.
 */
export function refuseAgentPath(
  context: Pick<ActionContext, "agentSession">,
  path: string,
): void {
  if (context.agentSession === undefined) return;
  const reason = agentPathRefusal(path);
  if (reason === undefined) return;
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: ["path"], code: reason, message: reason }] },
  });
}

type GrantRow = {
  id: string;
  organization_id: string;
  workflow_id: string;
  folder_id: string;
  access: AgentFileAccess;
  granted_by: string;
  expires_at: Date;
  revoked_at: Date | null;
};

export function toAgentFileGrant(row: GrantRow): AgentFileGrant {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workflowId: row.workflow_id,
    folderId: row.folder_id,
    access: row.access,
    grantedById: row.granted_by,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

type ChainRow = { id: string; name: string; organization_id: string };

/** The target and its ancestors, root first, all in this organization. */
async function folderChain(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  folderId: string,
): Promise<ChainRow[]> {
  const found = await tx.query<ChainRow & { depth: number }>(
    "with recursive up as (" +
      " select id, parent_id, name, organization_id, 0 as depth" +
      " from bakery.storage_entries where organization_id = $1 and id = $2" +
      " union all" +
      " select e.id, e.parent_id, e.name, e.organization_id, up.depth + 1" +
      " from bakery.storage_entries e" +
      " join up on e.organization_id = $1 and e.id = up.parent_id" +
      " where up.depth < 64)" +
      " select id, name, organization_id, depth from up order by depth desc",
    [organizationId, folderId],
  );
  return found.rows;
}

export type AgentFileWriteScope = Readonly<{
  organizationId: string;
  /** The person the session acts for (O50). */
  principalId: string;
  workflowId: string;
  attemptId: string;
  agentSessionId: string | null;
  target: AgentFileTarget;
  /**
   * The path the agent sent, when the target came from one; the parent
   * folders it spelled must match the stored names exactly. Absent for an
   * operation addressed by entry id (mv's source, rm).
   */
  rawPath?: string;
  access: AgentFileAccess;
  now: Date;
}>;

/**
 * Judges one agent write, layer by layer, and returns what its audit row must
 * name. Called after the target folder is locked and before anything is
 * written, so a refusal writes nothing.
 */
export async function assertAgentFileWrite(
  tx: Pick<PgTransactionClient, "query">,
  scope: AgentFileWriteScope,
): Promise<AgentWrite> {
  // Layer 3, lexical.
  if (scope.rawPath !== undefined) {
    const lexical = agentPathRefusal(scope.rawPath);
    if (lexical !== undefined) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: {
          issues: [{ path: ["path"], code: lexical, message: lexical }],
        },
      });
    }
  }
  // Layer 5: the chain is read with the organization predicate, and every row
  // it returns is checked against it again; an empty chain is a target that
  // does not exist here.
  const chain = await folderChain(tx, scope.organizationId, scope.target.id);
  if (
    storageScopeRefusal(
      scope.organizationId,
      chain.map((row) => ({ organizationId: row.organization_id })),
    )
  ) notFound();
  // Layer 3, resolved: the folders the path went through carry exactly the
  // names it spelled.
  if (scope.rawPath !== undefined) {
    const spelled = scope.rawPath.split("/").slice(1, -1);
    const spelling = pathSpellingRefusal(
      spelled,
      chain.map((row) => row.name),
    );
    if (spelling !== undefined) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: {
          issues: [{ path: ["path"], code: spelling, message: spelling }],
        },
      });
    }
  }
  // Layer 2: scope x area x expiry x revocation, at the time of this write.
  const grants = await tx.query<GrantRow>(
    "select id, organization_id, workflow_id, folder_id, access, granted_by," +
      " expires_at, revoked_at from bakery.agent_file_grants" +
      " where organization_id = $1 and workflow_id = $2" +
      " and folder_id = any($3::uuid[])",
    [scope.organizationId, scope.workflowId, chain.map((row) => row.id)],
  );
  const decision = grantRefusal(grants.rows.map(toAgentFileGrant), {
    organizationId: scope.organizationId,
    workflowId: scope.workflowId,
    access: scope.access,
    folderChain: chain.map((row) => row.id),
    now: scope.now,
  });
  if (decision.refusal !== undefined) forbidden(decision.refusal);
  const folder: AreaEntry = {
    policy: scope.target.policy,
    ownerId: scope.target.owner_id,
    systemKey: scope.target.system_key,
  };
  const area = agentAreaRefusal(folder, decision.grant.grantedById);
  if (area !== undefined) forbidden(area);
  // Layer 4: never beyond the person the agent acts for.
  const authority = principalAuthorityRefusal(folder, scope.principalId);
  if (authority !== undefined) forbidden(authority);
  return {
    attemptId: scope.attemptId,
    agentSessionId: scope.agentSessionId,
    fileGrantId: decision.grant.id,
  };
}

/**
 * The guard as a storage handler calls it: null for a person's own request,
 * the attribution to audit for an allowed agent write, and a named refusal
 * otherwise. A session whose attempt belongs to no run has no workflow, so no
 * grant can cover it.
 */
export async function agentFileWriteFor(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession">,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    target: AgentFileTarget;
    rawPath?: string;
    access?: AgentFileAccess;
    now?: Date;
  }>,
): Promise<AgentWrite | null> {
  if (context.agentSession === undefined) return null;
  const attemptId = context.agentSession.attemptId;
  const origin = await attemptOrigin(tx, scope.organizationId, attemptId);
  if (origin === null) forbidden(AgentFileRefusal.GrantMissing);
  return await assertAgentFileWrite(tx, {
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    workflowId: origin.workflowId,
    attemptId,
    agentSessionId: origin.agentSessionId,
    target: scope.target,
    ...(scope.rawPath === undefined ? {} : { rawPath: scope.rawPath }),
    access: scope.access ?? "write",
    now: scope.now ?? new Date(),
  });
}
