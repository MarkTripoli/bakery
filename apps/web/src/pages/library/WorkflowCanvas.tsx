import "@xyflow/react/dist/style.css";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ControlButton,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesStore,
  useReactFlow,
  useReactFlowStoreApi,
  useViewportStore,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk-api.js";
import * as UI from "@bakery/ui";
import {
  type CanvasBlock,
  type CanvasGraph,
  elkGraph,
  END_SIZE,
  type Placement,
  placements,
  type Size,
  STEP_SIZE,
  WIRE_LENGTH,
} from "./canvas-graph.ts";

/**
 * The workflow drawn on React Flow (#67, design-ux's "workflow canvas on React
 * Flow"). Bakery lays it out, top to bottom, with ELK in a worker; nobody
 * drags a block or draws a wire. Everything a block looks like and says comes
 * from the caller as render functions, so the picker, the cards and the words
 * stay where they are today and this module only places and moves them.
 *
 * This module is loaded lazily: it is the only place React Flow and ELK are
 * imported, so a page that never draws a diagram (a phone shows the outline)
 * never downloads them.
 */

export type WorkflowCanvasProps = Readonly<{
  graph: CanvasGraph;
  /** `page` reads the workflow; `editor` pans and zooms it. */
  mode: "page" | "editor";
  /** What a block looks like: a step card, a box, the start card or the end pill. */
  renderBlock: (block: CanvasBlock) => ReactNode;
  /** The "+" that adds a step after a block, drawn inside that block; null for none. */
  renderAdd: (block: CanvasBlock) => ReactNode;
  /** The block whose panel is open, brought into view when it changes. */
  selectedId: string | null;
  labels: Readonly<
    { canvas: string; zoomIn: string; zoomOut: string; fit: string }
  >;
}>;

type Render = Pick<WorkflowCanvasProps, "renderBlock" | "renderAdd">;
const RenderContext = createContext<Render>({
  renderBlock: () => null,
  renderAdd: () => null,
});

/** Room around the diagram inside its frame, in pixels. */
const PAD = 16;
/** The smallest a diagram is scaled to on the workflow page before Outline is offered. */
const PAGE_MIN_ZOOM = 0.6;

const isContainer = (block: CanvasBlock) =>
  block.kind === "box" || block.kind === "if" || block.kind === "arm";

let engine: InstanceType<typeof ELK> | undefined;
/** ELK in a Web Worker, created on first use. */
function elk(): InstanceType<typeof ELK> {
  engine ??= new ELK({
    workerFactory: () =>
      new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
  });
  return engine;
}

type BlockData = { block: CanvasBlock };

const ignoreNodeClick = () => {};

/** One block: its drawing, its "+" below it, and the hidden ports the wires meet at. */
function CanvasNode({ data }: NodeProps<Node<BlockData>>) {
  const { renderBlock, renderAdd } = useContext(RenderContext);
  const { block } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {renderBlock(block)}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      {renderAdd(block)}
    </>
  );
}
const NODE_TYPES = { step: CanvasNode, box: CanvasNode };

/** A rough height before the layout has answered, so the frame does not jump much. */
function estimatedHeight(graph: CanvasGraph): number {
  const drawn = graph.blocks.filter((block) => !isContainer(block)).length;
  return drawn * (STEP_SIZE.height + WIRE_LENGTH) + 2 * PAD;
}

