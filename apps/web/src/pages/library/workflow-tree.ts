/**
 * The workflow as the editor draws it (#67, slice 1 of the owner's spec): a
 * definition's nodes turned into the cards and groups a person sees, top to
 * bottom. One model, two renderings — the diagram and the phone outline — so
 * the two cannot drift.
 *
 * The definition is the server's own node tree (`WorkflowNode`): a sequence of
 * nodes, each an action, a branch with two arms, a parallel with lanes, a
 * repeat, or a wait. Slice 1 draws all of them and edits only the actions in a
 * straight line; a group a person cannot change says "Edited in code".
 *
 * Nothing is ever left out of the drawing (design-ux's ruling on #67, comment
 * 6917906748): a step Bakery knows but can only change in code is drawn as its
 * own card marked "Edited in code", a step it cannot read is drawn as a card
 * that needs setup, and a group holds its place even when it is empty. The only
 * case that draws no steps is a definition whose list of steps cannot be read
 * at all, and the page says so in a notice rather than showing an empty editor.
 */

import { ACTION_TITLES, PICKER_STEPS } from "./workflow-state.ts";

/**
 * A step the editor could not read or does not know. The owner's spec says a
 * node is never dropped (section 8), so it is drawn as a card that needs setup
 * rather than left out: dropping it would hide a step a run would still take.
 */
export type StepProblem = "unknown" | "unreadable";

/** One card in the drawing: a step type, and the step it came from. */
export type TreeStep = {
  readonly kind: "step";
  /** The step's id in the definition, which is how a problem points at it. */
  readonly id: string;
  /** The action it runs, e.g. `task.brief`; empty when the step is unreadable. */
  readonly uses: string;
  readonly agentVersionId: string | null;
  /** Why the card needs setup, when the step could not be drawn as an action. */
  readonly problem?: StepProblem;
  /** What the definition states in code, shown on the card (`Written in code as`). */
  readonly code?: string;
  /**
   * Bakery knows the step but slice 1 can only change it in code: a type the
   * "Add a step" list does not offer, or a setting the panel cannot show.
   */
  readonly codeOnly?: boolean;
};

/** A group the editor draws but does not let anyone change in slice 1. */
export type TreeGroup = {
  readonly kind: "group";
  /** A stable id for the group, so selecting it opens its panel. */
  readonly id: string;
  /** What the group is called: "Yes", "Otherwise", "At the same time", "Repeat", "Wait". */
  readonly label: GroupLabel;
  /** The nodes inside it, drawn under the label. */
  readonly children: readonly TreeNode[];
  /** How the definition states it, so the page can say it is code-only. */
  readonly editedInCode: true;
};

export type GroupLabel = "yes" | "otherwise" | "together" | "repeat" | "wait";

export type TreeNode = TreeStep | TreeGroup;

export type Tree = {
  /** The nodes after "How it starts". */
  readonly nodes: readonly TreeNode[];
  /** How many steps the drawing holds, at any depth. */
  readonly stepCount: number;
  /** Whether the definition is a straight line slice 1 can edit end to end. */
  readonly straightLine: boolean;
  /**
   * The definition's `steps` is missing or is not a list. There is nowhere to
   * put a card, so the page shows a notice in place of the diagram.
   */
  readonly unreadable: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Every action the shared registry knows, by the name a step runs it under. */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.keys(ACTION_TITLES));

/** The types the "Add a step" list offers, which slice 1 can add and change. */
const ADDABLE_ACTIONS: ReadonlySet<string> = new Set(PICKER_STEPS);

/** The retry policy a step has when nobody authored one. */
const DEFAULT_RETRY = { maxAttempts: 1, backoffMs: 0, on: [] as unknown[] };

/**
 * Whether slice 1 can change this step in the panel: the "Add a step" list
 * offers its type, and it carries no setting the panel has nowhere to show.
 */
function isCodeOnly(node: Record<string, unknown>, uses: string): boolean {
  if (!KNOWN_ACTIONS.has(uses)) return false;
  if (!ADDABLE_ACTIONS.has(uses)) return true;
  if (node.if !== undefined) return true;
  if (node.retry !== undefined) {
    const retry = record(node.retry);
    const attempts = retry.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
    const backoff = retry.backoffMs ?? DEFAULT_RETRY.backoffMs;
    const on = Array.isArray(retry.on) ? retry.on : [];
    if (
      attempts !== DEFAULT_RETRY.maxAttempts || backoff !== 0 || on.length > 0
    ) {
      return true;
    }
  }
  if (node.limits !== undefined) return true;
  // A step that says what it may read and write (#448) is changed in code: the
  // panel cannot show it, so a visual edit must never drop the key.
  if (node.sealed !== undefined || node.files !== undefined) return true;
  if (node.effectKey !== undefined) return true;
  if (Array.isArray(node.checks) && node.checks.length > 0) return true;
  return Array.isArray(node.needs) && node.needs.length > 0;
}

/**
 * The nodes of a definition's `steps`, turned into what the drawing shows. A
 * `steps` that is missing or is not a list is the one case with nothing to
 * draw, and it says so instead of looking like a new workflow.
 */
