import type { Meta, StoryObj } from "@storybook/react-vite";
import { TimeSeriesChart } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/TimeSeriesChart",
  parameters: { catalogId: "ui.timeSeriesChart", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const days = (values: (number | null)[]) =>
  values.map((value, index) => ({ label: `${index + 1} Nov`, value }));

export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "24px", maxWidth: "560px" }}>
      <TimeSeriesChart
        formatValue={String}
        gaps={[{ start: 4, end: 6, label: "No data, 5 Nov to 7 Nov" }]}
        label="Pull requests merged each day"
        points={days([2, 4, 3, 5, null, null, null, 6, 4, 7])}
      />
      <TimeSeriesChart
        formatValue={String}
        gaps={[{ start: 0, end: 1, label: "No data, 1 Nov to 2 Nov" }, {
          start: 3,
          end: 4,
          label: "No data, 4 Nov to 5 Nov",
        }]}
        label="One known day"
        points={days([null, null, 3, null, null])}
      />
      <TimeSeriesChart
        formatValue={String}
        gaps={[{ start: 0, end: 3, label: "No data, 1 Nov to 4 Nov" }]}
        label="Nothing known"
        points={days([null, null, null, null])}
      />
    </div>
  ),
};
