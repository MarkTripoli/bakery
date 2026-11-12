import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  type WorkflowSemanticDocument,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  type ActionDispatch,
  type JsonValue,
  nextStep,
  type RunState,
  type StepRecord,
  type WaitDispatch,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";

// Shared by the interpreter's unit tests: compile a small workflow with the real
// compiler, then play the engine's part (dispatch, record a scripted result,
// ask again) so a test reads as a story about one run.

export type Step = Record<string, unknown>;
export type Dispatch = ActionDispatch | WaitDispatch;

export function workflow(steps: Step[], inputs: Record<string, unknown> = {}) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "interpreter",
    description: "Exercises the pure workflow interpreter.",
    inputs,
    steps,
  };
}

export async function compiled(
  steps: Step[],
  inputs: Record<string, unknown> = {},
): Promise<WorkflowSemanticDocument> {
  const result = await compileWorkflowDocument(workflow(steps, inputs));
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.document;
}

export const REPO_ID = "00000000-0000-4000-8000-0000000000a1";

export const noop = (id: string, extra: Step = {}): Step => ({
  id,
  uses: "workflow.noop",
  ...extra,
});

export function stateOf(
  over: Partial<RunState> & { steps?: Map<string, StepRecord> } = {},
): RunState {
  return {
    inputs: {},
    task: {},
    steps: new Map(),
    ...over,
  };
}

export type Script = (step: Dispatch, trace: readonly string[]) => StepRecord;

export const completed = (output: JsonValue = {}): StepRecord => ({
  status: "completed",
  output,
});

/** Plays the engine's part: dispatch, record a scripted result, ask again. */
export function drive(
  document: WorkflowSemanticDocument,
  script: Script,
  over: Partial<RunState> = {},
) {
  const steps = new Map<string, StepRecord>();
  const trace: string[] = [];
  const dispatched: Dispatch[] = [];
  for (let guard = 0; guard < 2000; guard += 1) {
    const state = stateOf({ ...over, steps });
    const next = nextStep(document, state);
    if (next.kind !== "dispatch") return { next, trace, dispatched, steps };
    // A duplicate call must not change the answer.
    assertEquals(nextStep(document, stateOf({ ...over, steps })), next);
    assert(!steps.has(next.step.key), `${next.step.key} dispatched twice`);
    trace.push(next.step.key);
    dispatched.push(next.step);
    steps.set(next.step.key, script(next.step, trace));
  }
  throw new Error("the interpreter never finished");
}
