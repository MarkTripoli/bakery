import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AuthHeading,
  IconGlyph,
  Link,
  SettingsContent,
  SettingsSection,
  Stack,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/SettingsContent",
  parameters: {
    catalogId: "template.settingsContent",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <SettingsContent
        back={
          <Link href="#account" variant="quiet">
            <IconGlyph name="back" />
            Account and security
          </Link>
        }
      >
        <AuthHeading
          description="Review where this account is signed in."
          title="Sessions"
        />
        <SettingsSection title="Signed-in devices">
          <Text>
            The column keeps Paper's 760px measure and 28px rhythm; the page
            gutter comes from the application shell.
          </Text>
        </SettingsSection>
      </SettingsContent>
      <SettingsContent variant="personal">
        <AuthHeading
          description="Your name, title and photo across Bakery."
          title="Profile"
        />
      </SettingsContent>
      <SettingsContent variant="preferences">
        <AuthHeading
          description="Choose how Bakery looks on your devices."
          title="Appearance"
        />
      </SettingsContent>
      <SettingsContent variant="access">
        <AuthHeading
          description="What you can do in Platform team."
          title="Your access"
        />
      </SettingsContent>
    </Stack>
  ),
};
