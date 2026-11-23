import type { ElkNode } from "elkjs/lib/elk-api";
import type {
  GroupLabel,
  Tree,
  TreeGroup,
  TreeNode,
  TreeStep,
} from "./workflow-tree.ts";

/**
 * The workflow as the canvas draws it (design-ux #67, "the workflow canvas on
 * React Flow"): a flat list of blocks in execution order, each naming the block
 * that holds it, and the wires between neighbours. Pure and free of React so
 * the order and the nesting can be tested; the canvas only draws this.
 */

export type BlockKind = "start" | "step" | "box" | "if" | "arm" | "end";

export type CanvasBlock = Readonly<{
  /** The tree's id for a step or box; `start` and `end`; `if-<first arm id>` for an If. */
  id: string;
  kind: BlockKind;
  /** The block that holds this one, or null at the top level. */
  parent: string | null;
  /** The step, for a `step` block. */
  step?: TreeStep;
  /** The group, for a `box` or an `arm`. */
  group?: TreeGroup;
  /** What kind of box this is: a group's own label, or `if`. */
  label?: GroupLabel | "if";
  /** The most items or tries a box states, when it states one. */
  max?: number;
  /** A box or arm with nothing inside it: the canvas draws one line and one "+". */
  empty?: boolean;
}>;

export type CanvasEdge = Readonly<
  { id: string; source: string; target: string }
>;

export type CanvasGraph = Readonly<{
  /** Parents before their children, in execution order: the order Tab visits them. */
  blocks: readonly CanvasBlock[];
  edges: readonly CanvasEdge[];
}>;

export type Size = Readonly<{ width: number; height: number }>;

/** A step card is 320px wide; its height is measured once it is drawn. */
export const STEP_SIZE: Size = { width: 320, height: 64 };
/** The small outlined pill the workflow ends in. */
export const END_SIZE: Size = { width: 96, height: 32 };
/** Room a box keeps above its first block for its header, and around the rest. */
export const BOX_PADDING = { top: 40, side: 16, bottom: 16 } as const;
/** The wire between two neighbours, before and after the "+". */
export const WIRE_LENGTH = 48;
/** The space beside blocks in a row (the two arms of an If). */
export const SIDE_GAP = 24;
/** The gap between two cards inside a box, as the design draws it. */
export const BOX_GAP = 28;

function isArmPair(
  node: TreeNode,
  next: TreeNode | undefined,
): node is TreeGroup {
  return node.kind === "group" && node.label === "yes" && next !== undefined &&
    next.kind === "group" && next.label === "otherwise";
}

/** Turns the tree into blocks and wires. An unreadable tree draws only the start card. */
export function canvasGraph(tree: Tree): CanvasGraph {
  const blocks: CanvasBlock[] = [{ id: "start", kind: "start", parent: null }];
  const edges: CanvasEdge[] = [];

  /** Adds the blocks of one level and returns the ids that sit in sequence there. */
  const level = (
    held: readonly TreeNode[],
    parent: string | null,
  ): string[] => {
    const sequence: string[] = [];
    for (let index = 0; index < held.length; index += 1) {
      const node = held[index];
      if (node.kind === "step") {
        blocks.push({ id: node.id, kind: "step", parent, step: node });
        sequence.push(node.id);
        continue;
      }
      const next = held[index + 1];
      if (isArmPair(node, next) && next.kind === "group") {
        // The two arms of a branch are consecutive in the tree: one If, two columns.
        const id = `if-${node.id}`;
        blocks.push({ id, kind: "if", parent, label: "if" });
        for (const arm of [node, next]) {
          const inside = arm.children;
          blocks.push({
            id: arm.id,
            kind: "arm",
            parent: id,
            group: arm,
            label: arm.label,
            ...(inside.length === 0 ? { empty: true } : {}),
          });
          chain(level(inside, arm.id));
        }
        sequence.push(id);
        index += 1;
        continue;
      }
      if (node.kind !== "group") continue;
      blocks.push({
        id: node.id,
        kind: "box",
        parent,
        group: node,
        label: node.label,
        ...(node.max === undefined ? {} : { max: node.max }),
        ...(node.children.length === 0 ? { empty: true } : {}),
      });
      chain(level(node.children, node.id));
      sequence.push(node.id);
    }
    return sequence;
  };
  const chain = (ids: readonly string[]) => {
    for (let index = 0; index < ids.length - 1; index += 1) {
      edges.push({
        id: `${ids[index]}->${ids[index + 1]}`,
        source: ids[index],
        target: ids[index + 1],
      });
    }
  };

  if (tree.unreadable) return { blocks, edges };
  const top = level(tree.nodes, null);
  blocks.push({ id: "end", kind: "end", parent: null });
  chain(["start", ...top, "end"]);
  return { blocks, edges };
}

