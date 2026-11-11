import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Menu, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Menu",
  parameters: { catalogId: "ui.menu", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [value, setValue] = useState("ready");
    return (
      <Stack>
        <Menu
          aria-label="Task actions"
          onSelect={setValue}
          items={[{ id: "open", label: "Open task" }, {
            id: "archive",
            label: "Archive task",
          }, { id: "delete", label: "Delete task", disabled: true }]}
        />
        <Menu
          aria-label="Task selection"
          variant="selection"
          items={[{ id: "mine", label: "My tasks", selected: true }, {
            id: "all",
            label: "All tasks",
          }]}
        />
        <Text role="status">Selected: {value}</Text>
        <Menu aria-label="Closed actions" open={false} items={[]} />
        <Menu
          aria-label="Disabled actions"
          items={[{
            id: "disabled",
            label: "Unavailable action",
            disabled: true,
          }]}
        />
      </Stack>
    );
  },
};
