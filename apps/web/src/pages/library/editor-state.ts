/**
 * The steps of the workflow being edited, and every move a person can make on
 * them (#67, slice 1): add, remove, move, undo, redo. It is a pure reducer so
 * the editor's rules are testable without a browser — the page only renders
 * what this decides, and the publish dialog sends its `steps`.
 */

import type { WorkflowStart } from "@bakery/contracts/workflow-starts";
import {
  type ApprovalFields,
  approvalInput,
  approvalOfNode,
  sameApproval,
} from "./approval-step.ts";

/** One step as the editor holds it: what it runs, and the agent bound to it. */
export type EditorStep = {
  readonly id: string;
  readonly uses: string;
  readonly agentVersionId: string | null;
  /** The skill versions the step names, in order (#431); none for most steps. */
  readonly skills: readonly string[];
  readonly approval?: ApprovalFields;
  readonly list?: string;
};

export type LoopEdit = {
  readonly path: readonly (string | number)[];
  readonly min: number | null;
  readonly max: number;
  readonly allow: number | null;
};

export type EditorSnapshot = {
  readonly steps: readonly EditorStep[];
  readonly loops: readonly LoopEdit[];
  readonly starts: readonly WorkflowStart[];
};

export type EditorState = EditorSnapshot & {
  /** Earlier states, oldest first; the last one undo returns to. */
  readonly past: readonly EditorSnapshot[];
  /** States undone and not yet redone, newest first. */
  readonly future: readonly EditorSnapshot[];
  readonly typing?: string;
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
  | {
    readonly kind: "loop";
    readonly path: readonly (string | number)[];
    readonly min: number | null;
    readonly max: number;
    readonly allow: number | null;
  }
  | {
    readonly kind: "approval";
    readonly id: string;
    readonly approval: ApprovalFields;
    readonly typing?: string;
  }
  | {
    readonly kind: "starts";
    readonly starts: readonly WorkflowStart[];
    readonly typing?: string;
  }
  | {
    readonly kind: "reset";
    readonly steps: readonly EditorStep[];
    readonly starts?: readonly WorkflowStart[];
  }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

function isActionEntry(node: unknown): boolean {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return false;
  }
  const record = node as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  return (kind === "" || kind === "action") &&
    typeof record.id === "string" && record.steps === undefined &&
    AUTHORED_WRAPPERS.every((wrapper) => record[wrapper] === undefined);
}

export function straightLineOf(held: readonly unknown[]): boolean {
  return held.every(isActionEntry);
}

const GROUP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "needs",
  "kind",
  "steps",
]);

export type PlainGroup = Record<string, unknown> & {
  readonly id: string;
  readonly steps: readonly Record<string, unknown>[];
};

export function isPlainGroup(node: unknown): node is PlainGroup {
  const held = objectOf(node);
  return held !== null && typeof held.id === "string" &&
    (held.kind === undefined || held.kind === "sequence") &&
    Object.keys(held).every((key) => GROUP_KEYS.has(key)) &&
    Array.isArray(held.steps) && held.steps.length > 0 &&
    straightLineOf(held.steps);
}

export function nodeIds(value: unknown): ReadonlySet<string> {
  const found = new Set<string>();
  const walk = (held: unknown) => {
    if (Array.isArray(held)) {
      held.forEach(walk);
      return;
    }
    const node = objectOf(held);
    if (node === null) return;
    if (typeof node.id === "string") found.add(node.id);
    Object.values(node).forEach(walk);
  };
  walk(value);
  return found;
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
  if (straightLineOf(held)) {
    return { ...(authored ?? {}), steps: stepNodes(held, steps) };
  }
  if (!held.some(isPlainGroup)) return authored ?? {};
  return {
    ...(authored ?? {}),
    steps: held.map((node) => {
      if (!isPlainGroup(node)) return node;
      const inside = steps.filter((step) => step.list === node.id);
      return inside.length === 0
        ? node
        : { ...node, steps: stepNodes(node.steps, inside) };
    }),
  };
}

function stepNodes(
  held: readonly unknown[],
  steps: readonly EditorStep[],
): readonly Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of held) {
    const node = objectOf(raw);
    if (node !== null && typeof node.id === "string") byId.set(node.id, node);
  }
  return steps.map((step) => {
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
      agent === step.agentVersionId && sameList(skills, step.skills) &&
      keepsApproval(node, step)
    ) {
      return node;
    }
    const { agentVersionId: _dropped, skills: _skills, ...rest } = node ?? {};
    if (step.approval !== undefined) delete rest.with;
    const input = step.approval === undefined
      ? null
      : approvalInput(step.approval);
    return {
      ...rest,
      ...(input === null ? {} : { with: input }),
      id: step.id,
      uses: step.uses,
      ...(step.agentVersionId === null
        ? {}
        : { agentVersionId: step.agentVersionId }),
      // A step with no skills carries no `skills` key, as an authored one does.
      ...(step.skills.length === 0 ? {} : { skills: [...step.skills] }),
    };
  });
}

