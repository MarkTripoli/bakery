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