/** The ids in the order Tab visits them: blocks in execution order. */
export function tabOrder(graph: CanvasGraph): readonly string[] {
  return graph.blocks.map((block) => block.id);
}

/** The block's size as the layout starts: measured when known, else the default for its kind. */
function sizeOf(block: CanvasBlock, measured: ReadonlyMap<string, Size>): Size {
  const known = measured.get(block.id);
  if (known !== undefined) return known;
  return block.kind === "end" ? END_SIZE : STEP_SIZE;
}

/**
 * The graph as ELK reads it: boxes and arms hold their children, an If lays
 * its arms side by side, everything else runs top to bottom. Layout is
 * computed, never stored.
 */
export function elkGraph(
  graph: CanvasGraph,
  measured: ReadonlyMap<string, Size> = new Map(),
): ElkNode {
  const byId = new Map(graph.blocks.map((block) => [block.id, block]));
  const childrenOf = new Map<string | null, CanvasBlock[]>();
  for (const block of graph.blocks) {
    const list = childrenOf.get(block.parent) ?? [];
    list.push(block);
    childrenOf.set(block.parent, list);
  }
  const wires = (ids: ReadonlySet<string>) =>
    graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      }));

  const node = (block: CanvasBlock): ElkNode => {
    const held = childrenOf.get(block.id) ?? [];
    if (
      held.length === 0 && block.kind !== "box" && block.kind !== "arm" &&
      block.kind !== "if"
    ) {
      const size = sizeOf(block, measured);
      return { id: block.id, width: size.width, height: size.height };
    }
    const ids = new Set(held.map((child) => child.id));
    return {
      id: block.id,
      layoutOptions: {
        "elk.padding":
          `[top=${BOX_PADDING.top},left=${BOX_PADDING.side},bottom=${BOX_PADDING.bottom},right=${BOX_PADDING.side}]`,
        "elk.direction": block.kind === "if" ? "RIGHT" : "DOWN",
        "elk.spacing.nodeNode": String(
          block.kind === "if" ? SIDE_GAP : BOX_GAP,
        ),
        // The layers of a box are its rows: ELK's own default is 20.
        ...(block.kind === "if"
          ? {}
          : { "elk.layered.spacing.nodeNodeBetweenLayers": String(BOX_GAP) }),
      },
      // An empty box still has room for its one line and its "+".
      ...(held.length === 0
        ? {
          width: STEP_SIZE.width + 2 * BOX_PADDING.side,
          height: BOX_PADDING.top + END_SIZE.height + BOX_PADDING.bottom,
        }
        : {}),
      children: held.map(node),
      edges: wires(ids),
    };
  };

  const top = childrenOf.get(null) ?? [];
  const ids = new Set(top.map((block) => block.id));
  void byId;
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(WIRE_LENGTH),
      "elk.spacing.nodeNode": String(WIRE_LENGTH),
    },
    children: top.map(node),
    edges: wires(ids),
  };
}

export type Placement = Readonly<{
  id: string;
  /** Relative to the block that holds it, which is how React Flow places a child. */
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** What ELK computed, flattened in the graph's own order. */
export function placements(laid: ElkNode): readonly Placement[] {
  const out: Placement[] = [];
  const walk = (
    held: readonly ElkNode[] | undefined,
    inRow: boolean,
  ) => {
    // The arms of an If are laid out in a row, and ELK centres the shorter arm
    // against the taller. Both hang from the same top instead.
    const rowTop = inRow
      ? Math.min(...(held ?? []).map((child) => child.y ?? 0))
      : 0;
    for (const child of held ?? []) {
      out.push({
        id: child.id,
        x: child.x ?? 0,
        y: inRow ? rowTop : child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      walk(child.children, child.layoutOptions?.["elk.direction"] === "RIGHT");
    }
  };
  walk(laid.children, false);
  return out;
}
