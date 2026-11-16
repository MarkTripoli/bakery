import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ACTION_LINES, ACTION_TITLES } from "./workflow-state.ts";
import type { GroupLabel, Tree, TreeNode, TreeStep } from "./workflow-tree.ts";

/**
 * The workflow drawn top to bottom (#67, slice 1 of the owner's spec): "How it
 * starts", a card per step, and a "+" on the connector between them that opens
 * the step picker. A group the definition states in code (a branch arm, lanes,
 * a repeat, a wait) is drawn as a group and says so; slice 1 cannot change it.
 * A phone shows the same tree as an outline — one model, two renderings.
 */

/** The step types the picker offers, in the order the design lists them. */
export const PICKER_STEPS: readonly string[] = [
  "task.brief",
  "rpi.plan",
  "harness.implement",
  "quality.check",
  "agent.review",
  "delivery.merge",
];

export type DiagramProps = {
  readonly tree: Tree;
  /** The step whose panel is open, by id. */
  readonly selectedId: string | null;
  /** The problems the last check reported, by step id. */
  readonly problems: ReadonlyMap<string, string>;
  readonly canManage: boolean;
  /** Open the picker after the step with this id, or at the start when null. */
  readonly onAdd: (afterId: string | null) => void;
  readonly onSelect: (id: string) => void;
  /** The connector whose picker is open: a step id, `null` for the start, or absent. */
  readonly pickerAt?: string | null;
  readonly onPick: (uses: string) => void;
  readonly onPickClose: () => void;
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
    onAdd,
    onPick,
    onPickClose,
    onSelect,
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
    const open = pickerAt !== undefined && pickerAt === afterId;
    return (
      <UI.Stack gap="tight" data-connector={afterId ?? "start"}>
        {open ? picker : null}
        {canManage && !open
          ? (
            <UI.Button
              variant="secondary"
              aria-label={translate("library.editor.addHere" as never, {
                after: afterId === null
                  ? translate("library.editor.startsHere" as never)
                  : title(
                    treeStepUses(tree, afterId) ?? afterId,
                  ),
              })}
              onClick={() => onAdd(afterId)}
            >
              +
            </UI.Button>
          )
          : null}
      </UI.Stack>
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

  const card = (node: TreeStep, selectable: boolean) => {
    const id = node.id;
    const drawing = node.problem !== undefined;
    const problem = drawing
      ? translate("library.editor.card.needsSetup" as never)
      : problems.get(id);
    return (
      <UI.Stack
        gap="tight"
        data-card={id}
        data-needs-setup={drawing ? "true" : undefined}
      >
        <UI.Button
          variant="text"
          aria-pressed={selectedId === id}
          data-selected={selectedId === id ? "true" : undefined}
          data-problem={problem === undefined ? undefined : "true"}
          disabled={!selectable}
          onClick={() => onSelect(id)}
        >
          <UI.Stack gap="tight">
            <UI.Text variant="strong">{cardName(node)}</UI.Text>
            {node.problem !== undefined
              ? null
              : line(node.uses) === undefined
              ? null
              : <UI.Text variant="muted">{line(node.uses)}</UI.Text>}
            {node.code === undefined ? null : (
              <UI.Text variant="caption">
                {translate("library.editor.card.writtenInCode" as never, {
                  code: node.code,
                })}
              </UI.Text>
            )}
            {problem === undefined
              ? null
              : <UI.Text variant="error">{problem}</UI.Text>}
            {node.problem === undefined ? null : (
              <UI.Text variant="caption">
                {translate("library.editor.card.needsSetupLine" as never)}
              </UI.Text>
            )}
          </UI.Stack>
        </UI.Button>
      </UI.Stack>
    );
  };

  const nodes = (held: readonly TreeNode[]): ReactNode =>
    held.map((node, index) => {
      if (node.kind === "step") {
        return (
          <div key={`step-${node.id}`} data-node-index={index}>
            {card(node, canManage)}
            {connector(node.id)}
          </div>
        );
      }
      return (
        <UI.Stack
          key={`group-${node.label}-${index}`}
          gap="tight"
          data-group={node.label}
        >
          <UI.Text variant="muted">
            {translate(GROUP_LABEL[node.label] as never)}
          </UI.Text>
          {nodes(node.children)}
          <UI.Text variant="caption">
            {translate("library.editor.group.codeOnly" as never)}
          </UI.Text>
        </UI.Stack>
      );
    });

  return (
    <UI.Stack gap="standard" data-ui-region="workflow-diagram">
      <UI.Stack gap="tight" data-card="start">
        <UI.Text variant="muted">
          {translate("library.editor.howItStarts" as never)}
        </UI.Text>
        <UI.Text variant="strong">
          {translate("library.editor.howItStartsLine" as never)}
        </UI.Text>
      </UI.Stack>
      {connector(null)}
      {nodes(tree.nodes)}
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
