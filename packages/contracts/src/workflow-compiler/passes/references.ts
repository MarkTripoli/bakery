import type { WorkflowCompilerCatalog } from "../catalog.ts";
import type { WorkflowCompilerDiagnosticCode } from "../diagnostics.ts";
import type {
  WorkflowReferenceNode,
  WorkflowSemanticDocument,
} from "../schema.ts";
import { isSecretName } from "../secrets.ts";
import type { ObjectField, ValueType } from "../types.ts";
import {
  type FlowIndex,
  type FlowNode,
  guardsOf,
  insideScope,
  laneScopeOf,
  orderOf,
  prerequisiteLanes,
  type Reader,
} from "./flow-index.ts";

/** Everything a reference resolves against. */
export type FlowEnv = {
  readonly index: FlowIndex;
  readonly catalog: WorkflowCompilerCatalog;
  readonly inputs: ReadonlyMap<string, ValueType>;
  /**
   * False when the compile has no catalog: action outputs, event payloads and
   * `$task` are of unknown type, and reads of them resolve to an untyped value
   * instead of a diagnostic. Flow and scope rules apply either way.
   */
  readonly typed: boolean;
};

export type Resolution =
  | {
    readonly ok: true;
    /** Static type of the read value; undefined when it could not be derived. */
    readonly type: ValueType | undefined;
  }
  | { readonly ok: false; readonly code: WorkflowCompilerDiagnosticCode };

const REPEAT_OUTCOMES: readonly string[] = Object.freeze([
  "completed",
  "exhausted",
  "canceled",
  "failed",
  "timed_out",
]);

function field(type: ValueType, required = true): ObjectField {
  return { type, required, sensitive: false };
}

/** Type of `$step.<wait>`: its outcome and, for event waits, the payload. */
export function waitOutputType(
  node: Extract<FlowNode["node"], { kind: "wait" }>,
  catalog: WorkflowCompilerCatalog,
): ValueType {
  if (node.wait.kind === "duration") {
    return {
      kind: "object",
      fields: new Map([
        ["outcome", field({ kind: "string", enum: ["elapsed"] })],
      ]),
    };
  }
  const payload = catalog.event(node.wait.event)?.payload ??
    ({ kind: "json" } as ValueType);
  return {
    kind: "object",
    fields: new Map([
      [
        "outcome",
        field({ kind: "string", enum: ["received", "timed_out"] }),
      ],
      ["event", field({ kind: "nullable", inner: payload })],
    ]),
  };
}

/** Builds the type of each declared workflow input; optional ones are nullable. */
export function inputTypesOf(
  document: WorkflowSemanticDocument,
): Map<string, ValueType> {
  const types = new Map<string, ValueType>();
  for (const name of Object.keys(document.inputs)) {
    const declared = document.inputs[name]!;
    let type: ValueType;
    switch (declared.type) {
      case "uuid":
        type = { kind: "string", format: "uuid" };
        break;
      case "string":
        type = declared.enum && declared.enum.length > 0
          ? { kind: "string", enum: declared.enum }
          : { kind: "string" };
        break;
      case "integer":
        type = { kind: "number", integer: true };
        break;
      case "number":
        type = { kind: "number", integer: false };
        break;
      case "boolean":
        type = { kind: "boolean" };
        break;
    }
    types.set(
      name,
      declared.required ? type : { kind: "nullable", inner: type },
    );
  }
  return types;
}

function nullableOf(type: ValueType): ValueType {
  return type.kind === "nullable" || type.kind === "null" ||
      type.kind === "json"
    ? type
    : { kind: "nullable", inner: type };
}

const SENSITIVE_SCAN_DEPTH = 64;

/**
 * Whether a type holds a sensitive member at any depth: object fields, list
 * items and nullable inner types. Reading such a value whole would hand the
 * secret on, so it is as forbidden as reading the member itself.
 */
export function containsSensitive(type: ValueType, depth = 0): boolean {
  if (depth > SENSITIVE_SCAN_DEPTH) return true;
  const known = SENSITIVE_MEMO.get(type);
  if (known !== undefined) return known;
  const result = scanSensitive(type, depth);
  SENSITIVE_MEMO.set(type, result);
  return result;
}

/** Author-built types share subtypes (a DAG); each is scanned once. */
const SENSITIVE_MEMO = new WeakMap<ValueType, boolean>();

