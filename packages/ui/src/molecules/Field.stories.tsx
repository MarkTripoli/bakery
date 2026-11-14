import { useId } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Field",
  parameters: { catalogId: "ui.field", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const id = useId();
    return (
      <Stack>
        <Field
          htmlFor={`${id}-input`}
          label="Task title"
          hint="A short, descriptive name."
          state="default"
          variant="input"
        >
          <input id={`${id}-input`} defaultValue="Build something useful" />
        </Field>
        <Field
          htmlFor={`${id}-textarea`}
          label="Description"
          variant="textarea"
          state="focus"
        >
          <textarea
            autoFocus
            id={`${id}-textarea`}
            defaultValue="A long-form note."
          />
        </Field>
        <Field
          error="Choose a supported environment."
          htmlFor={`${id}-select`}
          label="Environment"
          state="invalid"
          variant="select"
        >
          <select id={`${id}-select`} defaultValue="">
            <option value="">Select one</option>
            <option value="development">Development</option>
          </select>
        </Field>
        <Field
          htmlFor={`${id}-inline`}
          label="Display name"
          layout="inline"
          hint="Shown across Bakery."
        >
          <input id={`${id}-inline`} defaultValue="Alex Morgan" />
        </Field>
        <Field htmlFor={`${id}-disabled`} label="Unavailable" state="disabled">
          <input disabled id={`${id}-disabled`} value="No access" readOnly />
        </Field>
        <Field htmlFor={`${id}-readonly`} label="Reference" state="readonly">
          <input id={`${id}-readonly`} value="Read-only value" readOnly />
        </Field>
      </Stack>
    );
  },
};
