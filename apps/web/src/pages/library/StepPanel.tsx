import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ACTION_LINES } from "./workflow-state.ts";

/**
 * The panel beside the diagram (#67, slice 1): what the person selected, and
 * the actions the design puts in the panel footer. Three things can be
 * selected, and each gets one treatment (design-ux's ruling, comment
 * 6917906748):
 *
 * - the start card, which says how a workflow starts and offers nothing;
 * - a part written in code (a group, or a step only changeable in code), which
 *   says so and offers "View as code" and no Move or Remove;
 * - a step, with its name as the step type's own name (the definition has no
 *   place to store a person's name yet) and move up, move down and remove.
 *
 * The reducer behind the actions is the same one the list editor used, so undo
 * and redo still decide what actually happens.
 */

/** What the panel is showing. */
export type PanelTarget =
  | { readonly kind: "start" }
  | {
    readonly kind: "codeOnly";
    readonly name: string;
    /** The problem's sentence, shown above the code-only sentence. */
    readonly problem: string | undefined;
  }
  | {
    readonly kind: "step";
    /** The card's name: the step type's own name, or "Unreadable step". */
    readonly name: string;
    /** Whether this page may delete the step, which is every editable page. */
    readonly deletable: boolean;
    readonly uses: string;
    /** What the definition states, when the step could not be drawn as an action. */
    readonly code: string | undefined;
    readonly problem: string | undefined;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly disabled: boolean;
    readonly onMoveUp: () => void;
    readonly onMoveDown: () => void;
    readonly onRemove: () => void;
  };

export function StepPanel(
  { target, onViewAsCode }: {
    readonly target: PanelTarget;
    readonly onViewAsCode: () => void;
  },
) {
  const { translate } = useI18n();
  const label = translate("library.editor.panel.label" as never);

  if (target.kind === "start") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={
          <UI.Text variant="strong">
            {translate("library.editor.howItStarts" as never)}
          </UI.Text>
        }
      >
        <UI.Text>
          {translate("library.editor.startsByHand" as never)}
        </UI.Text>
      </UI.InspectorPanel>
    );
  }

  if (target.kind === "codeOnly") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={<UI.Text variant="strong">{target.name}</UI.Text>}
        footer={
          <UI.Button variant="secondary" onClick={onViewAsCode}>
            {translate("library.editor.viewAsCode" as never)}
          </UI.Button>
        }
      >
        <UI.Stack gap="compact">
          {target.problem === undefined
            ? null
            : (
              <UI.InlineNotice role="status" tone="error">
                {target.problem}
              </UI.InlineNotice>
            )}
          <UI.Text>
            {translate("library.editor.panel.codeOnly" as never)}
          </UI.Text>
        </UI.Stack>
      </UI.InspectorPanel>
    );
  }

  const lineKey = ACTION_LINES[target.uses];
  const line = lineKey === undefined ? undefined : translate(lineKey as never);

  return (
    <UI.InspectorPanel
      id="editor-step-panel"
      label={label}
      variant="column"
      header={<UI.Text variant="strong">{target.name}</UI.Text>}
      footer={
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveUp}
            onClick={target.onMoveUp}
          >
            {translate("library.editor.panel.moveUp" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveDown}
            onClick={target.onMoveDown}
          >
            {translate("library.editor.panel.moveDown" as never)}
          </UI.Button>
          <UI.Button
            variant="destructive"
            // A step Bakery cannot read is exactly the one a person must be
            // able to delete, so only a read-only page disables this button
            // (#67 UX ruling 6932934119 fix 6).
            disabled={!target.deletable}
            onClick={target.onRemove}
          >
            {translate("library.editor.panel.remove" as never)}
          </UI.Button>
        </UI.Inline>
      }
    >
      <UI.Stack gap="compact">
        {line === undefined ? null : <UI.Text>{line}</UI.Text>}
        {target.problem === undefined
          ? null
          : (
            <UI.InlineNotice role="status" tone="error">
              {target.problem}
            </UI.InlineNotice>
          )}
        {target.code === undefined ? null : (
          <UI.Text variant="caption">
            {translate("library.editor.card.writtenInCode" as never, {
              code: target.code,
            })}
          </UI.Text>
        )}
      </UI.Stack>
    </UI.InspectorPanel>
  );
}
