/**
 * Every refusal the workflow interpreter can make. The message is fixed text
 * per code: it never carries a value, a path or an identifier that came from a
 * workflow, an input or a step output.
 */
export const WORKFLOW_INTERPRETER_ERRORS = {
  condition_not_boolean:
    "A condition did not evaluate to a boolean. The run cannot continue.",
  operand_invalid:
    "An expression operand has a type this operator does not accept. The run cannot continue.",
  reference_unresolved:
    "A reference names a value that the run has not recorded. The run cannot continue.",
  delivery_unresolved:
    "A reference reads delivery state that the host has not resolved yet.",
  parallel_unsupported:
    "This workflow contains a parallel group, which this interpreter revision does not run.",
  document_invalid:
    "The workflow document does not have the shape this interpreter runs.",
  state_not_json:
    "A recorded value is not plain JSON of bounded depth, so the interpreter cannot answer from it.",
  state_too_large:
    "A recorded value is larger than the interpreter will copy once every reference to it is expanded, so it cannot answer from it.",
  runtime_pin_invalid:
    "The recorded runtime pin does not have the shape of a runtime pin.",
  revision_unavailable:
    "The interpreter revision this run is pinned to is not deployed. The run cannot resume on another revision.",
  pin_mismatch:
    "The workflow document does not match the compiler version and digest this run is pinned to.",
} as const;

export type WorkflowInterpreterErrorCode =
  keyof typeof WORKFLOW_INTERPRETER_ERRORS;

export class WorkflowInterpreterError extends Error {
  readonly code: WorkflowInterpreterErrorCode;

  constructor(code: WorkflowInterpreterErrorCode) {
    super(WORKFLOW_INTERPRETER_ERRORS[code]);
    this.name = "WorkflowInterpreterError";
    this.code = code;
  }
}
