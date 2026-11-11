import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsIndexRow } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SettingsIndexRow",
  parameters: {
    catalogId: "ui.settingsIndexRow",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <nav aria-label="Settings sections">
      <SettingsIndexRow
        description="Name, job title and photo"
        href="#profile"
        title="Profile"
      />
      <SettingsIndexRow
        description="Password, email, and sign-in methods"
        href="#security"
        title="Account & security"
      />
      <SettingsIndexRow
        description="Theme, language and time zone"
        href="#appearance"
        title="Appearance"
      />
    </nav>
  ),
};
