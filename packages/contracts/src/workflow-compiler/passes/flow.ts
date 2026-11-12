import { UNTYPED_CATALOG, type WorkflowCompilerCatalog } from "../catalog.ts";
import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
} from "../diagnostics.ts";
import type {
  WorkflowActionNode,
  WorkflowBranchNode,
  WorkflowParallelNode,
  WorkflowRepeatNode,
  WorkflowSemanticDocument,
} from "../schema.ts";
import type { WorkflowJsonValue } from "../json-value.ts";
import { isSecretName } from "../secrets.ts";
import { isAssignable, literalMatches, type ValueType } from "../types.ts";
import {
  buildFlowIndex,
  type FlowIndex,
  type FlowNode,
  readerAt,
  readerEndOf,
  type Scope,
} from "./flow-index.ts";
import { inputTypesOf } from "./references.ts";
import type { NodeLocations } from "./shape.ts";
import {
  type AnalysisEnv,
  type Analyzed,
  analyzeValue,
  checkCondition,
  checkEffectKey,
  matchesType,
} from "./types.ts";

function nullableOf(type: ValueType): ValueType {
  return type.kind === "nullable" || type.kind === "null" ||
      type.kind === "json"
    ? type
    : { kind: "nullable", inner: type };
}

function checkAction(
  env: AnalysisEnv,
  flow: FlowNode,
  node: WorkflowActionNode,
): void {
  const reader = readerAt(flow);
  const schema = env.catalog.resolveAction(node.action)?.input.fields;
  const withPath: PointerSegment[] = [...flow.path, "with"];
  const value = node.with;
  if (!schema) {
    const names = value.kind === "object"
      ? Object.keys(value.fields)
      : value.kind === "literal" && typeof value.value === "object" &&
          value.value !== null && !Array.isArray(value.value)
      ? Object.keys(value.value)
      : [];
    if (names.some(isSecretName)) {
      env.collector.add(pointerOf(withPath), "input_secret_forbidden");
    }
  }
  if (value.kind === "object") {
    for (const name of Object.keys(value.fields)) {
      const member = schema?.get(name);
      const path = member ? [...withPath, name] : withPath;
      const analyzed = analyzeValue(env, reader, value.fields[name]!, path);
      if (member && !member.sensitive && !matchesType(analyzed, member.type)) {
        env.collector.add(pointerOf(path), "type_mismatch");
      }
    }
  } else if (
    value.kind === "literal" && typeof value.value === "object" &&
    value.value !== null && !Array.isArray(value.value) && schema
  ) {
    const literal = value.value as Record<string, WorkflowJsonValue>;
    for (const name of Object.keys(literal)) {
      const member = schema.get(name);
      if (
        member && !member.sensitive &&
        !literalMatches(literal[name]!, member.type)
      ) {
        env.collector.add(pointerOf([...withPath, name]), "type_mismatch");
      }
    }
  }
  if (node.effectKey) {
    const path = [...flow.path, "effectKey"];
    const keyType = checkEffectKey(env, reader, node.effectKey, path);
    const target = schema?.get("effectKey")?.type;
    if (target && !isAssignable(keyType, target)) {
      env.collector.add(pointerOf(path), "type_mismatch");
    }
  }
}

/** Common type of the two arms of a branch output; undefined when none fits. */
function branchOutputType(
  thenType: ValueType | undefined,
  elseType: ValueType | undefined,
  hasThen: boolean,
  hasElse: boolean,
): { type: ValueType | undefined; invalid: boolean } {
  if (hasThen && hasElse) {
    if (!thenType || !elseType) return { type: undefined, invalid: false };
    if (isAssignable(elseType, thenType)) {
      return { type: thenType, invalid: false };
    }
    if (isAssignable(thenType, elseType)) {
      return { type: elseType, invalid: false };
    }
    return { type: undefined, invalid: true };
  }
  const only = hasThen ? thenType : elseType;
  return { type: only ? nullableOf(only) : undefined, invalid: false };
}

function checkBranch(
  env: AnalysisEnv,
  flow: FlowNode,
  node: WorkflowBranchNode,
): void {
  const outputsPath: PointerSegment[] = [...flow.path, "branch", "outputs"];
  for (const name of Object.keys(node.outputs)) {
    const entry = node.outputs[name]!;
    const types: Record<"then" | "else", ValueType | undefined> = {
      then: undefined,
      else: undefined,
    };
    for (const arm of ["then", "else"] as const) {
      const value = entry[arm];
      if (!value) continue;
      const scope = arm === "then" ? flow.thenScope! : flow.elseScope!;
      types[arm] = analyzeValue(
        env,
        readerEndOf(scope, flow),
        value,
        [...outputsPath, name, arm],
      ).type;
    }
    const joined = branchOutputType(
      types.then,
      types.else,
      entry.then !== undefined,
      entry.else !== undefined,
    );
    if (joined.invalid) {
      env.collector.add(
        pointerOf([...outputsPath, name]),
        "branch_outputs_invalid",
      );
    }
    flow.branchExports.set(name, joined.type);
  }
}

function visitScope(env: AnalysisEnv, scope: Scope): void {
  for (const member of scope.members) visitNode(env, member);
}

