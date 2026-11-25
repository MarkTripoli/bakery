/**
 * Where the server's validation report belongs on the step the person is
 * looking at (#67, slice 1). The report answers JSON Pointers into the
 * definition it was given, so `/steps/2/uses` is the third step's action; a
 * pointer that names no step ("", `/steps`, `/name`) is the workflow's own
 * problem, not a step's.
 */

/** One problem as the report states it. */
export type ValidationProblem = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type StepProblems = {
  /** The problems that belong to a step, by the step's index. */
  readonly byStep: ReadonlyMap<number, readonly ValidationProblem[]>;
  /** The problems about the workflow itself, which no step can hold. */
  readonly workflow: readonly ValidationProblem[];
};

/** The codes for a skill that needs a choice: when a step has only these, its Skills section says it. */
export const SKILL_PROBLEM_CODES: ReadonlySet<string> = new Set([
  "step_skill_slot_open",
  "step_skill_stopped",
  "step_skill_unavailable",
]);

/** The one sentence for a step whose skill needs a choice, whichever of the three reasons it is. */
export const SKILL_PROBLEM_SENTENCE = "A skill on this step needs a choice.";

export const UNBOUND_AGENT_CODE = "model_agent_unbound";

export function withoutUnboundAgent(
  problems: readonly ValidationProblem[],
): readonly ValidationProblem[] {
  return problems.filter((problem) => problem.code !== UNBOUND_AGENT_CODE);
}

export function unboundActionsOf(
  problems: readonly ValidationProblem[],
  definition: unknown,
): ReadonlySet<string> {
  const actions = new Set<string>();
  for (const problem of problems) {
    if (problem.code !== UNBOUND_AGENT_CODE) continue;
    let node: unknown = definition;
    for (const part of problem.path.split("/")) {
      if (part === "") continue;
      node = typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
    }
    if (typeof node === "string") actions.add(node);
  }
  return actions;
}

/** The step index a pointer names, or null when it names no single step. */
export function stepIndexOf(path: string): number | null {
  // `/steps/2/uses`, `/steps/2`, and nothing else: a bare `/steps` is the list.
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 2 || parts[0] !== "steps") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(parts[1])) return null;
  return Number(parts[1]);
}

/** The report's problems sorted by the step they belong to. */
export function problemsOf(
  problems: readonly ValidationProblem[],
): StepProblems {
  const byStep = new Map<number, ValidationProblem[]>();
  const workflow: ValidationProblem[] = [];
  for (const problem of problems) {
    const index = stepIndexOf(problem.path);
    if (index === null) {
      workflow.push(problem);
      continue;
    }
    const held = byStep.get(index) ?? [];
    held.push(problem);
    byStep.set(index, held);
  }
  return { byStep, workflow };
}

/**
 * The one sentence a person reads for a problem code (#67 comment 6900485736
 * section 3). The server's own message is never shown: it names schema paths
 * and validator internals, not the step in front of them.
 *
 * Every code the validator can return has a sentence, and any code this table
 * does not know falls back to one written sentence rather than the message.
 */
const SENTENCES: Readonly<Record<string, string>> = {
  // The workflow's own problems.
  steps_required: "This workflow has no steps. Press + to add one.",
  steps_too_many:
    "This workflow has more steps than Bakery allows. Delete some steps.",
  definition_too_large:
    "This workflow is too large to publish. Delete some steps.",
  agent_binding_action_unknown:
    "This workflow's agent settings point at something Bakery cannot find. Ask an administrator to check the workflow's agents.",
  agent_binding_id_invalid:
    "This workflow's agent settings point at something Bakery cannot find. Ask an administrator to check the workflow's agents.",
  agents_not_object:
    "This workflow's agent settings point at something Bakery cannot find. Ask an administrator to check the workflow's agents.",
  definition_not_object:
    "Bakery cannot read this workflow. Open View as code to see what it holds.",
  workflow_structure_invalid:
    "Bakery cannot read this workflow. Open View as code to see what it holds.",
  workflow_kind_unsupported:
    "Bakery cannot read this workflow. Open View as code to see what it holds.",
  // A step whose skill needs a choice: the row in the Skills panel says which.
  step_skill_slot_open: SKILL_PROBLEM_SENTENCE,
  step_skill_stopped: SKILL_PROBLEM_SENTENCE,
  step_skill_unavailable: SKILL_PROBLEM_SENTENCE,
  parallel_lanes_workspace_write:
    "Only one lane of steps that run side by side may change the repository. Open View as code and narrow one of them.",
  action_unknown:
    "Bakery does not know this kind of step. Delete it and add a step from the list.",
  step_action_invalid:
    "Bakery does not know this kind of step. Delete it and add a step from the list.",
  action_not_executable:
    "This kind of step cannot run yet. Delete it or put another step in its place.",
  step_id_duplicate:
    "This step's ID clashes with another step. Delete this step and add it again.",
  step_id_invalid:
    "This step's ID clashes with another step. Delete this step and add it again.",
  step_binding_override_forbidden:
    "This step chooses an agent it is not allowed to choose. Delete the step and add it again.",
  step_not_object: "Bakery cannot read this step. Delete it and add it again.",
  step_requires_invalid:
    "Bakery cannot read this step. Delete it and add it again.",
};

/** The sentence shown where the table has no entry for a code. */
export const PROBLEM_FALLBACK =
  "This step has a problem. Open View as code to see the detail.";

/** The sentence a problem code is shown as. Never the server's message. */
export function problemSentence(code: string): string {
  return SENTENCES[code] ?? PROBLEM_FALLBACK;
}

/**
 * The lines a step shows for its problems: one sentence per problem, in the
 * order the report lists them. Two problems are two sentences, never a count.
 */
export function stepProblemLines(
  problems: readonly ValidationProblem[],
): readonly string[] {
  return problems.map((problem) => problemSentence(problem.code));
}

/** The single line under a step's card: its first problem's sentence. */
export function stepProblemLine(
  problems: readonly ValidationProblem[],
): string | null {
  const lines = stepProblemLines(problems);
  return lines.length === 0 ? null : lines[0];
}
