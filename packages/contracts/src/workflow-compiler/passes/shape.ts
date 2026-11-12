import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
  type WorkflowCompilerDiagnosticCode,
} from "../diagnostics.ts";
import { rememberAuthoredOrder } from "./authored-order.ts";
import { parseDuration, WORKFLOW_COMPILER_LIMITS } from "../limits.ts";
import {
  KNOWN_CAPABILITIES,
  REGISTERED_ACTION_NAMES,
  registeredActionMetadata,
} from "../registry.ts";
import { WORKFLOW_ACTION_REGISTRY_VERSION } from "../../workflow-action-registry.ts";
import { WORKFLOW_STRUCTURED_INPUT_TYPES } from "../schema.ts";
import type {
  WorkflowActionNode,
  WorkflowBranchNode,
  WorkflowExpressionNode,
  WorkflowLane,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowRepeatNode,
  WorkflowRepeatSeed,
  WorkflowSemanticDocument,
  WorkflowSequenceNode,
  WorkflowValueNode,
  WorkflowWaitNode,
} from "../schema.ts";
import { isSecretName } from "../secrets.ts";
import {
  compileWorkflowCondition,
  compileWorkflowEffectKey,
  compileWorkflowValue,
  isPlainObject,
} from "../values.ts";

/** Authored location of every node, lane and sequence seed, by object identity. */
export type NodeLocations = WeakMap<object, readonly PointerSegment[]>;

export type ShapeResult = {
  readonly document: WorkflowSemanticDocument | undefined;
  readonly locations: NodeLocations;
};

type Raw = Record<string, unknown>;
type Path = readonly PointerSegment[];

const ROOT_PRESENTATION: ReadonlySet<string> = new Set([
  "name",
  "description",
  "layout",
  "ui",
]);
const NODE_PRESENTATION: ReadonlySet<string> = new Set([
  "name",
  "description",
  "label",
  "layout",
  "ui",
  "position",
]);
const ROOT_KEYS: ReadonlySet<string> = new Set([
  "apiVersion",
  "kind",
  "inputs",
  "limits",
  "agents",
  "cancel",
  "steps",
]);
const NODE_BASE_KEYS = ["id", "needs", "if", "agentVersionId"] as const;
const ACTION_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "uses",
  "with",
  "requires",
  "checks",
  "limits",
  "timeout",
  "retry",
  "effectKey",
]);
const KIND_KEYS = [
  "uses",
  "steps",
  "branch",
  "repeat",
  "wait",
  "parallel",
] as const;
const ACTION_LIMIT_KEYS: ReadonlySet<string> = new Set([
  "maxDuration",
  "maxCostUsd",
  "maxFindings",
]);
const RETRY_KEYS: ReadonlySet<string> = new Set([
  "maxAttempts",
  "backoff",
  "on",
]);
const SEQUENCE_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "steps",
]);
const BRANCH_NODE_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "branch",
]);
const BRANCH_BODY_KEYS: ReadonlySet<string> = new Set([
  "when",
  "then",
  "else",
  "outputs",
]);
const REPEAT_NODE_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "repeat",
]);
const REPEAT_BODY_KEYS: ReadonlySet<string> = new Set([
  "max",
  "seed",
  "until",
  "steps",
  "outputs",
]);
const WAIT_NODE_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "wait",
]);
const PARALLEL_NODE_KEYS: ReadonlySet<string> = new Set([
  ...NODE_BASE_KEYS,
  "parallel",
]);
const PARALLEL_BODY_KEYS: ReadonlySet<string> = new Set([
  "maxConcurrency",
  "join",
  "failurePolicy",
  "branches",
  "outputs",
]);
const WORKFLOW_LIMIT_KEYS: ReadonlySet<string> = new Set([
  "wallClock",
  "maxCostUsd",
  "maxAttempts",
  "maxRepairCycles",
]);
const BRANCH_ARM_KEYS: ReadonlySet<string> = new Set(["then", "else"]);
const INPUT_KEYS: ReadonlySet<string> = new Set(["type", "required", "enum"]);
const WAIT_BODY_KEYS: ReadonlySet<string> = new Set([
  "duration",
  "event",
  "timeout",
]);
export const LANE_ID = /^[a-z][a-z0-9_]{1,63}$/;
export const INPUT_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
export const OUTPUT_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const LANE_REPOSITORY = /^[a-z][a-z0-9_-]{0,63}$/;
const EVENT_NAME = /^[a-z][A-Za-z0-9_.]{0,63}$/;
const AGENT_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_TYPES: ReadonlySet<string> = new Set([
  "uuid",
  "string",
  "integer",
  "number",
  "boolean",
  ...WORKFLOW_STRUCTURED_INPUT_TYPES,
]);
const MAX_NEEDS = 64;
const MAX_SET_ITEMS = 32;

type Context = {
  readonly collector: DiagnosticCollector;
  readonly locations: NodeLocations;
};

function report(
  context: Context,
  path: Path,
  code: WorkflowCompilerDiagnosticCode,
): void {
  context.collector.add(pointerOf(path), code);
}

function checkKeys(
  context: Context,
  raw: Raw,
  path: Path,
  allowed: ReadonlySet<string>,
  presentation?: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    if (presentation?.has(key)) continue;
    report(context, path, "field_unknown");
    return;
  }
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= min && value <= max;
}

function isFiniteBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= min && value <= max;
}

/**
 * Parses a duration to integer milliseconds within an inclusive range.
 * Malformed values and values below the minimum are `duration_invalid`;
 * values above the maximum are `timeout_exceeds_ceiling`.
 */
function readDuration(
  context: Context,
  raw: unknown,
  path: Path,
  minMs: number,
  maxMs: number,
): number | undefined {
  const parsed = parseDuration(raw);
  if (parsed === null || parsed < minMs) {
    report(context, path, "duration_invalid");
    return undefined;
  }
  if (parsed > maxMs) {
    report(context, path, "timeout_exceeds_ceiling");
    return undefined;
  }
  return parsed;
}

function readDurationField(
  context: Context,
  raw: Raw,
  key: string,
  path: Path,
  minMs: number,
  maxMs: number,
): number | undefined {
  return readDuration(context, raw[key], [...path, key], minMs, maxMs);
}

/** Reads a sorted, duplicate-free string set. Returns undefined on failure. */
function readStringSet(
  context: Context,
  raw: unknown,
  path: Path,
  max: number,
  duplicateCode: WorkflowCompilerDiagnosticCode,
  invalidCode: WorkflowCompilerDiagnosticCode,
  accept: (item: string) => boolean = () => true,
): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > max) {
    report(context, path, invalidCode);
    return undefined;
  }
  const seen = new Set<string>();
  let failed = false;
  for (const item of raw) {
    if (typeof item !== "string" || !accept(item)) {
      report(context, path, invalidCode);
      failed = true;
    } else if (seen.has(item)) {
      report(context, path, duplicateCode);
      failed = true;
    } else {
      seen.add(item);
    }
  }
  if (failed) return undefined;
  const sorted = [...seen].sort();
  rememberAuthoredOrder(sorted, [...seen]);
  return sorted;
}

function readNeeds(
  context: Context,
  raw: Raw,
  path: Path,
): string[] | undefined {
  if (!Object.hasOwn(raw, "needs")) return [];
  return readStringSet(
    context,
    raw["needs"],
    [...path, "needs"],
    MAX_NEEDS,
    "needs_invalid",
    "needs_invalid",
  );
}

function readOptionalCondition(
  context: Context,
  raw: Raw,
  path: Path,
): { ok: boolean; node?: WorkflowExpressionNode } {
  if (!Object.hasOwn(raw, "if")) return { ok: true };
  const node = compileWorkflowCondition(
    raw["if"],
    [...path, "if"],
    context.collector,
  );
  return node ? { ok: true, node } : { ok: false };
}

function requireCondition(
  context: Context,
  raw: Raw,
  key: string,
  path: Path,
): WorkflowExpressionNode | undefined {
  if (!Object.hasOwn(raw, key)) {
    report(context, path, "field_missing");
    return undefined;
  }
  return compileWorkflowCondition(raw[key], [...path, key], context.collector);
}

function readId(context: Context, raw: Raw, path: Path): string | undefined {
  if (!Object.hasOwn(raw, "id")) {
    report(context, path, "field_missing");
    return undefined;
  }
  const id = raw["id"];
  if (typeof id !== "string") {
    report(context, [...path, "id"], "node_id_invalid");
    return undefined;
  }
  return id;
}

function shapeNodeList(
  context: Context,
  raw: unknown,
  path: Path,
  allowEmpty: boolean,
): WorkflowNode[] | undefined {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  const nodes: WorkflowNode[] = [];
  let failed = false;
  raw.forEach((entry, index) => {
    const node = shapeNode(context, entry, [...path, index]);
    if (node) nodes.push(node);
    else failed = true;
  });
  return failed ? undefined : nodes;
}

function readLimits(
  context: Context,
  raw: unknown,
  path: Path,
): WorkflowActionNode["limits"] | null | undefined {
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return null;
  }
  checkKeys(
    context,
    raw,
    path,
    ACTION_LIMIT_KEYS,
  );
  const limits: NonNullable<WorkflowActionNode["limits"]> = {};
  let failed = false;
  if (Object.hasOwn(raw, "maxDuration")) {
    const ms = readDurationField(
      context,
      raw,
      "maxDuration",
      path,
      WORKFLOW_COMPILER_LIMITS.durationMinMs,
      WORKFLOW_COMPILER_LIMITS.durationMaxMs,
    );
    if (ms === undefined) failed = true;
    else limits.maxDurationMs = ms;
  }
  if (Object.hasOwn(raw, "maxCostUsd")) {
    if (isMicroDollars(raw["maxCostUsd"])) {
      limits.maxCostUsd = raw["maxCostUsd"] as number;
    } else {
      report(context, [...path, "maxCostUsd"], "action_limits_invalid");
      failed = true;
    }
  }
  if (Object.hasOwn(raw, "maxFindings")) {
    if (
      isInteger(raw["maxFindings"], 0, WORKFLOW_COMPILER_LIMITS.maxFindings)
    ) {
      limits.maxFindings = raw["maxFindings"];
    } else {
      report(context, [...path, "maxFindings"], "action_limits_invalid");
      failed = true;
    }
  }
  return failed ? null : limits;
}

