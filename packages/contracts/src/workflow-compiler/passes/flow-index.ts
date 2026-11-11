import type { PointerSegment } from "../diagnostics.ts";
import type { ValueType } from "../types.ts";
import type { WorkflowNode, WorkflowSemanticDocument } from "../schema.ts";
import type { NodeLocations } from "./shape.ts";

/** Kind of identifier namespace a node list belongs to. */
export type ScopeKind =
  | "root"
  | "sequence"
  | "then"
  | "else"
  | "seed"
  | "body"
  | "lane";

/** One ordered list of sibling nodes sharing an identifier namespace. */
export type Scope = {
  readonly uid: number;
  readonly kind: ScopeKind;
  /** Node that owns this scope; undefined for the workflow root. */
  readonly owner: FlowNode | undefined;
  /** Lane identifier, present on lane scopes only. */
  readonly laneId: string | undefined;
  readonly members: FlowNode[];
  readonly byId: Map<string, FlowNode>;
};

/** Node with its scope, position and the type facts later passes record. */
export type FlowNode = {
  readonly uid: number;
  readonly node: WorkflowNode;
  /** Authored pointer segments of the node. */
  readonly path: readonly PointerSegment[];
  readonly scope: Scope;
  readonly index: number;
  /** Child scopes in authored order (arms, seed, body, lanes). */
  readonly scopes: Scope[];
  readonly lanes: Map<string, Scope>;
  seedScope: Scope | undefined;
  bodyScope: Scope | undefined;
  thenScope: Scope | undefined;
  elseScope: Scope | undefined;
  guards: Set<string> | undefined;
  guardsBusy: boolean;
  /** Repeat candidate type; undefined when unknown. */
  candidate: ValueType | undefined;
  /** Branch output name to type; a missing entry or undefined means unknown. */
  branchExports: Map<string, ValueType | undefined>;
  /** Lane identifier to export name to type. */
  laneExports: Map<string, Map<string, ValueType | undefined>>;
};

export type FlowIndex = {
  readonly root: Scope;
  /** Every scope, in creation order. */
  readonly scopes: readonly Scope[];
  /** Flow node by node object identity. */
  readonly nodeOf: ReadonlyMap<object, FlowNode>;
};

/** Where a read happens: a position within a scope plus its owning node. */
export type Reader = {
  readonly scope: Scope;
  /** Position among the scope's members; the member count for an end position. */
  readonly index: number;
  /** Node whose field is being read; undefined for none. */
  readonly self: FlowNode | undefined;
  /** Enclosing repeat that `$repeat` names, if any. */
  readonly repeat: FlowNode | undefined;
  readonly guards: ReadonlySet<string>;
};

/**
 * Indexes a normalized document into scopes. Direct children of a sequence,
 * both branch arms, a repeat's seed and body steps (separate lists sharing
 * one namespace) and each lane's steps are scopes. Identifier uniqueness was
 * already enforced by the index pass, so lookups are unambiguous.
 */
export function buildFlowIndex(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
): FlowIndex {
  let uid = 0;
  const scopes: Scope[] = [];
  const nodeOf = new Map<object, FlowNode>();

  function makeScope(
    kind: ScopeKind,
    owner: FlowNode | undefined,
    laneId?: string,
  ): Scope {
    const scope: Scope = {
      uid: uid++,
      kind,
      owner,
      laneId,
      members: [],
      byId: new Map(),
    };
    scopes.push(scope);
    return scope;
  }

  function fill(scope: Scope, nodes: readonly WorkflowNode[]): void {
    nodes.forEach((node, index) => {
      const flow: FlowNode = {
        uid: uid++,
        node,
        path: locations.get(node) ?? [],
        scope,
        index,
        scopes: [],
        lanes: new Map(),
        seedScope: undefined,
        bodyScope: undefined,
        thenScope: undefined,
        elseScope: undefined,
        guards: undefined,
        guardsBusy: false,
        candidate: undefined,
        branchExports: new Map(),
        laneExports: new Map(),
      };
      scope.members.push(flow);
      scope.byId.set(node.id, flow);
      nodeOf.set(node, flow);
      expand(flow);
    });
  }

  function expand(flow: FlowNode): void {
    const node = flow.node;
    switch (node.kind) {
      case "action":
      case "wait":
        return;
      case "sequence": {
        const scope = makeScope("sequence", flow);
        flow.scopes.push(scope);
        fill(scope, node.steps);
        return;
      }
      case "branch": {
        flow.thenScope = makeScope("then", flow);
        flow.elseScope = makeScope("else", flow);
        flow.scopes.push(flow.thenScope, flow.elseScope);
        fill(flow.thenScope, node.then);
        fill(flow.elseScope, node.else);
        return;
      }
      case "repeat": {
        if (node.seed.form === "sequence") {
          flow.seedScope = makeScope("seed", flow);
          flow.scopes.push(flow.seedScope);
          fill(flow.seedScope, node.seed.steps);
        }
        flow.bodyScope = makeScope("body", flow);
        flow.scopes.push(flow.bodyScope);
        fill(flow.bodyScope, node.steps);
        return;
      }
      case "parallel": {
        for (const lane of node.lanes) {
          const scope = makeScope("lane", flow, lane.id);
          flow.scopes.push(scope);
          flow.lanes.set(lane.id, scope);
          fill(scope, lane.steps);
        }
        return;
      }
    }
  }

  const root = makeScope("root", undefined);
  fill(root, document.steps);
  return { root, scopes, nodeOf };
}

