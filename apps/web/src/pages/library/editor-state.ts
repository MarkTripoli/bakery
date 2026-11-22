/**
 * The steps of the workflow being edited, and every move a person can make on
 * them (#67, slice 1): add, remove, move, undo, redo. It is a pure reducer so
 * the editor's rules are testable without a browser — the page only renders
 * what this decides, and the publish dialog sends its `steps`.
 */

/** One step as the editor holds it: what it runs, and the agent bound to it. */
export type EditorStep = {
  readonly id: string;
  readonly uses: string;
  readonly agentVersionId: string | null;
  /** The skill versions the step names, in order (#431); none for most steps. */
  readonly skills: readonly string[];
};

export type EditorState = {
  readonly steps: readonly EditorStep[];
  /** Earlier states, oldest first; the last one undo returns to. */
  readonly past: readonly (readonly EditorStep[])[];
  /** States undone and not yet redone, newest first. */
  readonly future: readonly (readonly EditorStep[])[];
};

export type EditorAction =
  | { readonly kind: "add"; readonly step: EditorStep }
  | { readonly kind: "remove"; readonly id: string }
  /** Move the step to `index` in the list it ends up in; clamped, never lost. */
  | { readonly kind: "move"; readonly id: string; readonly index: number }
  /** Set the skill versions a step names: attach and remove both are this. */
  | {
    readonly kind: "skills";
    readonly id: string;
    readonly skills: readonly string[];
  }
  /** Start again from these steps: a different version is being edited. */
  | { readonly kind: "reset"; readonly steps: readonly EditorStep[] }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

/**
 * The definition the editor saves: the version's own definition with its
 * `steps` replaced by the editor's list. A step the editor did not change is
 * the authored node itself, every key kept (`if`, `retry`, `limits`, …),
 * so an edit of one step never rewrites another. A changed step keeps the keys
 * the editor does not hold; a new step has only what the editor knows.
 */
export function definitionOf(
  spec: Readonly<Record<string, unknown>> | null,
  steps: readonly EditorStep[],
): Record<string, unknown> {
  const held = Array.isArray(spec?.steps) ? spec.steps : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of held) {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const node = raw as Record<string, unknown>;
      if (typeof node.id === "string") byId.set(node.id, node);
    }
  }
  return {
    ...(spec ?? {}),
    steps: steps.map((step) => {
      const node = byId.get(step.id);
      const agent = typeof node?.agentVersionId === "string"
        ? node.agentVersionId
        : null;
      const skills = skillsOfNode(node);
      if (
        node !== undefined && node.uses === step.uses &&
        agent === step.agentVersionId && sameList(skills, step.skills)
      ) {
        return node;
      }
      const { agentVersionId: _dropped, skills: _skills, ...rest } = node ?? {};
      return {
        ...rest,
        id: step.id,
        uses: step.uses,
        ...(step.agentVersionId === null
          ? {}
          : { agentVersionId: step.agentVersionId }),
        // A step with no skills carries no `skills` key, as an authored one does.
        ...(step.skills.length === 0 ? {} : { skills: [...step.skills] }),
      };
    }),
  };
}

/** The skill version ids an authored step names; anything else is no skills. */
export function skillsOfNode(
  node: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  return Array.isArray(node?.skills)
    ? node.skills.filter((item): item is string => typeof item === "string")
    : [];
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, at) => item === right[at]);

/** The editor's state for a version's steps: nothing to undo yet. */
export function editorStateOf(
  steps: readonly EditorStep[],
): EditorState {
  return { steps: [...steps], past: [], future: [] };
}

/** Whether the steps differ from the state the editor started from. */
export function isDirty(state: EditorState): boolean {
  return state.past.length > 0;
}

/** How many steps the editor has, and whether undo and redo are possible. */
export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

/** A step id no step of this state uses, so an added step is addressable. */
export function freeStepId(
  state: EditorState,
  wanted = "step",
): string {
  const taken = new Set(state.steps.map((step) => step.id));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2;; n += 1) {
    const candidate = `${wanted}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const changed = (
  state: EditorState,
  steps: readonly EditorStep[],
): EditorState => ({
  steps,
  past: [...state.past, state.steps],
  future: [],
});

/** The index `index` clamped into a list of `length` items. */
function clamp(index: number, length: number): number {
  if (Number.isNaN(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(length, 0));
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.kind) {
    case "add":
      return changed(state, [...state.steps, action.step]);
    case "remove": {
      // Removing a step that is not there changes nothing, and leaves no
      // undo step behind: the history records what happened, not what was asked.
      if (!state.steps.some((step) => step.id === action.id)) return state;
      return changed(
        state,
        state.steps.filter((step) => step.id !== action.id),
      );
    }
    case "move": {
      const from = state.steps.findIndex((step) => step.id === action.id);
      if (from === -1) return state;
      const rest = state.steps.filter((step) => step.id !== action.id);
      const to = clamp(action.index, rest.length);
      const steps = [
        ...rest.slice(0, to),
        state.steps[from],
        ...rest.slice(to),
      ];
      if (steps.every((step, at) => step.id === state.steps[at].id)) {
        return state;
      }
      return changed(state, steps);
    }
    case "skills": {
      const at = state.steps.findIndex((step) => step.id === action.id);
      if (at === -1 || sameList(state.steps[at].skills, action.skills)) {
        return state;
      }
      return changed(
        state,
        state.steps.map((step, index) =>
          index === at ? { ...step, skills: [...action.skills] } : step
        ),
      );
    }
    case "reset":
      return {
        steps: [...action.steps],
        past: [],
        future: [],
      };
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        steps: previous,
        past: state.past.slice(0, -1),
        future: [state.steps, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        steps: next,
        past: [...state.past, state.steps],
        future: state.future.slice(1),
      };
    }
  }
}
