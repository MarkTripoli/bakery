import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedBar } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SegmentedBar",
  parameters: { catalogId: "ui.segmentedBar", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 32, maxInlineSize: 720 }}>
      {/* Four recorded parts and the part nobody recorded, hatched. */}
      <SegmentedBar
        label="Where the time went: agent working 6 h, queue 2 h, review 1 h, a person 3 h, not accounted for 4 h"
        parts={[
          {
            id: "agent",
            label: "Agent working",
            value: 6,
            tone: "first",
            detail: "6 h",
          },
          {
            id: "queue",
            label: "Waiting in queue",
            value: 2,
            tone: "second",
            detail: "2 h",
          },
          {
            id: "review",
            label: "In review",
            value: 1,
            tone: "third",
            detail: "1 h",
          },
          {
            id: "person",
            label: "Waiting for a person",
            value: 3,
            tone: "fourth",
            detail: "3 h",
          },
          {
            id: "unknown",
            label: "Not accounted for",
            value: 4,
            tone: "unknown",
            detail: "4 h",
          },
        ]}
      />
      {/* A part of zero is not drawn and not listed. */}
      <SegmentedBar
        label="Where the time went: agent working 5 h, in review 1 h"
        parts={[
          {
            id: "agent",
            label: "Agent working",
            value: 5,
            tone: "first",
            detail: "5 h",
          },
          {
            id: "queue",
            label: "Waiting in queue",
            value: 0,
            tone: "second",
            detail: "0 min",
          },
          {
            id: "review",
            label: "In review",
            value: 1,
            tone: "third",
            detail: "1 h",
          },
        ]}
      />
    </div>
  ),
};
