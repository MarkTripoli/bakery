import type { Meta, StoryObj } from "@storybook/react-vite";
import { Divider, Inline, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Divider",
  parameters: { catalogId: "ui.divider", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text>Task details</Text>
      <Divider />
      <Text>Activity</Text>
      <Divider orientation="horizontal" />
      <Inline>
        <Text>Left</Text>
        <Divider orientation="vertical" />
        <Text>Right</Text>
      </Inline>
    </Stack>
  ),
};
