import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconButton, Inline, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/IconButton",
  parameters: { catalogId: "ui.iconButton", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    const [pressed, setPressed] = useState(false);
    return (
      <Stack>
        <Inline>
          <IconButton label="Add task" onClick={() => setCount(count + 1)}>
            +
          </IconButton>
          <IconButton autoFocus label="Compact action" variant="compact">
            ···
          </IconButton>
          <IconButton label="Delete task" variant="destructive">
            ×
          </IconButton>
          <IconButton data-semantic-interaction="hover" label="Hover action">
            ·
          </IconButton>
          <IconButton
            aria-pressed={pressed}
            data-semantic-interaction="pressed"
            label="Pressed action"
            state={pressed ? "pressed" : "default"}
            onClick={() => setPressed(true)}
          >
            ·
          </IconButton>
          <IconButton
            autoFocus
            data-semantic-interaction="focus"
            label="Focus action"
          >
            ·
          </IconButton>
          <IconButton label="Loading action" loading>
            …
          </IconButton>
          <IconButton disabled label="Disabled action">
            −
          </IconButton>
        </Inline>
        <Text role="status">{count} tasks added</Text>
      </Stack>
    );
  },
};
