import { useEffect, useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  TASK_ACTION,
  TASK_MINUTES,
  TASK_PROMPT_MAX,
  TASK_TOOLS,
  type TaskFields,
  type TaskProblem,
  typedCost,
  typedTurns,
} from "./task-step.ts";

export type TaskPanelProps = Readonly<{
  stepId: string;
  fields: TaskFields;
  onChange: ((fields: TaskFields, typing?: string) => void) | undefined;
  problems: Readonly<Partial<Record<TaskProblem["field"], string>>>;
  focus:
    | Readonly<{ field: TaskProblem["field"]; request: number }>
    | null;
}>;

const TOOL_NAMES: Readonly<Record<string, MessageKey>> = {
  Read: "library.editor.task.tool.read",
  Glob: "library.editor.task.tool.glob",
  Grep: "library.editor.task.tool.grep",
};

function useTimeName() {
  const { translate } = useI18n();
  return (minutes: number) =>
    minutes % 60 === 0
      ? translate("library.editor.task.hours", { count: minutes / 60 })
      : translate("library.editor.task.minutes", { count: minutes });
}

export function TaskPanelBody(props: TaskPanelProps) {
  return props.onChange === undefined
    ? <ReadOnlyTask {...props} />
    : <EditableTask {...props} onChange={props.onChange} />;
}

function About({ stepId }: { readonly stepId: string }) {
  const { translate } = useI18n();
  return (
    <UI.Text variant="caption">
      {translate("library.editor.task.about", {
        id: stepId,
        action: TASK_ACTION,
      })}
    </UI.Text>
  );
}

function ReadOnlyTask({ fields, stepId }: TaskPanelProps) {
  const { translate, locale } = useI18n();
  const timeName = useTimeName();
  const tools = new Intl.ListFormat(locale).format(
    fields.tools.map((tool) => translate(TOOL_NAMES[tool])),
  );
  return (
    <UI.Stack gap="compact" data-testid="task-fields">
      <UI.Text>
        {translate("library.editor.task.read.instructions", {
          prompt: fields.prompt,
        })}
      </UI.Text>
      <UI.Text>
        {translate("library.editor.task.read.time", {
          time: timeName(fields.minutes),
        })}
      </UI.Text>
      <UI.Text>
        {translate("library.editor.task.read.cost", { cost: fields.cost })}
      </UI.Text>
      <UI.Text>
        {translate("library.editor.task.read.turns", { turns: fields.turns })}
      </UI.Text>
      <UI.Text>
        {fields.tools.length === 0
          ? translate("library.editor.task.read.noTools")
          : translate("library.editor.task.read.tools", { tools })}
      </UI.Text>
      <About stepId={stepId} />
    </UI.Stack>
  );
}

function EditableTask(
  props: TaskPanelProps & {
    readonly onChange: (fields: TaskFields, typing?: string) => void;
  },
) {
  const { fields, onChange, problems, focus } = props;
  const { translate } = useI18n();
  const timeName = useTimeName();
  const base = useId();
  const ids = {
    prompt: `${base}-prompt`,
    turns: `${base}-turns`,
    cost: `${base}-cost`,
  };
  const [draft, setDraft] = useState(fields);
  const [seen, setSeen] = useState(fields);
  if (seen !== fields) {
    setSeen(fields);
    setDraft(fields);
  }
  const advancedFocus = focus !== null && focus.field !== "prompt";
  const focusId = focus === null ? null : ids[focus.field];
  useEffect(() => {
    if (focusId === null) return;
    globalThis.document.getElementById(focusId)?.focus();
  }, [focusId, focus?.request]);
  const type = (field: "prompt" | "turns" | "cost", value: string) => {
    setDraft((held) => ({ ...held, [field]: value }));
    onChange({ ...fields, [field]: value }, field);
  };
  const times = TASK_MINUTES.includes(fields.minutes)
    ? TASK_MINUTES
    : [...TASK_MINUTES, fields.minutes];
  return (
    <UI.Stack gap="standard" data-testid="task-fields">
      <UI.Field
        error={problems.prompt}
        hint={translate("library.editor.task.instructionsHelp")}
        htmlFor={ids.prompt}
        label={translate("library.editor.task.instructions")}
        required
        variant="textarea"
      >
        <textarea
          id={ids.prompt}
          maxLength={TASK_PROMPT_MAX}
          onChange={(event) =>
            type("prompt", event.target.value.slice(0, TASK_PROMPT_MAX))}
          required
          rows={6}
          value={draft.prompt}
        />
      </UI.Field>
      <UI.Disclosure
        defaultOpen={advancedFocus || problems.turns !== undefined ||
          problems.cost !== undefined}
        key={advancedFocus ? focus.request : "closed"}
        summary={translate("library.editor.task.advanced")}
      >
        <UI.Stack gap="standard">
          <UI.Combobox
            label={translate("library.editor.task.time")}
            onChange={(event) =>
              onChange({
                ...fields,
                minutes: Number(event.currentTarget.value),
              })}
            options={times.map((minutes) => ({
              value: String(minutes),
              label: timeName(minutes),
            }))}
            value={String(fields.minutes)}
          />
          <UI.Field
            error={problems.cost}
            hint={translate("library.editor.task.costHelp")}
            htmlFor={ids.cost}
            label={translate("library.editor.task.cost")}
            required
          >
            <UI.TextInput
              autoComplete="off"
              id={ids.cost}
              inputMode="decimal"
              name="cost"
              onChange={(value) => {
                if (typedCost(value)) type("cost", value);
              }}
              type="text"
              value={draft.cost}
            />
          </UI.Field>
          <UI.Field
            error={problems.turns}
            hint={translate("library.editor.task.turnsHelp")}
            htmlFor={ids.turns}
            label={translate("library.editor.task.turns")}
            required
          >
            <UI.TextInput
              autoComplete="off"
              id={ids.turns}
              inputMode="numeric"
              name="turns"
              onChange={(value) => {
                if (typedTurns(value)) type("turns", value);
              }}
              type="text"
              value={draft.turns}
            />
          </UI.Field>
          <UI.Stack gap="tight">
            <UI.Text variant="strong">
              {translate("library.editor.task.tools")}
            </UI.Text>
            {TASK_TOOLS.map((tool) => (
              <UI.Checkbox
                checked={fields.tools.includes(tool)}
                key={tool}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  onChange({
                    ...fields,
                    tools: TASK_TOOLS.filter((one) =>
                      one === tool ? on : fields.tools.includes(one)
                    ),
                  });
                }}
              >
                {translate(TOOL_NAMES[tool])}
              </UI.Checkbox>
            ))}
            <UI.Text variant="caption">
              {translate(
                fields.tools.length === 0
                  ? "library.editor.task.noTools"
                  : "library.editor.task.toolsHelp",
              )}
            </UI.Text>
          </UI.Stack>
          <About stepId={props.stepId} />
        </UI.Stack>
      </UI.Disclosure>
    </UI.Stack>
  );
}