function checkRepeat(
  env: AnalysisEnv,
  flow: FlowNode,
  node: WorkflowRepeatNode,
): void {
  const base: PointerSegment[] = [...flow.path, "repeat"];
  let seed: Analyzed;
  if (node.seed.form === "mapping") {
    seed = analyzeValue(
      env,
      readerAt(flow),
      node.seed.currentCandidate,
      [...base, "seed", "currentCandidate"],
    );
  } else {
    visitScope(env, flow.seedScope!);
    seed = analyzeValue(
      env,
      readerEndOf(flow.seedScope!, flow),
      node.seed.currentCandidate,
      [...base, "seed", "outputs", "currentCandidate"],
    );
  }
  flow.candidate = seed.type;
  checkCondition(env, readerAt(flow, flow), node.until, [...base, "until"]);
  visitScope(env, flow.bodyScope!);
  const outputsPath = [...base, "outputs", "currentCandidate"];
  const produced = analyzeValue(
    env,
    readerEndOf(flow.bodyScope!, flow),
    node.currentCandidate,
    outputsPath,
  );
  if (seed.type && !matchesType(produced, seed.type)) {
    env.collector.add(pointerOf(outputsPath), "type_mismatch");
  }
}

/** Lane identifiers ordered so every lane follows its prerequisites. */
function laneOrder(node: WorkflowParallelNode): string[] {
  const ids = new Map(node.lanes.map((lane) => [lane.id, lane]));
  const done = new Set<string>();
  const order: string[] = [];
  for (const lane of node.lanes) {
    const stack: { id: string; next: number }[] = [{ id: lane.id, next: 0 }];
    const open = new Set<string>([lane.id]);
    if (done.has(lane.id)) continue;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const current = ids.get(frame.id)!;
      if (frame.next >= current.needs.length) {
        stack.pop();
        open.delete(frame.id);
        if (!done.has(frame.id)) {
          done.add(frame.id);
          order.push(frame.id);
        }
        continue;
      }
      const target = current.needs[frame.next]!;
      frame.next += 1;
      if (ids.has(target) && !done.has(target) && !open.has(target)) {
        open.add(target);
        stack.push({ id: target, next: 0 });
      }
    }
  }
  return order;
}

function checkParallel(
  env: AnalysisEnv,
  flow: FlowNode,
  node: WorkflowParallelNode,
): void {
  for (const laneId of laneOrder(node)) {
    const scope = flow.lanes.get(laneId)!;
    visitScope(env, scope);
    const exported = node.outputs[laneId];
    if (!exported) continue;
    const types = new Map<string, ValueType | undefined>();
    for (const name of Object.keys(exported)) {
      types.set(
        name,
        analyzeValue(
          env,
          readerEndOf(scope, flow),
          exported[name]!,
          [...flow.path, "parallel", "outputs", laneId, name],
        ).type,
      );
    }
    flow.laneExports.set(laneId, types);
  }
}

function visitNode(env: AnalysisEnv, flow: FlowNode): void {
  const node = flow.node;
  if (node.if) {
    checkCondition(env, readerAt(flow), node.if, [...flow.path, "if"]);
  }
  switch (node.kind) {
    case "action":
      checkAction(env, flow, node);
      return;
    case "wait":
      return;
    case "sequence":
      visitScope(env, flow.scopes[0]!);
      return;
    case "branch":
      checkCondition(env, readerAt(flow), node.when, [
        ...flow.path,
        "branch",
        "when",
      ]);
      visitScope(env, flow.thenScope!);
      visitScope(env, flow.elseScope!);
      checkBranch(env, flow, node);
      return;
    case "repeat":
      checkRepeat(env, flow, node);
      return;
    case "parallel":
      checkParallel(env, flow, node);
      return;
  }
}

/**
 * Reference flow and type pass. Runs after shape, identifiers and action
 * resolution: indexes scopes, then visits nodes in completion order so a
 * container's exports are typed before anything after it reads them. Reports
 * the reference codes (`reference_future`, `reference_self`,
 * `reference_skipped_step`, `reference_unselected_branch`,
 * `reference_parallel_sibling`, `reference_parallel_scope`,
 * `reference_repeat_scope`, `reference_input_unknown`,
 * `reference_step_unknown`, `reference_field_unknown`,
 * `reference_secret_forbidden`) and the type codes (`type_mismatch`,
 * `condition_not_boolean`, `expression_operand_invalid`,
 * `branch_outputs_invalid`, `effect_key_invalid`).
 */
export function checkWorkflowFlow(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  catalog: WorkflowCompilerCatalog | undefined,
  collector: DiagnosticCollector,
  index: FlowIndex = buildFlowIndex(document, locations),
): void {
  const { types, opaque } = inputTypesOf(document, catalog);
  const env: AnalysisEnv = {
    index,
    catalog: catalog ?? UNTYPED_CATALOG,
    typed: catalog !== undefined,
    inputs: types,
    opaqueInputs: opaque,
    collector,
  };
  // A catalog that cannot type a declared structured input is a catalog
  // problem, reported once at the declaration instead of at every read.
  if (catalog) {
    for (const name of opaque) {
      collector.add(
        pointerOf(["inputs", name, "type"]),
        "input_type_unsupported",
      );
    }
  }
  visitScope(env, index.root);
}
