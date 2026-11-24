import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, Spinner, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Spinner",
  parameters: { catalogId: "ui.spinner", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline gap="compact">
      <Spinner />
      <Text variant="muted">Waiting</Text>
    </Inline>
  ),
};
