import type { WorkflowCompilerCatalog } from "../catalog.ts";
import { authoredIndexOf } from "./authored-order.ts";
import {
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
  type WorkflowCompilerDiagnosticCode,
} from "../diagnostics.ts";
import type {
  WorkflowActionNode,
  WorkflowNode,
  WorkflowSemanticDocument,
  WorkflowValueNode,
} from "../schema.ts";
import type { NodeLocations } from "./shape.ts";

const CHECK_NAME_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/;
const LIMIT_KEYS = [
  ["maxDurationMs", "maxDuration"],
  ["maxCostUsd", "maxCostUsd"],
  ["maxFindings", "maxFindings"],
] as const;

type Walk = {
  readonly document: WorkflowSemanticDocument;
  readonly catalog: WorkflowCompilerCatalog;
  readonly locations: NodeLocations;
  readonly collector: DiagnosticCollector;
};

function report(
  walk: Walk,
  path: readonly PointerSegment[],
  code: WorkflowCompilerDiagnosticCode,
): void {
  walk.collector.add(pointerOf(path), code);
}

/** Names bound in `with`, or undefined when `with` is not an object value. */
function boundFields(value: WorkflowValueNode): string[] | undefined {
  if (value.kind === "object") return Object.keys(value.fields);
  if (
    value.kind === "literal" && typeof value.value === "object" &&
    value.value !== null && !Array.isArray(value.value)
  ) {
    return Object.keys(value.value);
  }
  return undefined;
}

function checkChecks(
  walk: Walk,
  node: WorkflowActionNode,
  path: readonly PointerSegment[],
): void {
  if (!node.checks) return;
  const names = walk.catalog.checkNames;
  node.checks.forEach((check, index) => {
    const known = names ? names.has(check) : CHECK_NAME_PATTERN.test(check);
    if (!known) {
      report(
        walk,
        [...path, "checks", authoredIndexOf(node.checks!, check, index)],
        "action_checks_invalid",
      );
    }
  });
}

function checkLimits(
  walk: Walk,
  node: WorkflowActionNode,
  path: readonly PointerSegment[],
): void {
  if (!node.limits) return;
  const allowed = walk.catalog.limitFields(node.action);
  const ceiling = walk.document.limits.maxCostUsd;
  for (const [stored, authored] of LIMIT_KEYS) {
    const value = node.limits[stored];
    if (value === undefined) continue;
    if (!allowed.includes(authored)) {
      report(walk, [...path, "limits", authored], "action_limits_invalid");
    } else if (
      authored === "maxCostUsd" && ceiling !== undefined && value > ceiling
    ) {
      report(walk, [...path, "limits", authored], "action_limits_invalid");
    }
  }
}

function checkInput(
  walk: Walk,
  node: WorkflowActionNode,
  path: readonly PointerSegment[],
): void {
  const resolved = walk.catalog.resolveAction(node.action);
  if (!resolved) {
    report(walk, [...path, "uses"], "action_schema_unresolved");
    return;
  }
  const schema = resolved.input.fields;
  const withPath = [...path, "with"];
  const bound = boundFields(node.with);
  if (!bound) {
    report(walk, withPath, "field_invalid");
    return;
  }
  const supplied = new Set<string>(bound);

  if (node.checks) {
    if (!schema.has("checks")) {
      report(walk, [...path, "checks"], "action_checks_unsupported");
    } else if (supplied.has("checks")) {
      report(walk, [...path, "checks"], "action_duplicate_field");
    } else {
      supplied.add("checks");
    }
  }
  if (node.effectKey && schema.has("effectKey")) {
    if (supplied.has("effectKey")) {
      report(walk, [...path, "effectKey"], "action_duplicate_field");
    } else {
      supplied.add("effectKey");
    }
  }

  let unknown = false;
  for (const name of bound) {
    const field = schema.get(name);
    if (!field) {
      unknown = true;
    } else if (field.sensitive) {
      report(walk, [...withPath, name], "input_secret_forbidden");
    }
  }
  if (unknown) report(walk, withPath, "input_field_unknown");
  for (const [name, field] of schema) {
    if (field.required && !supplied.has(name)) {
      report(walk, [...withPath, name], "input_field_missing");
    }
  }

  const policy = resolved.metadata.effectPolicy;
  if (policy.startsWith("external_effect_keyed") && !node.effectKey) {
    report(walk, path, "action_effect_key_required");
  }
}

function visitNode(walk: Walk, node: WorkflowNode): void {
  const path = walk.locations.get(node) ?? [];
  switch (node.kind) {
    case "action":
      checkChecks(walk, node, path);
      checkLimits(walk, node, path);
      checkInput(walk, node, path);
      return;
    case "wait":
      if (
        node.wait.kind === "event" && !walk.catalog.event(node.wait.event)
      ) {
        report(walk, [...path, "wait", "event"], "wait_event_unknown");
      }
      return;
    case "sequence":
      node.steps.forEach((child) => visitNode(walk, child));
      return;
    case "branch":
      node.then.forEach((child) => visitNode(walk, child));
      node.else.forEach((child) => visitNode(walk, child));
      return;
    case "repeat":
      if (node.seed.form === "sequence") {
        node.seed.steps.forEach((child) => visitNode(walk, child));
      }
      node.steps.forEach((child) => visitNode(walk, child));
      return;
    case "parallel":
      for (const lane of node.lanes) {
        lane.steps.forEach((child) => visitNode(walk, child));
      }
      return;
  }
}

/**
 * Resolves every action and wait of a shaped, indexed document against the
 * injected catalog. Reports unresolved action schemas, check names and limit
 * keys the catalog does not allow, `with` fields that are unknown, missing or
 * sensitive, checks and effect keys supplied in two places, a missing effect
 * key on a keyed action, and unknown wait events. Pointers use only catalog
 * field names and the authored location, never a submitted key.
 */
export function resolveWorkflowActions(
  document: WorkflowSemanticDocument,
  locations: NodeLocations,
  catalog: WorkflowCompilerCatalog,
  collector: DiagnosticCollector,
): void {
  const walk: Walk = { document, catalog, locations, collector };
  document.steps.forEach((node) => visitNode(walk, node));
}
