import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Inline } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Badge",
  parameters: { catalogId: "ui.badge", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline>
      <Badge>Password</Badge>
      <Badge tone="success">Current</Badge>
    </Inline>
  ),
};
