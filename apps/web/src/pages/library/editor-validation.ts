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

/** The line a step shows for its problems: the first message, and how many more. */
export function stepProblemLine(
  problems: readonly ValidationProblem[],
): string | null {
  if (problems.length === 0) return null;
  const first = problems[0].message;
  return problems.length === 1 ? first : `${first} (+${problems.length - 1})`;
}
