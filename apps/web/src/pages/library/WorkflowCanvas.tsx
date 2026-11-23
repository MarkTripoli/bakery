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

export type WorkflowCanvasProps = Readonly<{
  graph: CanvasGraph;
  mode: "page" | "editor";
  renderBlock: (block: CanvasBlock) => ReactNode;
  renderAdd: (block: CanvasBlock) => ReactNode;
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

const PAD = 16;
const PAGE_MIN_ZOOM = 0.6;

const isContainer = (block: CanvasBlock) =>
  block.kind === "box" || block.kind === "if" || block.kind === "arm";

let engine: InstanceType<typeof ELK> | undefined;
function elk(): InstanceType<typeof ELK> {
  engine ??= new ELK({
    workerFactory: () =>
      new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
  });
  return engine;
}

type BlockData = { block: CanvasBlock };

const ignoreNodeClick = () => {};

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
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setStable(true), 3000);
    return () => globalThis.clearTimeout(timer);
  }, [signature]);
  const settled = stable && laid !== null && laidKey === sizesKey;
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (settled) setRevealed(true);
  }, [settled]);

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

  const zoom = mode === "page" && width > 0 && bounds.w + 2 * PAD > width
    ? Math.max(PAGE_MIN_ZOOM, width / (bounds.w + 2 * PAD))
    : 1;

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
  }, [selectedId, laid, width, height]);

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
        settling={!revealed}
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

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Surface {...props} />
    </ReactFlowProvider>
  );
}