export function treeOf(definition: unknown): Tree {
  const spec = record(definition);
  if (!Array.isArray(spec.steps)) {
    return Object.freeze({
      nodes: [],
      stepCount: 0,
      straightLine: false,
      unreadable: true,
    });
  }
  const counter = { next: 0 };
  const drawn = spec.steps.flatMap((node) => drawNode(node, counter));
  return Object.freeze({
    nodes: drawn,
    stepCount: drawn.reduce((all, node) => all + countSteps(node), 0),
    straightLine: drawn.every((node) => node.kind === "step"),
    unreadable: false,
  });
}

/** The nodes of a definition's `sequence`, as nodes a group can hold. */
function drawNodes(
  nodes: readonly unknown[],
  counter: { next: number },
): readonly TreeNode[] {
  return nodes.flatMap((node) => drawNode(node, counter));
}

/** The id a node the editor cannot name still needs, so it can be drawn. */
function anonymousId(counter: { next: number }, held: string): string {
  counter.next += 1;
  return `${held}-${counter.next}`;
}

/**
 * One definition node as one drawing node. A node the editor cannot read is
 * still drawn — never dropped — as a card that needs setup (design ruling on
 * G2, #67): a step a run would take must not disappear from the page.
 */
function drawNode(
  raw: unknown,
  counter: { next: number },
): readonly TreeNode[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{
      kind: "step",
      id: anonymousId(counter, "unreadable"),
      uses: "",
      agentVersionId: null,
      problem: "unreadable",
      code: JSON.stringify(raw).slice(0, 120),
    }];
  }
  const node = record(raw);
  const kind = text(node.kind);
  if (kind === "action" || kind === "") {
    const id = text(node.id);
    const uses = text(node.uses);
    // A step with no id and no type has no name, but it still holds a place in
    // the workflow, so it is drawn as a step that cannot be read.
    if (id === "" && uses === "") {
      return [{
        kind: "step",
        id: anonymousId(counter, "unreadable"),
        uses: "",
        agentVersionId: null,
        problem: "unreadable",
        code: JSON.stringify(raw).slice(0, 120),
      }];
    }
    const agentVersionId = text(node.agentVersionId);
    return [{
      kind: "step",
      id: id === "" ? uses : id,
      uses,
      agentVersionId: agentVersionId === "" ? null : agentVersionId,
      codeOnly: isCodeOnly(node, uses),
    }];
  }
  if (kind === "sequence") {
    return drawNodes(Array.isArray(node.steps) ? node.steps : [], counter);
  }
  if (kind === "branch") {
    // Both arms are always drawn, even the one with no steps in it: a person
    // who cannot see an empty arm cannot tell it apart from a missing one.
    return [{
      kind: "group",
      id: anonymousId(counter, "group"),
      label: "yes",
      children: drawNodes(Array.isArray(node.then) ? node.then : [], counter),
      editedInCode: true,
    }, {
      kind: "group",
      id: anonymousId(counter, "group"),
      label: "otherwise",
      children: drawNodes(Array.isArray(node.else) ? node.else : [], counter),
      editedInCode: true,
    }];
  }
  if (kind === "parallel") {
    const lanes = Array.isArray(node.lanes) ? node.lanes : [];
    const children = lanes.flatMap((lane) => {
      const held = record(lane).steps;
      return drawNodes(Array.isArray(held) ? held : [], counter);
    });
    return [{
      kind: "group",
      id: anonymousId(counter, "group"),
      label: "together",
      children,
      editedInCode: true,
    }];
  }
  if (kind === "repeat") {
    const seed = record(node.seed);
    const seedNodes = seed.form === "sequence"
      ? drawNodes(Array.isArray(seed.steps) ? seed.steps : [], counter)
      : [];
    const body = drawNodes(
      Array.isArray(node.steps) ? node.steps : [],
      counter,
    );
    return [{
      kind: "group",
      id: anonymousId(counter, "group"),
      label: "repeat",
      children: [...seedNodes, ...body],
      editedInCode: true,
    }];
  }
  if (kind === "wait") {
    return [{
      kind: "group",
      id: anonymousId(counter, "group"),
      label: "wait",
      children: [],
      editedInCode: true,
    }];
  }
  // A kind the editor does not know is drawn as an unknown step, in place.
  const id = text(node.id);
  const uses = text(node.uses);
  return [{
    kind: "step",
    id: id === "" ? anonymousId(counter, "unknown") : id,
    uses,
    agentVersionId: text(node.agentVersionId) === ""
      ? null
      : text(node.agentVersionId),
    problem: "unknown",
    code: kind === "" ? JSON.stringify(raw).slice(0, 120) : kind,
  }];
}

/** How many steps a node holds, counting the ones inside a group. */
export function countSteps(node: TreeNode): number {
  return node.kind === "step"
    ? 1
    : node.children.reduce((all, child) => all + countSteps(child), 0);
}

/** Every step in the drawing, in the order it is drawn. */
export function stepsOfTree(tree: Tree): readonly TreeStep[] {
  const out: TreeStep[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === "step") out.push(node);
    else node.children.forEach(walk);
  };
  tree.nodes.forEach(walk);
  return out;
}

/** Every group in the drawing, in the order it is drawn. */
export function groupsOfTree(tree: Tree): readonly TreeGroup[] {
  const out: TreeGroup[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === "group") {
      out.push(node);
      node.children.forEach(walk);
    }
  };
  tree.nodes.forEach(walk);
  return out;
}
