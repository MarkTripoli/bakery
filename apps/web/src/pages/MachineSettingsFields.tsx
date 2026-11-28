import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { ADD_NAME_MAX, type AddAnswers, addProblems } from "./machine-add.ts";
import { CODING_AGENTS } from "./machine-systems.ts";

export function MachineSettingsFields(
  { answers, onChange, showProblems, translate }: {
    answers: AddAnswers;
    onChange: (next: AddAnswers) => void;
    showProblems: boolean;
    translate: Translator;
  },
) {
  const problems = showProblems ? addProblems(answers) : [];
  return (
    <UI.Stack gap="standard">
      <UI.Field
        label={translate("machines.wizard.name" as never)}
        htmlFor="machine-add-name"
        hint={translate("machines.add.nameHint" as never)}
        error={problems.includes("nameTooLong")
          ? translate("machines.wizard.nameTooLong" as never, {
            max: ADD_NAME_MAX,
          })
          : undefined}
      >
        <UI.TextInput
          id="machine-add-name"
          name="name"
          type="text"
          autoComplete="off"
          invalid={problems.includes("nameTooLong")}
          value={answers.name}
          onChange={(name) => onChange({ ...answers, name })}
        />
      </UI.Field>
      <UI.Field
        label={translate("machines.wizard.slots" as never)}
        htmlFor="machine-add-slots"
        hint={translate("machines.wizard.slotsHint" as never)}
        error={problems.includes("slotsInvalid")
          ? translate("machines.wizard.slotsInvalid" as never)
          : undefined}
        required
      >
        <UI.TextInput
          id="machine-add-slots"
          name="slots"
          type="number"
          autoComplete="off"
          inputMode="numeric"
          min={1}
          max={100}
          invalid={problems.includes("slotsInvalid")}
          value={answers.slots}
          onChange={(slots) => onChange({ ...answers, slots })}
        />
      </UI.Field>
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {translate("machines.wizard.agent.question" as never)}
        </UI.Text>
        <UI.Stack
          gap="compact"
          role="radiogroup"
          aria-label={translate("machines.wizard.agent.question" as never)}
        >
          {CODING_AGENTS.map((agent) => (
            <UI.PresetOption
              key={agent}
              name="machine-add-agent"
              value={agent}
              checked={answers.agent === agent}
              onChange={() => onChange({ ...answers, agent })}
              title={translate(`machines.agent.${agent}` as never)}
            />
          ))}
        </UI.Stack>
        {problems.includes("agentRequired")
          ? (
            <UI.Text variant="error" role="alert">
              {translate("machines.wizard.agent.required" as never)}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    </UI.Stack>
  );
}