/**
 * Nearest enclosing repeat whose body contains the scope. Seed scopes belong
 * to the repeat's outer context, so the walk skips past the owning repeat.
 */
export function repeatContext(scope: Scope): FlowNode | undefined {
  let current: Scope | undefined = scope;
  while (current) {
    if (current.kind === "body") return current.owner;
    current = current.owner?.scope;
  }
  return undefined;
}

/** True when the scope is the reader's scope or one of its enclosing scopes. */
export function insideScope(reader: Reader, scope: Scope): boolean {
  let current: Scope | undefined = reader.scope;
  while (current) {
    if (current === scope) return true;
    current = current.owner?.scope;
  }
  return false;
}

/** Lane scope of `group` that contains the reader, if any. */
export function laneScopeOf(
  reader: Reader,
  group: FlowNode,
): Scope | undefined {
  let current: Scope | undefined = reader.scope;
  while (current) {
    if (current.kind === "lane" && current.owner === group) return current;
    current = current.owner?.scope;
  }
  return undefined;
}

/**
 * Guard tokens that must hold for a scope to run: the owner's guards plus the
 * arm token of a branch arm.
 */
export function guardsOfScope(scope: Scope): ReadonlySet<string> {
  const owner = scope.owner;
  if (!owner) return new Set();
  const guards = new Set(guardsOf(owner));
  if (scope.kind === "then" || scope.kind === "else") {
    guards.add(`arm:${scope.uid}`);
  }
  return guards;
}

/**
 * Guard tokens of a node: its own `if`, those of enclosing arms and
 * ancestors, and those of every node it transitively needs (skipping
 * propagates only through `needs`). Cycle-safe: a node revisited while its
 * guards are computed contributes nothing.
 */
export function guardsOf(flow: FlowNode): ReadonlySet<string> {
  if (flow.guards) return flow.guards;
  if (flow.guardsBusy) return new Set();
  flow.guardsBusy = true;
  const guards = new Set(guardsOfScope(flow.scope));
  if (flow.node.if) guards.add(`if:${flow.uid}`);
  for (const id of flow.node.needs) {
    const needed = flow.scope.byId.get(id);
    if (needed && needed !== flow) {
      for (const token of guardsOf(needed)) guards.add(token);
    }
  }
  flow.guardsBusy = false;
  flow.guards = guards;
  return guards;
}

/** Reader for the fields of a node itself (`with`, `if`, `when`, seed mapping). */
export function readerAt(
  flow: FlowNode,
  repeat: FlowNode | undefined = repeatContext(flow.scope),
): Reader {
  return {
    scope: flow.scope,
    index: flow.index,
    self: flow,
    repeat,
    guards: guardsOf(flow),
  };
}

/** Reader positioned after the last member of a scope, on behalf of `owner`. */
export function readerEndOf(scope: Scope, owner: FlowNode): Reader {
  return {
    scope,
    index: scope.members.length,
    self: owner,
    repeat: repeatContext(scope),
    guards: guardsOfScope(scope),
  };
}

type Position = { readonly scope: Scope; readonly index: number };

function chainOf(scope: Scope, index: number): Position[] {
  const chain: Position[] = [{ scope, index }];
  let current = scope;
  while (current.owner) {
    chain.push({ scope: current.owner.scope, index: current.owner.index });
    current = current.owner.scope;
  }
  return chain.reverse();
}

export type Order =
  | { readonly kind: "before" }
  | { readonly kind: "self" }
  | { readonly kind: "future" }
  | { readonly kind: "diverge"; readonly owner: FlowNode };

/**
 * Whether `target` completes before the reader runs. Both positions are
 * compared outermost first: the first differing scope or index decides.
 * Different scopes of one owner (arms, seed against body, lanes) report that
 * owner; a target that is an ancestor of the reader, or reads that sit before
 * the target, are in the future.
 */
export function orderOf(target: FlowNode, reader: Reader): Order {
  const targetChain = chainOf(target.scope, target.index);
  const readerChain = chainOf(reader.scope, reader.index);
  const shared = Math.min(targetChain.length, readerChain.length);
  for (let position = 0; position < shared; position += 1) {
    const left = targetChain[position]!;
    const right = readerChain[position]!;
    if (left.scope !== right.scope) {
      const owner = left.scope.owner;
      return owner ? { kind: "diverge", owner } : { kind: "future" };
    }
    if (left.index !== right.index) {
      return left.index < right.index ? { kind: "before" } : {
        kind: "future",
      };
    }
  }
  return targetChain.length === readerChain.length
    ? { kind: "self" }
    : { kind: "future" };
}

/** Lane identifiers that must complete before `laneId` starts, transitively. */
export function prerequisiteLanes(
  group: FlowNode,
  laneId: string,
): ReadonlySet<string> {
  const node = group.node;
  if (node.kind !== "parallel") return new Set();
  const needsOf = new Map<string, readonly string[]>();
  for (const lane of node.lanes) needsOf.set(lane.id, lane.needs);
  const seen = new Set<string>();
  const stack = [...(needsOf.get(laneId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of needsOf.get(id) ?? []) stack.push(next);
  }
  return seen;
}
