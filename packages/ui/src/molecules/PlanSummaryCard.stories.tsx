import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlanSummaryCard } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/PlanSummaryCard",
  parameters: { catalogId: "ui.planSummaryCard", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <PlanSummaryCard
        title="Plan · Revision 2"
        meta="Awaiting your decision"
        tone="warning"
      />
      <PlanSummaryCard title="Plan" meta="No plan yet" tone="neutral" />
    </>
  ),
};
