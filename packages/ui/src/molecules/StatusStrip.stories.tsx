import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge, StatusStrip } from "@bakery/ui";
import { PaperStatusStrip } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Molecules/StatusStrip",
  parameters: { catalogId: "ui.statusStrip", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <PaperStatusStrip />
      <StatusStrip
        label="Worker readiness, attention"
        state="attention"
        variant="compact"
      >
        <StatusBadge status="disconnected">No workers ready</StatusBadge>
        <span>Queued work waits for a worker.</span>
      </StatusStrip>
    </div>
  ),
};
