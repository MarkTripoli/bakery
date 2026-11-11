import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, HandoffForm, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/HandoffForm",
  parameters: { catalogId: "ui.handoffForm", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <Text>Taking you to GitHub to confirm the App.</Text>
      <Button form="handoff-specimen-form" type="submit">
        Continue to GitHub
      </Button>
      <HandoffForm
        action="https://github.com/settings/apps/new"
        data-testid="handoff-specimen"
        id="handoff-specimen-form"
        fields={{ manifest: "{}", state: "specimen-state" }}
      />
    </>
  ),
};
