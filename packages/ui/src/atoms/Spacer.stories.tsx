import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, Spacer, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Spacer",
  parameters: { catalogId: "ui.spacer", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline>
      <Text>Left</Text>
      <Spacer variant="inline" />
      <Text>Right</Text>
      <Spacer variant="block" />
    </Inline>
  ),
};
