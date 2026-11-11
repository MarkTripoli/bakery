import { z } from "zod";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";

/** Closed set of diagnostic codes. Every code is reachable and unit-tested. */
export const WORKFLOW_COMPILER_DIAGNOSTIC_CODES = Object.freeze(
  [
    // Foundations: decoding and the inert snapshot.
    "definition_syntax_invalid",
    "definition_duplicate_key",
    "definition_too_large",
    "definition_too_deep",
    "definition_too_many_values",
    "definition_value_unsupported",
    "definition_number_invalid",
    "definition_key_forbidden",
    "diagnostics_truncated",
    // Expression grammar.
    "expression_syntax_invalid",
    "expression_too_long",
    "expression_too_deep",
    "expression_too_many_nodes",
    "expression_list_too_long",
    "expression_number_invalid",
    // Shape, identifiers, tagged values and normalization.
    "workflow_version_unsupported",
    "field_unknown",
    "field_missing",
    "field_invalid",
    "node_kind_invalid",
    "node_id_invalid",
    "node_id_duplicate",
    "node_id_reserved",
    "node_depth_exceeded",
    "node_count_exceeded",
    "input_name_invalid",
    "input_type_unsupported",
    "input_secret_forbidden",
    "output_name_invalid",
    "output_name_conflict",
    "value_reference_ambiguous",
    "literal_reserved_key",
    "reference_malformed",
    "reference_root_unknown",
    "reference_secret_forbidden",
    "repeat_seed_invalid",
    "repeat_outputs_invalid",
    "lane_repository_invalid",
    "agent_binding_invalid",
    "step_agent_version_forbidden",
    "effect_key_invalid",
    "duration_invalid",
    "timeout_exceeds_ceiling",
    "limits_invalid",
    // Catalog and action resolution.
    "action_unknown",
    "action_schema_unresolved",
    "action_requires_invalid",
    "action_checks_invalid",
    "action_checks_unsupported",
    "action_limits_invalid",
    "action_duplicate_field",
    "action_effect_key_required",
    "input_field_unknown",
    "input_field_missing",
    "wait_event_unknown",
    // Reference flow, needs and type check.
    "reference_future",
    "reference_self",
    "reference_skipped_step",
    "reference_unselected_branch",
    "reference_parallel_sibling",
    "reference_parallel_scope",
    "reference_repeat_scope",
    "reference_input_unknown",
    "reference_step_unknown",
    "reference_field_unknown",
    "needs_invalid",
    "needs_unknown",
    "needs_forward",
    "needs_cycle",
    "type_mismatch",
    "condition_not_boolean",
    "expression_operand_invalid",
    "branch_outputs_invalid",
    // Bounds, worst case and plan.
    "retry_invalid",
    "retry_exceeds_registry",
    "retry_fault_unsupported",
    "repeat_max_invalid",
    "repeat_exceeds_policy",
    "wait_shape_invalid",
    "wait_timeout_required",
    "parallel_lanes_invalid",
    "parallel_join_required",
    "parallel_failure_policy_required",
    "parallel_concurrency_invalid",
    "expansion_steps_exceeded",
    "expansion_attempts_exceeded",
    "expansion_wall_clock_exceeded",
    "expansion_cost_exceeded",
  ] as const,
);

export type WorkflowCompilerDiagnosticCode =
  (typeof WORKFLOW_COMPILER_DIAGNOSTIC_CODES)[number];

/**
 * Frozen code to message table. Messages are fixed prose: they never contain
 * a submitted key, value, identifier, event name or expression text.
 */
export const WORKFLOW_COMPILER_MESSAGES: Readonly<
  Record<WorkflowCompilerDiagnosticCode, string>
