import {
  type ReactNode,
  useCallback,
  useEffect,
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
  stepName,
} from "./workflow-state.ts";
import type { GroupLabel, Tree, TreeNode, TreeStep } from "./workflow-tree.ts";

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
};

const GROUP_LABEL: Readonly<Record<GroupLabel, string>> = {
  yes: "library.editor.group.yes",
  otherwise: "library.editor.group.otherwise",
  together: "library.editor.group.together",
  repeat: "library.editor.group.repeat",
  fix: "library.editor.group.fixUntilPasses",
  wait: "library.editor.group.wait",
};

export function WorkflowDiagram(
  {
    canManage,
    detail,
    editable,
    onAdd,
    onPick,
    onPickClose,
    onSelect,
    onViewAsCode,
    pickerAt,
    problems,
    readOnlyPage = false,
    selectedId,
    tree,
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
        ref={(node) => {
          listEl.current = node;
          measureListFade(node);
        }}
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

  // The connector between two cards: the "+" a person presses to add a step,
  // or the bare line when the workflow cannot be changed here.
  const connector = (afterId: string | null, last = false): ReactNode => {
    if (!editable) {
      return (
        <div data-connector={afterId ?? "start"}>
          <UI.StepConnector
            label={translate("library.editor.pathLine" as never)}
            readOnly
            endLabel={last
              ? translate("library.editor.pathEnd" as never)
              : undefined}
          />
        </div>
      );
    }
    const open = pickerAt !== undefined && pickerAt === afterId;
    if (!canManage) return <div data-connector={afterId ?? "start"} />;
    // The picker is a popover beside the "+" it came from, and a bottom sheet
    // on a phone, so it never pushes the diagram down (#67 UX ruling
    // 6934081003 fix 2).
    const addLabel = translate("library.editor.addHere" as never, {
      after: afterId === null
        ? translate("library.editor.startsHere" as never)
        : title(treeStepUses(tree, afterId) ?? afterId),
    });
    return (
      <div data-connector={afterId ?? "start"}>
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
          : (
            <UI.StepConnector
              label={addLabel}
              control={
                <UI.Popover
                  open={open}
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
              }
            />
          )}
      </div>
    );
  };

  const cardName = (node: TreeStep): string => {
    if (node.problem === "unknown") {
      return translate("library.editor.card.unknown" as never);
    }
    if (node.problem === "unreadable") {
      return translate("library.editor.card.unreadable" as never);
    }
    return stepName(node, translate);
  };

  const card = (node: TreeStep): ReactNode => {
    const id = node.id;
    const problemLine = problems.get(id);
    // A step with a problem wears the red outline and says "Needs setup" in
    // place of its usual line, whether Bakery cannot read it or can only
    // change it in code. The sentence is never loose text under the card; it
    // belongs to the panel and the problem list (#67 UX ruling 6932934119
    // fixes 2 and 3).
    const drawing = node.problem !== undefined || problemLine !== undefined;
    const codeOnly = node.codeOnly === true && !drawing;
    const glyph = drawing ? "info" : stepGlyph(node);
    // On a read-only page a known step shows its usual line, not "Edited in
    // code": nothing can be edited there, so the label would only add noise
    // (#67 UX ruling 6932934119 fix 14).
    const summary = drawing
      ? undefined
      : codeOnly && editedInCode !== undefined
      ? editedInCode
      : stepLine(node, translate);
    const extra = drawing ? undefined : detail?.(node.uses, id);
    return (
      <div data-card={id}>
        <UI.StepCard
          icon={glyph === undefined
            ? undefined
            : <UI.IconGlyph name={glyph as never} size="small" />}
          title={cardName(node)}
          selected={selectedId === id}
          needsSetup={drawing}
          needsSetupLabel={translate("library.editor.card.needsSetup" as never)}
          writtenInCode={node.code === undefined ? undefined : (
            translate("library.editor.card.writtenInCode" as never, {
              code: node.code,
            })
          )}
          summary={summary}
          detail={extra === undefined
            ? undefined
            : <span data-step-extra="true">{extra}</span>}
          disabled={!canManage}
          onClick={() => onSelect(id)}
        />
      </div>
    );
  };

  // A group is a container with an edge, not a loose label above cards: its
  // label, its "edited in code" line and its cards sit inside one border, and
  // the path line runs into the top and out of the bottom (#67 UX ruling
  // 6932934119 fix 10). "Yes" and "Otherwise" are the two arms of one If.
  const groupBody = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode => (
    <>
      {node.children.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("library.editor.group.noSteps" as never)}
          </UI.Text>
        )
        : nodes(node.children)}
    </>
  );

  /**
   * The word for what kind of group this is. Where a person can select it, it
   * is a button; where they cannot (a read-only page) it is plain text, never a
   * disabled button, so every group's word reads at full strength (#62 QA).
   */
  const groupWord = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode =>
    canManage
      ? (
        <UI.Button variant="text" onClick={() => onSelect(node.id)}>
          {translate(GROUP_LABEL[node.label] as never)}
        </UI.Button>
      )
      : <UI.Text>{translate(GROUP_LABEL[node.label] as never)}</UI.Text>;

  /** A group's own label: its word, and "Edited in code" once for the group. */
  const groupLabel = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode => (
    <div data-group-label={node.id}>
      {groupWord(node)}
      {node.max === undefined
        ? null
        : (
          <UI.Text variant="caption" data-fix-limit="true">
            {translate("library.editor.group.fixLimit" as never, {
              max: node.max,
            })}
          </UI.Text>
        )}
      {editedInCode === undefined
        ? null
        : <UI.Text variant="caption">{editedInCode}</UI.Text>}
    </div>
  );

  /**
   * An arm inside an If container: only its word, because the container says
   * "Edited in code" once for both arms (#67 UX ruling 6934081003 fix 5).
   */
  const armLabel = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode => <div data-group-label={node.id}>{groupWord(node)}</div>;

  const group = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode => (
    <section key={`group-${node.id}`} data-group={node.label}>
      {groupLabel(node)}
      {groupBody(node)}
    </section>
  );

  /** The two arms of a branch, side by side inside one container labelled If. */
  const ifGroup = (
    held: readonly [
      Extract<TreeNode, { kind: "group" }>,
      ...Extract<
        TreeNode,
        { kind: "group" }
      >[],
    ],
  ): ReactNode => (
    <section key={`if-${held[0].id}`} data-group="if" data-group-shape="if">
      <div data-group-label="if">
        <UI.Text variant="strong">
          {translate("library.editor.group.if" as never)}
        </UI.Text>
        {editedInCode === undefined
          ? null
          : <UI.Text variant="caption">{editedInCode}</UI.Text>}
      </div>
      <div data-group-arms="true">
        {held.map((arm) => (
          <div key={`arm-${arm.id}`} data-group-arm={arm.label}>
            {armLabel(arm)}
            {groupBody(arm)}
          </div>
        ))}
      </div>
    </section>
  );

  const nodes = (all: readonly TreeNode[]): ReactNode => {
    const held = all.filter((node) =>
      node.kind !== "step" || node.end !== true
    );
    const out: ReactNode[] = [];
    for (let index = 0; index < held.length; index += 1) {
      const node = held[index];
      if (node.kind === "step") {
        // A step draws its card and the connector AFTER it, unless it is the
        // last thing on the page: the tail connector is drawn once by the
        // page itself, so the path never ends in two "+" buttons (#67 UX
        // ruling 6934081003 fix 3).
        out.push(
          <div key={`step-${node.id}`} data-node-index={index}>
            {card(node)}
            {index === held.length - 1 ? null : connector(node.id)}
          </div>,
        );
        continue;
      }
      // The two arms of a branch are consecutive in the tree: pair them into
      // one If container so a person reads one decision, not two labels.
      const next = held[index + 1];
      if (
        node.label === "yes" && next !== undefined && next.kind === "group" &&
        next.label === "otherwise"
      ) {
        out.push(ifGroup([node, next]));
        index += 1;
        continue;
      }
      out.push(group(node));
    }
    return out;
  };

  // gap="none": a connector must touch the cards above and below it, so the
  // space between cards is the connector's own 40px, not a stack gap plus a
  // connector (#67 UX ruling comment 6935518498 fix 1). Every non-connector
  // child carries its own spacing.
  return (
    <UI.Stack gap="none" data-ui-region="workflow-diagram">
      <div data-card="start">
        <UI.StepCard
          icon={<UI.IconGlyph name="lightning" size="small" />}
          title={translate("library.editor.howItStarts" as never)}
          summary={translate("library.editor.howItStartsLine" as never)}
          selected={selectedId === "start"}
          controls="editor-step-panel"
          onClick={() => onSelect("start")}
        />
      </div>
      {tree.unreadable
        ? (
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
        )
        : (
          <>
            {connector(null)}
            {nodes(tree.nodes)}
            {tree.nodes.length === 0 ? null : connector("end", true)}
          </>
        )}
    </UI.Stack>
  );
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
