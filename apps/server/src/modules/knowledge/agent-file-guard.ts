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
  AgentFileAccess,
  type AgentFileGrant,
  AgentFileRefusal,
  type AgentOwnPlaces,
  agentPathRefusal,
  agentReadAreaRefusal,
  AgentTreeArea,
  agentTreeAreaOf,
  type AgentWrite,
  boundConnectionsOf,
  type ChainEntry,
  connectionMountKey,
  declaredTreeAreas,
  grantRefusal,
  pathSpellingRefusal,
  personalOwnerOf,
  principalAuthorityRefusal,
  storageScopeRefusal,
} from "./agent-file-scope.ts";
import { type AreaEntry, isVisibleTo } from "./storage-areas.ts";
import {
  reviewerDeclaredOutput,
  reviewerIsolationOf,
} from "./reviewer-isolation.ts";
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

type ChainRow = {
  id: string;
  name: string;
  organization_id: string;
  system_key: string | null;
  policy: StoragePolicy;
  owner_id: string | null;
};

function chainEntries(chain: readonly ChainRow[]): ChainEntry[] {
  return chain.map((row) => ({
    systemKey: row.system_key ?? null,
    policy: row.policy,
    ownerId: row.owner_id ?? null,
  }));
}

/** The target and its ancestors, root first, all in this organization. */
async function folderChain(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  folderId: string,
): Promise<ChainRow[]> {
  const found = await tx.query<ChainRow & { depth: number }>(
    "with recursive up as (" +
      " select id, parent_id, name, organization_id, system_key, policy," +
      " owner_id, 0 as depth" +
      " from bakery.storage_entries where organization_id = $1 and id = $2" +
      " union all" +
      " select e.id, e.parent_id, e.name, e.organization_id, e.system_key," +
      " e.policy, e.owner_id, up.depth + 1" +
      " from bakery.storage_entries e" +
      " join up on e.organization_id = $1 and e.id = up.parent_id" +
      " where up.depth < 64)" +
      " select id, name, organization_id, system_key, policy, owner_id, depth" +
      " from up order by depth desc",
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
  /**
   * The step's default write areas (O45) and the run's own work item and
   * project. With them, a write no grant covers is still allowed in a declared
   * area; without them only a grant can cover it.
   */
  defaults?: Readonly<{
    declared: readonly AgentTreeArea[];
    own: AgentOwnPlaces;
  }>;
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
  // A write no grant covers may still land in one of the step's default write
  // areas (O45). The grant's own refusal stands for anywhere else, so a
  // withdrawn grant still says withdrawn.
  let fileGrantId: string | null;
  let grantedById: string;
  if (decision.refusal === undefined) {
    fileGrantId = decision.grant.id;
    grantedById = decision.grant.grantedById;
  } else {
    const defaults = scope.defaults;
    if (
      defaults === undefined ||
      !defaults.declared.includes(
        agentTreeAreaOf(chainEntries(chain), defaults.own),
      )
    ) forbidden(decision.refusal);
    fileGrantId = null;
    grantedById = scope.principalId;
  }
  const folder: AreaEntry = {
    policy: scope.target.policy,
    ownerId: scope.target.owner_id,
    systemKey: scope.target.system_key,
  };
  const area = agentAreaRefusal(folder, grantedById);
  if (area !== undefined) forbidden(area);
  // Layer 4: never beyond the person the agent acts for.
  const authority = principalAuthorityRefusal(folder, scope.principalId);
  if (authority !== undefined) forbidden(authority);
  return {
    attemptId: scope.attemptId,
    agentSessionId: scope.agentSessionId,
    fileGrantId,
  };
}

/** The work item and project of the run an attempt belongs to. */
async function ownPlaces(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  taskId: string | null,
): Promise<AgentOwnPlaces> {
  if (taskId === null) return { taskId: null, applicationId: null };
  const found = await tx.query<{ application_id: string | null }>(
    "select application_id from bakery.tasks" +
      " where organization_id = $1 and id = $2",
    [organizationId, taskId],
  );
  return { taskId, applicationId: found.rows[0]?.application_id ?? null };
}

export type AgentFileReadScope = Readonly<{
  organizationId: string;
  /** The person the session acts for (O50). */
  principalId: string;
  workflowId: string;
  /** The entry read: the folder listed or the file opened. */
  target: AgentFileTarget;
  /** The tree areas the step's files section reaches (O44), from its scopes. */
  declared: readonly AgentTreeArea[];
  own: AgentOwnPlaces;
  now: Date;
  /**
   * The entry is a declared output of the reviewer's own run tree (O47): a
   * reviewer reads it even where its files section and grants reach nothing.
   * Only the area axis gives way; /trash, /system and the principal's own
   * authority still decide.
   */
  reviewedOutput?: boolean;
  boundConnections?: readonly string[];
}>;

function underBoundConnection(
  entries: readonly ChainEntry[],
  bound: readonly string[],
): boolean {
  if (bound.length === 0) return false;
  if (entries.length === 1) return true;
  const mountKey = entries[1]?.systemKey;
  return bound.some((id) => connectionMountKey(id) === mountKey);
}

type ReadDecision = Readonly<{
  chain: readonly ChainRow[];
  grants: readonly AgentFileGrant[];
}>;

function agentReadRefusal(
  scope: AgentFileReadScope,
  decision: ReadDecision,
): AgentFileRefusal | "not_found" | undefined {
  const { chain } = decision;
  if (
    storageScopeRefusal(
      scope.organizationId,
      chain.map((row) => ({ organizationId: row.organization_id })),
    )
  ) return "not_found";
  const entries = chainEntries(chain);
  const area = agentTreeAreaOf(entries, scope.own);
  if (area === AgentTreeArea.Trash) return AgentFileRefusal.TrashArea;
  if (area === AgentTreeArea.System) return AgentFileRefusal.SystemArea;
  const grant = grantRefusal([...decision.grants], {
    organizationId: scope.organizationId,
    workflowId: scope.workflowId,
    access: AgentFileAccess.Read,
    folderChain: chain.map((row) => row.id),
    now: scope.now,
  });
  const refusal = scope.reviewedOutput === true
    ? undefined
    : agentReadAreaRefusal({
      area,
      declared: scope.declared,
      liveGrant: grant.grant,
      personalOwnerId: personalOwnerOf(entries),
      boundConnection: area === AgentTreeArea.Connections &&
        underBoundConnection(entries, scope.boundConnections ?? []),
    });
  if (refusal !== undefined) return refusal;
  if (
    !isVisibleTo({
      policy: scope.target.policy,
      ownerId: scope.target.owner_id,
      systemKey: scope.target.system_key,
    }, scope.principalId)
  ) return AgentFileRefusal.PrincipalCannotRead;
  return undefined;
}

async function liveGrantsOn(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  workflowId: string,
  folderIds: readonly string[],
): Promise<AgentFileGrant[]> {
  const grants = await tx.query<GrantRow>(
    "select id, organization_id, workflow_id, folder_id, access, granted_by," +
      " expires_at, revoked_at from bakery.agent_file_grants" +
      " where organization_id = $1 and workflow_id = $2" +
      " and folder_id = any($3::uuid[])",
    [organizationId, workflowId, [...folderIds]],
  );
  return grants.rows.map(toAgentFileGrant);
}

export async function assertAgentFileRead(
  tx: Pick<PgTransactionClient, "query">,
  scope: AgentFileReadScope,
): Promise<void> {
  const chain = await folderChain(tx, scope.organizationId, scope.target.id);
  const refusal = agentReadRefusal(scope, {
    chain,
    grants: await liveGrantsOn(
      tx,
      scope.organizationId,
      scope.workflowId,
      chain.map((row) => row.id),
    ),
  });
  if (refusal === "not_found") notFound();
  if (refusal !== undefined) forbidden(refusal);
}

async function folderChains(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  entryIds: readonly string[],
): Promise<Map<string, ChainRow[]>> {
  const found = await tx.query<ChainRow & { origin: string; depth: number }>(
    "with recursive up as (" +
      " select id as origin, id, parent_id, name, organization_id, system_key," +
      " policy, owner_id, 0 as depth" +
      " from bakery.storage_entries" +
      " where organization_id = $1 and id = any($2::uuid[])" +
      " union all" +
      " select up.origin, e.id, e.parent_id, e.name, e.organization_id," +
      " e.system_key, e.policy, e.owner_id, up.depth + 1" +
      " from bakery.storage_entries e" +
      " join up on e.organization_id = $1 and e.id = up.parent_id" +
      " where up.depth < 64)" +
      " select origin, id, name, organization_id, system_key, policy, owner_id," +
      " depth from up order by origin, depth desc",
    [organizationId, [...entryIds]],
  );
  const chains = new Map<string, ChainRow[]>();
  for (const row of found.rows) {
    const chain = chains.get(row.origin) ?? [];
    chain.push(row);
    chains.set(row.origin, chain);
  }
  return chains;
}

export async function agentReadableFileIds(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    targets: readonly AgentFileTarget[];
    now?: Date;
  }>,
): Promise<ReadonlySet<string>> {
  const ids = scope.targets.map((target) => target.id);
  if (context.agentSession === undefined) return new Set(ids);
  if (ids.length === 0) return new Set();
  const origin = await attemptOrigin(
    tx,
    scope.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) return new Set();
  const chains = await folderChains(tx, scope.organizationId, ids);
  const grants = await liveGrantsOn(
    tx,
    scope.organizationId,
    origin.workflowId,
    [...new Set([...chains.values()].flat().map((row) => row.id))],
  );
  const own = await ownPlaces(tx, scope.organizationId, origin.taskId);
  const isolation = await reviewerIsolationOf(
    tx,
    context,
    scope.organizationId,
  );
  const now = scope.now ?? new Date();
  const readable = new Set<string>();
  for (const target of scope.targets) {
    const chain = chains.get(target.id);
    if (chain === undefined) continue;
    const base = {
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      workflowId: origin.workflowId,
      target,
      declared: declaredTreeAreas(context.sessionScopes, AgentFileAccess.Read),
      boundConnections: boundConnectionsOf(context.sessionScopes),
      own,
      now,
    };
    let refusal = agentReadRefusal(base, { chain, grants });
    if (
      refusal !== undefined && refusal !== "not_found" && isolation !== null &&
      await reviewerDeclaredOutput(
        tx,
        isolation,
        scope.organizationId,
        target.id,
      )
    ) {
      refusal = agentReadRefusal({ ...base, reviewedOutput: true }, {
        chain,
        grants,
      });
    }
    if (refusal === undefined) readable.add(target.id);
  }
  return readable;
}

