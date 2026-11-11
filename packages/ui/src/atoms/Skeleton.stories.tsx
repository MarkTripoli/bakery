import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Skeleton",
  parameters: { catalogId: "ui.skeleton", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Skeleton shape="text" />
      <Skeleton shape="control" />
      <Skeleton shape="row" />
      <Skeleton shape="surface" />
    </Stack>
  ),
};
