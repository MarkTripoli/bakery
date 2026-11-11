import type { Meta, StoryObj } from "@storybook/react-vite";
import { PaneSection, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/PaneSection",
  parameters: { catalogId: "ui.paneSection", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <PaneSection ruled title="Participants (2)">
        <Text>Priya Raman (you)</Text>
        <Text>Dana Okafor</Text>
      </PaneSection>
      <PaneSection
        heading="strong"
        ruled
        title="Trusted repository inspection"
        trailing={<Text>Running</Text>}
      >
        <Text>Each verified result creates a new immutable profile.</Text>
      </PaneSection>
      <PaneSection>
        <Text>Shared checkout onboarding</Text>
      </PaneSection>
    </>
  ),
};
