/** A step of a workflow definition: what it is called, what it runs, and whatever else the definition says. */
export type EditorStep = {
  readonly id: string;
  readonly uses: string;
  readonly [key: string]: unknown;
};

/** A workflow definition as the editor holds it: an object whose `steps` it edits and the rest of which it keeps as it is. */
export type EditorDefinition = { readonly [key: string]: unknown };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Whether the definition is a flat list of steps, which is what the Steps tab edits. */
export function hasStepList(definition: EditorDefinition): boolean {
  return Array.isArray(definition.steps);
}

/** The steps of a definition (an entry that is not an object is shown as an empty step). */
export function stepsOf(definition: EditorDefinition): EditorStep[] {
  const steps = definition.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const item = record(step);
    return {
      ...item,
      id: typeof item.id === "string" ? item.id : "",
      uses: typeof item.uses === "string" ? item.uses : "",
    };
  });
}

function withSteps(
  definition: EditorDefinition,
  steps: readonly unknown[],
): EditorDefinition {
  return { ...definition, steps };
}

/** A step key for an action ("harness.implement" is "implement"), unused by the others ("implement-2"). */
export function newStepId(uses: string, taken: readonly string[]): string {
  const last = uses.split(".").pop() ?? "";
  const base = last.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "step";
  if (!taken.includes(base)) return base;
  for (let number = 2;; number += 1) {
    const candidate = `${base}-${number}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Adds a step that runs `uses` at the end, or after `index` when given. */
export function addStep(
  definition: EditorDefinition,
  uses: string,
  index?: number,
): EditorDefinition {
  const steps = stepsOf(definition);
  const step: EditorStep = {
    id: newStepId(uses, steps.map((item) => item.id)),
    uses,
  };
  const at = index === undefined
    ? steps.length
    : Math.min(index + 1, steps.length);
  return withSteps(definition, [
    ...steps.slice(0, at),
    step,
    ...steps.slice(at),
  ]);
}

/** Removes the step at `index`. */
export function removeStep(
  definition: EditorDefinition,
  index: number,
): EditorDefinition {
  return withSteps(
    definition,
    stepsOf(definition).filter((_, at) => at !== index),
  );
}

/** Moves the step at `index` up (-1) or down (+1); a step at an end stays. */
export function moveStep(
  definition: EditorDefinition,
  index: number,
  delta: -1 | 1,
): EditorDefinition {
  const steps = stepsOf(definition);
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) {
    return definition;
  }
  const next = [...steps];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return withSteps(definition, next);
}

/** Sets one field of the step at `index` (its key `id`, or what it runs, `uses`). */
export function setStepField(
  definition: EditorDefinition,
  index: number,
  field: "id" | "uses",
  value: string,
): EditorDefinition {
  return withSteps(
    definition,
    stepsOf(definition).map((step, at) =>
      at === index ? { ...step, [field]: value } : step
    ),
  );
}

/** The definition as the Code tab shows it. */
export function definitionText(definition: EditorDefinition): string {
  return JSON.stringify(definition, null, 2);
}

/** Reads the Code tab's text: the definition, or where the JSON is wrong. */
export function readDefinitionText(
  text: string,
): { readonly ok: true; readonly definition: EditorDefinition } | {
  readonly ok: false;
  readonly message: string;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, message: "The definition must be one object." };
    }
    return { ok: true, definition: value as EditorDefinition };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Not valid JSON.",
    };
  }
}

/** Whether two definitions are the same (what makes a draft "changed"). */
export function sameDefinition(
  a: EditorDefinition,
  b: EditorDefinition,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The step a validation finding is about (its pointer is "/steps/2/uses"), or null when it is about the whole definition. */
export function stepIndexOf(path: string): number | null {
  const match = /^\/steps\/(\d+)(\/|$)/.exec(path);
  return match === null ? null : Number(match[1]);
}
