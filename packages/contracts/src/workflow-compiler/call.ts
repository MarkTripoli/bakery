import {
  createDiagnosticCollector,
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
} from "./diagnostics.ts";
import type { WorkflowJsonValue } from "./json-value.ts";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";
import { registeredActionMetadata } from "./registry.ts";
import type {
  WorkflowActionNode,
  WorkflowEffectKey,
  WorkflowExpressionNode,
  WorkflowLane,
  WorkflowNode,
  WorkflowReferenceNode,
  WorkflowSemanticDocument,
  WorkflowValueNode,
} from "./schema.ts";
import type { NodeLocations } from "./passes/shape.ts";

/**
 * Calling one workflow from another (#418, one engine O10). A `call` names a
 * published version of another workflow and binds its inputs. The compiler
 * inlines it: the called workflow's steps take the call's place under the
 * call's id, its inputs become the values the call passes, and what the call
 * exposes is exactly the outputs the called workflow declares. Nothing after
 * this pass knows a call existed, so every check, the worst case and the plan
 * see ordinary steps, approvals and waits included.
 *
 * Inlining is the first of the two bindings the design names; a child-run
 * binding later adds a named outcome a caller can branch on. Because a call
 * pins a published, immutable version, a workflow cannot reach itself, and
 * calls nest at most two levels.
 */

export type WorkflowCallNode = {
  kind: "call";
  id: string;
  needs: string[];
  if?: WorkflowExpressionNode | undefined;
  /** Published workflow version this call runs. */
  workflow: string;
  /** Value for each input of the called workflow. */
  with: Record<string, WorkflowValueNode>;
};

/** Published child versions by id: each is the version's authored definition. */
export type ChildWorkflows = ReadonlyMap<string, unknown>;

/** Shapes one authored child definition; supplied by the compiler entry point. */
export type ShapeChild = (
  definition: unknown,
  collector: DiagnosticCollector,
) => {
  readonly document: WorkflowSemanticDocument | undefined;
  readonly locations: NodeLocations;
};

type Substitute = (
  ref: WorkflowReferenceNode,
  at: string,
) => WorkflowValueNode | undefined;

type Refusal = (at: string, code: CallDiagnostic) => void;
type CallDiagnostic =
  | "call_input_unusable"
  | "call_output_unknown";

function isCall(node: WorkflowNode): node is WorkflowNode & WorkflowCallNode {
  return (node as { kind: string }).kind === "call";
}

// ---------------------------------------------------------------------------
// Value, expression and effect-key positions
// ---------------------------------------------------------------------------

function mapValue(
  value: WorkflowValueNode,
  sub: Substitute,
  at: string,
): WorkflowValueNode | undefined {
  switch (value.kind) {
    case "literal":
      return value;
    case "ref":
      return sub(value, at);
    case "list": {
      const items: WorkflowValueNode[] = [];
      for (const item of value.items) {
        const mapped = mapValue(item, sub, at);
        if (!mapped) return undefined;
        items.push(mapped);
      }
      // A list or object that no longer holds a reference is a literal, as the
      // normalizer would have made it had the author written it that way.
      return items.every((item) => item.kind === "literal")
        ? {
          kind: "literal",
          value: items.map((item) =>
            (item as { value: WorkflowJsonValue }).value
          ),
        }
        : { kind: "list", items };
    }
    case "object": {
      const fields: Record<string, WorkflowValueNode> = Object.create(null);
      for (const name of Object.keys(value.fields)) {
        const mapped = mapValue(value.fields[name]!, sub, at);
        if (!mapped) return undefined;
        fields[name] = mapped;
      }
      const names = Object.keys(fields);
      return names.every((name) => fields[name]!.kind === "literal")
        ? {
          kind: "literal",
          value: Object.fromEntries(
            names.map((name) => [
              name,
              (fields[name] as { value: WorkflowJsonValue }).value,
            ]),
          ),
        }
        : { kind: "object", fields };
    }
  }
}

