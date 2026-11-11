import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Popover, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Popover",
  parameters: { catalogId: "ui.popover", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const forgedContentProps = {
  "data-state": "forged",
  "data-testid": "popover-reserved-props",
  "data-ui-component": "popover",
  "data-variant": "forged",
} as unknown as { "data-testid": string };

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    return (
      <Stack>
        <Popover
          label="Task information"
          trigger="Show task information"
        >
          <Text>Closed content is not shown.</Text>
        </Popover>
        <Popover
          {...forgedContentProps}
          defaultOpen
          label="Interactive task information"
          trigger="Interactive information"
          variant="interactive"
        >
          <Text>Keyboard focus is placed in this panel.</Text>
          <Button onClick={() => setCount(count + 1)}>
            Mark read ({count})
          </Button>
        </Popover>
      </Stack>
    );
  },
};
