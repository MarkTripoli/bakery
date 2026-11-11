import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Stack",
  parameters: { catalogId: "ui.stack", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <>
      <Stack gap="compact">
        <Text>Compact item</Text>
        <Text>Second item</Text>
      </Stack>
      <Stack gap="standard">
        <Text>Standard item</Text>
      </Stack>
      <Stack gap="spacious">
        <Text>Spacious item</Text>
      </Stack>
    </>
  ),
};

const TightStory: StoryObj = {
  render: () => (
    <Stack gap="tight">
      <Text>northwind/payments</Text>
      <Text variant="caption">alias contract</Text>
    </Stack>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {TightStory.render?.(args, context)}
    </>
  ),
};