> = Object.freeze({
  definition_syntax_invalid: "The definition is not valid JSON.",
  definition_duplicate_key: "An object repeats a member name.",
  definition_too_large: "The definition exceeds the size limit.",
  definition_too_deep: "The definition is nested too deeply.",
  definition_too_many_values: "The definition holds too many values.",
  definition_value_unsupported: "The definition holds a non-JSON value.",
  definition_number_invalid:
    "A number is not exactly representable as a finite JSON number.",
  definition_key_forbidden: "An object member name is forbidden.",
  diagnostics_truncated: "Further diagnostics were omitted.",
  expression_syntax_invalid: "The expression is not valid.",
  expression_too_long: "The expression exceeds the length limit.",
  expression_too_deep: "The expression is nested too deeply.",
  expression_too_many_nodes: "The expression has too many nodes.",
  expression_list_too_long: "An expression list has too many items.",
  expression_number_invalid: "An expression number is not exact and finite.",
  workflow_version_unsupported:
    "The workflow apiVersion or kind is unsupported.",
  field_unknown: "A field is not allowed here.",
  field_missing: "A required field is missing.",
  field_invalid: "A field has an invalid shape.",
  node_kind_invalid: "A node must declare exactly one known kind.",
  node_id_invalid: "A node identifier is invalid.",
  node_id_duplicate: "A node identifier is already used in this scope.",
  node_id_reserved: "A node identifier is reserved in this scope.",
  node_depth_exceeded: "Nodes are nested too deeply.",
  node_count_exceeded: "The workflow has too many nodes.",
  input_name_invalid: "A workflow input name is invalid.",
  input_type_unsupported: "A workflow input type is not supported.",
  input_secret_forbidden: "A secret cannot be a workflow or action input.",
  output_name_invalid: "An output name is invalid.",
  output_name_conflict: "An output name collides with a child identifier.",
  value_reference_ambiguous: "A string mixes literal text with a reference.",
  literal_reserved_key: "A reserved key was used in a literal object.",
  reference_malformed: "A reference is malformed.",
  reference_root_unknown: "A reference root is unknown.",
  reference_secret_forbidden: "A reference reads a secret.",
  repeat_seed_invalid: "The repeat seed is invalid.",
  repeat_outputs_invalid: "The repeat outputs are invalid.",
  lane_repository_invalid: "A lane repository alias is missing or invalid.",
  agent_binding_invalid: "An agent binding is invalid.",
  step_agent_version_forbidden: "A step cannot select an agent version.",
  effect_key_invalid: "The effect key is invalid.",
  duration_invalid: "A duration is malformed or below the minimum.",
  timeout_exceeds_ceiling: "A duration exceeds the allowed ceiling.",
  limits_invalid: "A limit is invalid.",
  action_unknown: "The action is not registered.",
  action_schema_unresolved: "The action schema cannot be resolved.",
  action_requires_invalid: "The declared capabilities are invalid.",
  action_checks_invalid: "A check name is not registered.",
  action_checks_unsupported: "The action does not accept checks.",
  action_limits_invalid: "An action limit is invalid.",
  action_duplicate_field: "A field is supplied in two locations.",
  action_effect_key_required: "The action requires an effect key.",
  input_field_unknown: "The action input has an unknown field.",
  input_field_missing: "The action input is missing a required field.",
  wait_event_unknown: "The wait event is not known.",
  reference_future: "A reference reads a step that has not completed.",
  reference_self: "A step references itself.",
  reference_skipped_step: "A reference reads a step that may be skipped.",
  reference_unselected_branch:
    "A reference reads a step in an unselected branch arm.",
  reference_parallel_sibling:
    "A reference reads a sibling lane without depending on it.",
  reference_parallel_scope: "A reference reads inside a parallel lane.",
  reference_repeat_scope: "A reference is outside the repeat scope.",
  reference_input_unknown: "A reference names an undeclared input.",
  reference_step_unknown: "A reference names an unknown step.",
  reference_field_unknown: "A reference names an unknown field.",
  needs_invalid: "The needs list is invalid.",
  needs_unknown: "The needs list names an unknown sibling.",
  needs_forward: "The needs list names a later sibling.",
  needs_cycle: "The needs graph contains a cycle.",
  type_mismatch: "A value does not match the expected type.",
  condition_not_boolean: "A condition does not evaluate to a boolean.",
  expression_operand_invalid: "An expression operand has an invalid type.",
  branch_outputs_invalid: "The branch outputs are invalid.",
  retry_invalid: "The retry policy is invalid.",
  retry_exceeds_registry: "The retry policy exceeds the registry limit.",
  retry_fault_unsupported: "A retry fault is not supported by the action.",
  repeat_max_invalid: "The repeat max is invalid.",
  repeat_exceeds_policy: "The repeat max exceeds the repair-cycle policy.",
  wait_shape_invalid: "The wait must declare a duration or an event.",
  wait_timeout_required: "An event wait requires a timeout.",
  parallel_lanes_invalid: "The parallel lanes are invalid.",
  parallel_join_required: "The parallel join policy must be explicit.",
  parallel_failure_policy_required:
    "The parallel failure policy must be explicit.",
  parallel_concurrency_invalid: "The parallel concurrency is invalid.",
  expansion_steps_exceeded: "The expanded step count exceeds the limit.",
  expansion_attempts_exceeded:
    "The worst-case attempt count exceeds the limit.",
  expansion_wall_clock_exceeded: "The worst-case duration exceeds the limit.",
  expansion_cost_exceeded: "The worst-case cost exceeds the limit.",
});

