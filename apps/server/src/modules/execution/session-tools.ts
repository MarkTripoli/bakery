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
    "tasks.create": "work.write",
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
  });

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
    throw new SessionToolError("SESSION_TOOL_UNKNOWN", name);
  }
  if (!scopes.includes(scope)) {
    throw new SessionToolError("SESSION_TOOL_DENIED", name, scope);
  }
  return scope;
}

export class SessionToolError extends Error {
  constructor(
    readonly code: "SESSION_TOOL_UNKNOWN" | "SESSION_TOOL_DENIED",
    readonly tool: string,
    readonly scope?: OperationScope,
  ) {
    super(
      code === "SESSION_TOOL_UNKNOWN"
        ? `no session tool named ${tool}`
        : `session does not hold ${scope} for ${tool}`,
    );
    this.name = "SessionToolError";
  }
}
