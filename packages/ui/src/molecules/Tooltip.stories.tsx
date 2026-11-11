import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Stack, Tooltip } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Tooltip",
  parameters: { catalogId: "ui.tooltip", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const forgedOwnerProps = {
  "data-state": "forged",
  "data-testid": "tooltip-owner-override",
  "data-variant": "forged",
} as unknown as { "data-testid": string };

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Tooltip content="Create a new task" variant="label">
        <Button data-semantic-interaction="open" variant="secondary">
          Hover for help
        </Button>
      </Tooltip>
      <Tooltip
        {...forgedOwnerProps}
        content="More details about this task"
        variant="description"
      >
        <Button
          data-semantic-interaction="focus"
          data-testid="tooltip-prevent-default-focus"
          onBlur={(event) => event.preventDefault()}
          onFocus={(event) => event.preventDefault()}
          variant="secondary"
        >
          Focus for a description
        </Button>
      </Tooltip>
    </Stack>
  ),
};
