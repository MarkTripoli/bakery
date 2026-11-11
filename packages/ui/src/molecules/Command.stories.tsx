import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Command, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Command",
  parameters: { catalogId: "ui.command", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [value, setValue] = useState("ready");
    return (
      <Stack>
        <Command
          inputLabel="Search commands"
          items={[{ id: "new", label: "Create task" }, {
            id: "search",
            label: "Search work",
          }, { id: "settings", label: "Open settings" }]}
          onRun={setValue}
        />
        <Command
          inputLabel="Search scoped commands"
          query="missing"
          scope="Current task"
          variant="scoped"
          items={[{ id: "retry", label: "Retry build" }, {
            id: "cancel",
            label: "Cancel run",
            disabled: true,
          }]}
          emptyMessage="No matching commands."
        />
        <Command
          inputLabel="Search commands while typing"
          query="task"
          items={[{ id: "task", label: "Create task" }]}
        />
        <Command
          inputLabel="Closed command search"
          open={false}
          items={[]}
        />
        <Text role="status">Last command: {value}</Text>
      </Stack>
    );
  },
};
