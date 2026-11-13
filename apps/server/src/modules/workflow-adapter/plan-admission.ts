import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  buildWorkflowPlan,
  inputTypesOf,
  literalMatches,
  type WorkflowJsonValue,
  type WorkflowSemanticDocument,
  WorkflowSemanticDocumentSchema,
} from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import {
  cloneJson,
  type JsonValue,
  pinWorkflowRuntime,
  type WorkflowRuntimePin,
} from "@bakery/contracts/workflow-interpreter";
import { selectStepAgentVersion } from "@bakery/persistence";
import { readPlanAgents } from "@bakery/persistence/repository-admission";
import {
  planActionAgentsFromSnapshot,
  planInputsFromSnapshot,
  planRuntimeFromSnapshot,
  PlanStateError,
  planTaskFromSnapshot,
} from "./plan-state.ts";

/**
 * Admission's side of a compiled plan run: which agent each step runs as, which
 * inputs the run starts with, and the sections the run snapshot freezes. The
 * engine reads those sections back through `plan-state.ts` and
 * `readPlanAgents`; `writePlanRun` reads what it is about to write through the
 * same functions, so a snapshot the engine could not read is never inserted.
 * It touches no database: the caller supplies the task, the resolved agents
 * and the run's inputs.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The inputs the run starts with, checked against what the plan declares: each
 * declared input present (an optional one frozen as `null`), each of the right
 * kind, none undeclared. A refusal names the input; it never echoes its value.
 */
export function planRunInputs(
  document: WorkflowSemanticDocument,
  supplied: unknown,
): Record<string, JsonValue> {
  if (supplied !== null && supplied !== undefined && !isRecord(supplied)) {
    throw unprocessable(["inputs"], "inputs_not_object");
  }
  const given = supplied ?? {};
  const { types } = inputTypesOf(document, defaultWorkflowCompilerCatalog());
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(document.inputs, name)) {
      throw unprocessable(["inputs", name], "input_unknown");
    }
  }
  const frozen: Record<string, JsonValue> = {};
  for (const name of Object.keys(document.inputs).sort()) {
    if (!Object.hasOwn(given, name)) {
      if (document.inputs[name]!.required) {
        throw unprocessable(["inputs", name], "input_required");
      }
      frozen[name] = null;
      continue;
    }
    let value: JsonValue;
    try {
      value = cloneJson(given[name]);
    } catch {
      throw unprocessable(["inputs", name], "input_invalid");
    }
    if (!literalMatches(value as WorkflowJsonValue, types.get(name)!)) {
      throw unprocessable(["inputs", name], "input_invalid");
    }
    frozen[name] = value;
  }
  return frozen;
}

/**
 * The agent each action falls back to, for the steps that name none: the
 * workflow's `agents` binding, else the repository profile's. An action is
 * listed only when some step of it has no agent of its own, so an agent that
 * every step overrides is not frozen for nothing.
 */
export function planActionAgentBindings(
  document: WorkflowSemanticDocument,
  profileAgentBindings: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  const steps = buildWorkflowPlan(document).steps;
  const actions = new Set(
    steps.filter((step) =>
      step.kind === "action" && step.agentVersionId === undefined
    ).map((step) => step.action!),
  );
  for (const action of [...actions].sort()) {
    const { agentVersionId } = selectStepAgentVersion({
      action,
      stepAgentVersionId: undefined,
      workflowAgents: document.agents,
      profileAgentBindings,
    });
    if (agentVersionId !== null) bindings[action] = agentVersionId;
  }
  return bindings;
}

/** Every agent version a plan's steps can run as, sorted and once each. */
export function referencedPlanAgentIds(
  document: WorkflowSemanticDocument,
  actionAgents: Readonly<Record<string, string>>,
): string[] {
  const ids = new Set<string>(Object.values(actionAgents));
  for (const step of buildWorkflowPlan(document).steps) {
    if (step.kind === "action" && step.agentVersionId !== undefined) {
      ids.add(step.agentVersionId);
    }
  }
  return [...ids].sort();
}

/** What a plan run's snapshot freezes beside the sections every run has. */
export type PlanRunSections = Readonly<{
  runtime: Readonly<{
    pin: WorkflowRuntimePin;
    document: WorkflowSemanticDocument;
  }>;
  task: JsonValue;
  inputs: Record<string, JsonValue>;
  planAgents: JsonValue;
  planActionAgents: JsonValue;
}>;

const invalid = () => new PlanStateError("plan_snapshot_invalid");

/**
 * Builds the sections of a plan run's snapshot and proves them readable. The
 * document is read through the schema the engine reads it with and pinned as
 * parsed; the task and agents are copied, never aliased; and the finished
 * sections, as a jsonb column will hand them back, are read through
 * `planRuntimeFromSnapshot`, `planInputsFromSnapshot`, `planTaskFromSnapshot`,
 * `readPlanAgents` and `planActionAgentsFromSnapshot`. Anything those refuse is
 * refused here with `plan_snapshot_invalid`, before any row is written. The
 * frozen agents are exactly the ones the plan's steps and fallbacks name.
 *
 * Inputs the run cannot start with are the caller's to fix and are refused as
 * unprocessable; everything else this refuses is a bug of the admitting code.
 */
export async function writePlanRun(options: {
  document: WorkflowSemanticDocument;
  task: unknown;
  inputs: unknown;
  /** The resolved agents, by agent version id. */
  agents: Readonly<Record<string, unknown>>;
  actionAgents: Readonly<Record<string, string>>;
}): Promise<PlanRunSections> {
  const parsed = WorkflowSemanticDocumentSchema.safeParse(options.document);
  if (!parsed.success) throw invalid();
  const document = parsed.data;
  const inputs = planRunInputs(document, options.inputs);

  let task: JsonValue;
  let planAgents: JsonValue;
  let planActionAgents: JsonValue;
  try {
    task = cloneJson(options.task);
    planAgents = cloneJson(options.agents);
    planActionAgents = cloneJson(options.actionAgents);
  } catch {
    throw invalid();
  }

  const sections: PlanRunSections = {
    runtime: { pin: await pinWorkflowRuntime(document), document },
    task,
    inputs,
    planAgents,
    planActionAgents,
  };

  // Read it back as the engine will: from jsonb, through its own readers.
  const snapshot = JSON.parse(
    JSON.stringify({ schemaVersion: 1, ...sections }),
  );
  try {
    await planRuntimeFromSnapshot(snapshot);
    planInputsFromSnapshot(snapshot);
    planTaskFromSnapshot(snapshot);
    const agents = readPlanAgents(snapshot);
    const actionAgents = planActionAgentsFromSnapshot(snapshot);
    const expected = referencedPlanAgentIds(document, actionAgents);
    // Exactly the agents the plan names: none missing, none to spare.
    if (
      expected.length !== agents.size || !expected.every((id) => agents.has(id))
    ) throw invalid();
    // The fallbacks are the ones the plan's own rules produce.
    const own = planActionAgentBindings(document, actionAgents);
    const given = Object.entries(actionAgents).sort(([a], [b]) =>
      a < b ? -1 : 1
    );
    const wanted = Object.entries(own).sort(([a], [b]) => a < b ? -1 : 1);
    if (JSON.stringify(given) !== JSON.stringify(wanted)) throw invalid();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    throw invalid();
  }
  return sections;
}
