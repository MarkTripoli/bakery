import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, StackedRow, StatusDot, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StackedRow",
  parameters: { catalogId: "ui.stackedRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="none">
      <StackedRow
        title="northwind/web"
        status={<StatusDot size="small" tone="information">Running</StatusDot>}
      >
        <Text variant="hintInk">Waits for: contract</Text>
        <Text variant="caption">Receives: webhook-schema ← contract</Text>
      </StackedRow>
      {/* The row whose detail is open beside the list is marked selected. */}
      <StackedRow
        title="northwind/api"
        selected
        status={<StatusDot size="small" tone="success">Done</StatusDot>}
      >
        <Text variant="caption">Open beside the list</Text>
      </StackedRow>
    </Stack>
  ),
};