function Surface(props: WorkflowCanvasProps) {
  const { graph, labels, mode, renderAdd, renderBlock, selectedId } = props;
  const flow = useReactFlow();
  const stores = useReactFlowStoreApi();
  const width = useViewportStore((state) => state.width);
  const height = useViewportStore((state) => state.height);

  const signature = useMemo(
    () =>
      graph.blocks.map((block) =>
        `${block.id}:${block.kind}:${block.empty ? 1 : 0}`
      ).join("|"),
    [graph],
  );
  const [sizes, setSizes] = useState<ReadonlyMap<string, Size>>(new Map());
  const [laid, setLaid] = useState<readonly Placement[] | null>(null);
  // The block sizes the current `laid` was computed from, and whether the
  // measured sizes agree with them: only then is the drawing final.
  const [laidKey, setLaidKey] = useState<string | null>(null);
  const [stable, setStable] = useState(false);
  const passes = useRef(0);
  const sizesKey = useMemo(
    () =>
      [...sizes].map(([id, size]) =>
        `${id}:${Math.round(size.width)}x${Math.round(size.height)}`
      ).join("|"),
    [sizes],
  );

  // Layout: ELK answers from the block sizes known so far.
  useEffect(() => {
    let live = true;
    elk().layout(elkGraph(graph, sizes)).then((result) => {
      if (!live) return;
      setLaid(placements(result));
      setLaidKey(sizesKey);
    });
    return () => {
      live = false;
    };
  }, [signature, sizesKey]);
  useEffect(() => {
    passes.current = 0;
    setStable(false);
  }, [signature]);

  const placed = useMemo(
    () => new Map((laid ?? []).map((one) => [one.id, one])),
    [laid],
  );

  // Second pass: once the blocks are drawn, their real heights replace the guesses.
  const measured = useNodesStore((state) => {
    let out = "";
    for (const [id, node] of state.nodeLookup) {
      out += `${id}:${node.measured.width ?? 0}x${node.measured.height ?? 0};`;
    }
    return out;
  });
  useEffect(() => {
    if (laid === null || laidKey !== sizesKey) return;
    if (passes.current >= 6) {
      setStable(true);
      return;
    }
    const next = new Map(sizes);
    let changed = false;
    let unmeasured = false;
    for (const block of graph.blocks) {
      if (isContainer(block)) continue;
      const found = stores.nodesStore.getState().nodeLookup.get(block.id)
        ?.measured;
      if (found?.width === undefined || found.height === undefined) {
        unmeasured = true;
        continue;
      }
      const known = sizes.get(block.id) ??
        (block.kind === "end" ? END_SIZE : STEP_SIZE);
      if (
        Math.abs(known.width - found.width) > 1 ||
        Math.abs(known.height - found.height) > 1
      ) {
        next.set(block.id, { width: found.width, height: found.height });
        changed = true;
      }
    }
    if (changed) {
      passes.current += 1;
      setStable(false);
      setSizes(next);
    } else if (!unmeasured) {
      setStable(true);
    }
  }, [measured, laidKey]);
  // A block that never reports a size must not leave the canvas clear for good.
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setStable(true), 3000);
    return () => globalThis.clearTimeout(timer);
  }, [signature]);
  // Until the measured sizes have replaced the guesses the blocks sit where the
  // guesses put them, so the canvas stays clear instead of showing that jump.
  const settled = stable && laid !== null && laidKey === sizesKey;

  const nodes = useMemo<Node<BlockData>[]>(
    () =>
      laid === null ? [] : graph.blocks.flatMap((block) => {
        const one = placed.get(block.id);
        if (one === undefined) return [];
        const container = isContainer(block);
        return [{
          id: block.id,
          type: container ? "box" : "step",
          position: { x: one.x, y: one.y },
          ...(block.parent === null ? {} : { parentId: block.parent }),
          data: { block },
          width: one.width,
          ...(container ? { height: one.height } : {}),
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
        }];
      }),
    [graph, laid, placed],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "straight",
        focusable: false,
        selectable: false,
        deletable: false,
      })),
    [graph],
  );

  // The diagram's size, from the top-level blocks (their positions are absolute).
  const bounds = useMemo(() => {
    let w = 0;
    let h = 0;
    for (const block of graph.blocks) {
      if (block.parent !== null) continue;
      const one = placed.get(block.id);
      if (one === undefined) continue;
      w = Math.max(w, one.x + one.width);
      h = Math.max(h, one.y + one.height);
    }
    return { w, h };
  }, [graph, placed]);

  // A page scales a wide diagram down to fit its frame, not below 60%.
  const zoom = mode === "page" && width > 0 && bounds.w + 2 * PAD > width
    ? Math.max(PAGE_MIN_ZOOM, width / (bounds.w + 2 * PAD))
    : 1;

  // Centre it, at the top. The editor does this once, so a person's own pan stays.
  const centred = useRef(false);
  useEffect(() => {
    if (laid === null || width === 0 || bounds.w === 0) return;
    if (mode === "editor" && centred.current) return;
    centred.current = true;
    flow.setViewport({
      x: Math.max(PAD, (width - bounds.w * zoom) / 2),
      y: PAD,
      zoom,
    });
  }, [laid, width, bounds.w, zoom, mode]);

  // The canvas gets narrower when the panel opens and wider when it closes.
  // Keep the diagram where it was relative to the middle of the canvas, so a
  // wide box is not left half behind the panel, and a person's own pan stays.
  const lastWidth = useRef(0);
  useEffect(() => {
    const before = lastWidth.current;
    lastWidth.current = width;
    if (mode !== "editor" || before === 0 || width === 0 || before === width) {
      return;
    }
    const [viewX, viewY, scale] = stores.viewportStore.getState().transform;
    flow.setViewport({
      x: viewX + (width - before) / 2,
      y: viewY,
      zoom: scale,
    });
  }, [width]);

  // A block that is selected or added is brought into view.
  useEffect(() => {
    if (mode !== "editor" || selectedId === null || laid === null) return;
    const node = stores.nodesStore.getState().nodeLookup.get(selectedId);
    if (node === undefined) return;
    const [viewX, viewY, scale] = stores.viewportStore.getState().transform;
    const left = node.internals.positionAbsolute.x * scale + viewX;
    const top = node.internals.positionAbsolute.y * scale + viewY;
    const wide = (node.measured.width ?? 0) * scale;
    const tall = (node.measured.height ?? 0) * scale;
    let dx = 0;
    let dy = 0;
    if (top < PAD) dy = PAD - top;
    else if (top + tall > height - PAD) dy = height - PAD - (top + tall);
    if (left < PAD) dx = PAD - left;
    else if (left + wide > width - PAD) dx = width - PAD - (left + wide);
    if (dx === 0 && dy === 0) return;
    const calm = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches ?? false;
    flow.setViewport({ x: viewX + dx, y: viewY + dy, zoom: scale }, {
      duration: calm ? 0 : 200,
    });
  }, [selectedId, laid]);

  const larger = (bounds.h + 2 * PAD) * zoom > height ||
    (bounds.w + 2 * PAD) * zoom > width;
  const frameHeight = laid === null
    ? estimatedHeight(graph)
    : Math.ceil(bounds.h * zoom + 2 * PAD);

  return (
    <RenderContext.Provider value={{ renderBlock, renderAdd }}>
      <UI.CanvasFrame
        data-layout={settled ? "ready" : "settling"}
        data-popover-boundary="true"
        data-ui-region="workflow-canvas"
        height={frameHeight}
        variant={mode === "editor" ? "fill" : "page"}
      >
        <ReactFlow
          aria-label={labels.canvas}
          ariaLabelConfig={{
            "node.a11yDescription.default": "",
            "node.a11yDescription.keyboardDisabled": "",
            "edge.a11yDescription.default": "",
            "controls.ariaLabel": labels.canvas,
            "controls.zoomIn.ariaLabel": labels.zoomIn,
            "controls.zoomOut.ariaLabel": labels.zoomOut,
            "controls.fitView.ariaLabel": labels.fit,
          }}
          connectOnClick={false}
          edges={edges}
          edgesFocusable={false}
          elementsSelectable={false}
          maxZoom={1.5}
          minZoom={0.5}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          // React Flow switches pointer events off, inline, on a node nobody can
          // drag, select or click, and that would also switch off the "+" inside
          // it. A click handler is its documented way to keep them on; it does
          // nothing, and selection stays off.
          onNodeClick={ignoreNodeClick}
          nodeTypes={NODE_TYPES}
          panOnDrag={mode === "editor"}
          panOnScroll={mode === "editor"}
          preventScrolling={mode === "editor"}
          zoomOnDoubleClick={false}
          zoomOnPinch={mode === "editor"}
          zoomOnScroll={false}
        >
          {mode === "editor" && larger
            ? (
              // One horizontal group: zoom out, zoom in, then Fit with its word.
              <Controls
                aria-label={labels.canvas}
                orientation="horizontal"
                showFitView={false}
                showInteractive={false}
                showZoom={false}
              >
                <ControlButton
                  aria-label={labels.zoomOut}
                  onClick={() => void flow.zoomOut()}
                  title={labels.zoomOut}
                >
                  {"\u2212"}
                </ControlButton>
                <ControlButton
                  aria-label={labels.zoomIn}
                  onClick={() => void flow.zoomIn()}
                  title={labels.zoomIn}
                >
                  +
                </ControlButton>
                <ControlButton
                  data-fit="true"
                  onClick={() =>
                    void flow.setViewport({
                      x: Math.max(PAD, (width - bounds.w) / 2),
                      y: PAD,
                      zoom: 1,
                    })}
                >
                  {labels.fit}
                </ControlButton>
              </Controls>
            )
            : null}
        </ReactFlow>
      </UI.CanvasFrame>
    </RenderContext.Provider>
  );
}

/** The workflow canvas; its own provider so the page needs no React Flow state. */
export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Surface {...props} />
    </ReactFlowProvider>
  );
}
