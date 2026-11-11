import type { Meta, StoryObj } from "@storybook/react-vite";
import { Combobox, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Combobox",
  parameters: { catalogId: "ui.combobox", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Combobox
        label="Choose one model"
        state="selected"
        variant="single"
        defaultValue="luna"
        options={[{ value: "luna", label: "Luna" }, {
          value: "astra",
          label: "Astra",
          disabled: true,
        }]}
      />
      <Combobox
        label="Choose models"
        multiple
        state="open"
        variant="multiple"
        options={[{ value: "luna", label: "Luna" }, {
          value: "astra",
          label: "Astra",
        }]}
      />
      <Combobox label="Loading models" state="loading" options={[]} />
      <Combobox label="No models" state="empty" options={[]} />
      <Combobox label="Closed models" state="closed" options={[]} />
      <Combobox
        label="Disabled models"
        disabled
        state="disabled"
        options={[]}
      />
    </Stack>
  ),
};
