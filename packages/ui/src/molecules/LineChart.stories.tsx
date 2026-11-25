import type { Meta, StoryObj } from "@storybook/react-vite";
import { LineChart } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/LineChart",
  parameters: { catalogId: "ui.lineChart", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const day = (index: number) => Date.UTC(2026, 10, 1 + index);

export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 32, maxInlineSize: 720 }}>
      <LineChart
        label="Pull requests merged"
        width={900}
        domain={[day(0), day(5)]}
        pointCount={6}
        segments={[
          [{ at: day(0), value: 2 }, { at: day(1), value: 4 }],
          [{ at: day(3), value: 1 }, { at: day(5), value: 5 }],
        ]}
        gaps={[{
          id: "gap",
          from: day(2),
          to: day(2),
          label: "No data, Nov 3, 2026",
          description: "no data, Nov 3, 2026",
        }]}
        maximum={5}
        maximumLabel="5"
        startLabel="Nov 1, 2026"
        endLabel="Nov 6, 2026"
        describe={() => "No data for 1 day. A gap is not zero."}
      />
      <LineChart
        label="Pull requests merged, every day measured"
        width={360}
        domain={[day(0), day(3)]}
        pointCount={4}
        segments={[[
          { at: day(0), value: 3 },
          { at: day(1), value: 0 },
          { at: day(2), value: 5 },
          { at: day(3), value: 4 },
        ]]}
        gaps={[]}
        maximum={5}
        maximumLabel="5"
        startLabel="Nov 1, 2026"
        endLabel="Nov 4, 2026"
        describe={() => "Every day has a measurement."}
      />
    </div>
  ),
};
