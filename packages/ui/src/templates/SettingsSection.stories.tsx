import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, InlineNotice, SettingsSection, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/SettingsSection",
  parameters: {
    catalogId: "template.settingsSection",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <SettingsSection title="Sign-in methods">
        <Text>A plain section: the rows below carry their own spacing.</Text>
      </SettingsSection>
      <SettingsSection title="Account protection" variant="stack">
        <InlineNotice tone="information">
          Two-factor authentication is off for this account.
        </InlineNotice>
        <Button variant="secondary">Turn on two-factor</Button>
      </SettingsSection>
    </>
  ),
};