function scalar(
  value: WorkflowJsonValue,
): string | number | boolean | null | undefined {
  return value === null || typeof value === "string" ||
      typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** A value a call passes, as an expression operand; undefined when it cannot be one. */
function valueToExpression(
  value: WorkflowValueNode,
): WorkflowExpressionNode | undefined {
  if (value.kind === "ref") return value;
  if (value.kind === "literal") {
    const plain = scalar(value.value);
    if (plain !== undefined) return { kind: "literal", value: plain };
    if (
      Array.isArray(value.value) &&
      value.value.every((item) => scalar(item) !== undefined)
    ) {
      return {
        kind: "list",
        items: value.value.map((item) => ({
          kind: "literal" as const,
          value: scalar(item)!,
        })),
      };
    }
  }
  return undefined;
}

function mapExpression(
  expression: WorkflowExpressionNode,
  sub: Substitute,
  at: string,
  refuse: Refusal,
): WorkflowExpressionNode | undefined {
  switch (expression.kind) {
    case "literal":
      return expression;
    case "ref": {
      const replacement = sub(expression, at);
      if (!replacement) return undefined;
      const operand = valueToExpression(replacement);
      if (!operand) {
        refuse(at, "call_input_unusable");
        return undefined;
      }
      return operand;
    }
    case "list": {
      const items: WorkflowExpressionNode[] = [];
      for (const item of expression.items) {
        const mapped = mapExpression(item, sub, at, refuse);
        if (!mapped) return undefined;
        items.push(mapped);
      }
      return { kind: "list", items };
    }
    case "not": {
      const operand = mapExpression(expression.operand, sub, at, refuse);
      return operand && { kind: "not", operand };
    }
    case "logical":
    case "compare": {
      const left = mapExpression(expression.left, sub, at, refuse);
      const right = mapExpression(expression.right, sub, at, refuse);
      if (!left || !right) return undefined;
      return { ...expression, left, right } as WorkflowExpressionNode;
    }
  }
}

function mapEffectKey(
  key: WorkflowEffectKey,
  sub: Substitute,
  at: string,
  refuse: Refusal,
): WorkflowEffectKey | undefined {
  const parts: WorkflowEffectKey["parts"] = [];
  for (const part of key.parts) {
    if (part.kind === "literal") {
      parts.push(part);
      continue;
    }
    const replacement = sub(part, at);
    if (!replacement) return undefined;
    if (replacement.kind === "ref") parts.push(replacement);
    else if (
      replacement.kind === "literal" && typeof replacement.value === "string"
    ) parts.push({ kind: "literal", value: replacement.value });
    else {
      refuse(at, "call_input_unusable");
      return undefined;
    }
  }
  return { kind: "effect_key", parts };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

type Mapper = {
  readonly sub: Substitute;
  readonly refuse: Refusal;
  readonly locations: NodeLocations;
  /** Leave call nodes as they are: their bindings were read in their own scope. */
  readonly keepCalls: boolean;
  ok: boolean;
};

function at(mapper: Mapper, node: object): string {
  return pointerOf(mapper.locations.get(node) ?? []);
}

function condition(
  mapper: Mapper,
  node: WorkflowNode,
  expression: WorkflowExpressionNode | undefined,
): WorkflowExpressionNode | undefined {
  if (!expression) return undefined;
  const mapped = mapExpression(
    expression,
    mapper.sub,
    at(mapper, node),
    mapper.refuse,
  );
  if (!mapped) mapper.ok = false;
  return mapped;
}

function value(
  mapper: Mapper,
  node: object,
  input: WorkflowValueNode,
): WorkflowValueNode {
  const mapped = mapValue(input, mapper.sub, at(mapper, node));
  if (!mapped) {
    mapper.ok = false;
    return input;
  }
  return mapped;
}

function expression(
  mapper: Mapper,
  node: object,
  input: WorkflowExpressionNode,
): WorkflowExpressionNode {
  const mapped = mapExpression(
    input,
    mapper.sub,
    at(mapper, node),
    mapper.refuse,
  );
  if (!mapped) {
    mapper.ok = false;
    return input;
  }
  return mapped;
}

function mapNodes(
  mapper: Mapper,
  nodes: readonly WorkflowNode[],
): WorkflowNode[] {
  return nodes.map((node) => mapNode(mapper, node));
}

function carry<T extends object>(mapper: Mapper, from: object, to: T): T {
  const where = mapper.locations.get(from);
  if (where) mapper.locations.set(to, where);
  return to;
}

function mapNode(mapper: Mapper, node: WorkflowNode): WorkflowNode {
  switch (node.kind) {
    case "action": {
      const mapped: WorkflowActionNode = {
        ...node,
        with: value(mapper, node, node.with),
      };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      if (node.inputs) {
        mapped.inputs = node.inputs.map((slot) => ({
          ...slot,
          from: value(mapper, node, slot.from),
        }));
      }
      if (node.effectKey) {
        const key = mapEffectKey(
          node.effectKey,
          mapper.sub,
          at(mapper, node),
          mapper.refuse,
        );
        if (key) mapped.effectKey = key;
        else mapper.ok = false;
      }
      return carry(mapper, node, mapped);
    }
    case "wait": {
      const mapped = { ...node };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
    case "sequence": {
      const mapped = { ...node, steps: mapNodes(mapper, node.steps) };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
    case "branch": {
      const outputs: typeof node.outputs = Object.create(null);
      for (const name of Object.keys(node.outputs)) {
        const arms = node.outputs[name]!;
        outputs[name] = {
          ...(arms.then ? { then: value(mapper, node, arms.then) } : {}),
          ...(arms.else ? { else: value(mapper, node, arms.else) } : {}),
        };
      }
      const mapped = {
        ...node,
        when: expression(mapper, node, node.when),
        then: mapNodes(mapper, node.then),
        else: mapNodes(mapper, node.else),
        outputs,
      };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
    case "repeat": {
      const seed = node.seed.form === "mapping"
        ? {
          form: "mapping" as const,
          currentCandidate: value(mapper, node, node.seed.currentCandidate),
        }
        : {
          form: "sequence" as const,
          steps: mapNodes(mapper, node.seed.steps),
          currentCandidate: value(mapper, node, node.seed.currentCandidate),
        };
      const mapped = {
        ...node,
        seed,
        until: expression(mapper, node, node.until),
        steps: mapNodes(mapper, node.steps),
        currentCandidate: value(mapper, node, node.currentCandidate),
      };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
    case "forEach": {
      const mapped = {
        ...node,
        items: value(mapper, node, node.items),
        steps: mapNodes(mapper, node.steps),
      };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
    case "parallel": {
      const outputs: typeof node.outputs = Object.create(null);
      for (const lane of Object.keys(node.outputs)) {
        const names: Record<string, WorkflowValueNode> = Object.create(null);
        for (const name of Object.keys(node.outputs[lane]!)) {
          names[name] = value(mapper, node, node.outputs[lane]![name]!);
        }
        outputs[lane] = names;
      }
      const lanes: WorkflowLane[] = node.lanes.map((lane) =>
        carry(mapper, lane, { ...lane, steps: mapNodes(mapper, lane.steps) })
      );
      const mapped = { ...node, lanes, outputs };
      if (node.if) mapped.if = condition(mapper, node, node.if);
      return carry(mapper, node, mapped);
    }
  }
  return mapCall(
    mapper,
    node as unknown as WorkflowCallNode,
  ) as unknown as WorkflowNode;
}

/**
 * A call is a node here only while its parent is being read; its bindings
 * were already read in the scope the call was written in.
 */
function mapCall(mapper: Mapper, call: WorkflowCallNode): WorkflowCallNode {
  if (mapper.keepCalls) return call;
  const bindings: Record<string, WorkflowValueNode> = Object.create(null);
  for (const name of Object.keys(call.with)) {
    bindings[name] = value(mapper, call, call.with[name]!);
  }
  const mapped: WorkflowCallNode = { ...call, with: bindings };
  if (call.if) {
    mapped.if = condition(mapper, call as unknown as WorkflowNode, call.if);
  }
  return carry(mapper, call, mapped);
}

// ---------------------------------------------------------------------------
// Inlining
// ---------------------------------------------------------------------------

type Callee = {
  /** Qualified path of the call, which is where its steps now live. */
  readonly qualified: readonly string[];
  readonly outputs: Readonly<Record<string, WorkflowReferenceNode>>;
};

type Graft = {
  readonly call: WorkflowCallNode;
  readonly sequence: WorkflowNode;
  readonly callee: Callee;
};

function agentStamped(
  nodes: readonly WorkflowNode[],
  agents: WorkflowSemanticDocument["agents"],
  locations: NodeLocations,
): WorkflowNode[] {
  const visit = (node: WorkflowNode): WorkflowNode => {
    const copy = <T extends WorkflowNode>(next: T): T => {
      const where = locations.get(node);
      if (where) locations.set(next, where);
      return next;
    };
    switch (node.kind) {
      case "action": {
        if (node.agentVersionId !== undefined) return node;
        const bound = agents[node.action];
        const model = registeredActionMetadata(node.action)?.capabilities
          .includes("model") === true;
        return bound && model ? copy({ ...node, agentVersionId: bound }) : node;
      }
      case "wait":
        return node;
      case "sequence":
      case "forEach":
        return copy({ ...node, steps: node.steps.map(visit) });
      case "branch":
        return copy({
          ...node,
          then: node.then.map(visit),
          else: node.else.map(visit),
        });
      case "repeat":
        return copy({
          ...node,
          seed: node.seed.form === "sequence"
            ? { ...node.seed, steps: node.seed.steps.map(visit) }
            : node.seed,
          steps: node.steps.map(visit),
        });
      case "parallel":
        return copy({
          ...node,
          lanes: node.lanes.map((lane) => ({
            ...lane,
            steps: lane.steps.map(visit),
          })),
        });
    }
  };
  return nodes.map(visit);
}

/**
 * Replaces every call in `document` with the called workflow's steps. Mutates
 * the document and its location map in place; reports to `collector` and
 * leaves the call nodes it could not expand, which stops compilation.
 */
export function inlineWorkflowCalls(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  children: ChildWorkflows,
  shapeChild: ShapeChild,
  collector: DiagnosticCollector,
  level = 1,
): void {
  const callees = new Map<string, Callee>();

  /**
   * What the rest of the workflow reads from a call is the call's declared
   * outputs and nothing else: a reference to a call's inner step or outcome
   * is refused, so a child's internals stay its own.
   */
  const external: Substitute = (ref, pointer) => {
    if (ref.root !== "step") return ref;
    for (let length = ref.path.length - 1; length >= 1; length--) {
      const callee = callees.get(ref.path.slice(0, length).join("."));
      if (!callee) continue;
      const source = callee.outputs[ref.path[length]!];
      if (!source) {
        collector.add(pointer, "call_output_unknown");
        return undefined;
      }
      return {
        ...source,
        path: [...source.path, ...ref.path.slice(length + 1)],
      };
    }
    return ref;
  };

  const expand = (
    call: WorkflowCallNode,
    qualified: readonly string[],
  ): Graft | undefined => {
    const where = locations.get(call) ?? [];
    const here = (...extra: PointerSegment[]) =>
      pointerOf([...where, ...extra]);
    if (level > WORKFLOW_COMPILER_LIMITS.callDepth) {
      collector.add(here(), "call_depth_exceeded");
      return undefined;
    }
    const definition = children.get(call.workflow);
    if (definition === undefined) {
      collector.add(here("call", "workflow"), "call_version_unavailable");
      return undefined;
    }
    const childCollector = createDiagnosticCollector();
    const shaped = shapeChild(definition, childCollector);
    if (!shaped.document || childCollector.size > 0) {
      collector.add(here(), "call_child_invalid");
      return undefined;
    }
    const child = shaped.document;
    inlineWorkflowCalls(
      child,
      shaped.locations,
      children,
      shapeChild,
      childCollector,
      level + 1,
    );
    if (childCollector.size > 0) {
      const deep = childCollector.list().some((d) =>
        d.code === "call_depth_exceeded"
      );
      collector.add(
        here(),
        deep ? "call_depth_exceeded" : "call_child_invalid",
      );
      return undefined;
    }

    // The call binds exactly the child's declared inputs.
    let bound = true;
    for (const name of Object.keys(call.with)) {
      if (!Object.hasOwn(child.inputs, name)) {
        collector.add(here("call", "with"), "call_input_unknown");
        bound = false;
      }
    }
    for (const [name, declared] of Object.entries(child.inputs)) {
      if (declared.required && !Object.hasOwn(call.with, name)) {
        collector.add(here("call", "with"), "call_input_missing");
        bound = false;
      }
    }
    if (!bound) return undefined;
    // A tool pin is taken at publish against the version that holds the step,
    // so a step inlined from another version would run without one.
    const usesTool = (nodes: readonly WorkflowNode[]): boolean =>
      nodes.some((node) => {
        switch (node.kind) {
          case "action":
            return node.action === "tool.call";
          case "wait":
            return false;
          case "sequence":
          case "forEach":
            return usesTool(node.steps);
          case "branch":
            return usesTool(node.then) || usesTool(node.else);
          case "repeat":
            return usesTool(node.steps) ||
              (node.seed.form === "sequence" && usesTool(node.seed.steps));
          case "parallel":
            return node.lanes.some((lane) => usesTool(lane.steps));
        }
      });
    if (usesTool(child.steps)) {
      collector.add(here(), "call_action_unsupported");
      return undefined;
    }

    // A value the call passes is read in the scope the call was written in, so
    // an output of an earlier call is already what that call exposes.
    const given: Record<string, WorkflowValueNode> = Object.create(null);
    for (const name of Object.keys(call.with)) {
      const mapped = mapValue(call.with[name]!, external, here());
      if (!mapped) return undefined;
      given[name] = mapped;
    }

    let refused = false;
    const refuse: Refusal = (_pointer, code) => {
      collector.add(here(), code);
      refused = true;
    };
    const substitute: Substitute = (ref) => {
      if (ref.root === "step") {
        return { ...ref, path: [...qualified, ...ref.path] };
      }
      if (ref.root !== "input") return ref;
      const [name, ...rest] = ref.path;
      const passed = Object.hasOwn(given, name!)
        ? given[name!]!
        : { kind: "literal" as const, value: null };
      if (rest.length === 0) return passed;
      if (passed.kind === "ref") {
        return { ...passed, path: [...passed.path, ...rest] };
      }
      let current: WorkflowJsonValue | undefined = passed.kind === "literal"
        ? passed.value
        : undefined;
      for (const field of rest) {
        current = current !== null && typeof current === "object" &&
            !Array.isArray(current)
          ? (current as Record<string, WorkflowJsonValue>)[field]
          : undefined;
      }
      if (current === undefined) {
        refuse(here(), "call_input_unusable");
        return undefined;
      }
      return { kind: "literal", value: current };
    };
    const mapper: Mapper = {
      sub: substitute,
      refuse,
      locations: shaped.locations,
      keepCalls: false,
      ok: true,
    };
    const mapped = mapNodes(mapper, child.steps);
    if (!mapper.ok || refused) return undefined;
    const stamped = agentStamped(mapped, child.agents, shaped.locations);

    const outputs: Record<string, WorkflowReferenceNode> = Object.create(null);
    for (const name of Object.keys(child.outputs ?? {})) {
      const source = substitute(child.outputs![name]!, "");
      if (!source || source.kind !== "ref") return undefined;
      outputs[name] = source;
    }

    // Everything the child's nodes were located at is the call, so a finding
    // on an inlined step points at the call that brought it in.
    const reassign = (node: WorkflowNode): void => {
      locations.set(node, where);
      const kids: WorkflowNode[] = [];
      if ("steps" in node) kids.push(...node.steps);
      if (node.kind === "branch") kids.push(...node.then, ...node.else);
      if (node.kind === "repeat" && node.seed.form === "sequence") {
        kids.push(...node.seed.steps);
      }
      if (node.kind === "parallel") {
        for (const lane of node.lanes) {
          locations.set(lane, where);
          kids.push(...lane.steps);
        }
      }
      for (const kid of kids) reassign(kid);
    };
    const sequence: WorkflowNode = {
      kind: "sequence",
      id: call.id,
      needs: call.needs,
      steps: stamped,
    };
    if (call.if) sequence.if = call.if;
    for (const step of stamped) reassign(step);
    locations.set(sequence, where);
    return { call, sequence, callee: { qualified, outputs } };
  };

  /** Expands each call in document order, with the qualified path its steps get. */
  const grafts = new Map<string, Graft>();
  const find = (nodes: readonly WorkflowNode[], prefix: readonly string[]) => {
    for (const node of nodes) {
      const next = [...prefix, node.id];
      if (isCall(node)) {
        const graft = expand(node, next);
        if (graft) {
          grafts.set(next.join("."), graft);
          callees.set(next.join("."), graft.callee);
        }
        continue;
      }
      switch (node.kind) {
        case "sequence":
        case "forEach":
          find(node.steps, next);
          break;
        case "branch":
          find(node.then, next);
          find(node.else, next);
          break;
        case "repeat":
          if (node.seed.form === "sequence") find(node.seed.steps, next);
          find(node.steps, next);
          break;
        case "parallel":
          for (const lane of node.lanes) find(lane.steps, [...next, lane.id]);
          break;
      }
    }
  };
  find(document.steps, []);
  if (collector.size > 0) return;

  // The rest of the workflow reads only what calls declare. The calls
  // themselves were read above, in their own scope.
  const outer: Mapper = {
    sub: external,
    refuse: (pointer, code) => collector.add(pointer, code),
    locations,
    keepCalls: true,
    ok: true,
  };
  const rewritten = mapNodes(outer, document.steps);
  if (!outer.ok || collector.size > 0) return;
  if (document.outputs) {
    for (const name of Object.keys(document.outputs)) {
      const mapped = external(document.outputs[name]!, pointerOf(["outputs"]));
      if (!mapped || mapped.kind !== "ref") return;
      document.outputs[name] = mapped;
    }
  }

  // Put each call's steps where the call stood. The tree was copied above, so
  // the swap happens in place and the location map keeps pointing at its nodes.
  const swap = (nodes: WorkflowNode[], prefix: readonly string[]): void => {
    nodes.forEach((node, index) => {
      const next = [...prefix, node.id];
      if (isCall(node)) {
        const graft = grafts.get(next.join("."));
        if (graft) nodes[index] = graft.sequence;
        return;
      }
      switch (node.kind) {
        case "sequence":
        case "forEach":
          swap(node.steps, next);
          break;
        case "branch":
          swap(node.then, next);
          swap(node.else, next);
          break;
        case "repeat":
          if (node.seed.form === "sequence") swap(node.seed.steps, next);
          swap(node.steps, next);
          break;
        case "parallel":
          for (const lane of node.lanes) swap(lane.steps, [...next, lane.id]);
          break;
      }
    });
  };
  swap(rewritten, []);
  document.steps = rewritten;
}
