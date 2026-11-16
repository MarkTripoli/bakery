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
 */

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
};

/** A group the editor draws but does not let anyone change in slice 1. */
export type TreeGroup = {
  readonly kind: "group";
  /** What the group is called: "Yes", "Otherwise", "At the same time". */
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
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The nodes of a definition's `steps`, turned into what the drawing shows. */
export function treeOf(definition: unknown): Tree {
  const spec = record(definition);
  const nodes = Array.isArray(spec.steps) ? spec.steps : [];
  const drawn = nodes.flatMap((node) => drawNode(node));
  return Object.freeze({
    nodes: drawn,
    stepCount: drawn.reduce((all, node) => all + countSteps(node), 0),
    straightLine: drawn.every((node) => node.kind === "step"),
  });
}

/** The nodes of a definition's `sequence`, as nodes a group can hold. */
function drawNodes(nodes: readonly unknown[]): readonly TreeNode[] {
  return nodes.flatMap((node) => drawNode(node));
}

/**
 * One definition node as one drawing node. A node the editor cannot read is
 * still drawn — never dropped — as a card that needs setup (design ruling on
 * G2, #67): a step a run would take must not disappear from the page.
 */
function drawNode(raw: unknown): readonly TreeNode[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{
      kind: "step",
      id: `unreadable-${text(record(raw).id) || "step"}`,
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
    if (id === "" && uses === "") return [];
    const agentVersionId = text(node.agentVersionId);
    return [{
      kind: "step",
      id: id === "" ? uses : id,
      uses,
      agentVersionId: agentVersionId === "" ? null : agentVersionId,
    }];
  }
  if (kind === "sequence") {
    return drawNodes(Array.isArray(node.steps) ? node.steps : []);
  }
  if (kind === "branch") {
    const thenNodes = drawNodes(
      Array.isArray(node.then) ? node.then : [],
    );
    const elseNodes = drawNodes(
      Array.isArray(node.else) ? node.else : [],
    );
    const groups: TreeNode[] = [];
    if (thenNodes.length > 0) {
      groups.push({
        kind: "group",
        label: "yes",
        children: thenNodes,
        editedInCode: true,
      });
    }
    if (elseNodes.length > 0) {
      groups.push({
        kind: "group",
        label: "otherwise",
        children: elseNodes,
        editedInCode: true,
      });
    }
    return groups;
  }
  if (kind === "parallel") {
    const lanes = Array.isArray(node.lanes) ? node.lanes : [];
    const children = lanes.flatMap((lane) => {
      const held = record(lane).steps;
      return drawNodes(Array.isArray(held) ? held : []);
    });
    return children.length === 0 ? [] : [{
      kind: "group",
      label: "together",
      children,
      editedInCode: true,
    }];
  }
  if (kind === "repeat") {
    const body = drawNodes(Array.isArray(node.steps) ? node.steps : []);
    const seed = record(node.seed);
    const seedNodes = seed.form === "sequence"
      ? drawNodes(Array.isArray(seed.steps) ? seed.steps : [])
      : [];
    const children = [...seedNodes, ...body];
    return children.length === 0 ? [] : [{
      kind: "group",
      label: "repeat",
      children,
      editedInCode: true,
    }];
  }
  if (kind === "wait") {
    return [{
      kind: "group",
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
    id: id === "" ? `unknown-${kind}` : id,
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
