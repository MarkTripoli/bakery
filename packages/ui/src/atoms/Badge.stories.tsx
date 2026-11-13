import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Inline, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Badge",
  parameters: { catalogId: "ui.badge", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="compact">
      <Inline>
        <Badge>Password</Badge>
      </Inline>
      <Inline>
        <Badge tone="success">Current</Badge>
      </Inline>
      <Inline>
        <Badge tone="warning">Needs care</Badge>
      </Inline>
      <Inline>
        <Badge tone="danger">Blocked</Badge>
      </Inline>
    </Stack>
  ),
};