function scanSensitive(type: ValueType, depth: number): boolean {
  switch (type.kind) {
    case "nullable":
      return containsSensitive(type.inner, depth + 1);
    case "list":
      return containsSensitive(type.item, depth + 1);
    case "object":
      for (const member of type.fields.values()) {
        if (member.sensitive || containsSensitive(member.type, depth + 1)) {
          return true;
        }
      }
      return false;
    default:
      return false;
  }
}

/**
 * Walks typed field segments of a value. Optional fields read as nullable,
 * and a field read through a nullable value reads as nullable. Reading into a
 * scalar, list or `json` value, or an unknown field, is `reference_field_unknown`;
 * a sensitive field, or a read whose resulting type holds a sensitive member
 * at any depth (a whole object, a list of objects), is
 * `reference_secret_forbidden`.
 */
export function walkFields(
  type: ValueType,
  segments: readonly string[],
): Resolution {
  let current = type;
  let throughNullable = false;
  for (const segment of segments) {
    let base = current;
    if (base.kind === "nullable") {
      throughNullable = true;
      base = base.inner;
    }
    if (base.kind !== "object") {
      return { ok: false, code: "reference_field_unknown" };
    }
    const member = base.fields.get(segment);
    if (!member) return { ok: false, code: "reference_field_unknown" };
    if (member.sensitive) {
      return { ok: false, code: "reference_secret_forbidden" };
    }
    current = member.required ? member.type : nullableOf(member.type);
  }
  if (containsSensitive(current)) {
    return { ok: false, code: "reference_secret_forbidden" };
  }
  return {
    ok: true,
    type: throughNullable ? nullableOf(current) : current,
  };
}

/** Untyped resolution: a secret-named remaining segment is still forbidden. */
function untypedResolution(segments: readonly string[]): Resolution {
  return segments.some(isSecretName)
    ? { ok: false, code: "reference_secret_forbidden" }
    : { ok: true, type: undefined };
}

function finishWalk(
  type: ValueType | undefined,
  segments: readonly string[],
): Resolution {
  if (type === undefined) return untypedResolution(segments);
  return walkFields(type, segments);
}

/**
 * Flow rules for reading `target`: not itself, completed before the reader,
 * and every guard on the target also guards the reader. `laneId` marks a read
 * of a parallel group's lane export.
 */
function flowCheck(
  reader: Reader,
  target: FlowNode,
  laneId: string | undefined,
): WorkflowCompilerDiagnosticCode | undefined {
  if (reader.self === target) return "reference_self";
  if (target.node.kind === "parallel" && laneId !== undefined) {
    const own = laneScopeOf(reader, target);
    if (own) {
      if (own.laneId === laneId) return "reference_future";
      if (!prerequisiteLanes(target, own.laneId!).has(laneId)) {
        return "reference_parallel_sibling";
      }
      return undefined;
    }
  }
  const order = orderOf(target, reader);
  switch (order.kind) {
    case "self":
      return "reference_self";
    case "future":
      return "reference_future";
    case "diverge":
      return order.owner.node.kind === "branch"
        ? "reference_unselected_branch"
        : order.owner.node.kind === "parallel"
        ? "reference_parallel_scope"
        : order.owner.node.kind === "repeat"
        ? "reference_repeat_scope"
        : "reference_future";
    case "before":
      break;
  }
  for (const token of guardsOf(target)) {
    if (!reader.guards.has(token)) {
      return token.startsWith("arm:")
        ? "reference_unselected_branch"
        : "reference_skipped_step";
    }
  }
  return undefined;
}