/**
 * The read guard as a storage read handler calls it: nothing for a person's
 * own request, a named refusal for an agent read its step may not make.
 */
export async function agentFileReadFor(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    target: AgentFileTarget;
    now?: Date;
  }>,
): Promise<void> {
  if (context.agentSession === undefined) return;
  const origin = await attemptOrigin(
    tx,
    scope.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) forbidden(AgentFileRefusal.AreaNotDeclared);
  await assertAgentFileRead(tx, {
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    workflowId: origin.workflowId,
    target: scope.target,
    declared: declaredTreeAreas(context.sessionScopes, AgentFileAccess.Read),
    boundConnections: boundConnectionsOf(context.sessionScopes),
    own: await ownPlaces(tx, scope.organizationId, origin.taskId),
    now: scope.now ?? new Date(),
    reviewedOutput: await reviewerDeclaredOutput(
      tx,
      await reviewerIsolationOf(tx, context, scope.organizationId),
      scope.organizationId,
      scope.target.id,
    ),
  });
}

export async function agentReadGrantedFolders(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession">,
  scope: Readonly<{
    organizationId: string;
    folderId: string;
    childIds: readonly string[];
    now?: Date;
  }>,
): Promise<{ folder: boolean; children: ReadonlySet<string> }> {
  if (context.agentSession === undefined) {
    return { folder: true, children: new Set(scope.childIds) };
  }
  const origin = await attemptOrigin(
    tx,
    scope.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) return { folder: false, children: new Set() };
  const chain = (await folderChain(tx, scope.organizationId, scope.folderId))
    .map((row) => row.id);
  const grants = await tx.query<GrantRow>(
    "select id, organization_id, workflow_id, folder_id, access, granted_by," +
      " expires_at, revoked_at from bakery.agent_file_grants" +
      " where organization_id = $1 and workflow_id = $2" +
      " and folder_id = any($3::uuid[])",
    [scope.organizationId, origin.workflowId, [...chain, ...scope.childIds]],
  );
  const live = grants.rows.map(toAgentFileGrant);
  const now = scope.now ?? new Date();
  const covers = (folderChain: readonly string[]) =>
    grantRefusal(live, {
      organizationId: scope.organizationId,
      workflowId: origin.workflowId,
      access: AgentFileAccess.Read,
      folderChain: [...folderChain],
      now,
    }).refusal === undefined;
  return {
    folder: covers(chain),
    children: new Set(
      scope.childIds.filter((childId) => covers([...chain, childId])),
    ),
  };
}

