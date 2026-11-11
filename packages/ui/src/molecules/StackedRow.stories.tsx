import type { Meta, StoryObj } from "@storybook/react-vite";
import { StackedRow, StatusDot, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StackedRow",
  parameters: { catalogId: "ui.stackedRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <StackedRow
      title="northwind/web"
      status={<StatusDot size="small" tone="information">Running</StatusDot>}
    >
      <Text variant="hintInk">Waits for: contract</Text>
      <Text variant="caption">Receives: webhook-schema ← contract</Text>
    </StackedRow>
  ),
};
