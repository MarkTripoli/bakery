import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

import {
  ACTION_LINES,
  ACTION_TITLES,
  PICKER_STEPS,
  stepGlyph,
  stepLine,
  stepName as authoredName,
} from "./workflow-state.ts";
import {
  type CanvasBlock,
  type CanvasGraph,
  canvasGraph,
  STEP_SIZE,
  WIRE_LENGTH,
} from "./canvas-graph.ts";
import type {
  GroupLabel,
  Tree,
  TreeGroup,
  TreeLoop,
  TreeNode,
  TreeStep,
} from "./workflow-tree.ts";

/**
 * The workflow drawn top to bottom (#67, slice 1 of the owner's spec): "How it
 * starts", a card per step, and a "+" on the connector between them that opens
 * the step picker. A group the definition states in code (a branch arm, lanes,
 * a repeat, a wait) is drawn as a group and says so; slice 1 cannot change it.
 * A phone shows the same tree as an outline — one model, two renderings.
 *
 * Nothing is left out (design-ux's ruling, comment 6917906748): a step only
 * changeable in code says "Edited in code", a step Bakery cannot read is a card
 * that needs setup, and a group holds its place even when it is empty. A
 * definition whose list of steps cannot be read at all draws a notice instead.
 */

export { PICKER_STEPS };

export type DiagramProps = {
  readonly tree: Tree;
  /** The step or group whose panel is open, by id; `start` for the start card. */
  readonly selectedId: string | null;
  readonly start?: { readonly title: string; readonly line: string };
  /** The problems the last check reported, by step id. */
  readonly problems: ReadonlyMap<string, string>;
  /** Whether the person may change the workflow at all. */
  readonly canManage: boolean;
  /** Whether slice 1 can add, move and remove steps here. */
  readonly editable: boolean;
  /**
   * Whether this is a read-only page (the workflow page or a built-in), where
   * nothing can be edited at all. "Edited in code" tells a person where to go
   * and change something, so it is shown in the editor and not here (#67 UX
   * ruling 6932934119 fix 14).
   */
  readonly readOnlyPage?: boolean;
  /** Open the picker after the step with this id, or at the start when null. */
  readonly onAdd: (afterId: string | null) => void;
  readonly onSelect: (id: string) => void;
  /** The connector whose picker is open: a step id, `null` for the start, or absent. */
  readonly pickerAt?: string | null;
  readonly onPick: (uses: string) => void;
  readonly onPickClose: () => void;
  /** Open the code view, which the notice and a code-only panel offer. */
  readonly onViewAsCode: () => void;
  /**
   * A second line under a card, for what only the reading page knows: which
   * agent a step runs, and whether that could be read. The editor passes none.
   */
  readonly detail?: (uses: string, id: string) => ReactNode;
  readonly lines?: ReadonlyMap<string, string>;
  readonly view?: "diagram" | "outline";
};

const GROUP_LABEL: Readonly<Record<GroupLabel, string>> = {
  yes: "library.editor.group.yes",
  otherwise: "library.editor.group.otherwise",
  together: "library.editor.group.together",
  repeat: "library.editor.group.repeat",
  fix: "library.editor.group.fixUntilPasses",
  each: "library.editor.group.each",
  wait: "library.editor.group.wait",
};

const GROUP_ICON: Readonly<Partial<Record<GroupLabel, string>>> = {
  together: "lanes",
  repeat: "refresh",
  fix: "refresh",
  each: "refresh",
  wait: "clock",
};