/** The tree areas an agent session's roots listing may show, or null for a person. */
export function agentDeclaredReadAreas(
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
): readonly AgentTreeArea[] | null {
  if (context.agentSession === undefined) return null;
  return declaredTreeAreas(context.sessionScopes, AgentFileAccess.Read);
}

/**
 * The guard as a storage handler calls it: null for a person's own request,
 * the attribution to audit for an allowed agent write, and a named refusal
 * otherwise. A session whose attempt belongs to no run has no workflow, so no
 * grant can cover it.
 */
export async function agentFileWriteFor(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession" | "sessionScopes">,
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
  // O47: a reviewer writes only its declared outputs, which reach the record
  // area through its step's result, never a storage write. Judged before any
  // grant is read, so a grant to the folder cannot reopen it.
  if (
    (await reviewerIsolationOf(tx, context, scope.organizationId)) !== null
  ) forbidden(AgentFileRefusal.ReviewerOutputsOnly);
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
    // O45: the step's declared write areas in its own work item and project,
    // which no grant is needed for. A read-access check (mv's source) takes
    // no defaults: it is judged on grants alone, as before.
    ...((scope.access ?? "write") === "write"
      ? {
        defaults: {
          declared: declaredTreeAreas(
            context.sessionScopes,
            AgentFileAccess.Write,
          ),
          own: await ownPlaces(tx, scope.organizationId, origin.taskId),
        },
      }
      : {}),
  });
}
