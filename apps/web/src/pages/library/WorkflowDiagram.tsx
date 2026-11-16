import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  ACTION_ICONS,
  ACTION_LINES,
  ACTION_TITLES,
  PICKER_STEPS,
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
  /** Open the picker after the step with this id, or at the start when null. */
  readonly onAdd: (afterId: string | null) => void;
  readonly onSelect: (id: string) => void;
  /** The connector whose picker is open: a step id, `null` for the start, or absent. */
  readonly pickerAt?: string | null;
  readonly onPick: (uses: string) => void;
  readonly onPickClose: () => void;
  /** Open the code view, which the notice and a code-only panel offer. */
  readonly onViewAsCode: () => void;
};

const GROUP_LABEL: Readonly<Record<GroupLabel, string>> = {
  yes: "library.editor.group.yes",
  otherwise: "library.editor.group.otherwise",
  together: "library.editor.group.together",
  repeat: "library.editor.group.repeat",
  wait: "library.editor.group.wait",
};

export function WorkflowDiagram(
  {
    canManage,
    editable,
    onAdd,
    onPick,
    onPickClose,
    onSelect,
    onViewAsCode,
    pickerAt,
    problems,
    selectedId,
    tree,
  }: DiagramProps,
) {
  const { translate } = useI18n();
  const title = (uses: string): string => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key as never);
  };
  const line = (uses: string): string | undefined => {
    const key = ACTION_LINES[uses];
    return key === undefined ? undefined : translate(key as never);
  };

  const picker = (
    <UI.Stack gap="tight" data-testid="step-picker">
      <UI.Text variant="strong">
        {translate("library.editor.picker.title" as never)}
      </UI.Text>
      {PICKER_STEPS.map((uses) => (
        <UI.Button
          key={uses}
          variant="text"
          onClick={() => onPick(uses)}
        >
          {title(uses)}
        </UI.Button>
      ))}
      <UI.Button variant="secondary" onClick={onPickClose}>
        {translate("library.editor.picker.cancel" as never)}
      </UI.Button>
    </UI.Stack>
  );

  // The connector between two cards: the "+" a person presses to add a step.
  const connector = (afterId: string | null): ReactNode => {
    if (!editable) return null;
    const open = pickerAt !== undefined && pickerAt === afterId;
    return (
      <div data-connector={afterId ?? "start"}>
        {open ? picker : null}
        {canManage && !open
          ? (
            <UI.StepConnector
              label={translate("library.editor.addHere" as never, {
                after: afterId === null
                  ? translate("library.editor.startsHere" as never)
                  : title(treeStepUses(tree, afterId) ?? afterId),
              })}
              onClick={() => onAdd(afterId)}
            />
          )
          : null}
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
    return title(node.uses);
  };

  const card = (node: TreeStep): ReactNode => {
    const id = node.id;
    const drawing = node.problem !== undefined;
    const codeOnly = node.codeOnly === true && !drawing;
    const glyph = node.problem !== undefined ? "info" : ACTION_ICONS[node.uses];
    // A step Bakery knows but can only change in code says so in the line where
    // its description would be: no red outline, and never a problem.
    const summary = drawing
      ? undefined
      : codeOnly
      ? translate("library.editor.group.codeOnly" as never)
      : line(node.uses);
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
          disabled={!canManage}
          onClick={() => onSelect(id)}
        />
        {problems.get(id) === undefined
          ? null
          : <UI.Text variant="error">{problems.get(id)}</UI.Text>}
      </div>
    );
  };

  const group = (
    node: Extract<TreeNode, { kind: "group" }>,
  ): ReactNode => (
    <UI.Stack
      key={`group-${node.id}`}
      gap="tight"
      data-group={node.label}
    >
      <div data-group-label={node.id}>
        <UI.Button
          variant="text"
          disabled={!canManage}
          onClick={() => onSelect(node.id)}
        >
          {translate(GROUP_LABEL[node.label] as never)}
        </UI.Button>
        <UI.Text variant="caption">
          {translate("library.editor.group.codeOnly" as never)}
        </UI.Text>
      </div>
      {node.children.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("library.editor.group.noSteps" as never)}
          </UI.Text>
        )
        : nodes(node.children)}
    </UI.Stack>
  );

  const nodes = (held: readonly TreeNode[]): ReactNode =>
    held.map((node, index) => {
      if (node.kind === "step") {
        return (
          <div key={`step-${node.id}`} data-node-index={index}>
            {card(node)}
            {connector(node.id)}
          </div>
        );
      }
      return group(node);
    });

  return (
    <UI.Stack gap="standard" data-ui-region="workflow-diagram">
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
