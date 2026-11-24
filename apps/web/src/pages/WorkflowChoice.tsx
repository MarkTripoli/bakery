import type { ReactNode } from "react";
import * as UI from "@bakery/ui";

export type WorkflowChoiceItem = Readonly<{
  id: string;
  title: string;
  description?: string;
}>;

export function WorkflowChoice(
  { id, label, items, value, onChange, placeholder, error, disabled = false }: {
    id: string;
    label: string;
    items: readonly WorkflowChoiceItem[];
    value: string;
    onChange: (id: string) => void;
    placeholder: string;
    error?: ReactNode;
    disabled?: boolean;
  },
) {
  const chosen = items.find((item) => item.id === value);
  return (
    <>
      <UI.Combobox
        appearance="field"
        disabled={disabled}
        error={error}
        id={id}
        label={label}
        onChange={(event) => onChange(event.target.value)}
        options={[
          ...(chosen === undefined
            ? [{ disabled: true, label: placeholder, value: "" }]
            : []),
          ...items.map((item) => ({ label: item.title, value: item.id })),
        ]}
        required
        value={chosen === undefined ? "" : chosen.id}
      />
      {chosen?.description
        ? <UI.Text variant="hint">{chosen.description}</UI.Text>
        : null}
    </>
  );
}
