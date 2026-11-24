import type { ReactNode } from "react";
import * as UI from "@bakery/ui";

export type WorkflowChoiceItem = Readonly<{
  id: string;
  title: string;
  description?: string;
}>;

export function WorkflowChoice(
  {
    id,
    label,
    labelHidden = false,
    items,
    value,
    onChange,
    placeholder,
    error,
    disabled = false,
  }: {
    id: string;
    label: string;
    labelHidden?: boolean;
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
        labelHidden={labelHidden}
        onChange={(event) => onChange(event.target.value)}
        options={[
          ...(chosen === undefined
            ? [{ disabled: true, label: placeholder, value: "" }]
            : []),
          ...items.map((item) => ({ label: item.title, value: item.id })),
        ]}
        required={!labelHidden}
        value={chosen === undefined ? "" : chosen.id}
      />
      {chosen?.description
        ? <UI.Text variant="hint">{chosen.description}</UI.Text>
        : null}
    </>
  );
}