export const WorkflowCompilerDiagnosticSchema = z.object({
  path: z.string().max(2048).describe(
    "RFC 6901 JSON Pointer to the offending location, built only from safe segments and truncated to the nearest safe ancestor.",
  ),
  code: z.enum(WORKFLOW_COMPILER_DIAGNOSTIC_CODES).describe(
    "Stable machine-readable diagnostic code from the closed workflow compiler set.",
  ),
  message: z.string().max(200).describe(
    "Fixed prose for the code; never contains a submitted key, value, identifier or expression.",
  ),
}).strict().describe(
  "One workflow compiler finding, located by JSON Pointer and explained by fixed prose that never echoes submitted values.",
);

export type WorkflowCompilerDiagnostic = {
  readonly path: string;
  readonly code: WorkflowCompilerDiagnosticCode;
  readonly message: string;
};

/** One pointer segment: an array index, or a candidate field name to vet. */
export type PointerSegment = string | number;

const SAFE_NAME_SEGMENT = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** True when a segment may appear in a diagnostic pointer. */
export function isSafePointerSegment(segment: PointerSegment): boolean {
  return typeof segment === "number"
    ? Number.isSafeInteger(segment) && segment >= 0
    : SAFE_NAME_SEGMENT.test(segment);
}

function escapeSegment(segment: PointerSegment): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Builds a JSON Pointer from vetted segments. The first unsafe segment (a
 * negative or fractional index, or a name outside the safe pattern) truncates
 * the pointer to its parent, so a submitted key never reaches a diagnostic.
 */
export function pointerOf(segments: readonly PointerSegment[]): string {
  let result = "";
  for (const segment of segments) {
    if (!isSafePointerSegment(segment)) break;
    result += `/${escapeSegment(segment)}`;
  }
  return result;
}

export function diagnosticOf(
  path: string,
  code: WorkflowCompilerDiagnosticCode,
): WorkflowCompilerDiagnostic {
  return Object.freeze({
    path,
    code,
    message: WORKFLOW_COMPILER_MESSAGES[code],
  });
}

export type DiagnosticCollector = {
  /** Adds a diagnostic unless it is a duplicate or the cap was reached. */
  add(path: string, code: WorkflowCompilerDiagnosticCode): void;
  /** Number of diagnostics held, not counting the truncation marker. */
  readonly size: number;
  /** True once a diagnostic was dropped for exceeding the cap. */
  readonly truncated: boolean;
  /** Ordered diagnostics, ending with `diagnostics_truncated` when capped. */
  list(): readonly WorkflowCompilerDiagnostic[];
};

/** Capped, de-duplicating collector. Holds at most the limit plus one marker. */
export function createDiagnosticCollector(
  limit: number = WORKFLOW_COMPILER_LIMITS.diagnostics,
): DiagnosticCollector {
  const held: WorkflowCompilerDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  return {
    add(path, code) {
      const key = `${code}\u0000${path}`;
      if (seen.has(key)) return;
      if (held.length >= limit) {
        truncated = true;
        return;
      }
      seen.add(key);
      held.push(diagnosticOf(path, code));
    },
    get size() {
      return held.length;
    },
    get truncated() {
      return truncated;
    },
    list() {
      return truncated
        ? [...held, diagnosticOf("", "diagnostics_truncated")]
        : [...held];
    },
  };
}
