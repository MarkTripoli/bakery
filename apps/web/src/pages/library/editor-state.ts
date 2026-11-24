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

/** A repeat's three numbers as the panel commits them (#419). */
export type LoopEdit = {
  /** Where the repeat node sits in the definition, e.g. `["steps", 2]`. */
  readonly path: readonly (string | number)[];
  readonly min: number | null;
  readonly max: number;
  readonly allow: number | null;
};

/** Everything one undo step restores: the steps and the loop numbers. */
export type EditorSnapshot = {
  readonly steps: readonly EditorStep[];
  readonly loops: readonly LoopEdit[];
};

export type EditorState = EditorSnapshot & {
  /** Earlier states, oldest first; the last one undo returns to. */
  readonly past: readonly EditorSnapshot[];
  /** States undone and not yet redone, newest first. */
  readonly future: readonly EditorSnapshot[];
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
  /** Set one repeat's numbers; the panel only sends what validated. */
  | {
    readonly kind: "loop";
    readonly path: readonly (string | number)[];
    readonly min: number | null;
    readonly max: number;
    readonly allow: number | null;
  }
  | { readonly kind: "reset"; readonly steps: readonly EditorStep[] }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

/**
 * Whether the authored `steps` are a straight line of actions, the one shape
 * the editor rebuilds. A definition that holds a group keeps its authored
 * shape, because replacing its steps would drop every group.
 */
function straightLineOf(held: readonly unknown[]): boolean {
  return held.every((node) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return false;
    }
    const record = node as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    return (kind === "" || kind === "action") &&
      typeof record.id === "string";
  });
}

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
  loops: readonly LoopEdit[] = [],
): Record<string, unknown> {
  const authored = applyLoops(spec, loops);
  const held = Array.isArray(authored?.steps) ? authored.steps : [];
  if (!straightLineOf(held)) return authored ?? {};
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of held) {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const node = raw as Record<string, unknown>;
      if (typeof node.id === "string") byId.set(node.id, node);
    }
  }
  return {
    ...(authored ?? {}),
    steps: steps.map((step) => {
      const node = byId.get(step.id);
      const agent = typeof node?.agentVersionId === "string"
        ? node.agentVersionId
        : null;
      const skills = skillsOfNode(node);
      const sameAction = node !== undefined &&
        (node.uses === step.uses ||
          (typeof node.uses !== "string" && step.uses === ""));
      if (
        node !== undefined && sameAction &&
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

/**
 * The definition with each loop's committed numbers written into its repeat
 * node (#419): a number the person cleared is removed, so the authored shape
 * stays what it was. Nothing else in the definition is touched.
 */
export function applyLoops(
  spec: Readonly<Record<string, unknown>> | null,
  loops: readonly LoopEdit[],
): Readonly<Record<string, unknown>> | null {
  if (spec === null || loops.length === 0) return spec;
  const copy = structuredClone(spec) as Record<string, unknown>;
  for (const loop of loops) {
    const node = nodeAt(copy, loop.path);
    if (node === null) continue;
    if (loop.min === null) delete node.min;
    else node.min = loop.min;
    node.max = loop.max;
    if (loop.allow === null) delete node.allow;
    else node.allow = loop.allow;
  }
  return copy;
}

function nodeAt(
  root: Record<string, unknown>,
  path: readonly (string | number)[],
): Record<string, unknown> | null {
  let held: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(held)) return null;
      held = held[segment];
    } else {
      if (typeof held !== "object" || held === null || Array.isArray(held)) {
        return null;
      }
      held = (held as Record<string, unknown>)[segment];
    }
  }
  return typeof held === "object" && held !== null && !Array.isArray(held)
    ? held as Record<string, unknown>
    : null;
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
  return { steps: [...steps], loops: [], past: [], future: [] };
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

const snapshot = (state: EditorState): EditorSnapshot => ({
  steps: state.steps,
  loops: state.loops,
});

const changed = (
  state: EditorState,
  steps: readonly EditorStep[],
): EditorState => ({
  steps,
  loops: state.loops,
  past: [...state.past, snapshot(state)],
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
    case "loop": {
      const key = action.path.join("/");
      const at = state.loops.findIndex((loop) => loop.path.join("/") === key);
      const next: LoopEdit = {
        path: action.path,
        min: action.min,
        max: action.max,
        allow: action.allow,
      };
      const held = at === -1 ? undefined : state.loops[at];
      if (
        held !== undefined && held.min === next.min && held.max === next.max &&
        held.allow === next.allow
      ) {
        return state;
      }
      const loops = at === -1
        ? [...state.loops, next]
        : state.loops.map((loop, index) => index === at ? next : loop);
      return {
        steps: state.steps,
        loops,
        past: [...state.past, snapshot(state)],
        future: [],
      };
    }
    case "reset":
      return {
        steps: [...action.steps],
        loops: [],
        past: [],
        future: [],
      };
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        steps: previous.steps,
        loops: previous.loops,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        steps: next.steps,
        loops: next.loops,
        past: [...state.past, snapshot(state)],
        future: state.future.slice(1),
      };
    }
  }
}