function resolveStep(
  env: FlowEnv,
  reader: Reader,
  path: readonly string[],
): Resolution {
  let node: FlowNode | undefined = env.index.root.byId.get(path[0]!);
  if (!node) return { ok: false, code: "reference_step_unknown" };
  let position = 1;
  const fieldUnknown: Resolution = {
    ok: false,
    code: "reference_field_unknown",
  };
  for (;;) {
    const flow: FlowNode = node;
    const authored = flow.node;
    const segment = path[position];
    switch (authored.kind) {
      case "action":
      case "wait": {
        const failure = flowCheck(reader, flow, undefined);
        if (failure) return { ok: false, code: failure };
        if (
          !env.typed && authored.kind === "wait" &&
          authored.wait.kind === "event" && segment === "event" &&
          path.length > position + 1
        ) {
          return untypedResolution(path.slice(position + 1));
        }
        const output = authored.kind === "wait"
          ? waitOutputType(authored, env.catalog)
          : env.catalog.resolveAction(authored.action)?.output;
        return finishWalk(output, path.slice(position));
      }
      case "sequence": {
        if (segment === undefined) return fieldUnknown;
        const child: FlowNode | undefined = flow.scopes[0]!.byId.get(segment);
        if (!child) return fieldUnknown;
        node = child;
        position += 1;
        continue;
      }
      case "branch": {
        if (segment === undefined) return fieldUnknown;
        if (Object.hasOwn(authored.outputs, segment)) {
          if (isSecretName(segment)) {
            return { ok: false, code: "reference_secret_forbidden" };
          }
          const failure = flowCheck(reader, flow, undefined);
          if (failure) return { ok: false, code: failure };
          return finishWalk(
            flow.branchExports.get(segment),
            path.slice(position + 1),
          );
        }
        const arm = flow.thenScope!.byId.has(segment)
          ? flow.thenScope!
          : flow.elseScope!.byId.has(segment)
          ? flow.elseScope!
          : undefined;
        if (!arm) return fieldUnknown;
        if (!insideScope(reader, arm)) {
          return { ok: false, code: "reference_unselected_branch" };
        }
        node = arm.byId.get(segment)!;
        position += 1;
        continue;
      }
      case "repeat": {
        if (segment === undefined) return fieldUnknown;
        if (
          segment === "iterations" || segment === "outcome" ||
          segment === "currentCandidate"
        ) {
          const failure = flowCheck(reader, flow, undefined);
          if (failure) return { ok: false, code: failure };
          const rest = path.slice(position + 1);
          if (segment === "iterations") {
            return finishWalk({ kind: "number", integer: true }, rest);
          }
          if (segment === "outcome") {
            return finishWalk({ kind: "string", enum: REPEAT_OUTCOMES }, rest);
          }
          return finishWalk(flow.candidate, rest);
        }
        const scope = flow.seedScope?.byId.has(segment)
          ? flow.seedScope
          : flow.bodyScope!.byId.has(segment)
          ? flow.bodyScope!
          : undefined;
        if (!scope) return fieldUnknown;
        if (!insideScope(reader, scope)) {
          return { ok: false, code: "reference_repeat_scope" };
        }
        node = scope.byId.get(segment)!;
        position += 1;
        continue;
      }
      case "parallel": {
        if (segment === undefined) return fieldUnknown;
        const lane = flow.lanes.get(segment);
        const next = path[position + 1];
        if (!lane || next === undefined) return fieldUnknown;
        const exported = authored.outputs[segment];
        if (exported && Object.hasOwn(exported, next)) {
          if (isSecretName(next)) {
            return { ok: false, code: "reference_secret_forbidden" };
          }
          const failure = flowCheck(reader, flow, segment);
          if (failure) return { ok: false, code: failure };
          return finishWalk(
            flow.laneExports.get(segment)?.get(next),
            path.slice(position + 2),
          );
        }
        const child: FlowNode | undefined = lane.byId.get(next);
        if (!child) return fieldUnknown;
        if (!insideScope(reader, lane)) {
          return { ok: false, code: "reference_parallel_scope" };
        }
        node = child;
        position += 2;
        continue;
      }
    }
  }
}

/**
 * Resolves one typed reference at a reader position. `$input.*` names a
 * declared workflow input; `$task.*` walks the catalog task type;
 * `$repeat.currentCandidate.*` reads the enclosing repeat's candidate;
 * `$step.*` walks absolute node paths from the workflow root, descending into
 * containers by the scope rules and stopping at an action output or a
 * container export. A failure carries only a code: nothing submitted is
 * echoed.
 */
export function resolveReference(
  env: FlowEnv,
  reader: Reader,
  reference: WorkflowReferenceNode,
): Resolution {
  const path = reference.path;
  switch (reference.root) {
    case "input": {
      const type = env.inputs.get(path[0]!);
      if (!type) return { ok: false, code: "reference_input_unknown" };
      return walkFields(type, path.slice(1));
    }
    case "task": {
      const task = env.catalog.task();
      if (!task) {
        return env.typed
          ? { ok: false, code: "reference_field_unknown" }
          : untypedResolution(path);
      }
      return walkFields(task, path);
    }
    case "repeat": {
      if (!reader.repeat) return { ok: false, code: "reference_repeat_scope" };
      if (path[0] !== "currentCandidate") {
        return { ok: false, code: "reference_field_unknown" };
      }
      return finishWalk(reader.repeat.candidate, path.slice(1));
    }
    case "step":
      return resolveStep(env, reader, path);
  }
}
