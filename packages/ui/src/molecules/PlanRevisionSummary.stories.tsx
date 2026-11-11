import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlanRevisionSummary, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/PlanRevisionSummary",
  parameters: {
    catalogId: "ui.planRevisionSummary",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <PlanRevisionSummary
        title="Shared checkout onboarding"
        revision="Revision 2"
        status={{ label: "Awaiting your decision", tone: "warning" }}
        stepsLabel="Plan steps"
        steps={[
          {
            id: "s1",
            title: "Publish the webhook contract",
            detail: "Payments adds the checkout.completed schema.",
          },
          { id: "s2", title: "Verify both lanes end to end" },
        ]}
      />
      <PlanRevisionSummary
        state="muted"
        title="Shared checkout onboarding"
        revision="Revision 1"
        status={{ label: "Replaced by a newer revision", tone: "neutral" }}
        stepsLabel="Plan steps"
        steps={[{
          id: "s1",
          title: "Add checkout onboarding to the storefront",
        }]}
      />
    </Stack>
  ),
};
