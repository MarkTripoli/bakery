/**
 * Bakery's own operations, offered to a session as tools (chapter 25 §18.1).
 *
 * The registry already exists and the web app already calls it; nothing new is
 * exposed here. What was missing is a way for an agent *inside* a session to
 * reach it, and the shape that solves it is the same one used for outside
 * connections: a tool gateway listing exactly the tools this session may call.
 *
 * Two rules do the work:
 *
 * - **The list is derived, never hand-written.** A tool the registry does not
 *   implement cannot be offered, and an operation added later cannot exist as a
 *   tool until someone gives it a scope *and* a definition. A curated second
 *   list would drift from the registry the moment either side changed.
 * - **A tool is only offered if the session may call it.** Reading is the
 *   default a definition gets (O44); a write tool appears only where the
 *   definition granted the scope. The gateway is an advertisement, not a check:
 *   the operation still authorises the call as it would a person's, because a
 *   list is not enforcement.
 */

import {
  type ActionDefinition,
  ActionKind,
} from "@bakery/contracts/action-registry";
import {
  type ImplementedActionName,
  implementedActions,
} from "@bakery/contracts/implemented-actions";
import { type OperationScope } from "./session-credential.ts";
import type { AgentPower } from "../auth/application/agent-power-grants.ts";

/**
 * The scope an operation needs to be offered as a tool.
 *
 * Reads are named by surface (`work.read`, `runs.read`, …); writes carry the
 * mutation itself (`workflows.publish`). A write's scope is *not* derivable
 * from its name alone — publishing and drafting a workflow are different
 * authorities on the same noun — so the map is explicit and a missing entry
 * means the operation is not offered at all.
 */
const OPERATION_SCOPES: Readonly<Record<string, OperationScope>> = Object
  .freeze({
    // Work items.
    "tasks.list": "work.read",
    "tasks.get": "work.read",
    // Starting work is a spawn (#413): off by default, granted as run_start,
    // and admitted under depth, count and budget checks at the action.
    "tasks.create": "runs.start",
    "runs.create": "runs.start",
    // Steering another agent is off by default (O52) and reaches only runs the
    // agent spawned; both operations are the ones a person uses.
    "sessions.steer": "runs.steer",
    "runSteps.note": "runs.steer",
    // Runs and their steps.
    "runs.list": "runs.read",
    "runs.get": "runs.read",
    "runSteps.list": "runs.read",
    "jobAttempts.list": "runs.read",
    // Artifacts.
    "artifacts.list": "artifacts.read",
    "artifacts.get": "artifacts.read",
    "artifactVersions.list": "artifacts.read",
    // The library: skills, agents and the drafts built from them.
    "skills.list": "library.read",
    "skills.get": "library.read",
    "agents.list": "library.read",
    "agents.get": "library.read",
    // A decision is off by default (O52): the scope is minted at claim only
    // where a grant covers the run's workflow, and the action rechecks the grant
    // live on every call, so a revoked grant stops the next call.
    "approvals.decide": "approvals.decide",
    // Controlling a run is off by default too (O52); same grant-then-scope rule.
    "runs.control": "runs.control",
    // One text search across skills, agents and artifacts. It has the list
    // operations' guard, and leaves artifacts out for a session without
    // `artifacts.read` (the dispatched context carries the session's scopes).
    "library.search": "library.read",
    // Bakery Files (#448, section 17.6): an agent writes files and folders
    // through the same storage operations a person uses. The scope only offers
    // the tools; it is minted where a person granted the workflow a folder,
    // and every call is judged again by the file grant guard, which checks the
    // grant's folder, access, expiry and revocation at the time of the write.
    // Granting itself, restore and the Admin purge are not offered: delegating
    // and destroying stay with people (O51).
    "storageFiles.put": "files.write",
    "storageFolders.create": "files.write",
    "storageEntries.copy": "files.write",
    "storageEntries.move": "files.write",
    "storageEntries.trash": "files.write",
    // The read half (O44): the roots, a folder's entries and a file's bytes,
    // offered where the step's files section reaches a tree area. Not a
    // blanket read: an inputs-only step (read: [inputs]) is never offered them, and
    // every call is judged again by the same layered guard as a write.
    "storageRoots.list": "files.read",
    "storageFolderEntries.list": "files.read",
    "storageFiles.content": "files.read",
    // A file's saved versions, the runs that used one, and what a version
    // belongs to (#404). These are the same tree read three more ways, and the
    // `bakery` CLI inside a session has commands for each: `history`, `uses` and
    // `open`. Without them those commands would exist, be listed by nobody, and
    // refuse for a reason an agent cannot act on. Reads only - a pin is an
    // administrator's write and stays off this map.
    "storageFileVersions.list": "files.read",
    "storageFileUses.list": "files.read",
    "storageFiles.byVersion": "files.read",
    "storageConnectionPaths.list": "files.read",
    "storageConnectionPaths.stat": "files.read",
    "storageConnectionPaths.read": "files.read",
    // Comments and work-item edits (#448 S9a, chapter 25 section 18.2: "the
    // same operations as people"). Draft comments are not offered: they run
    // through the draft routes' own staged execution, which a session call does
    // not enter. Off by default like every other write: the
    // scope is minted where a person granted the workflow the comment or
    // edit_work power, and the gateway checks that grant again on every call.
    // The operation still authorizes the call as the person the run is for.
    "artifactComments.create": "comments.write",
    "artifactComments.update": "comments.write",
    "tasks.update": "work.write",
    // Asking people (#414 slice 4): a step asks the role or group a person
    // named in its workflow's ask grant, through the same run requests a person
    // makes. Off by default; the action checks the grant and its audience live.
    "runRequests.create": "runs.ask",
    // Connection drafts (#448 S9b): an agent prepares a connection and a person
    // completes it. The operations refuse a secret, an organization-wide
    // connection and switching one on whenever an agent is the caller.
    "mcpConnections.create": "connections.draft",
    "mcpConnections.update": "connections.draft",
  });

