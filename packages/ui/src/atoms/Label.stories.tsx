import { useId } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Label",
  parameters: { catalogId: "ui.label", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const id = useId();
    return (
      <Stack>
        <Label htmlFor={`${id}-field`} variant="field">Task name</Label>
        <input id={`${id}-field`} defaultValue="Review the baseline" />
        <Label htmlFor={`${id}-required`} required variant="field">
          Required task name
        </Label>
        <input id={`${id}-required`} required />
        <Label htmlFor={`${id}-disabled`} disabled variant="metadata">
          Unavailable field
        </Label>
        <input disabled id={`${id}-disabled`} />
      </Stack>
    );
  },
};
