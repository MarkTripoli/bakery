import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppearancePreview, StatusBadge } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/AppearancePreview",
  parameters: {
    catalogId: "ui.appearancePreview",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <AppearancePreview
      action="Open task"
      caption="Preview"
      label="Work"
      meta="Bakery · Your answer will resume this task."
      status={<StatusBadge status="needsInput">Needs input</StatusBadge>}
      title="Add repository onboarding"
    />
  ),
};
