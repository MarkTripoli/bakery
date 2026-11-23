import * as UI from "@bakery/ui";
import type { TicketPresetId } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { TICKET_PRESETS } from "./issue-sources.ts";
import { presetCopy } from "./task-composer-labels.ts";

/**
 * The two built-in workflows as a radio group of option cards (design-ux, #61
 * revision 7): the same cards, titles and descriptions wherever a person
 * chooses one, in the Start work question and in a repository's settings.
 */
export function BuiltInWorkflowChoice(
  { disabled = false, label, name, onChange, value }: {
    readonly disabled?: boolean;
    /** The group's accessible name. */
    readonly label: string;
    /** The radio group's name: one per place the choice is drawn. */
    readonly name: string;
    readonly onChange: (preset: TicketPresetId) => void;
    readonly value: TicketPresetId;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.Stack gap="compact" role="radiogroup" aria-label={label}>
      {TICKET_PRESETS.map((id) => {
        const copy = presetCopy(translate, id);
        return (
          <UI.PresetOption
            key={id}
            checked={value === id}
            description={copy.description}
            disabled={disabled}
            name={name}
            onChange={() => onChange(id)}
            title={copy.title}
            value={id}
          />
        );
      })}
    </UI.Stack>
  );
}