export function applyLoops(
  spec: Readonly<Record<string, unknown>> | null,
  loops: readonly LoopEdit[],
): Readonly<Record<string, unknown>> | null {
  if (spec === null || loops.length === 0) return spec;
  const copy = structuredClone(spec) as Record<string, unknown>;
  for (const loop of loops) {
    const node = nodeAt(copy, loop.path);
    if (node === null) continue;
    const held = loopBodyOf(node);
    if (held !== node) {
      delete node.min;
      delete node.max;
      delete node.allow;
    }
    if (loop.min === null) delete held.min;
    else held.min = loop.min;
    held.max = loop.max;
    if (loop.allow === null) delete held.allow;
    else held.allow = loop.allow;
  }
  return copy;
}

const AUTHORED_WRAPPERS = [
  "repeat",
  "branch",
  "parallel",
  "forEach",
] as const;

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function loopBodyOf(node: Record<string, unknown>): Record<string, unknown> {
  return objectOf(node.repeat) ?? node;
}

function childOf(node: Record<string, unknown>, key: string): unknown {
  if (node[key] !== undefined) return node[key];
  for (const wrapper of AUTHORED_WRAPPERS) {
    const held = objectOf(node[wrapper]);
    const inner = held?.[key] ?? (key === "lanes" ? held?.branches : undefined);
    if (inner !== undefined) return inner;
  }
  return undefined;
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
      const holder = objectOf(held);
      if (holder === null) return null;
      held = childOf(holder, segment);
    }
  }
  return objectOf(held);
}

/** The skill version ids an authored step names; anything else is no skills. */
export function skillsOfNode(
  node: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  return Array.isArray(node?.skills)
    ? node.skills.filter((item): item is string => typeof item === "string")
    : [];
}

function keepsApproval(
  node: Readonly<Record<string, unknown>>,
  step: EditorStep,
): boolean {
  if (step.approval === undefined) return true;
  const held = approvalOfNode(node);
  return held !== null && sameApproval(held, step.approval);
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, at) => item === right[at]);

/** The editor's state for a version's steps: nothing to undo yet. */
export function editorStateOf(
  steps: readonly EditorStep[],
  starts: readonly WorkflowStart[] = [],
): EditorState {
  return {
    steps: [...steps],
    loops: [],
    starts: [...starts],
    past: [],
    future: [],
  };
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
  held: ReadonlySet<string> = new Set(),
): string {
  const base = wanted.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const taken = new Set([...held, ...state.steps.map((step) => step.id)]);
  if (!taken.has(base)) return base;
  for (let n = 2;; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const snapshot = (state: EditorState): EditorSnapshot => ({
  steps: state.steps,
  loops: state.loops,
  starts: state.starts,
});

const changed = (
  state: EditorState,
  steps: readonly EditorStep[],
): EditorState => ({
  steps,
  loops: state.loops,
  starts: state.starts,
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
    case "approval": {
      const at = state.steps.findIndex((step) => step.id === action.id);
      const held = state.steps[at]?.approval;
      if (held === undefined || sameApproval(held, action.approval)) {
        return state;
      }
      const next = changed(
        state,
        state.steps.map((step, index) =>
          index === at ? { ...step, approval: action.approval } : step
        ),
      );
      if (action.typing === undefined) return next;
      const typing = `${action.id}/${action.typing}`;
      return state.typing === typing
        ? { ...next, past: state.past, typing }
        : { ...next, typing };
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
        starts: state.starts,
        past: [...state.past, snapshot(state)],
        future: [],
      };
    }
    case "starts": {
      if (JSON.stringify(state.starts) === JSON.stringify(action.starts)) {
        return state;
      }
      const next: EditorState = {
        ...snapshot(state),
        starts: [...action.starts],
        past: [...state.past, snapshot(state)],
        future: [],
      };
      if (action.typing === undefined) return next;
      const typing = `start/${action.typing}`;
      return state.typing === typing
        ? { ...next, past: state.past, typing }
        : { ...next, typing };
    }
    case "reset":
      return editorStateOf(action.steps, action.starts);
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...previous,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...next,
        past: [...state.past, snapshot(state)],
        future: state.future.slice(1),
      };
    }
  }
}