export function WorkflowDiagram(
  {
    canManage,
    detail,
    editable,
    lines,
    onAdd,
    onPick,
    onPickClose,
    onSelect,
    onViewAsCode,
    pickerAt,
    problems,
    readOnlyPage = false,
    selectedId,
    start,
    tree,
    view = "diagram",
  }: DiagramProps,
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  // Fix 14 of the #67 UX ruling: "Edited in code" tells a person where to go and
  // change something, so it belongs in the editor. On a read-only page nothing
  // is editable there, so the label would only add noise.
  const editedInCode = readOnlyPage
    ? undefined
    : translate("library.editor.group.codeOnly" as never);
  const title = (uses: string): string => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key as never);
  };
  const line = (uses: string): string | undefined => {
    const key = ACTION_LINES[uses];
    return key === undefined ? undefined : translate(key as never);
  };

  // The picker's body: a search field, then the step types with the same one
  // sentence each shows on its card. A bare list of links pushed the diagram
  // down and said nothing about what each step does (#67 UX ruling
  // 6934081003 fix 2, spec in 6900431228).
  const [pickQuery, setPickQuery] = useState("");
  const offered = PICKER_STEPS.filter((uses) => {
    const needle = pickQuery.trim().toLowerCase();
    return needle === "" ||
      title(uses).toLowerCase().includes(needle) ||
      (line(uses) ?? "").toLowerCase().includes(needle);
  });
  // The picker's list scrolls, so it says so: a 24px fade at whichever end has
  // rows hidden past it, and none when everything fits (#67 UX ruling
  // 6942486257, option 1). QA found the last visible row sliced mid-glyph with
  // no scrollbar painted, which read as a broken render rather than "there is
  // more". The rule is about overflow, not a breakpoint, so the phone sheet
  // follows it too.
  const [listFade, setListFade] = useState({ top: false, bottom: false });
  const listEl = useRef<HTMLElement | null>(null);
  const measureListFade = useCallback((list: HTMLElement | null) => {
    if (!list) return;
    const { scrollTop, clientHeight, scrollHeight } = list;
    // One pixel of slack: sub-pixel layout rounds scrollHeight, and a strict
    // comparison would leave the fade on at the very end of the list.
    const top = scrollTop > 0;
    const bottom = scrollTop + clientHeight < scrollHeight - 1;
    setListFade((was) =>
      was.top === top && was.bottom === bottom ? was : { top, bottom }
    );
  }, []);
  useEffect(() => {
    // A narrower search changes what is hidden; re-measure after that render.
    measureListFade(listEl.current);
  }, [measureListFade, pickQuery]);
  const listWatch = useRef<ResizeObserver | null>(null);
  const setListEl = useCallback((node: HTMLElement | null) => {
    listWatch.current?.disconnect();
    listWatch.current = null;
    listEl.current = node;
    measureListFade(node);
    if (node !== null && typeof ResizeObserver !== "undefined") {
      listWatch.current = new ResizeObserver(() => measureListFade(node));
      listWatch.current.observe(node);
    }
  }, [measureListFade]);

  const pickerBody = (
    <UI.Stack gap="compact" data-testid="step-picker">
      <UI.SearchField
        aria-label={translate("library.editor.picker.search" as never)}
        placeholder={translate("library.editor.picker.search" as never)}
        value={pickQuery}
        onChange={(event) => setPickQuery(event.currentTarget.value)}
      />
      <UI.Stack
        gap="compact"
        data-picker-fade-bottom={listFade.bottom ? "true" : undefined}
        data-picker-fade-top={listFade.top ? "true" : undefined}
        data-picker-list="true"
        onScroll={(event) => measureListFade(event.currentTarget)}
        ref={setListEl}
      >
        {offered.length === 0
          ? (
            <UI.Text variant="muted">
              {translate("library.editor.picker.none" as never)}
            </UI.Text>
          )
          : offered.map((uses) => (
            <UI.Button
              key={uses}
              variant="quiet"
              data-pick-step={uses}
              onClick={() => onPick(uses)}
            >
              <span data-pick-body="true">
                <span data-pick-title="true">{title(uses)}</span>
                <span data-pick-line="true">{line(uses)}</span>
              </span>
            </UI.Button>
          ))}
      </UI.Stack>
      <UI.Button variant="secondary" onClick={onPickClose}>
        {translate("library.editor.picker.cancel" as never)}
      </UI.Button>
    </UI.Stack>
  );

  const drawn = useMemo<Tree>(() => ({
    ...tree,
    nodes: tree.nodes.filter((node) =>
      node.kind !== "step" || node.end !== true
    ),
  }), [tree]);
  const graph = useMemo<CanvasGraph>(() => canvasGraph(drawn), [drawn]);
  const stepNumber = useMemo(
    () =>
      new Map(
        graph.blocks.filter((block) => block.kind === "step").map((
          block,
          index,
        ) => [block.id, index + 1] as const),
      ),
    [graph],
  );
  const marked = useMemo(() => {
    const out = new Set<string>();
    const byId = new Map(graph.blocks.map((block) => [block.id, block]));
    for (const block of graph.blocks) {
      if (block.kind !== "box" && block.kind !== "if") continue;
      let inside = false;
      for (
        let up = block.parent;
        up !== null;
        up = byId.get(up)?.parent ?? null
      ) {
        if (out.has(up)) {
          inside = true;
          break;
        }
      }
      if (!inside) out.add(block.id);
    }
    return out;
  }, [graph]);

  const stepsInside = (held: readonly TreeNode[]): number =>
    held.reduce(
      (sum, node) =>
        sum + (node.kind === "step" ? 1 : stepsInside(node.children)),
      0,
    );

  const addControl = (afterId: string | null): ReactNode => {
    if (!editable || !canManage) return null;
    const open = pickerAt !== undefined && pickerAt === afterId;
    const addLabel = translate("library.editor.addHere" as never, {
      after: afterId === null
        ? translate("library.editor.startsHere" as never)
        : title(treeStepUses(tree, afterId) ?? afterId),
    });
    return (
      <>
        <UI.Popover
          floating
          open={phone ? false : open}
          label={addLabel}
          triggerLabel={addLabel}
          variant="interactive"
          onOpenChange={(next) => {
            if (next) onAdd(afterId);
            else if (open) onPickClose();
          }}
          trigger={<span data-add-highlight="true">+</span>}
        >
          {pickerBody}
        </UI.Popover>
        {phone && open
          ? (
            <UI.Sheet
              open
              variant="bottom"
              title={translate("library.editor.picker.title" as never)}
              onOpenChange={(next) => {
                if (!next) onPickClose();
              }}
            >
              {pickerBody}
            </UI.Sheet>
          )
          : null}
      </>
    );
  };

  const cardName = (node: TreeStep): string => {
    if (node.problem === "unknown") {
      return translate("library.editor.card.unknown" as never);
    }
    if (node.problem === "unreadable") {
      return translate("library.editor.card.unreadable" as never);
    }
    return authoredName(node, translate);
  };
  const stepName = (node: TreeStep): string =>
    translate("library.editor.canvas.stepName" as never, {
      name: cardName(node),
      number: stepNumber.get(node.id) ?? 0,
      total: stepNumber.size,
    });

  const stepFacts = (node: TreeStep) => {
    const drawing = node.problem !== undefined ||
      problems.get(node.id) !== undefined;
    const codeOnly = node.codeOnly === true && !drawing;
    const glyph = drawing ? "info" : stepGlyph(node);
    const summary = drawing
      ? undefined
      : lines?.get(node.id) ?? stepLine(node, translate);
    const extra = drawing ? undefined : detail?.(node.uses, node.id);
    return { codeOnly, drawing, extra, glyph, summary };
  };
  const insideBox = useMemo(
    () =>
      new Set(
        graph.blocks.filter((block) =>
          block.kind === "step" && block.parent !== null
        ).map((block) => block.id),
      ),
    [graph],
  );
  const markedName = (node: TreeStep, marked: boolean): string =>
    marked && editedInCode !== undefined
      ? `${stepName(node)} ${editedInCode}.`
      : stepName(node);

  const card = (node: TreeStep): ReactNode => {
    const facts = stepFacts(node);
    const marked = facts.codeOnly && !insideBox.has(node.id);
    return (
      <div data-card={node.id}>
        <UI.StepCard
          aria-label={markedName(node, marked)}
          codeMark={marked ? codeMark() : undefined}
          icon={facts.glyph === undefined
            ? undefined
            : <UI.IconGlyph name={facts.glyph as never} size="small" />}
          title={cardName(node)}
          selected={selectedId === node.id}
          needsSetup={facts.drawing}
          needsSetupLabel={translate("library.editor.card.needsSetup" as never)}
          writtenInCode={node.code === undefined ? undefined : (
            translate("library.editor.card.writtenInCode" as never, {
              code: node.code,
            })
          )}
          summary={facts.summary}
          detail={facts.extra === undefined
            ? undefined
            : <span data-step-extra="true">{facts.extra}</span>}
          disabled={!canManage}
          onClick={() => onSelect(node.id)}
        />
      </div>
    );
  };

  const startCard = (
    <div data-card="start">
      <UI.StepCard
        icon={<UI.IconGlyph name="lightning" size="small" />}
        title={start?.title ??
          translate("library.editor.howItStarts" as never)}
        summary={start?.line ??
          translate("library.editor.howItStartsLine" as never)}
        needsSetup={problems.get("start") !== undefined}
        needsSetupLabel={translate("library.editor.card.needsSetup" as never)}
        selected={selectedId === "start"}
        controls="editor-step-panel"
        onClick={() => onSelect("start")}
      />
    </div>
  );

  const codeMark = (): ReactNode =>
    editedInCode === undefined ? undefined : (
      <UI.Tooltip content={editedInCode}>
        <span aria-label={editedInCode} role="img">
          <UI.IconGlyph name={"code" as never} size="small" />
        </span>
      </UI.Tooltip>
    );

  const loopLimit = (loop: TreeLoop): string => {
    const ask = loop.allow === null
      ? ""
      : ` · ${
        translate("library.editor.group.fixAsk" as never, {
          from: loop.allow,
        })
      }`;
    if (loop.min !== null && loop.min === loop.max) {
      return translate("library.editor.group.fixExact" as never, {
        max: loop.max,
      }) + ask;
    }
    if (loop.min !== null) {
      return translate("library.editor.group.fixRange" as never, {
        min: loop.min,
        max: loop.max,
      }) + ask;
    }
    return translate("library.editor.group.fixLimit" as never, {
      max: loop.max,
    }) + ask;
  };
  const limitOf = (group: TreeGroup): string | undefined => {
    if (
      group.loop !== undefined && group.loop.fix === (group.label === "fix")
    ) {
      return loopLimit(group.loop);
    }
    if (group.max === undefined) return undefined;
    if (group.label === "each") {
      return translate("library.editor.group.eachLimit" as never, {
        max: group.max,
      });
    }
    if (group.label === "fix") {
      return translate("library.editor.group.fixLimit" as never, {
        max: group.max,
      });
    }
    return undefined;
  };
  const wordFor = (label: GroupLabel): string =>
    translate(GROUP_LABEL[label] as never);
  const groupName = (
    label: string,
    limit: string | undefined,
    inside: number,
    inCode: boolean,
  ): string => {
    const said = limit === undefined
      ? translate("library.editor.canvas.boxName" as never, {
        count: inside,
        label,
      })
      : translate("library.editor.canvas.boxNameLimit" as never, {
        count: inside,
        label,
        limit,
      });
    return inCode && editedInCode !== undefined
      ? `${said} ${editedInCode}.`
      : said;
  };
  const noSteps = translate("library.editor.group.noSteps" as never);
  const glyphOf = (label: GroupLabel): ReactNode => {
    const name = GROUP_ICON[label];
    return name === undefined
      ? undefined
      : <UI.IconGlyph name={name as never} size="small" />;
  };

  const renderBlock = (block: CanvasBlock): ReactNode => {
    switch (block.kind) {
      case "start":
        return startCard;
      case "step":
        return block.step === undefined ? null : card(block.step);
      case "end":
        return (
          <span data-canvas-end="true">
            <UI.Text variant="caption">
              {translate("library.editor.pathEnd" as never)}
            </UI.Text>
          </span>
        );
      case "if":
        return (
          <UI.StepGroup
            data-group="if"
            codeMark={marked.has(block.id) ? codeMark() : undefined}
            icon={<UI.IconGlyph name="branch" size="small" />}
            label={translate("library.editor.group.if" as never)}
          />
        );
      case "box":
      case "arm": {
        const group = block.group;
        if (group === undefined) return null;
        const arm = block.kind === "arm";
        const inCode = marked.has(block.id);
        const limit = limitOf(group);
        return (
          <UI.StepGroup
            data-group={group.label}
            codeMark={inCode ? codeMark() : undefined}
            empty={group.children.length === 0 ? noSteps : undefined}
            icon={arm ? undefined : glyphOf(group.label)}
            label={wordFor(group.label)}
            limit={limit}
            onSelect={canManage ? () => onSelect(group.id) : undefined}
            selectLabel={groupName(
              wordFor(group.label),
              limit,
              stepsInside(group.children),
              inCode,
            )}
            selected={selectedId === group.id}
            variant={arm ? "arm" : "box"}
          />
        );
      }
    }
  };
  const renderAdd = (block: CanvasBlock): ReactNode => {
    if (block.kind !== "start" && block.kind !== "step") return null;
    const afterId = block.kind === "start" ? null : block.id;
    const control = addControl(afterId);
    return control === null
      ? null
      : (
        <span data-canvas-add="true" data-connector={afterId ?? "start"}>
          {control}
        </span>
      );
  };

  const outlineAdd = (afterId: string | null): ReactNode => {
    const control = addControl(afterId);
    return control === null
      ? undefined
      : <span data-connector={afterId ?? "start"}>{control}</span>;
  };
  const stepRow = (node: TreeStep, inCode: boolean): ReactNode => {
    const facts = stepFacts(node);
    const marked = facts.codeOnly && !inCode;
    return (
      <UI.OutlineRow
        add={outlineAdd(node.id)}
        codeMark={marked ? codeMark() : undefined}
        data-card={node.id}
        icon={facts.glyph === undefined
          ? undefined
          : <UI.IconGlyph name={facts.glyph as never} size="small" />}
        key={node.id}
        needsSetup={facts.drawing}
        needsSetupLabel={translate("library.editor.card.needsSetup" as never)}
        onSelect={canManage ? () => onSelect(node.id) : undefined}
        selectLabel={markedName(node, marked)}
        selected={selectedId === node.id}
        summary={facts.extra === undefined ? facts.summary : (
          <>
            {facts.summary}
            <span data-step-extra="true">{facts.extra}</span>
          </>
        )}
        title={cardName(node)}
      />
    );
  };
  const innerList = (held: readonly TreeNode[]): ReactNode =>
    held.length === 0
      ? <UI.Text variant="muted">{noSteps}</UI.Text>
      : <UI.OutlineList>{outlineRows(held, true)}</UI.OutlineList>;
  const groupRow = (node: TreeGroup, inCode: boolean): ReactNode => {
    const limit = limitOf(node);
    return (
      <UI.OutlineRow
        codeMark={inCode ? undefined : codeMark()}
        data-group={node.label}
        icon={glyphOf(node.label)}
        key={node.id}
        onSelect={canManage ? () => onSelect(node.id) : undefined}
        selectLabel={groupName(
          wordFor(node.label),
          limit,
          stepsInside(node.children),
          !inCode,
        )}
        selected={selectedId === node.id}
        summary={limit}
        title={wordFor(node.label)}
      >
        {node.children.length === 0
          ? (
            <UI.OutlineList>
              <UI.OutlineRow
                caption
                title={<UI.Text variant="muted">{noSteps}</UI.Text>}
              />
            </UI.OutlineList>
          )
          : innerList(node.children)}
      </UI.OutlineRow>
    );
  };
  const outlineRows = (
    held: readonly TreeNode[],
    inCode: boolean,
  ): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (let index = 0; index < held.length; index += 1) {
      const node = held[index];
      if (node.kind === "step") {
        rows.push(stepRow(node, inCode));
        continue;
      }
      const next = held[index + 1];
      if (
        node.label === "yes" && next !== undefined && next.kind === "group" &&
        next.label === "otherwise"
      ) {
        rows.push(
          <UI.OutlineRow
            codeMark={inCode ? undefined : codeMark()}
            data-group="if"
            icon={<UI.IconGlyph name="branch" size="small" />}
            key={`if-${node.id}`}
            title={translate("library.editor.group.if" as never)}
          >
            <UI.OutlineList>
              {[node, next].map((arm) => (
                <UI.OutlineRow
                  caption
                  data-group={arm.label}
                  key={arm.id}
                  title={wordFor(arm.label)}
                >
                  {innerList(arm.children)}
                </UI.OutlineRow>
              ))}
            </UI.OutlineList>
          </UI.OutlineRow>,
        );
        index += 1;
        continue;
      }
      rows.push(groupRow(node, inCode));
    }
    return rows;
  };
  const outline = (
    <UI.OutlineList
      aria-label={translate("library.editor.outline.label" as never)}
      data-ui-region="workflow-outline"
    >
      <UI.OutlineRow
        add={tree.unreadable ? undefined : outlineAdd(null)}
        controls="editor-step-panel"
        data-card="start"
        icon={<UI.IconGlyph name="lightning" size="small" />}
        onSelect={() => onSelect("start")}
        selected={selectedId === "start"}
        summary={problems.get("start") === undefined
          ? start?.line ??
            translate("library.editor.howItStartsLine" as never)
          : translate("library.editor.card.needsSetup" as never)}
        title={start?.title ??
          translate("library.editor.howItStarts" as never)}
      />
      {tree.unreadable ? null : outlineRows(drawn.nodes, false)}
    </UI.OutlineList>
  );

  const [failed, setFailed] = useState(false);
  const Canvas = useMemo(
    () => lazy(() => import("./WorkflowCanvas.tsx")),
    [],
  );
  const mode = readOnlyPage ? "page" : "editor";

  if (tree.unreadable) {
    return (
      <UI.Stack gap="none" data-ui-region="workflow-diagram">
        {startCard}
        <UI.InlineNotice
          tone="error"
          action={
            <UI.Button variant="secondary" onClick={onViewAsCode}>
              {translate("library.editor.viewAsCode" as never)}
            </UI.Button>
          }
        >
          <UI.Stack gap="tight">
            <UI.Text variant="strong">
              {translate("library.editor.unreadable.title" as never)}
            </UI.Text>
            <UI.Text>
              {translate("library.editor.unreadable.body" as never)}
            </UI.Text>
          </UI.Stack>
        </UI.InlineNotice>
      </UI.Stack>
    );
  }
  if (phone || view === "outline" || failed) {
    return (
      <UI.Stack gap="standard" data-ui-region="workflow-diagram">
        {failed && !phone && view !== "outline"
          ? (
            <UI.InlineNotice
              tone="information"
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => globalThis.location.reload()}
                >
                  {translate("library.editor.canvas.retry" as never)}
                </UI.Button>
              }
            >
              <UI.Text>
                {translate("library.editor.canvas.failed" as never)}
              </UI.Text>
            </UI.InlineNotice>
          )
          : null}
        {outline}
      </UI.Stack>
    );
  }
  return (
    <div data-ui-region="workflow-diagram">
      <CanvasBoundary onFail={() => setFailed(true)}>
        <Suspense
          fallback={
            <UI.CanvasFrame
              height={graph.blocks.length * (STEP_SIZE.height + WIRE_LENGTH)}
              loading
              variant={mode === "page" ? "page" : "fill"}
            />
          }
        >
          <Canvas
            graph={graph}
            labels={{
              canvas: translate("library.editor.canvas.label" as never),
              fit: translate("library.editor.canvas.fit" as never),
              zoomIn: translate("library.editor.canvas.zoomIn" as never),
              zoomOut: translate("library.editor.canvas.zoomOut" as never),
            }}
            mode={mode}
            renderAdd={renderAdd}
            renderBlock={renderBlock}
            selectedId={selectedId}
          />
        </Suspense>
      </CanvasBoundary>
    </div>
  );
}

class CanvasBoundary extends Component<
  { children: ReactNode; onFail: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFail();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The action a drawn step runs, for a connector's label. */
function treeStepUses(tree: Tree, id: string): string | null {
  const walk = (held: readonly TreeNode[]): string | null => {
    for (const node of held) {
      if (node.kind === "step") {
        if (node.id === id) return node.uses;
      } else {
        const found = walk(node.children);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(tree.nodes);
}
