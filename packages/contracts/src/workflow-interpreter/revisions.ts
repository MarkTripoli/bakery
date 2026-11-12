import {
  WORKFLOW_COMPILER_VERSION,
  workflowSemanticDigest,
} from "../workflow-compiler/digest.ts";
import type { WorkflowSemanticDocument } from "../workflow-compiler/schema.ts";
import { WorkflowInterpreterError } from "./errors.ts";
import { type NextStep, nextStep, type RunState } from "./interpret.ts";

/** One released way of deciding what a compiled workflow does next. */
export type InterpreterRevision = (
  document: WorkflowSemanticDocument,
  state: RunState,
) => NextStep;

/**
 * Every interpreter revision a deployed server can still run. A run records the
 * revision it was admitted under and resumes on that revision for its whole
 * life, so a revision is never edited once a run can be pinned to it and never
 * removed while a run pinned to it can still resume. A change in behavior is a
 * new entry. Revision 1's behavior is held in place by a conformance test.
 */
export const INTERPRETER_REVISIONS: Readonly<
  Record<string, InterpreterRevision>
> = Object.freeze({ "1": nextStep });

/** The revision a run admitted now is pinned to. */
export const CURRENT_INTERPRETER_REVISION = "1";

/**
 * What a run freezes at admission so a later deploy cannot change how it runs:
 * the compiler that produced its document, the digest of that document, and the
 * interpreter revision that executes it.
 */
export type WorkflowRuntimePin = Readonly<{
  compilerVersion: string;
  interpreterRevision: string;
  semanticDigest: string;
}>;

/** Pins the runtime a run admitted now will execute under. */
export async function pinWorkflowRuntime(
  document: WorkflowSemanticDocument,
): Promise<WorkflowRuntimePin> {
  return {
    compilerVersion: WORKFLOW_COMPILER_VERSION,
    interpreterRevision: CURRENT_INTERPRETER_REVISION,
    semanticDigest: await workflowSemanticDigest(document),
  };
}

const PIN_FIELDS = ["compilerVersion", "interpreterRevision", "semanticDigest"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reads a pin back from storage. It has exactly its three fields, each of the
 * right kind; anything else is refused without echoing what it carried.
 */
export function readWorkflowRuntimePin(value: unknown): WorkflowRuntimePin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowInterpreterError("runtime_pin_invalid");
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    keys.length !== PIN_FIELDS.length ||
    !PIN_FIELDS.every((name) => Object.hasOwn(fields, name))
  ) {
    throw new WorkflowInterpreterError("runtime_pin_invalid");
  }
  const { compilerVersion, interpreterRevision, semanticDigest } = fields;
  if (
    typeof compilerVersion !== "string" || compilerVersion === "" ||
    typeof interpreterRevision !== "string" || interpreterRevision === "" ||
    typeof semanticDigest !== "string" || !SHA256_HEX.test(semanticDigest)
  ) {
    throw new WorkflowInterpreterError("runtime_pin_invalid");
  }
  return { compilerVersion, interpreterRevision, semanticDigest };
}

/**
 * The interpreter a pinned run resumes on. The pinned revision must still be
 * deployed, and the document must still be the one that was pinned: its
 * compiler version and digest are checked, so a run is never resumed on a
 * revision it was not admitted under or on a document that changed under it.
 * Neither is repaired by falling back to the current revision.
 *
 * `available` defaults to the deployed registry and is a parameter so a test
 * can stand in for a later deploy.
 */
export async function resolveWorkflowRuntime(
  pin: WorkflowRuntimePin,
  document: WorkflowSemanticDocument,
  available: Readonly<Record<string, InterpreterRevision>> =
    INTERPRETER_REVISIONS,
): Promise<InterpreterRevision> {
  const revision = Object.hasOwn(available, pin.interpreterRevision)
    ? available[pin.interpreterRevision]
    : undefined;
  if (revision === undefined) {
    throw new WorkflowInterpreterError("revision_unavailable");
  }
  if (
    pin.compilerVersion !== String(document.compilerVersion) ||
    pin.semanticDigest !== await workflowSemanticDigest(document)
  ) {
    throw new WorkflowInterpreterError("pin_mismatch");
  }
  return revision;
}
