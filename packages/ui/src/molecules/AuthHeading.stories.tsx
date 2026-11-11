import type { Meta, StoryObj } from "@storybook/react-vite";
import { AuthHeading } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/AuthHeading",
  parameters: { catalogId: "ui.authHeading", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <AuthHeading
      description="Use your work email and password to sign in."
      title="Sign in"
    />
  ),
};