function readRetry(
  context: Context,
  raw: unknown,
  path: Path,
  action: string,
): WorkflowActionNode["retry"] | undefined {
  if (raw === undefined) return { maxAttempts: 1, backoffMs: 0, on: [] };
  if (!isPlainObject(raw)) {
    report(context, path, "retry_invalid");
    return undefined;
  }
  checkKeys(context, raw, path, RETRY_KEYS);
  const registry = registeredActionMetadata(action);
  let failed = false;
  let maxAttempts = 1;
  if (Object.hasOwn(raw, "maxAttempts")) {
    if (
      !isInteger(
        raw["maxAttempts"],
        1,
        WORKFLOW_COMPILER_LIMITS.worstCaseAttempts,
      )
    ) {
      report(context, [...path, "maxAttempts"], "retry_invalid");
      failed = true;
    } else if (registry && raw["maxAttempts"] > registry.retry.maxAttempts) {
      report(context, [...path, "maxAttempts"], "retry_exceeds_registry");
      failed = true;
    } else {
      maxAttempts = raw["maxAttempts"];
    }
  }
  let backoffMs = 0;
  if (Object.hasOwn(raw, "backoff")) {
    const parsed = readDurationField(
      context,
      raw,
      "backoff",
      path,
      0,
      WORKFLOW_COMPILER_LIMITS.backoffMaxMs,
    );
    if (parsed === undefined) failed = true;
    else backoffMs = parsed;
  }
  let on: string[] = [];
  if (Object.hasOwn(raw, "on")) {
    const faults = readStringSet(
      context,
      raw["on"],
      [...path, "on"],
      MAX_SET_ITEMS,
      "retry_invalid",
      "retry_invalid",
    );
    if (!faults) {
      failed = true;
    } else {
      const supported: readonly string[] = registry?.retry.faults ?? [];
      for (const fault of faults) {
        if (registry && !supported.includes(fault)) {
          report(context, [...path, "on"], "retry_fault_unsupported");
          failed = true;
        }
      }
      on = faults;
    }
  }
  return failed ? undefined : { maxAttempts, backoffMs, on };
}

