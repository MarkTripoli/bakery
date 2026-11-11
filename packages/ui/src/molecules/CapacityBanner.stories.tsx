import type { Meta, StoryObj } from "@storybook/react-vite";
import { CapacityBanner, Stack } from "@bakery/ui";
const meta = {
  title: "Bakery/Molecules/CapacityBanner",
  parameters: { catalogId: "ui.capacityBanner", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <CapacityBanner
        title="Storage nearly full"
        description="Remove unneeded pinned artifacts to free capacity."
        state="warning"
      />
      <CapacityBanner
        title="Artifact publishing paused"
        description="Storage capacity is full. Existing revisions remain readable."
        state="paused"
      />
    </Stack>
  ),
};
