import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageMeter } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/UsageMeter",
  parameters: { catalogId: "ui.usageMeter", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 24, maxInlineSize: 640 }}>
      {/* Room to spare, nearly full, and paused: the fill changes tone at each. */}
      <UsageMeter
        label="Storage used"
        limit={100}
        marks={[{ at: 0.75 }, { at: 0.9 }]}
        state="ok"
        value={42}
        valueText="42 GB of 100 GB"
      />
      <UsageMeter
        label="Storage used"
        limit={100}
        marks={[{ at: 0.75 }, { at: 0.9 }]}
        state="warning"
        value={78}
        valueText="78 GB of 100 GB"
      />
      <UsageMeter
        label="Storage used"
        limit={100}
        marks={[{ at: 0.75 }, { at: 0.9 }]}
        state="paused"
        value={96}
        valueText="96 GB of 100 GB"
      />
    </div>
  ),
};