function shapeAction(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowActionNode | undefined {
  checkKeys(context, raw, path, ACTION_KEYS, NODE_PRESENTATION);
  let failed = false;
  const uses = raw["uses"];
  let action = "";
  if (typeof uses !== "string") {
    report(context, [...path, "uses"], "field_invalid");
    failed = true;
  } else if (!REGISTERED_ACTION_NAMES.has(uses)) {
    report(context, [...path, "uses"], "action_unknown");
    failed = true;
  } else {
    action = uses;
  }

  let withValue: WorkflowValueNode = {
    kind: "literal",
    value: Object.create(null),
  };
  if (Object.hasOwn(raw, "with")) {
    if (!isPlainObject(raw["with"])) {
      report(context, [...path, "with"], "field_invalid");
      failed = true;
    } else {
      const compiled = compileWorkflowValue(
        raw["with"],
        [...path, "with"],
        context.collector,
      );
      if (compiled) withValue = compiled;
      else failed = true;
    }
  }

  let agentVersionId: string | undefined;
  if (Object.hasOwn(raw, "agentVersionId")) {
    const selected = raw["agentVersionId"];
    if (typeof selected === "string" && AGENT_VERSION_ID.test(selected)) {
      agentVersionId = selected.toLowerCase();
    } else {
      report(context, [...path, "agentVersionId"], "agent_binding_invalid");
      failed = true;
    }
  }

  const registry = registeredActionMetadata(action);
  // Capabilities are registry facts, so this needs no catalog: only an action
  // that runs a model has an agent version to select. (An unknown action is
  // already reported above.)
  if (
    agentVersionId !== undefined && registry &&
    !registry.capabilities.includes("model")
  ) {
    report(
      context,
      [...path, "agentVersionId"],
      "step_agent_version_forbidden",
    );
    failed = true;
  }
  let declared: string[] = [];
  if (Object.hasOwn(raw, "requires")) {
    const parsed = readStringSet(
      context,
      raw["requires"],
      [...path, "requires"],
      MAX_SET_ITEMS,
      "action_requires_invalid",
      "action_requires_invalid",
      (item) => KNOWN_CAPABILITIES.has(item),
    );
    if (parsed) declared = parsed;
    else failed = true;
  }
  const requires = [
    ...new Set([...declared, ...(registry?.capabilities ?? [])]),
  ].sort();

  let checks: string[] | undefined;
  if (Object.hasOwn(raw, "checks")) {
    checks = readStringSet(
      context,
      raw["checks"],
      [...path, "checks"],
      MAX_SET_ITEMS,
      "action_checks_invalid",
      "field_invalid",
      (item) => item.length >= 1 && item.length <= 64,
    );
    if (!checks) failed = true;
  }

  let limits: WorkflowActionNode["limits"];
  if (Object.hasOwn(raw, "limits")) {
    const parsed = readLimits(context, raw["limits"], [...path, "limits"]);
    if (parsed === null) failed = true;
    else limits = parsed;
  }

  let timeoutMs: number | undefined;
  if (Object.hasOwn(raw, "timeout")) {
    timeoutMs = readDurationField(
      context,
      raw,
      "timeout",
      path,
      WORKFLOW_COMPILER_LIMITS.durationMinMs,
      WORKFLOW_COMPILER_LIMITS.durationMaxMs,
    );
    if (timeoutMs === undefined) failed = true;
  } else {
    timeoutMs = Math.min(
      WORKFLOW_COMPILER_LIMITS.defaultActionTimeoutMs,
      limits?.maxDurationMs ?? WORKFLOW_COMPILER_LIMITS.defaultActionTimeoutMs,
    );
  }

  const retry = readRetry(context, raw["retry"], [...path, "retry"], action);
  if (!retry) failed = true;

  let effectKey: WorkflowActionNode["effectKey"];
  if (Object.hasOwn(raw, "effectKey")) {
    effectKey = compileWorkflowEffectKey(
      raw["effectKey"],
      [...path, "effectKey"],
      context.collector,
    );
    if (!effectKey) failed = true;
  }

  if (failed || timeoutMs === undefined || !retry) return undefined;
  const node: WorkflowActionNode = {
    kind: "action",
    id,
    needs,
    action,
    with: withValue,
    requires,
    timeoutMs,
    retry,
  };
  if (condition) node.if = condition;
  if (agentVersionId) node.agentVersionId = agentVersionId;
  if (checks) node.checks = checks;
  if (effectKey) node.effectKey = effectKey;
  if (limits) node.limits = limits;
  return node;
}

function shapeSequence(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowSequenceNode | undefined {
  checkKeys(
    context,
    raw,
    path,
    SEQUENCE_KEYS,
    NODE_PRESENTATION,
  );
  const steps = shapeNodeList(context, raw["steps"], [...path, "steps"], false);
  if (!steps) return undefined;
  const node: WorkflowSequenceNode = { kind: "sequence", id, needs, steps };
  if (condition) node.if = condition;
  return node;
}

function shapeBranch(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowBranchNode | undefined {
  checkKeys(
    context,
    raw,
    path,
    BRANCH_NODE_KEYS,
    NODE_PRESENTATION,
  );
  const body = raw["branch"];
  const bodyPath = [...path, "branch"];
  if (!isPlainObject(body)) {
    report(context, bodyPath, "field_invalid");
    return undefined;
  }
  checkKeys(
    context,
    body,
    bodyPath,
    BRANCH_BODY_KEYS,
  );
  let failed = false;
  const when = requireCondition(context, body, "when", bodyPath);
  if (!when) failed = true;
  let thenSteps: WorkflowNode[] | undefined;
  if (!Object.hasOwn(body, "then")) {
    report(context, bodyPath, "field_missing");
    failed = true;
  } else {
    thenSteps = shapeNodeList(
      context,
      body["then"],
      [...bodyPath, "then"],
      false,
    );
    if (!thenSteps) failed = true;
  }
  let elseSteps: WorkflowNode[] = [];
  if (Object.hasOwn(body, "else")) {
    const parsed = shapeNodeList(
      context,
      body["else"],
      [...bodyPath, "else"],
      true,
    );
    if (parsed) elseSteps = parsed;
    else failed = true;
  }
  const outputs: WorkflowBranchNode["outputs"] = Object.create(null);
  if (Object.hasOwn(body, "outputs")) {
    const outputsPath = [...bodyPath, "outputs"];
    const rawOutputs = body["outputs"];
    if (!isPlainObject(rawOutputs)) {
      report(context, outputsPath, "field_invalid");
      failed = true;
    } else {
      for (const name of Object.keys(rawOutputs)) {
        if (!OUTPUT_NAME.test(name)) {
          report(context, outputsPath, "output_name_invalid");
          failed = true;
          continue;
        }
        const entryPath = [...outputsPath, name];
        const entry = rawOutputs[name];
        if (!isPlainObject(entry)) {
          report(context, entryPath, "field_invalid");
          failed = true;
          continue;
        }
        checkKeys(context, entry, entryPath, BRANCH_ARM_KEYS);
        if (!Object.hasOwn(entry, "then") && !Object.hasOwn(entry, "else")) {
          report(context, entryPath, "branch_outputs_invalid");
          failed = true;
          continue;
        }
        const output: WorkflowBranchNode["outputs"][string] = {};
        for (const arm of ["then", "else"] as const) {
          if (!Object.hasOwn(entry, arm)) continue;
          const value = compileWorkflowValue(
            entry[arm],
            [...entryPath, arm],
            context.collector,
          );
          if (value) output[arm] = value;
          else failed = true;
        }
        outputs[name] = output;
      }
    }
  }
  if (failed || !when || !thenSteps) return undefined;
  const node: WorkflowBranchNode = {
    kind: "branch",
    id,
    needs,
    when,
    then: thenSteps,
    else: elseSteps,
    outputs,
  };
  if (condition) node.if = condition;
  return node;
}

function shapeSeed(
  context: Context,
  raw: unknown,
  path: Path,
): WorkflowRepeatSeed | undefined {
  if (!isPlainObject(raw)) {
    report(context, path, "repeat_seed_invalid");
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === "currentCandidate") {
    const value = compileWorkflowValue(
      raw["currentCandidate"],
      [...path, "currentCandidate"],
      context.collector,
    );
    return value ? { form: "mapping", currentCandidate: value } : undefined;
  }
  if (
    keys.length === 2 && Object.hasOwn(raw, "steps") &&
    Object.hasOwn(raw, "outputs")
  ) {
    const outputs = raw["outputs"];
    const outputsKeys = isPlainObject(outputs) ? Object.keys(outputs) : [];
    if (
      !Array.isArray(raw["steps"]) || raw["steps"].length === 0 ||
      !isPlainObject(outputs) || outputsKeys.length !== 1 ||
      outputsKeys[0] !== "currentCandidate"
    ) {
      report(context, path, "repeat_seed_invalid");
      return undefined;
    }
    const steps = shapeNodeList(
      context,
      raw["steps"],
      [...path, "steps"],
      false,
    );
    const value = compileWorkflowValue(
      outputs["currentCandidate"],
      [...path, "outputs", "currentCandidate"],
      context.collector,
    );
    return steps && value
      ? { form: "sequence", steps, currentCandidate: value }
      : undefined;
  }
  report(context, path, "repeat_seed_invalid");
  return undefined;
}

function shapeRepeat(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowRepeatNode | undefined {
  checkKeys(
    context,
    raw,
    path,
    REPEAT_NODE_KEYS,
    NODE_PRESENTATION,
  );
  const body = raw["repeat"];
  const bodyPath = [...path, "repeat"];
  if (!isPlainObject(body)) {
    report(context, bodyPath, "field_invalid");
    return undefined;
  }
  checkKeys(
    context,
    body,
    bodyPath,
    REPEAT_BODY_KEYS,
  );
  let failed = false;
  let max = 0;
  if (!Object.hasOwn(body, "max")) {
    report(context, bodyPath, "field_missing");
    failed = true;
  } else if (!isInteger(body["max"], 1, WORKFLOW_COMPILER_LIMITS.repeatMax)) {
    report(context, [...bodyPath, "max"], "repeat_max_invalid");
    failed = true;
  } else {
    max = body["max"];
  }
  let seed: WorkflowRepeatSeed | undefined;
  if (!Object.hasOwn(body, "seed")) {
    report(context, bodyPath, "field_missing");
    failed = true;
  } else {
    seed = shapeSeed(context, body["seed"], [...bodyPath, "seed"]);
    if (!seed) failed = true;
  }
  const until = requireCondition(context, body, "until", bodyPath);
  if (!until) failed = true;
  let steps: WorkflowNode[] | undefined;
  if (!Object.hasOwn(body, "steps")) {
    report(context, bodyPath, "field_missing");
    failed = true;
  } else {
    steps = shapeNodeList(
      context,
      body["steps"],
      [...bodyPath, "steps"],
      false,
    );
    if (!steps) failed = true;
  }
  let currentCandidate: WorkflowValueNode | undefined;
  const outputs = body["outputs"];
  const outputsPath = [...bodyPath, "outputs"];
  if (
    !isPlainObject(outputs) || Object.keys(outputs).length !== 1 ||
    !Object.hasOwn(outputs, "currentCandidate")
  ) {
    report(context, outputsPath, "repeat_outputs_invalid");
    failed = true;
  } else {
    currentCandidate = compileWorkflowValue(
      outputs["currentCandidate"],
      [...outputsPath, "currentCandidate"],
      context.collector,
    );
    if (!currentCandidate) failed = true;
  }
  if (failed || !seed || !until || !steps || !currentCandidate) {
    return undefined;
  }
  const node: WorkflowRepeatNode = {
    kind: "repeat",
    id,
    needs,
    max,
    seed,
    until,
    steps,
    currentCandidate,
  };
  if (condition) node.if = condition;
  return node;
}

function shapeWait(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowWaitNode | undefined {
  checkKeys(
    context,
    raw,
    path,
    WAIT_NODE_KEYS,
    NODE_PRESENTATION,
  );
  const body = raw["wait"];
  const bodyPath = [...path, "wait"];
  if (!isPlainObject(body)) {
    report(context, bodyPath, "wait_shape_invalid");
    return undefined;
  }
  const hasDuration = Object.hasOwn(body, "duration");
  const hasEvent = Object.hasOwn(body, "event");
  const min = WORKFLOW_COMPILER_LIMITS.durationMinMs;
  const max = WORKFLOW_COMPILER_LIMITS.durationMaxMs;
  let wait: WorkflowWaitNode["wait"] | undefined;
  if (hasDuration && !hasEvent && Object.keys(body).length === 1) {
    const durationMs = readDurationField(
      context,
      body,
      "duration",
      bodyPath,
      min,
      max,
    );
    if (durationMs !== undefined) wait = { kind: "duration", durationMs };
  } else if (hasEvent && !hasDuration) {
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "event" && key !== "timeout")) {
      report(context, bodyPath, "wait_shape_invalid");
    } else if (
      typeof body["event"] !== "string" || !EVENT_NAME.test(body["event"])
    ) {
      report(context, [...bodyPath, "event"], "wait_shape_invalid");
    } else if (!Object.hasOwn(body, "timeout")) {
      report(context, bodyPath, "wait_timeout_required");
    } else {
      const timeoutMs = readDurationField(
        context,
        body,
        "timeout",
        bodyPath,
        min,
        max,
      );
      if (timeoutMs !== undefined) {
        wait = { kind: "event", event: body["event"], timeoutMs };
      }
    }
  } else {
    report(context, bodyPath, "wait_shape_invalid");
  }
  if (!wait) return undefined;
  const node: WorkflowWaitNode = { kind: "wait", id, needs, wait };
  if (condition) node.if = condition;
  return node;
}

const LANE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "needs",
  "repository",
  "steps",
]);

/**
 * Every key the compiler's own vocabulary fixes, derived from the tables
 * above. Only these keys, and keys at declared-name positions, may enter a
 * diagnostic pointer.
 */
export const STRUCTURAL_KEY_NAMES: ReadonlySet<string> = new Set([
  ...ROOT_PRESENTATION,
  ...NODE_PRESENTATION,
  ...ROOT_KEYS,
  ...ACTION_KEYS,
  ...LANE_KEYS,
  ...ACTION_LIMIT_KEYS,
  ...RETRY_KEYS,
  ...SEQUENCE_KEYS,
  ...BRANCH_NODE_KEYS,
  ...BRANCH_BODY_KEYS,
  ...REPEAT_NODE_KEYS,
  ...REPEAT_BODY_KEYS,
  ...WAIT_NODE_KEYS,
  ...WAIT_BODY_KEYS,
  ...PARALLEL_NODE_KEYS,
  ...PARALLEL_BODY_KEYS,
  ...WORKFLOW_LIMIT_KEYS,
  ...BRANCH_ARM_KEYS,
  ...INPUT_KEYS,
  "currentCandidate",
]);

function shapeLane(
  context: Context,
  raw: unknown,
  path: Path,
): WorkflowLane | undefined {
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  checkKeys(context, raw, path, LANE_KEYS, NODE_PRESENTATION);
  let failed = false;
  const id = readId(context, raw, path);
  if (id === undefined) failed = true;
  const needs = readNeeds(context, raw, path);
  if (!needs) failed = true;
  let repository = "";
  if (
    typeof raw["repository"] !== "string" ||
    !LANE_REPOSITORY.test(raw["repository"])
  ) {
    report(context, [...path, "repository"], "lane_repository_invalid");
    failed = true;
  } else {
    repository = raw["repository"];
  }
  const steps = Object.hasOwn(raw, "steps")
    ? shapeNodeList(context, raw["steps"], [...path, "steps"], false)
    : (report(context, path, "field_missing"), undefined);
  if (!steps) failed = true;
  if (failed || id === undefined || !needs || !steps) return undefined;
  const lane: WorkflowLane = { id, needs, repository, steps };
  context.locations.set(lane, path);
  return lane;
}

function shapeParallel(
  context: Context,
  raw: Raw,
  path: Path,
  id: string,
  needs: string[],
  condition: WorkflowExpressionNode | undefined,
): WorkflowParallelNode | undefined {
  checkKeys(
    context,
    raw,
    path,
    PARALLEL_NODE_KEYS,
    NODE_PRESENTATION,
  );
  const body = raw["parallel"];
  const bodyPath = [...path, "parallel"];
  if (!isPlainObject(body)) {
    report(context, bodyPath, "field_invalid");
    return undefined;
  }
  checkKeys(
    context,
    body,
    bodyPath,
    PARALLEL_BODY_KEYS,
  );
  let failed = false;
  let maxConcurrency = 0;
  if (!isInteger(body["maxConcurrency"], 1, WORKFLOW_COMPILER_LIMITS.lanes)) {
    report(
      context,
      [...bodyPath, "maxConcurrency"],
      "parallel_concurrency_invalid",
    );
    failed = true;
  } else {
    maxConcurrency = body["maxConcurrency"];
  }
  if (body["join"] !== "all-required") {
    report(context, [...bodyPath, "join"], "parallel_join_required");
    failed = true;
  }
  if (body["failurePolicy"] !== "stop-dependent") {
    report(
      context,
      [...bodyPath, "failurePolicy"],
      "parallel_failure_policy_required",
    );
    failed = true;
  }
  const lanes: WorkflowLane[] = [];
  const rawLanes = body["branches"];
  const lanesPath = [...bodyPath, "branches"];
  if (
    !Array.isArray(rawLanes) || rawLanes.length === 0 ||
    rawLanes.length > WORKFLOW_COMPILER_LIMITS.lanes
  ) {
    report(context, lanesPath, "parallel_lanes_invalid");
    failed = true;
  } else {
    rawLanes.forEach((entry, index) => {
      const lane = shapeLane(context, entry, [...lanesPath, index]);
      if (lane) lanes.push(lane);
      else failed = true;
    });
  }
  if (
    Array.isArray(rawLanes) && rawLanes.length > 0 &&
    maxConcurrency > rawLanes.length
  ) {
    report(
      context,
      [...bodyPath, "maxConcurrency"],
      "parallel_concurrency_invalid",
    );
    failed = true;
  }
  const outputs: WorkflowParallelNode["outputs"] = Object.create(null);
  if (Object.hasOwn(body, "outputs")) {
    const outputsPath = [...bodyPath, "outputs"];
    const rawOutputs = body["outputs"];
    if (!isPlainObject(rawOutputs)) {
      report(context, outputsPath, "field_invalid");
      failed = true;
    } else {
      for (const laneId of Object.keys(rawOutputs)) {
        if (!LANE_ID.test(laneId)) {
          report(context, outputsPath, "parallel_lanes_invalid");
          failed = true;
          continue;
        }
        const lanePath = [...outputsPath, laneId];
        const entry = rawOutputs[laneId];
        if (!isPlainObject(entry)) {
          report(context, lanePath, "field_invalid");
          failed = true;
          continue;
        }
        const exports: Record<string, WorkflowValueNode> = Object.create(null);
        for (const name of Object.keys(entry)) {
          if (!OUTPUT_NAME.test(name)) {
            report(context, lanePath, "output_name_invalid");
            failed = true;
            continue;
          }
          const value = compileWorkflowValue(
            entry[name],
            [...lanePath, name],
            context.collector,
          );
          if (value) exports[name] = value;
          else failed = true;
        }
        outputs[laneId] = exports;
      }
    }
  }
  if (failed) return undefined;
  const node: WorkflowParallelNode = {
    kind: "parallel",
    id,
    needs,
    maxConcurrency,
    join: "all-required",
    failurePolicy: "stop-dependent",
    lanes,
    outputs,
  };
  if (condition) node.if = condition;
  return node;
}

function shapeNode(
  context: Context,
  raw: unknown,
  path: Path,
): WorkflowNode | undefined {
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  // Only an action node may select an agent version, and only a model action
  // (checked against the registry in the actions pass). Every container, and
  // a wait, is refused here.
  if (Object.hasOwn(raw, "agentVersionId") && !Object.hasOwn(raw, "uses")) {
    report(
      context,
      [...path, "agentVersionId"],
      "step_agent_version_forbidden",
    );
  }
  const kinds = KIND_KEYS.filter((key) => Object.hasOwn(raw, key));
  if (kinds.length !== 1) {
    report(context, path, "node_kind_invalid");
    return undefined;
  }
  let failed = false;
  const id = readId(context, raw, path);
  if (id === undefined) failed = true;
  const needs = readNeeds(context, raw, path);
  if (!needs) failed = true;
  const condition = readOptionalCondition(context, raw, path);
  if (!condition.ok) failed = true;
  const kind = kinds[0]!;
  const shapers = {
    uses: shapeAction,
    steps: shapeSequence,
    branch: shapeBranch,
    repeat: shapeRepeat,
    wait: shapeWait,
    parallel: shapeParallel,
  } as const;
  const node = shapers[kind](
    context,
    raw,
    path,
    id ?? "",
    needs ?? [],
    condition.node,
  );
  if (failed || !node) return undefined;
  context.locations.set(node, path);
  return node;
}

/**
 * A cost ceiling in 0..10000 that is exactly a whole number of micro-dollars:
 * the value round-trips through integer micro-units, so rounding never
 * under-counts.
 */
function isMicroDollars(value: unknown): boolean {
  return isFiniteBetween(value, 0, 10_000) &&
    Math.round((value as number) * 1_000_000) / 1_000_000 === value;
}

function shapeInputs(
  context: Context,
  raw: unknown,
): WorkflowSemanticDocument["inputs"] | undefined {
  const path: Path = ["inputs"];
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  const inputs: WorkflowSemanticDocument["inputs"] = Object.create(null);
  let failed = false;
  for (const name of Object.keys(raw)) {
    if (!INPUT_NAME.test(name)) {
      report(context, path, "input_name_invalid");
      failed = true;
      continue;
    }
    if (isSecretName(name)) {
      report(context, path, "input_secret_forbidden");
      failed = true;
      continue;
    }
    const inputPath = [...path, name];
    const entry = raw[name];
    if (!isPlainObject(entry)) {
      report(context, inputPath, "field_invalid");
      failed = true;
      continue;
    }
    checkKeys(context, entry, inputPath, INPUT_KEYS);
    const type = entry["type"];
    if (typeof type !== "string") {
      report(context, inputPath, "field_missing");
      failed = true;
      continue;
    }
    if (!INPUT_TYPES.has(type)) {
      report(context, [...inputPath, "type"], "input_type_unsupported");
      failed = true;
      continue;
    }
    if (typeof entry["required"] !== "boolean") {
      report(context, inputPath, "field_missing");
      failed = true;
      continue;
    }
    const input: WorkflowSemanticDocument["inputs"][string] = {
      type: type as WorkflowSemanticDocument["inputs"][string]["type"],
      required: entry["required"],
    };
    if (Object.hasOwn(entry, "enum")) {
      const values = entry["enum"];
      const enumPath = [...inputPath, "enum"];
      if (type !== "string") {
        report(context, enumPath, "input_type_unsupported");
        failed = true;
        continue;
      }
      if (
        !Array.isArray(values) || values.length === 0 || values.length > 64 ||
        !values.every((item) => typeof item === "string")
      ) {
        report(context, enumPath, "field_invalid");
        failed = true;
        continue;
      }
      if (new Set(values).size !== values.length) {
        report(context, enumPath, "field_invalid");
        failed = true;
        continue;
      }
      input.enum = [...(values as string[])].sort();
    }
    inputs[name] = input;
  }
  return failed ? undefined : inputs;
}

function shapeLimits(
  context: Context,
  raw: unknown,
): WorkflowSemanticDocument["limits"] | undefined {
  const path: Path = ["limits"];
  const limits: WorkflowSemanticDocument["limits"] = {
    wallClockMs: WORKFLOW_COMPILER_LIMITS.durationMaxMs,
    maxAttempts: WORKFLOW_COMPILER_LIMITS.worstCaseAttempts,
  };
  if (raw === undefined) return limits;
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  checkKeys(
    context,
    raw,
    path,
    WORKFLOW_LIMIT_KEYS,
  );
  let failed = false;
  if (Object.hasOwn(raw, "wallClock")) {
    const ms = readDurationField(
      context,
      raw,
      "wallClock",
      path,
      WORKFLOW_COMPILER_LIMITS.durationMinMs,
      WORKFLOW_COMPILER_LIMITS.durationMaxMs,
    );
    if (ms === undefined) failed = true;
    else limits.wallClockMs = ms;
  }
  if (Object.hasOwn(raw, "maxCostUsd")) {
    if (isMicroDollars(raw["maxCostUsd"])) {
      limits.maxCostUsd = raw["maxCostUsd"] as number;
    } else {
      report(context, [...path, "maxCostUsd"], "limits_invalid");
      failed = true;
    }
  }
  if (Object.hasOwn(raw, "maxAttempts")) {
    if (
      isInteger(
        raw["maxAttempts"],
        1,
        WORKFLOW_COMPILER_LIMITS.worstCaseAttempts,
      )
    ) {
      limits.maxAttempts = raw["maxAttempts"];
    } else {
      report(context, [...path, "maxAttempts"], "limits_invalid");
      failed = true;
    }
  }
  if (Object.hasOwn(raw, "maxRepairCycles")) {
    if (
      isInteger(raw["maxRepairCycles"], 0, WORKFLOW_COMPILER_LIMITS.repeatMax)
    ) {
      limits.maxRepairCycles = raw["maxRepairCycles"];
    } else {
      report(context, [...path, "maxRepairCycles"], "limits_invalid");
      failed = true;
    }
  }
  return failed ? undefined : limits;
}

function shapeAgents(
  context: Context,
  raw: unknown,
): WorkflowSemanticDocument["agents"] | undefined {
  const path: Path = ["agents"];
  const agents: WorkflowSemanticDocument["agents"] = Object.create(null);
  if (raw === undefined) return agents;
  if (!isPlainObject(raw)) {
    report(context, path, "field_invalid");
    return undefined;
  }
  let failed = false;
  for (const action of Object.keys(raw)) {
    if (!REGISTERED_ACTION_NAMES.has(action)) {
      report(context, path, "action_unknown");
      failed = true;
      continue;
    }
    const version = raw[action];
    if (typeof version !== "string" || !AGENT_VERSION_ID.test(version)) {
      report(context, [...path, action], "agent_binding_invalid");
      failed = true;
      continue;
    }
    agents[action] = version.toLowerCase();
  }
  return failed ? undefined : agents;
}

/**
 * Walks an inert snapshot of an authored definition and builds the normalized
 * semantic document. Presentation keys are stripped only at the workflow
 * root, node objects and lane objects; everywhere else a key such as `name`
 * or `description` is data or `field_unknown`. Every diagnostic carries a
 * pointer built from indexes and compiler-fixed or vetted names only.
 */
export function shapeWorkflow(
  root: unknown,
  collector: DiagnosticCollector,
): ShapeResult {
  const locations: NodeLocations = new WeakMap();
  const context: Context = { collector, locations };
  const before = collector.size;
  if (!isPlainObject(root)) {
    report(context, [], "field_invalid");
    return { document: undefined, locations };
  }
  checkKeys(context, root, [], ROOT_KEYS, ROOT_PRESENTATION);
  if (root["apiVersion"] !== "bakery.dev/v1" || root["kind"] !== "workflow") {
    report(context, [], "workflow_version_unsupported");
  }
  const inputs = Object.hasOwn(root, "inputs")
    ? shapeInputs(context, root["inputs"])
    : Object.create(null) as WorkflowSemanticDocument["inputs"];
  const limits = shapeLimits(context, root["limits"]);
  const agents = shapeAgents(context, root["agents"]);
  let cancel: "stop-started-actions" | undefined;
  if (Object.hasOwn(root, "cancel")) {
    if (root["cancel"] === "stop-started-actions") {
      cancel = "stop-started-actions";
    } else report(context, ["cancel"], "field_invalid");
  }
  const steps = Object.hasOwn(root, "steps")
    ? shapeNodeList(context, root["steps"], ["steps"], false)
    : (report(context, [], "field_missing"), undefined);
  if (collector.size > before || !inputs || !limits || !agents || !steps) {
    return { document: undefined, locations };
  }
  const document: WorkflowSemanticDocument = {
    compilerVersion: 2,
    registryVersion: WORKFLOW_ACTION_REGISTRY_VERSION,
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs,
    limits,
    agents,
    steps,
  };
  if (cancel) document.cancel = cancel;
  return { document, locations };
}
