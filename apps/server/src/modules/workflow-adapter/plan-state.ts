import {
  type WorkflowSemanticDocument,
  WorkflowSemanticDocumentSchema,
} from "@bakery/contracts/workflow-compiler";
import {
  INTERPRETER_REVISIONS,
  type InterpreterRevision,
  type JsonValue,
  type NextStep,
  readWorkflowRuntimePin,
  resolveWorkflowRuntime,
  type StepRecord,
  type WorkflowRuntimePin,
} from "@bakery/contracts/workflow-interpreter";

/**
 * The part of running a compiled plan that is neither the interpreter nor the
 * database: what a run snapshot freezes, how stored step rows become the
 * interpreter's records, and one call that asks the run's own interpreter
 * revision what to do next. It touches no database and adds no decisions of its
 * own; the engine supplies the rows and acts on the answer.
 */

/** Every refusal of this module. The text is fixed and never carries a value. */
export const PLAN_STATE_ERRORS = {
  plan_snapshot_invalid:
    "The run snapshot's runtime section does not have the shape of a pinned plan.",
  plan_row_invalid:
    "A stored step row cannot be read as a record of a compiled plan.",
} as const;

export type PlanStateErrorCode = keyof typeof PLAN_STATE_ERRORS;

export class PlanStateError extends Error {
  readonly code: PlanStateErrorCode;

  constructor(code: PlanStateErrorCode) {
    super(PLAN_STATE_ERRORS[code]);
    this.name = "PlanStateError";
    this.code = code;
  }
}

/** A run executed from a compiled plan: its frozen document, pin and interpreter. */
export type PlanRuntime = Readonly<{
  pin: WorkflowRuntimePin;
  document: WorkflowSemanticDocument;
  interpreter: InterpreterRevision;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The runtime a run was admitted under, or `null` for a run admitted before
 * plans existed (no `runtime` section), which keeps running on the flat loop.
 * A section that is there but wrong is refused by name, never read as legacy:
 * a half-written pin must not turn a plan run into a flat one.
 *
 * The pinned revision must still be deployed and the frozen document must
 * still match its pin, both checked by `resolveWorkflowRuntime`, so an old run
 * resumes on the semantics it started with or is refused.
 */
export async function planRuntimeFromSnapshot(
  snapshot: unknown,
  available: Readonly<Record<string, InterpreterRevision>> =
    INTERPRETER_REVISIONS,
): Promise<PlanRuntime | null> {
  if (!isRecord(snapshot)) throw new PlanStateError("plan_snapshot_invalid");
  if (!Object.hasOwn(snapshot, "runtime")) return null;
  const section = snapshot["runtime"];
  if (
    !isRecord(section) || Object.keys(section).length !== 2 ||
    !Object.hasOwn(section, "pin") || !Object.hasOwn(section, "document")
  ) {
    throw new PlanStateError("plan_snapshot_invalid");
  }
  const pin = readWorkflowRuntimePin(section["pin"]);
  const parsed = WorkflowSemanticDocumentSchema.safeParse(section["document"]);
  if (!parsed.success) throw new PlanStateError("plan_snapshot_invalid");
  const interpreter = await resolveWorkflowRuntime(
    pin,
    parsed.data,
    available,
  );
  return { pin, document: parsed.data, interpreter };
}

/** The run's frozen inputs, which `$input` references read. */
export function planInputsFromSnapshot(
  snapshot: unknown,
): Readonly<Record<string, JsonValue>> {
  if (!isRecord(snapshot) || !isRecord(snapshot["inputs"])) {
    throw new PlanStateError("plan_snapshot_invalid");
  }
  return snapshot["inputs"] as Readonly<Record<string, JsonValue>>;
}

/**
 * The run's frozen `$task`: what the plan may read about the task it runs
 * for. Admission writes it into the snapshot beside the runtime section, so a
 * later edit of the task cannot change what an old run's references resolve to.
 */
export function planTaskFromSnapshot(snapshot: unknown): JsonValue {
  if (!isRecord(snapshot) || !isRecord(snapshot["task"])) {
    throw new PlanStateError("plan_snapshot_invalid");
  }
  return snapshot["task"] as JsonValue;
}

const ACTION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const AGENT_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The agent each action falls back to when a step names none: the workflow's
 * own `agents` binding, else the repository profile's, frozen by admission so a
 * later edit of either cannot change an old run. A run that froze none has an
 * empty map. Every id is a lower-case agent version id; the agent itself is
 * read from `planAgents` under that id.
 */
export function planActionAgentsFromSnapshot(
  snapshot: unknown,
): Readonly<Record<string, string>> {
  if (!isRecord(snapshot)) throw new PlanStateError("plan_snapshot_invalid");
  const value = snapshot["planActionAgents"];
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 100) {
    throw new PlanStateError("plan_snapshot_invalid");
  }
  for (const [action, agentVersionId] of Object.entries(value)) {
    if (
      !ACTION_NAME.test(action) || typeof agentVersionId !== "string" ||
      !AGENT_VERSION_ID.test(agentVersionId)
    ) throw new PlanStateError("plan_snapshot_invalid");
  }
  return value as Readonly<Record<string, string>>;
}

/** A stored step row, as much of it as the interpreter reads. */
export type PlanStepRow = Readonly<{
  stepKey: string;
  iteration: number;
  status: string;
  output: unknown;
}>;

/**
 * Step rows become the interpreter's records, keyed by the full step key
 * (`repair@2.repair_test`), which a plan run stores whole in `step_key` with
 * iteration 0. A row that is still pending, running or waiting has no result
 * yet and is simply not a record, so the interpreter dispatches that key again
 * and the engine's own idempotent admission picks the work back up.
 *
 * A row this cannot read (an iteration other than 0, a repeated key, a status
 * it does not know) is refused: a plan's state must not be guessed at.
 */
export function recordsFromRows(
  rows: readonly PlanStepRow[],
): ReadonlyMap<string, StepRecord> {
  const records = new Map<string, StepRecord>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.iteration !== 0 || seen.has(row.stepKey)) {
      throw new PlanStateError("plan_row_invalid");
    }
    seen.add(row.stepKey);
    switch (row.status) {
      case "completed":
        records.set(row.stepKey, {
          status: "completed",
          output: (row.output ?? null) as JsonValue,
        });
        break;
      case "failed":
      case "canceled":
        records.set(row.stepKey, { status: row.status });
        break;
      case "pending":
      case "running":
      case "waiting":
        break;
      default:
        throw new PlanStateError("plan_row_invalid");
    }
  }
  return records;
}

/** What the engine knows about a run apart from its step rows. */
export type PlanStateInput = Readonly<{
  inputs: Readonly<Record<string, JsonValue>>;
  /** `$task`, frozen by the engine when the run is claimed. */
  task: JsonValue;
  /** `$delivery`, resolved by the engine; absent until it is. */
  delivery?: JsonValue;
  rows: readonly PlanStepRow[];
  cancelRequested?: boolean;
}>;

/** Asks the run's own interpreter revision what to do next. */
export function nextPlanStep(
  runtime: PlanRuntime,
  input: PlanStateInput,
): NextStep {
  return runtime.interpreter(runtime.document, {
    inputs: input.inputs,
    task: input.task,
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    steps: recordsFromRows(input.rows),
    ...(input.cancelRequested === true ? { cancelRequested: true } : {}),
  });
}