/**
 * The session scope each granted agent power adds, and nothing else: the scope
 * only offers the tool, the grant is checked again when it is called. Powers
 * whose operations are not yet offered to a session add no scope.
 */
export const POWER_SESSION_SCOPES: Readonly<
  Record<AgentPower, readonly OperationScope[]>
> = Object.freeze({
  decide: Object.freeze(["approvals.decide"]),
  run_control: Object.freeze(["runs.control"]),
  run_start: Object.freeze(["runs.start"]),
  steer: Object.freeze(["runs.steer"]),
  // Reviewer steering rides on the steer scope; it only widens the target.
  steer_reviewer: Object.freeze([]),
  comment: Object.freeze(["comments.write"]),
  edit_work: Object.freeze(["work.write"]),
  draft_connection: Object.freeze(["connections.draft"]),
  ask: Object.freeze(["runs.ask"]),
});

/**
 * Powers whose operations check the grant themselves, live, on every call, and
 * refuse with their own named reason (spawn_requires_grant, steer_requires_grant,
 * agent_power_requires_grant, agent_power_grant_expired, ...). The gateway does
 * not check these again: a second, earlier check would answer a bare denial
 * and hide the reason the operation gives. The other powers (comments, work
 * edits, connection drafts) run operations that judge the call as the person,
 * so the gateway's check is the only grant check they get.
 */
export const ACTION_GUARDED_POWERS: ReadonlySet<AgentPower> = new Set([
  "decide",
  "run_control",
  "run_start",
  "steer",
  "ask",
]);

/**
 * The power whose grant a session scope stands for, or null for a scope that
 * is not a granted power (a read, or a files scope with its own grant).
 *
 * The gateway calls this to check the grant again at every call: holding the
 * scope proves the grant was live at claim, not that it still is.
 */
export function powerForSessionScope(scope: OperationScope): AgentPower | null {
  for (const [power, scopes] of Object.entries(POWER_SESSION_SCOPES)) {
    if (scopes.includes(scope)) return power as AgentPower;
  }
  return null;
}

export type SessionTool = Readonly<{
  /** The operation's own name; a tool is never an alias for something else. */
  name: ImplementedActionName;
  method: string;
  path: string;
  /** Scope a caller must hold; shown so a refusal is not a mystery. */
  scope: OperationScope;
  /** True for a read, so a definition can render tools without classification. */
  readOnly: boolean;
}>;

