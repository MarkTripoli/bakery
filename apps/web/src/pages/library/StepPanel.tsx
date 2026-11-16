import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ACTION_LINES, ACTION_TITLES } from "./workflow-state.ts";

/**
 * The panel beside the diagram (#67, slice 1): the selected step, its name as
 * the step type's own name (the definition has nowhere to store a person's
 * name yet), and the three actions the design puts in the panel footer — move
 * up, move down, remove. The reducer behind them is the same one the list
 * editor used, so undo and redo still decide what actually happens.
 */
export function StepPanel(
  {
    uses,
    problem,
    canMoveUp,
    canMoveDown,
    disabled,
    onMoveUp,
    onMoveDown,
    onRemove,
  }: {
    readonly uses: string;
    readonly problem: string | undefined;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly disabled: boolean;
    readonly onMoveUp: () => void;
    readonly onMoveDown: () => void;
    readonly onRemove: () => void;
  },
) {
  const { translate } = useI18n();
  const titleKey = ACTION_TITLES[uses];
  const name = titleKey === undefined ? uses : translate(titleKey as never);
  const lineKey = ACTION_LINES[uses];
  const line = lineKey === undefined ? undefined : translate(lineKey as never);

  return (
    <UI.InspectorPanel
      label={translate("library.editor.panel.label" as never)}
      variant="column"
      header={
        <UI.Stack gap="tight">
          <UI.Text variant="strong">{name}</UI.Text>
          <UI.Text variant="muted">
            {translate("library.editor.panel.nameIsType" as never)}
          </UI.Text>
        </UI.Stack>
      }
      footer={
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={disabled || !canMoveUp}
            onClick={onMoveUp}
          >
            {translate("library.editor.panel.moveUp" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            disabled={disabled || !canMoveDown}
            onClick={onMoveDown}
          >
            {translate("library.editor.panel.moveDown" as never)}
          </UI.Button>
          <UI.Button
            variant="destructive"
            disabled={disabled}
            onClick={onRemove}
          >
            {translate("library.editor.panel.remove" as never)}
          </UI.Button>
        </UI.Inline>
      }
    >
      <UI.Stack gap="compact">
        {line === undefined ? null : <UI.Text>{line}</UI.Text>}
        {problem === undefined
          ? null
          : (
            <UI.InlineNotice role="status" tone="error">
              {problem}
            </UI.InlineNotice>
          )}
      </UI.Stack>
    </UI.InspectorPanel>
  );
}
