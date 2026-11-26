import type { ElkNode } from "elkjs/lib/elk-api";
import type {
  GroupLabel,
  Tree,
  TreeGroup,
  TreeNode,
  TreeStep,
} from "./workflow-tree.ts";

export type BlockKind =
  | "start"
  | "step"
  | "box"
  | "if"
  | "arm"
  | "lane"
  | "end";

export type CanvasBlock = Readonly<{
  id: string;
  kind: BlockKind;
  parent: string | null;
  step?: TreeStep;
  group?: TreeGroup;
  label?: GroupLabel | "if";
  max?: number;
  empty?: boolean;
  row?: boolean;
}>;

export type CanvasEdge = Readonly<
  { id: string; source: string; target: string }
>;

export type CanvasGraph = Readonly<{
  blocks: readonly CanvasBlock[];
  edges: readonly CanvasEdge[];
}>;

export type Size = Readonly<{ width: number; height: number }>;

export const STEP_SIZE: Size = { width: 320, height: 64 };
export const END_SIZE: Size = { width: 96, height: 32 };
export const BOX_PADDING = { top: 40, side: 16, bottom: 16 } as const;
export const WIRE_LENGTH = 48;
export const SIDE_GAP = 24;
export const BOX_GAP = 28;

function isArmPair(
  node: TreeNode,
  next: TreeNode | undefined,
): node is TreeGroup {
  return node.kind === "group" && node.label === "yes" && next !== undefined &&
    next.kind === "group" && next.label === "otherwise";
}

export function canvasGraph(tree: Tree): CanvasGraph {
  const blocks: CanvasBlock[] = [{ id: "start", kind: "start", parent: null }];
  const edges: CanvasEdge[] = [];

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
        ...(node.lanes === undefined ? {} : { row: true }),
      });
      if (node.lanes === undefined) {
        chain(level(node.children, node.id));
      } else {
        node.lanes.forEach((lane, position) => {
          const id = `${node.id}-lane-${position}`;
          blocks.push({
            id,
            kind: "lane",
            parent: node.id,
            ...(lane.length === 0 ? { empty: true } : {}),
          });
          chain(level(lane, id));
        });
      }
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

function sizeOf(block: CanvasBlock, measured: ReadonlyMap<string, Size>): Size {
  const known = measured.get(block.id);
  if (known !== undefined) return known;
  return block.kind === "end" ? END_SIZE : STEP_SIZE;
}

export function elkGraph(
  graph: CanvasGraph,
  measured: ReadonlyMap<string, Size> = new Map(),
): ElkNode {
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
    const row = block.kind === "if" || block.row === true;
    const lane = block.kind === "lane";
    if (
      held.length === 0 && block.kind !== "box" && block.kind !== "arm" &&
      block.kind !== "if" && !lane
    ) {
      const size = sizeOf(block, measured);
      return { id: block.id, width: size.width, height: size.height };
    }
    const ids = new Set(held.map((child) => child.id));
    return {
      id: block.id,
      layoutOptions: {
        "elk.padding": lane
          ? `[top=0,left=0,bottom=${BOX_PADDING.bottom},right=0]`
          : `[top=${BOX_PADDING.top},left=${BOX_PADDING.side},bottom=${BOX_PADDING.bottom},right=${BOX_PADDING.side}]`,
        "elk.direction": row ? "RIGHT" : "DOWN",
        "elk.spacing.nodeNode": String(row ? SIDE_GAP : BOX_GAP),
        ...(row
          ? {}
          : { "elk.layered.spacing.nodeNodeBetweenLayers": String(BOX_GAP) }),
      },
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
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export function placements(laid: ElkNode): readonly Placement[] {
  const out: Placement[] = [];
  const walk = (
    held: readonly ElkNode[] | undefined,
    inRow: boolean,
  ) => {
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