/**
 * Lists the tools this session may call.
 *
 * Ordered by name so the list is stable across calls: an agent that decides
 * what to do based on the list should see the same list twice, and a snapshot
 * digest (chapter 25 §15.4 pins one for outside servers) is only meaningful if
 * the order does not depend on registry construction.
 */
export function sessionOperationScopes(): readonly string[] {
  return Object.keys(OPERATION_SCOPES).sort();
}

/**
 * Every scope the operation map names, deduplicated and ordered.
 *
 * Distinct from `sessionOperationScopes`, which returns operation *names*. A
 * caller that wants "what may a session be granted" needs the scopes, and
 * deriving them from names is not possible - `tasks.list` and `tasks.get` share
 * `work.read`, and a future write scope will not end in the operation's noun.
 */
export function sessionOperationScopeValues(): readonly OperationScope[] {
  const values = Object.values(OPERATION_SCOPES);
  return [...new Set(values)].sort();
}

export function listSessionTools(
  scopes: readonly OperationScope[],
  registry: readonly ActionDefinition[],
): readonly SessionTool[] {
  const known = new Set<string>(implementedActions);
  const held = new Set(scopes);
  const tools: SessionTool[] = [];
  for (const action of registry) {
    // A registered action the contracts package does not know about is not a
    // tool, however convenient it would be: the two lists disagreeing is a bug
    // to surface, not something to route around.
    if (!known.has(action.name)) {
      throw new SessionToolError("SESSION_TOOL_UNKNOWN", action.name);
    }
    const scope = OPERATION_SCOPES[action.name];
    // No scope means no tool: an operation that was never classified for
    // sessions is not silently granted one.
    if (!scope || !held.has(scope)) continue;
    tools.push({
      name: action.name as ImplementedActionName,
      method: action.method,
      path: action.path,
      scope,
      readOnly: action.policy.type === ActionKind.Query,
    });
  }
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The operations O51 keeps with people (AC5): secrets, consent and grants,
 * and the destructive storage operations. A session asking for one is told
 * it is a person's operation; no scope may ever name one.
 */
export const PEOPLE_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "secrets.list",
  "secrets.get",
  "secrets.create",
  "secrets.rotate",
  "secrets.updatePolicy",
  "secrets.revoke",
  "integrationGrants.create",
  "permissionGrants.create",
  "agentPowerGrants.create",
  "definitionPublishGrants.create",
  "mcpUseGrants.create",
  "agentFileGrants.create",
  "agentFileGrants.revoke",
  "storageEntries.restore",
  "storageEntries.purge",
]);

/**
 * Refuses a session that may not call the operation it named.
 *
 * Separate from the list because asking for a tool you were not offered and
 * calling one anyway are the same refusal, and a caller reaching this has
 * usually skipped the list: the message naming the required scope is what makes
 * it fixable rather than mysterious.
 */
export function assertSessionToolAllowed(
  scopes: readonly OperationScope[],
  name: string,
): OperationScope {
  const scope = OPERATION_SCOPES[name];
  if (!scope) {
    // The operations O51 keeps with people are refused by name; any other
    // name no scope covers stays unknown to a session.
    if (PEOPLE_ONLY_OPERATIONS.has(name)) {
      throw new SessionToolError("SESSION_TOOL_PEOPLE_ONLY", name);
    }
    throw new SessionToolError("SESSION_TOOL_UNKNOWN", name);
  }
  if (!scopes.includes(scope)) {
    throw new SessionToolError("SESSION_TOOL_DENIED", name, scope);
  }
  return scope;
}

export class SessionToolError extends Error {
  constructor(
    readonly code:
      | "SESSION_TOOL_UNKNOWN"
      | "SESSION_TOOL_DENIED"
      | "SESSION_TOOL_PEOPLE_ONLY",
    readonly tool: string,
    readonly scope?: OperationScope,
  ) {
    super(
      code === "SESSION_TOOL_UNKNOWN"
        ? `no session tool named ${tool}`
        : code === "SESSION_TOOL_PEOPLE_ONLY"
        ? `${tool} is a person's operation, never a session's`
        : `session does not hold ${scope} for ${tool}`,
    );
    this.name = "SessionToolError";
  }
}
